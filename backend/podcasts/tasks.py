from celery import shared_task

from core.jobs import running
from core.tasks import optimize_track

from .models import Episode, Podcast
from .services import download_episode, refresh


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
                track = download_episode(episode, on_progress=lambda f, b=base, s=share: job.step(b + f * s * 0.7))
                if kbps:
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
