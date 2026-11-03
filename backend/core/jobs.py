"""Create, run and report on background jobs.

A view calls ``enqueue(kind, title, task, *args, target=obj)``; the Celery task receives the job id as its first
argument and wraps its work in ``with running(job_id) as job:``, calling ``job.step(progress, message)`` as it goes.
"""

import logging
import time
import traceback
from contextlib import contextmanager

from django.db import models
from django.utils import timezone

from .models import Job

log = logging.getLogger(__name__)


class JobCancelled(Exception):
    pass


def enqueue(kind: str, title: str, task, *args, target: models.Model | None = None, **kwargs) -> Job:
    job = Job.objects.create(
        kind=kind,
        title=title[:300],
        target_type=target._meta.model_name if target is not None else "",
        target_id=target.pk if target is not None else None,
    )
    result = task.delay(job.pk, *args, **kwargs)
    Job.objects.filter(pk=job.pk).update(celery_id=result.id or "")
    job.celery_id = result.id or ""
    return job


def active_job(target: models.Model, kind: str | None = None) -> Job | None:
    qs = Job.objects.filter(
        target_type=target._meta.model_name,
        target_id=target.pk,
        status__in=[Job.Status.QUEUED, Job.Status.RUNNING],
    )
    if kind:
        qs = qs.filter(kind=kind)
    return qs.first()


class JobHandle:
    def __init__(self, job: Job):
        self.job = job
        self._last_write = 0.0

    def step(self, progress: float | None = None, message: str | None = None, force: bool = False) -> None:
        """Record progress (0–1). Writes are throttled to one per second unless forced."""
        if progress is not None:
            self.job.progress = max(0.0, min(1.0, progress))
        if message is not None:
            self.job.message = message[:500]
        now = time.monotonic()
        if force or now - self._last_write > 1.0:
            self._last_write = now
            Job.objects.filter(pk=self.job.pk).update(progress=self.job.progress, message=self.job.message)
            status = Job.objects.filter(pk=self.job.pk).values_list("status", flat=True).first()
            if status == Job.Status.CANCELLED:
                raise JobCancelled()


@contextmanager
def running(job_id: int):
    job = Job.objects.get(pk=job_id)
    if job.status == Job.Status.CANCELLED:
        return
    job.status = Job.Status.RUNNING
    job.started_at = timezone.now()
    job.save(update_fields=["status", "started_at", "updated_at"])
    handle = JobHandle(job)
    try:
        yield handle
    except JobCancelled:
        Job.objects.filter(pk=job.pk).update(finished_at=timezone.now(), message="Cancelled")
        return
    except Exception as exc:
        log.exception("Job %s failed", job.pk)
        Job.objects.filter(pk=job.pk).update(
            status=Job.Status.FAILED,
            error=f"{exc}\n\n{traceback.format_exc()}"[-8000:],
            message=str(exc)[:500],
            finished_at=timezone.now(),
        )
        raise
    Job.objects.filter(pk=job.pk).update(
        status=Job.Status.SUCCEEDED,
        progress=1.0,
        message=handle.job.message or "Done",
        finished_at=timezone.now(),
    )
