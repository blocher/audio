from pathlib import Path

from celery import shared_task

from . import audio
from .jobs import running
from .models import Track


def optimized_path(track: Track, kbps: int, mono: bool) -> Path:
    original = Path(track.file)
    suffix = f".{kbps}k{'m' if mono else 's'}.mp3"
    return audio.media_path(str(Path("optimized") / original.parent / (original.stem + suffix)))


def optimize_track(track: Track, kbps: int, mono: bool, on_progress=None) -> None:
    src = audio.media_path(track.file)
    dest = optimized_path(track, kbps, mono)
    audio.transcode_mp3(src, dest, kbps=kbps, mono=mono, title=track.title, on_progress=on_progress)
    old = track.optimized_file
    track.optimized_file = audio.relative_media(dest)
    track.optimized_size_bytes = dest.stat().st_size
    track.optimized_bitrate_kbps = kbps
    track.optimized_mono = mono
    track.save(
        update_fields=[
            "optimized_file",
            "optimized_size_bytes",
            "optimized_bitrate_kbps",
            "optimized_mono",
            "updated_at",
        ]
    )
    if old and old != track.optimized_file:
        audio.media_path(old).unlink(missing_ok=True)


@shared_task
def optimize_tracks_task(job_id: int, track_ids: list[int], kbps: int, mono: bool):
    with running(job_id) as job:
        tracks = list(Track.objects.filter(pk__in=track_ids).exclude(file=""))
        total_ms = sum(t.duration_ms for t in tracks) or 1
        done_ms = 0
        saved = 0
        for n, track in enumerate(tracks, start=1):
            before = track.size_bytes
            job.step(done_ms / total_ms, f"Downsizing {n}/{len(tracks)}: {track.title}", force=True)

            def report(fraction, base=done_ms, length=track.duration_ms):
                job.step((base + fraction * length) / total_ms)

            optimize_track(track, kbps, mono, on_progress=report)
            saved += max(0, before - track.optimized_size_bytes)
            done_ms += track.duration_ms
        job.step(1.0, f"Downsized {len(tracks)} track(s), saved {saved / 1024 / 1024:.0f} MB", force=True)
