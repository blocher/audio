from django.db import models

from core.models import TimeStamped


class Podcast(TimeStamped):
    feed_url = models.URLField(max_length=1000, unique=True)
    apple_url = models.URLField(max_length=1000, blank=True)
    title = models.CharField(max_length=500)
    author = models.CharField(max_length=300, blank=True)
    description = models.TextField(blank=True)
    image_url = models.URLField(max_length=1000, blank=True)
    link = models.URLField(max_length=1000, blank=True)
    last_refreshed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["title"]

    def __str__(self) -> str:
        return self.title


class Episode(TimeStamped):
    class Status(models.TextChoices):
        REMOTE = "remote"
        DOWNLOADING = "downloading"
        READY = "ready"
        FAILED = "failed"

    podcast = models.ForeignKey(Podcast, on_delete=models.CASCADE, related_name="episodes")
    guid = models.CharField(max_length=1000)
    title = models.CharField(max_length=500)
    description = models.TextField(blank=True)
    published_at = models.DateTimeField(null=True, blank=True)
    audio_url = models.URLField(max_length=2000)
    image_url = models.URLField(max_length=1000, blank=True)
    duration_ms = models.BigIntegerField(default=0)
    enclosure_bytes = models.BigIntegerField(default=0)
    season = models.PositiveIntegerField(null=True, blank=True)
    number = models.PositiveIntegerField(null=True, blank=True)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.REMOTE)
    listen_position_ms = models.BigIntegerField(default=0)

    class Meta:
        ordering = ["-published_at", "-id"]
        unique_together = [("podcast", "guid")]

    def __str__(self) -> str:
        return self.title
