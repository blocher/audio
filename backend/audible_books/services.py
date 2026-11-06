import re
import shutil
from pathlib import Path

import httpx
from django.db import transaction
from django.db.models import Value
from django.db.models.functions import Greatest
from django.utils import timezone

from core import audio
from core.models import Track
from core.secrets import decrypt_json, encrypt_json

from . import client
from .models import AudibleAccount, Book, LibraryEntry, Listener

# Chapters shorter than this (credits, “This is Audible”) are folded into their neighbour.
MIN_CHAPTER_MS = 20_000


def slug(text: str, limit: int = 60) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:limit] or "book"


# What Audible reports per library rather than per book; these live on LibraryEntry.
ENTRY_FIELDS = ("purchase_date", "percent_complete", "is_finished")


def book_dir(book: Book) -> Path:
    if book.source_file:  # the download account can change later; the files stay where they were put
        return audio.media_path(book.source_file).parent
    return audio.media_path(f"audible/{book.account_id}/{book.asin}-{slug(book.title, 40)}")


def my_account_id(user) -> int | None:
    """The Audible account whose positions this login sees: the one they picked, else the first connected one."""
    if user is not None and user.is_authenticated:
        picked = Listener.objects.filter(user=user).values_list("account_id", flat=True).first()
        if picked:
            return picked
    accounts = AudibleAccount.objects.order_by("name", "pk")
    connected = accounts.exclude(encrypted_auth="").values_list("pk", flat=True).first()
    return connected or accounts.values_list("pk", flat=True).first()


def entry_for(book: Book, user) -> LibraryEntry | None:
    """The library copy whose listening state this login sees: their own account's, else another's."""
    entries = list(book.entries.select_related("account"))
    mine = my_account_id(user)
    return next((e for e in entries if e.account_id == mine), None) or next(iter(entries), None)


def download_account(book: Book) -> AudibleAccount | None:
    """A signed-in account that has this book: the usual one if it's connected, else any other."""
    if book.account.connected:
        return book.account
    return next((e.account for e in book.entries.select_related("account") if e.account.connected), None)


def remove_account(account: AudibleAccount) -> None:
    """Forget an account. Books someone else also has stay, downloaded through them from now on."""
    for book in Book.objects.filter(account=account):
        other = book.entries.exclude(account=account).values_list("account_id", flat=True).first()
        if other:
            book.account_id = other
            book.save(update_fields=["account", "updated_at"])
        elif book.status != Book.Status.REMOTE:
            delete_audio(book)
    account.delete()


@transaction.atomic
def sync_library(account: AudibleAccount) -> dict:
    items = client.fetch_library(account)
    seen = set()
    created = 0
    for item in items:
        asin = item.get("asin")
        if not asin:
            continue
        seen.add(asin)
        fields = client.book_fields(item)
        listening = {k: fields.pop(k) for k in ENTRY_FIELDS}
        # Family sharing puts the same book in both libraries; it's one book with an entry in each.
        book, was_created = Book.objects.update_or_create(
            asin=asin, defaults=fields, create_defaults={**fields, "account": account}
        )
        LibraryEntry.objects.update_or_create(account=account, book=book, defaults=listening)
        created += was_created
    removed = 0
    if seen:
        # Titles that left this library (returns, expired Plus titles) leave it, unless we've already converted them.
        gone = account.entries.exclude(book__asin__in=seen).filter(book__status=Book.Status.REMOTE)
        gone_ids = list(gone.values_list("book_id", flat=True))
        gone.delete()
        orphans = Book.objects.filter(pk__in=gone_ids, entries__isnull=True)
        removed = orphans.count()
        orphans.delete()
        for book in Book.objects.filter(pk__in=gone_ids, account=account):
            book.account_id = book.entries.values_list("account_id", flat=True).first()
            book.save(update_fields=["account", "updated_at"])
    account.last_synced_at = timezone.now()
    account.last_error = ""
    account.save(update_fields=["last_synced_at", "last_error", "updated_at"])
    return {"total": len(seen), "created": created, "removed": removed}


