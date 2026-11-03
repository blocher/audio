import re
import shutil
from pathlib import Path

import httpx
from django.db import transaction
from django.utils import timezone

from core import audio
from core.models import Track
from core.secrets import decrypt_json, encrypt_json

from . import client
from .models import AudibleAccount, Book

# Chapters shorter than this (credits, “This is Audible”) are folded into their neighbour.
MIN_CHAPTER_MS = 20_000


def slug(text: str, limit: int = 60) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:limit] or "book"


def book_dir(book: Book) -> Path:
    return audio.media_path(f"audible/{book.account_id}/{book.asin}-{slug(book.title, 40)}")


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
        _, was_created = Book.objects.update_or_create(account=account, asin=asin, defaults=fields)
        created += was_created
    # Titles that left the library (returns, expired Plus titles) go unless we've already converted them.
    removed, _ = account.books.exclude(asin__in=seen).filter(status=Book.Status.REMOTE).delete() if seen else (0, None)
    account.last_synced_at = timezone.now()
    account.last_error = ""
    account.save(update_fields=["last_synced_at", "last_error", "updated_at"])
    return {"total": len(seen), "created": created, "removed": removed}


def sync_positions(account: AudibleAccount, books: list[Book] | None = None) -> int:
    books = books if books is not None else list(account.books.all())
    positions = client.fetch_positions(account, [b.asin for b in books])
    now = timezone.now()
    for book in books:
        if book.asin in positions:
            book.position_ms = positions[book.asin][0]
            book.position_synced_at = now
            book.save(update_fields=["position_ms", "position_synced_at", "updated_at"])
    return len(positions)


def download_source(book: Book, on_progress=None) -> Path:
    """Fetch the encrypted AAXC (or DRM-free MP3) and remember its key and chapters."""
    lic = client.license_request(book.account, book.asin)
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
        book.position_ms = lic["position_ms"]
        book.position_synced_at = timezone.now()
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
