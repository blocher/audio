import mimetypes
import threading
import uuid
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from pathlib import Path

from django.db import connection, transaction
from django.utils import timezone

from core import audio, packing
from core.models import Track

from . import client
from .models import Playlist, PlaylistItem, Upload, YotoAccount

# How many of a card's tracks upload and transcode at once. Each thread sends one request at a time, so this also caps
# requests in flight to Yoto. A community uploader (yoto-up) uses 4 without reported trouble.
UPLOAD_THREADS = 4


def default_cover(track: Track) -> str:
    if track.book_id:
        return track.book.cover_url
    if track.episode_id:
        return track.episode.image_url or track.episode.podcast.image_url
    return ""


@transaction.atomic
def create_playlist(
    title: str,
    items: list[packing.Item] | list[int],
    account: YotoAccount | None = None,
    cover_url: str = "",
    batch: str = "",
    author: str = "",
) -> Playlist:
    playlist = Playlist.objects.create(
        title=title[:200], account=account, cover_url=cover_url, batch=batch, author=author[:200]
    )
    for n, item in enumerate(items):
        if isinstance(item, packing.Item):
            PlaylistItem.objects.create(
                playlist=playlist,
                track_id=item.track_id,
                position=n,
                start_ms=item.start_ms,
                end_ms=item.end_ms,
                title=item.title[:300] if item.custom_title else "",
            )
        else:
            PlaylistItem.objects.create(playlist=playlist, track_id=int(item), position=n)
    if not playlist.cover_url:
        first = playlist.items.select_related("track__book", "track__episode__podcast").first()
        if first:
            playlist.cover_url = default_cover(first.track)
            playlist.save(update_fields=["cover_url"])
    return playlist


def create_from_cards(
    cards: list[packing.Card], account: YotoAccount | None, cover_url: str = "", name: str = ""
) -> list[Playlist]:
    """One draft playlist per card. With a ``name`` the cards are titled "Name (3 of 24)" instead of by contents."""
    batch = uuid.uuid4().hex[:12]
    name = name.strip()

    def title(n: int, card: packing.Card) -> str:
        if not name:
            return card.title
        return name if len(cards) == 1 else f"{name} ({n} of {len(cards)})"

    return [
        create_playlist(title(n, card), card.items, account, cover_url, batch) for n, card in enumerate(cards, start=1)
    ]


def item_file(item: PlaylistItem, use_optimized: bool) -> Path:
    """The audio to upload for this item, cutting a slice for over-long tracks (cached on disk)."""
    track = item.track
    source = track.best_file if use_optimized else track.file
    path = audio.media_path(source)
    if item.start_ms is None and item.end_ms is None:
        return path
    start, end = item.start_ms or 0, item.end_ms or track.duration_ms
    dest = audio.media_path(f"yoto-slices/{track.pk}/{Path(source).stem}-{start}-{end}.mp3")
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix.lower() == ".mp3":
            audio.run_ffmpeg(
                [
                    "-ss",
                    f"{start / 1000:.3f}",
                    "-to",
                    f"{end / 1000:.3f}",
                    "-i",
                    str(path),
                    "-map",
                    "0:a",
                    "-c",
                    "copy",
                    str(dest),
                ]
            )
        else:
            kbps = track.optimized_bitrate_kbps or 96
            audio.transcode_mp3(path, dest, kbps=kbps, mono=track.channels == 1, start_ms=start, end_ms=end)
    return dest


def _track_info(upload: Upload) -> dict:
    return {
        "trackUrl": upload.track_url,
        "duration": upload.duration,
        "fileSize": upload.file_size,
        "channels": upload.channels,
        "format": upload.format,
    }


def upload_item(api: client.Api, item: PlaylistItem, use_optimized: bool, on_progress=None) -> dict:
    path = item_file(item, use_optimized)
    sha = client.sha256(path)
    cached = Upload.objects.filter(sha256=sha).first()
    if cached:
        return _track_info(cached)
    result = api.upload_audio(path, on_progress=on_progress, sha=sha)
    info = result.get("transcodedInfo") or {}
    # get_or_create, because the same file can appear twice on a card and upload on two threads at once.
    upload, _ = Upload.objects.get_or_create(
        sha256=sha,
        defaults={
            "track_url": f"yoto:#{result['transcodedSha256']}",
            "duration": float(info.get("duration") or 0),
            "file_size": int(info.get("fileSize") or 0),
            "channels": str(info.get("channels") or ""),
            "format": str(info.get("format") or "aac"),
        },
    )
    return _track_info(upload)


class _Stopped(Exception):
    """Another track failed or the job was cancelled, so this track gives up at its next progress report."""


def upload_items(api: client.Api, items: list[PlaylistItem], use_optimized: bool, report) -> list[dict]:
    """Upload a card's tracks in parallel, returning each one's Yoto track info in item order.

    Yoto transcodes each file on its own servers, so the time goes into waiting. Running tracks side by side overlaps
    that wait. ``report`` is only called on this thread: job progress writes to the database and can raise
    JobCancelled, and either one stops the other tracks.
    """
    progress = [0.0] * len(items)
    results: list[dict | None] = [None] * len(items)
    stop = threading.Event()

    def work(n: int, item: PlaylistItem) -> dict:
        def on_progress(fraction: float) -> None:
            if stop.is_set():
                raise _Stopped()
            progress[n] = max(progress[n], fraction)

        try:
            return upload_item(api, item, use_optimized, on_progress=on_progress)
        finally:
            connection.close()  # each worker thread has its own database connection

    pool = ThreadPoolExecutor(max_workers=min(UPLOAD_THREADS, len(items)), thread_name_prefix="yoto-upload")
    futures = {pool.submit(work, n, item): n for n, item in enumerate(items)}
    pending = set(futures)
    try:
        while pending:
            done, pending = wait(pending, timeout=1, return_when=FIRST_EXCEPTION)
            for future in done:
                n = futures[future]
                results[n] = future.result()
                progress[n] = 1.0
            finished = sum(r is not None for r in results)
            report(sum(progress) / len(items) * 0.95, f"Uploading tracks: {finished} of {len(items)} done")
    except BaseException:
        stop.set()
        raise
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    return results


