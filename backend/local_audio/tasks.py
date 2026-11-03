from pathlib import Path

from celery import shared_task

from core.jobs import running
from core.tasks import optimize_track

from .models import Collection
from .services import add_file, renumber, scan


@shared_task
def import_paths_task(job_id: int, collection_id: int, paths: list[str], kbps: int | None = None, mono: bool = True):
    with running(job_id) as job:
        collection = Collection.objects.get(pk=collection_id)
        files = scan([Path(p) for p in paths])
        if not files:
            raise RuntimeError("No audio files found in those folders")
        for n, (src, rel) in enumerate(files):
            job.step(n / len(files), f"Importing {n + 1}/{len(files)}: {rel}", force=True)
            track = add_file(collection, src, rel)
            if kbps:
                optimize_track(track, kbps, mono)
        renumber(collection)
        job.step(1.0, f"Imported {len(files)} file(s)", force=True)
