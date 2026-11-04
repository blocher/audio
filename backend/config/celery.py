import os
import time

from celery import Celery
from celery.signals import worker_ready

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

# Messages delivered before this moment belong to a worker process that no longer exists.
BOOTED_AT = time.time()

app = Celery("audio")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()


@worker_ready.connect
def resume_interrupted_jobs(**kwargs):
    from core.recovery import requeue_interrupted

    requeue_interrupted(app, BOOTED_AT)
