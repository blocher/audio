from django.db import models

from core.models import TimeStamped


class Collection(TimeStamped):
    """A set of audio files imported from folders on a computer (uploaded, or read from disk in local dev)."""

    name = models.CharField(max_length=300)
    description = models.TextField(blank=True)
    source_paths = models.JSONField(default=list, blank=True)
    cover = models.CharField(max_length=1000, blank=True, help_text="Image path relative to MEDIA_ROOT")

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return self.name