def sync_positions(account: AudibleAccount, books: list[Book] | None = None) -> int:
    """Fetch this account's own listening positions, for its copies of ``books`` (default: its whole library)."""
    entries = account.entries.select_related("book")
    if books is not None:
        entries = entries.filter(book__in=books)
    entries = list(entries)
    positions = client.fetch_positions(account, [e.book.asin for e in entries])
    now = timezone.now()
    # Every book asked about was checked, even when Audible has no position for it (never played
    # there); those keep the position they had.
    for entry in entries:
        if entry.book.asin in positions:
            entry.position_ms = positions[entry.book.asin][0]
            entry.farthest_ms = max(entry.farthest_ms, entry.position_ms)
        entry.position_synced_at = now
        entry.updated_at = now
    LibraryEntry.objects.bulk_update(
        entries, ["position_ms", "farthest_ms", "position_synced_at", "updated_at"], batch_size=500
    )
    return len(positions)


def download_source(book: Book, on_progress=None) -> Path:
    """Fetch the encrypted AAXC (or DRM-free MP3) and remember its key and chapters."""
    account = download_account(book)
    if account is None:
        raise client.AudibleError(f"{book.account.name}'s Audible account needs signing in again.")
    lic = client.license_request(account, book.asin)
    folder = book_dir(book)
    folder.mkdir(parents=True, exist_ok=True)
    ext = ".mp3" if lic["format"] == "mpeg" else ".aaxc"
    dest = folder / f"source{ext}"
    tmp = dest.with_suffix(ext + ".part")
    with httpx.Client(follow_redirects=True, timeout=120, headers={"User-Agent": client.DOWNLOAD_USER_AGENT}) as http:
        with http.stream("GET", lic["url"]) as response:
            response.raise_for_status()
            if response.headers.get("content-type", "").startswith("text/html"):
                raise client.AudibleError("Audible returned an error page instead of audio; try again later.")
            total = int(response.headers.get("content-length") or 0)
            received = 0
            with tmp.open("wb") as fh:
                for chunk in response.iter_bytes(1024 * 1024):
                    fh.write(chunk)
                    received += len(chunk)
                    if on_progress and total:
                        on_progress(received / total)
    tmp.replace(dest)
    book.source_file = audio.relative_media(dest)
    book.encrypted_drm = encrypt_json(lic["drm"]) if lic["drm"] else ""
    book.chapters = lic["chapters"]
    if lic["position_ms"]:
        LibraryEntry.objects.filter(account=account, book=book).update(
            position_ms=lic["position_ms"],
            farthest_ms=Greatest("farthest_ms", Value(lic["position_ms"])),
            position_synced_at=timezone.now(),
        )
    book.account = account
    book.status = Book.Status.DOWNLOADED
    book.save()
    return dest


def decrypt_to_m4b(book: Book, on_progress=None) -> Path:
    """Strip the DRM without re-encoding; the m4b keeps Audible's embedded chapter marks."""
    src = audio.media_path(book.source_file)
    if src.suffix == ".mp3":
        return src
    drm = decrypt_json(book.encrypted_drm)
    if drm.get("key"):
        pre = ["-audible_key", drm["key"], "-audible_iv", drm["iv"]]
    elif drm.get("activation_bytes"):
        pre = ["-activation_bytes", drm["activation_bytes"]]
    else:
        raise client.AudibleError("No decryption key stored for this book; download it again.")
    dest = src.with_name("book.m4b")
    audio.run_ffmpeg(
        [*pre, "-i", str(src), "-map", "0:a", "-c", "copy", str(dest)],
        duration_ms=book.runtime_min * 60_000,
        on_progress=on_progress,
    )
    return dest


