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

    # A book is stored once even when family sharing puts it in several libraries; each library's copy is a
    # LibraryEntry. ``account`` is the one used to download it, and is always one of the libraries it's in.
    account = models.ForeignKey(AudibleAccount, on_delete=models.CASCADE, related_name="books")
    asin = models.CharField(max_length=20, unique=True)
    title = models.CharField(max_length=500)
    subtitle = models.CharField(max_length=500, blank=True)
    authors = models.CharField(max_length=500, blank=True)
    narrators = models.CharField(max_length=500, blank=True)
    series = models.CharField(max_length=300, blank=True)
    series_position = models.CharField(max_length=20, blank=True)
    # Every series Audible lists, in its order: [{"title": ..., "position": ...}]. `series` is the first.
    series_list = models.JSONField(default=list, blank=True)
    summary = models.TextField(blank=True)
    cover_url = models.URLField(max_length=500, blank=True)
    runtime_min = models.PositiveIntegerField(default=0)
    release_date = models.DateField(null=True, blank=True)
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

    def __str__(self) -> str:
        return self.title


class LibraryEntry(TimeStamped):
    """A book in one account's library, with that person's own listening state from Audible."""

    account = models.ForeignKey(AudibleAccount, on_delete=models.CASCADE, related_name="entries")
    book = models.ForeignKey(Book, on_delete=models.CASCADE, related_name="entries")
    purchase_date = models.DateTimeField(null=True, blank=True)
    percent_complete = models.FloatField(default=0)
    position_ms = models.BigIntegerField(default=0, help_text="Last listening position reported by Audible")
    farthest_ms = models.BigIntegerField(default=0, help_text="Farthest position ever seen, even after rewinding")
    position_synced_at = models.DateTimeField(null=True, blank=True)
    is_finished = models.BooleanField(default=False)

    class Meta:
        ordering = ["account__name"]
        constraints = [models.UniqueConstraint(fields=["account", "book"], name="one_entry_per_library")]


class Listener(TimeStamped):
    """Which Audible account is this login's own. Its listening positions are the ones they see."""

    user = models.OneToOneField("auth.User", on_delete=models.CASCADE, related_name="audible_listener")
    account = models.ForeignKey(AudibleAccount, on_delete=models.CASCADE, related_name="listeners")
