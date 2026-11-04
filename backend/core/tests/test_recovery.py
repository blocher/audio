import os
import time
from datetime import timedelta

import pytest
import redis
from celery import Celery
from celery.exceptions import Ignore
from django.utils import timezone

from core.jobs import running
from core.models import Job
from core.recovery import requeue_interrupted

REDIS_URL = os.getenv("REDIS_TEST_URL", "redis://127.0.0.1:6390/15")


def test_running_skips_finished_or_cancelled_jobs(db):
    for status in (Job.Status.CANCELLED, Job.Status.SUCCEEDED, Job.Status.FAILED):
        job = Job.objects.create(kind="x", title="x", status=status)
        with pytest.raises(Ignore), running(job.pk):
            pytest.fail("body should not run")


def test_running_reports_when_a_job_resumes(db):
    fresh = Job.objects.create(kind="x", title="x")
    with running(fresh.pk) as handle:
        assert handle.resumed_from is None

    first_start = timezone.now() - timedelta(minutes=20)
    resumed = Job.objects.create(kind="x", title="x", status=Job.Status.QUEUED, started_at=first_start)
    with running(resumed.pk) as handle:
        assert handle.resumed_from == first_start
    resumed.refresh_from_db()
    assert resumed.started_at == first_start and resumed.status == Job.Status.SUCCEEDED


@pytest.fixture
def broker():
    client = redis.Redis.from_url(REDIS_URL)
    try:
        client.ping()
    except redis.ConnectionError:
        pytest.skip(f"no Redis at {REDIS_URL}")
    client.flushdb()
    app = Celery("recovery-test", broker=REDIS_URL)
    yield app, client
    client.flushdb()


def deliver_and_die(app, task_id: str) -> None:
    """Hand a task to a 'worker' that is then killed before acknowledging it."""
    app.send_task("demo.task", args=[1], task_id=task_id)
    with app.connection_for_write() as conn:
        channel = conn.channel()
        assert channel.basic_get("celery", no_ack=False) is not None
        channel.qos.restore_at_shutdown = False  # SIGKILL: nothing gets put back on the way out
        channel.close()


def test_restart_requeues_orphaned_jobs(db, broker):
    app, client = broker
    earlier = timezone.now() - timedelta(minutes=5)
    orphan = Job.objects.create(kind="x", title="x", status="running", started_at=earlier, celery_id="orphan")
    lost = Job.objects.create(kind="x", title="x", status="running", started_at=earlier, celery_id="gone")
    deliver_and_die(app, "orphan")
    assert client.llen("celery") == 0 and client.hlen("unacked") == 1

    booted_at = time.time()
    current = Job.objects.create(kind="x", title="x", status="running", started_at=timezone.now(), celery_id="new")
    deliver_and_die(app, "new")  # delivered to the new process: not ours to touch

    assert requeue_interrupted(app, booted_at) == ["orphan"]
    assert client.llen("celery") == 1 and client.hlen("unacked") == 1

    orphan.refresh_from_db()
    lost.refresh_from_db()
    current.refresh_from_db()
    assert orphan.status == Job.Status.QUEUED and orphan.started_at == earlier
    assert lost.status == Job.Status.FAILED and lost.message == "Interrupted by a restart"
    assert current.status == Job.Status.RUNNING
