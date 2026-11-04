"""Resume jobs that a worker restart cut off.

Every deploy restarts the worker, and systemd kills whatever it is still running after ``TimeoutStopSec``. Tasks are
acknowledged late, so a killed task's message stays in Redis's ``unacked`` hash, but kombu only hands it back after
the visibility timeout. That timeout is longer than the task time limit, so a long job is never handed out twice
while it is still running; the cost is that an orphaned job would sit for hours.

So when the worker starts, it puts back on the queue every message that was delivered before this process booted.
Production runs a single worker, so those messages belonged to the process that was just killed. Running jobs whose
message has gone are marked failed rather than left "running" forever.
"""

import json
import logging

from django.utils import timezone

from .models import Job

log = logging.getLogger(__name__)


def requeue_interrupted(app, booted_at: float) -> list[str]:
    """Restore unacked messages delivered before ``booted_at`` (a ``time.time()``). Returns their task ids."""
    restored = []
    with app.connection_for_write() as conn:
        channel = conn.default_channel
        client = channel.client
        stale = client.zrangebyscore(channel.unacked_index_key, 0, booted_at)
        for tag in stale:
            raw = client.hget(channel.unacked_key, tag)
            if raw is None:
                continue
            task_id = (json.loads(raw)[0].get("headers") or {}).get("id")
            # kombu publishes with LPUSH and consumes from the right, so the right end is the front of the queue.
            channel.qos.restore_by_tag(tag, leftmost=False)
            if task_id:
                restored.append(task_id)

    if restored:
        Job.objects.filter(celery_id__in=restored, status=Job.Status.RUNNING).update(
            status=Job.Status.QUEUED, message="Interrupted by a restart; resuming"
        )
        log.warning("Requeued %d task(s) interrupted by a worker restart", len(restored))

    lost = Job.objects.filter(status=Job.Status.RUNNING, started_at__lt=_as_datetime(booted_at)).exclude(
        celery_id__in=restored
    )
    for job in lost:
        log.warning("Job %s was interrupted by a restart and its task message is gone", job.pk)
    lost.update(
        status=Job.Status.FAILED,
        message="Interrupted by a restart",
        error="The worker restarted while this job was running and its task could not be resumed.",
        finished_at=timezone.now(),
    )
    return restored


def _as_datetime(ts: float):
    from datetime import UTC, datetime

    return datetime.fromtimestamp(ts, tz=UTC)
