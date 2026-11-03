from celery import shared_task

from core.jobs import running

from .models import Playlist
from .services import sync_playlist


@shared_task
def sync_playlists_task(job_id: int, playlist_ids: list[int]):
    with running(job_id) as job:
        playlists = list(Playlist.objects.filter(pk__in=playlist_ids).select_related("account").order_by("id"))
        failures = []
        for n, playlist in enumerate(playlists):

            def report(fraction, message=None, n=n):
                prefix = f"Card {n + 1}/{len(playlists)} · " if len(playlists) > 1 else ""
                job.step((n + fraction) / len(playlists), f"{prefix}{message}" if message else None)

            try:
                sync_playlist(playlist, on_progress=report)
            except Exception as exc:
                failures.append(f"{playlist.title}: {exc}")
                if len(playlists) == 1:
                    raise
        if failures:
            raise RuntimeError(f"{len(failures)} of {len(playlists)} cards failed: " + "; ".join(failures)[:1500])
        job.step(1.0, f"Synced {len(playlists)} card(s) to Yoto", force=True)