def _channels(value: str):
    return int(value) if value.isdigit() else (value or "stereo")


def build_content(playlist: Playlist, uploaded: list[tuple[PlaylistItem, dict]]) -> dict:
    """One chapter per track, so the player's skip buttons move between chapters/episodes."""
    icon = playlist.icon or client.DEFAULT_ICON
    chapters = []
    for n, (item, info) in enumerate(uploaded, start=1):
        key = f"{n:02d}"
        title = (item.title or item.track.title)[:200]
        item_icon = item.icon or icon
        chapters.append(
            {
                "key": key,
                "title": title,
                "overlayLabel": str(n),
                "display": {"icon16x16": item_icon},
                "tracks": [
                    {
                        "key": key,
                        "title": title,
                        "trackUrl": info["trackUrl"],
                        "type": "audio",
                        "format": info["format"],
                        "duration": info["duration"],
                        "fileSize": info["fileSize"],
                        "channels": _channels(info["channels"]),
                        "overlayLabel": str(n),
                        "display": {"icon16x16": item_icon},
                    }
                ],
            }
        )
    body = {
        "title": playlist.title[:140],
        "content": {"chapters": chapters, "playbackType": "linear", "config": {"resumeTimeout": 2592000}},
        "metadata": {
            "description": playlist.description[:1000],
            **({"author": playlist.author} if playlist.author else {}),
            "media": {
                "duration": sum(i["duration"] for _, i in uploaded),
                "fileSize": sum(i["fileSize"] for _, i in uploaded),
            },
            **({"cover": {"imageL": playlist.yoto_cover_url}} if playlist.yoto_cover_url else {}),
        },
    }
    if playlist.card_id:
        body["cardId"] = playlist.card_id
    return body


def upload_cover(api: client.Api, playlist: Playlist) -> None:
    if not playlist.cover_url or playlist.yoto_cover_url:
        return
    if playlist.cover_url.startswith(("http://", "https://")) and "/api/media/" not in playlist.cover_url:
        playlist.yoto_cover_url = api.upload_cover_from_url(playlist.cover_url)
    else:
        local = audio.media_path(playlist.cover_url.split("/api/media/")[-1])
        content_type = mimetypes.guess_type(local.name)[0] or "image/jpeg"
        playlist.yoto_cover_url = api.upload_cover(local.read_bytes(), content_type)
    playlist.save(update_fields=["yoto_cover_url"])


def sync_playlist(playlist: Playlist, on_progress=None) -> Playlist:
    report = on_progress or (lambda f, m=None: None)
    if playlist.account is None:
        playlist.account = YotoAccount.objects.exclude(encrypted_tokens="").first()
        if playlist.account is None:
            raise client.YotoError("Connect a Yoto account first.")
        playlist.save(update_fields=["account"])
    items = list(playlist.items.select_related("track").order_by("position", "id"))
    if not items:
        raise client.YotoError("This playlist has no tracks.")
    missing = [i.track.title for i in items if not i.track.file]
    if missing:
        raise client.YotoError(f"Download or convert these first: {', '.join(missing[:5])}")
    Playlist.objects.filter(pk=playlist.pk).update(status=Playlist.Status.SYNCING, last_error="")
    try:
        with client.Api(playlist.account) as api:
            try:
                upload_cover(api, playlist)
            except client.YotoError:
                pass  # a cover is nice to have; never fail the card over it
            infos = upload_items(api, items, playlist.use_optimized, report)
            for item, info in zip(items, infos, strict=True):
                item.yoto_track = info
                item.save(update_fields=["yoto_track"])
            uploaded = list(zip(items, infos, strict=True))
            report(0.97, "Saving card on Yoto")
            card = api.save_content(build_content(playlist, uploaded))
    except Exception as exc:
        Playlist.objects.filter(pk=playlist.pk).update(status=Playlist.Status.FAILED, last_error=str(exc)[:4000])
        raise
    playlist.card_id = card.get("cardId", playlist.card_id)
    playlist.status = Playlist.Status.SYNCED
    playlist.last_synced_at = timezone.now()
    playlist.last_error = ""
    playlist.save()
    return playlist


def remove_from_yoto(playlist: Playlist) -> Playlist:
    """Delete the card from the Yoto account and turn the playlist back into a draft.

    The uploaded audio and cover stay cached, so sending it again later doesn't re-upload anything.
    A card already deleted in the Yoto app counts as removed.
    """
    if playlist.card_id:
        if playlist.account is None or not playlist.account.connected:
            raise client.YotoError("This card's Yoto account isn't connected any more; reconnect it first.")
        with client.Api(playlist.account) as api:
            try:
                api.delete_content(playlist.card_id)
            except client.NotFound:
                pass
    playlist.card_id = ""
    playlist.status = Playlist.Status.DRAFT
    playlist.last_synced_at = None
    playlist.last_error = ""
    playlist.save()
    return playlist


def mark_changed(playlist: Playlist) -> None:
    if playlist.status == Playlist.Status.SYNCED:
        playlist.status = Playlist.Status.CHANGED
        playlist.save(update_fields=["status", "updated_at"])
