import re
from pathlib import Path

from django.db import transaction
from django.utils import timezone

from core import audio
from core.models import Track

from .feeds import fetch_feed, http, resolve_feed_url
from .models import Episode, Podcast


def slug(text: str, limit: int = 60) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:limit] or "audio"


def subscribe(url: str) -> Podcast:
    feed_url, apple_url = resolve_feed_url(url)
    podcast = Podcast.objects.filter(feed_url=feed_url).first()
    if podcast is None:
        podcast = Podcast(feed_url=feed_url, apple_url=apple_url, title="…")
    elif apple_url and not podcast.apple_url:
        podcast.apple_url = apple_url
    refresh(podcast)
    return podcast


@transaction.atomic
def refresh(podcast: Podcast) -> int:
    """Update podcast details and add new episodes. Returns how many episodes were new."""
    data = fetch_feed(podcast.feed_url)
    for field in ("title", "author", "description", "image_url", "link"):
        setattr(podcast, field, data[field] or getattr(podcast, field))
    podcast.last_refreshed_at = timezone.now()
    podcast.save()
    existing = {e.guid: e for e in podcast.episodes.all()}
    new = 0
    for item in data["episodes"]:
        episode = existing.get(item["guid"])
        if episode is None:
            Episode.objects.create(podcast=podcast, **item)
            new += 1
        else:
            changed = False
            for key in ("title", "description", "published_at", "audio_url", "image_url", "season", "number"):
                if getattr(episode, key) != item[key] and item[key] is not None:
                    setattr(episode, key, item[key])
                    changed = True
            if item["duration_ms"] and not episode.duration_ms:
                episode.duration_ms = item["duration_ms"]
                changed = True
            if changed:
                episode.save()
    return new


def episode_path(episode: Episode, extension: str) -> Path:
    date = episode.published_at.strftime("%Y-%m-%d") if episode.published_at else "undated"
    name = f"{date}-{episode.pk}-{slug(episode.title)}{extension}"
    return audio.media_path(f"podcasts/{episode.podcast_id}-{slug(episode.podcast.title, 40)}/{name}")


def download_episode(episode: Episode, on_progress=None) -> Track:
    extension = Path(episode.audio_url.split("?")[0]).suffix.lower()
    if extension not in audio.AUDIO_EXTENSIONS:
        extension = ".mp3"
    dest = episode_path(episode, extension)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    episode.status = Episode.Status.DOWNLOADING
    episode.save(update_fields=["status"])
    try:
        with http() as client, client.stream("GET", episode.audio_url, timeout=120) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length") or episode.enclosure_bytes or 0)
            received = 0
            with tmp.open("wb") as fh:
                for chunk in response.iter_bytes(1024 * 256):
                    fh.write(chunk)
                    received += len(chunk)
                    if on_progress and total:
                        on_progress(received / total)
        tmp.replace(dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        episode.status = Episode.Status.FAILED
        episode.save(update_fields=["status"])
        raise
    probe = audio.ffprobe(dest)
    track, _ = Track.objects.update_or_create(
        episode=episode,
        defaults={
            "source": Track.Source.EPISODE,
            "title": episode.title,
            "file": audio.relative_media(dest),
            "duration_ms": probe.duration_ms,
            "size_bytes": probe.size_bytes,
            "bitrate_kbps": probe.bitrate_kbps,
            "channels": probe.channels,
        },
    )
    episode.status = Episode.Status.READY
    if probe.duration_ms:
        episode.duration_ms = probe.duration_ms
    episode.save(update_fields=["status", "duration_ms"])
    return track