def chapter_plan(book: Book, probe: audio.Probe) -> list[dict]:
    """Chapter boundaries from the file itself, else Audible's list, else one track per ~30 minutes."""
    chapters = [{"title": c["title"], "start_ms": c["start_ms"]} for c in probe.chapters] or list(book.chapters)
    if not chapters:
        step = 30 * 60_000
        chapters = [{"title": f"Part {n + 1}", "start_ms": s} for n, s in enumerate(range(0, probe.duration_ms, step))]
    chapters.sort(key=lambda c: c["start_ms"])
    plan = []
    for n, c in enumerate(chapters):
        end = chapters[n + 1]["start_ms"] if n + 1 < len(chapters) else probe.duration_ms
        plan.append({"title": c["title"], "start_ms": c["start_ms"], "end_ms": end})
    merged: list[dict] = []
    for c in plan:
        if merged and c["end_ms"] - c["start_ms"] < MIN_CHAPTER_MS:
            merged[-1]["end_ms"] = c["end_ms"]
        elif merged and merged[-1]["end_ms"] - merged[-1]["start_ms"] < MIN_CHAPTER_MS:
            merged[-1]["end_ms"] = c["end_ms"]
            merged[-1]["title"] = c["title"]
        else:
            merged.append(dict(c))
    return [c for c in merged if c["end_ms"] > c["start_ms"]]


def convert_to_mp3(book: Book, kbps: int, mono: bool, on_progress=None) -> list[Track]:
    """Decrypt, then cut one MP3 per chapter. Replaces any tracks from an earlier conversion."""
    report = on_progress or (lambda f: None)
    m4b = decrypt_to_m4b(book, on_progress=lambda f: report(f * 0.15))
    probe = audio.ffprobe(m4b)
    plan = chapter_plan(book, probe)
    folder = book_dir(book) / "mp3"
    shutil.rmtree(folder, ignore_errors=True)
    for old in book.tracks.all():
        if old.optimized_file:
            audio.media_path(old.optimized_file).unlink(missing_ok=True)
    book.tracks.all().delete()
    tracks = []
    total = plan[-1]["end_ms"] if plan else 1
    for n, chapter in enumerate(plan):
        dest = folder / f"{n + 1:03d}-{slug(chapter['title'], 50)}.mp3"
        length = chapter["end_ms"] - chapter["start_ms"]

        def chapter_progress(f, start=chapter["start_ms"], length=length):
            report(0.15 + 0.85 * (start + f * length) / total)

        audio.transcode_mp3(
            m4b,
            dest,
            kbps=kbps,
            mono=mono,
            title=chapter["title"],
            start_ms=chapter["start_ms"],
            end_ms=chapter["end_ms"],
            on_progress=chapter_progress,
        )
        tracks.append(
            Track.objects.create(
                source=Track.Source.BOOK,
                book=book,
                title=chapter["title"][:500],
                position=n,
                start_ms=chapter["start_ms"],
                duration_ms=length,
                file=audio.relative_media(dest),
                size_bytes=dest.stat().st_size,
                bitrate_kbps=kbps,
                channels=1 if mono else 2,
            )
        )
    if m4b.name == "book.m4b":
        # Keep the decrypted master so a re-convert at another bitrate skips the download; drop the AAXC.
        audio.media_path(book.source_file).unlink(missing_ok=True)
        book.source_file = audio.relative_media(m4b)
        book.encrypted_drm = ""
    book.convert_kbps, book.convert_mono = kbps, mono
    book.status = Book.Status.READY
    book.save()
    return tracks


def delete_audio(book: Book) -> None:
    for track in book.tracks.all():
        if track.optimized_file:
            audio.media_path(track.optimized_file).unlink(missing_ok=True)
    book.tracks.all().delete()
    shutil.rmtree(book_dir(book), ignore_errors=True)
    book.source_file = ""
    book.encrypted_drm = ""
    book.status = Book.Status.REMOTE
    book.save()
