from django.db import models

from core.models import TimeStamped


class AudibleAccount(TimeStamped):
    """One person's Audible login, registered as a virtual device. Auth data is Fernet-encrypted."""

    name = models.CharField(max_length=100, help_text="Whose library this is, e.g. “Ben”")
    locale = models.CharField(max_length=8, default="us")
    email = models.CharField(max_length=200, blank=True)
    encrypted_auth = models.TextField(blank=True)
    # Login is two steps: we store the in-flight PKCE verifier and device serial between them.
    pending_login = models.TextField(blank=True)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name

    @property
    def connected(self) -> bool:
        return bool(self.encrypted_auth)


class Book(TimeStamped):
    class Status(models.TextChoices):
        REMOTE = "remote", "In library"
        DOWNLOADING = "downloading"
        DOWNLOADED = "downloaded", "Downloaded"
        CONVERTING = "converting"
        READY = "ready", "MP3 ready"
        FAILED = "failed"

    account = models.ForeignKey(AudibleAccount, on_delete=models.CASCADE, related_name="books")
    asin = models.CharField(max_length=20)
    title = models.CharField(max_length=500)
    subtitle = models.CharField(max_length=500, blank=True)
    authors = models.CharField(max_length=500, blank=True)
    narrators = models.CharField(max_length=500, blank=True)
    series = models.CharField(max_length=300, blank=True)
    series_position = models.CharField(max_length=20, blank=True)
    summary = models.TextField(blank=True)
    cover_url = models.URLField(max_length=500, blank=True)
    runtime_min = models.PositiveIntegerField(default=0)
    release_date = models.DateField(null=True, blank=True)
    purchase_date = models.DateTimeField(null=True, blank=True)
    percent_complete = models.FloatField(default=0)
    position_ms = models.BigIntegerField(default=0, help_text="Last listening position reported by Audible")
    position_synced_at = models.DateTimeField(null=True, blank=True)
    is_finished = models.BooleanField(default=False)
    content_type = models.CharField(max_length=40, blank=True)

    status = models.CharField(max_length=12, choices=Status.choices, default=Status.REMOTE)
    source_file = models.CharField(max_length=1000, blank=True, help_text="Encrypted AAX/AAXC, relative to MEDIA_ROOT")
    # For AAXC: {"key": "...", "iv": "..."}; for AAX: {"activation_bytes": "..."}. Encrypted.
    encrypted_drm = models.TextField(blank=True)
    chapters = models.JSONField(default=list, blank=True)
    convert_kbps = models.PositiveIntegerField(default=0)
    convert_mono = models.BooleanField(default=False)
    raw = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["title"]
        unique_together = [("account", "asin")]

    def __str__(self) -> str:
        return self.title
