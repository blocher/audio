from celery import shared_task

from core import audio
from core.jobs import running
from core.models import Track
from core.tasks import optimize_track

from .models import Episode, Podcast
from .services import download_episode, refresh


def already_downloaded(episode: Episode, since) -> Track | None:
    """The episode's track, if an earlier run of this same job (cut off by a restart) already downloaded it."""
    if since is None or episode.status != Episode.Status.READY:
        return None
    track = Track.objects.filter(episode=episode).first()
    return track if track and track.updated_at >= since else None


def already_downsized(track: Track, kbps: int, mono: bool, since) -> bool:
    """Whether an earlier run of this same job already wrote the downsized copy."""
    if since is None or not track.optimized_file:
        return False
    if (track.optimized_bitrate_kbps, track.optimized_mono) != (kbps, mono):
        return False
    path = audio.media_path(track.optimized_file)
    return path.exists() and path.stat().st_mtime >= since.timestamp()


@shared_task
def download_episodes_task(job_id: int, episode_ids: list[int], kbps: int | None = None, mono: bool = True):
    """Download episodes oldest first; optionally downsize each as soon as it lands."""
    with running(job_id) as job:
        episodes = list(Episode.objects.filter(pk__in=episode_ids).select_related("podcast").order_by("published_at"))
        failures = []
        for n, episode in enumerate(episodes):
            base = n / len(episodes)
            share = 1 / len(episodes)
            job.step(base, f"Downloading {n + 1}/{len(episodes)}: {episode.title}", force=True)
            try:
                track = already_downloaded(episode, job.resumed_from)
                if track is None:
                    track = download_episode(episode, on_progress=lambda f, b=base, s=share: job.step(b + f * s * 0.7))
                if kbps and not already_downsized(track, kbps, mono, job.resumed_from):
                    job.step(base + share * 0.7, f"Downsizing {n + 1}/{len(episodes)}: {episode.title}")
                    optimize_track(
                        track, kbps, mono, on_progress=lambda f, b=base, s=share: job.step(b + s * (0.7 + 0.3 * f))
                    )
            except Exception as exc:  # keep going; one bad enclosure shouldn't sink a 300-episode backfill
                failures.append(f"{episode.title}: {exc}")
        if failures:
            job.step(
                1.0, f"Downloaded {len(episodes) - len(failures)}/{len(episodes)}; {len(failures)} failed", force=True
            )
            if len(failures) == len(episodes):
                raise RuntimeError("; ".join(failures)[:2000])
        else:
            job.step(1.0, f"Downloaded {len(episodes)} episode(s)", force=True)


@shared_task
def refresh_all_podcasts():
    for podcast in Podcast.objects.all():
        try:
            refresh(podcast)
        except Exception:  # noqa: BLE001 - a dead feed shouldn't stop the others
            continue
