from celery import shared_task

from core.jobs import running
from core.models import Track

from .services import transcribe_track


@shared_task
def transcribe_tracks_task(job_id: int, track_ids: list[int], provider: str | None = None, model: str | None = None):
    with running(job_id) as job:
        tracks = list(Track.objects.filter(pk__in=track_ids).exclude(file="").order_by("position", "id"))
        total = sum(t.duration_ms for t in tracks) or 1
        done = 0
        for n, track in enumerate(tracks, start=1):
            job.step(done / total, f"Transcribing {n}/{len(tracks)}: {track.title}", force=True)
            transcribe_track(
                track,
                provider,
                model,
                on_progress=lambda f, base=done, d=track.duration_ms: job.step((base + f * d) / total),
            )
            done += track.duration_ms
        job.step(1.0, f"Transcribed {len(tracks)} track(s)", force=True)
