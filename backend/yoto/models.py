from django.db import models

from core.models import TimeStamped


class YotoAccount(TimeStamped):
    name = models.CharField(max_length=100, default="Family")
    email = models.CharField(max_length=200, blank=True)
    encrypted_tokens = models.TextField(blank=True)
    # OAuth sign-in in flight: {"state", "created"}.
    pending_login = models.JSONField(default=dict, blank=True)
    last_error = models.TextField(blank=True)

    def __str__(self) -> str:
        return self.name

    @property
    def connected(self) -> bool:
        return bool(self.encrypted_tokens)


class Playlist(TimeStamped):
    """A Yoto Make-Your-Own card's contents, built here and synced to the Yoto account."""

    class Status(models.TextChoices):
        DRAFT = "draft"
        SYNCING = "syncing"
        SYNCED = "synced"
        CHANGED = "changed", "Changed since sync"
        FAILED = "failed"

    account = models.ForeignKey(
        YotoAccount, null=True, blank=True, on_delete=models.SET_NULL, related_name="playlists"
    )
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    author = models.CharField(max_length=200, blank=True)
    cover_url = models.URLField(max_length=1000, blank=True, help_text="Source image to upload as the card cover")
    yoto_cover_url = models.URLField(max_length=1000, blank=True)
    icon = models.CharField(max_length=200, blank=True, help_text="Default chapter icon, e.g. yoto:#abc…")
    card_id = models.CharField(max_length=40, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    use_optimized = models.BooleanField(default=True, help_text="Upload the downsized file when there is one")
    # A group of playlists produced together by the card packer.
    batch = models.CharField(max_length=40, blank=True)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self) -> str:
        return self.title


class PlaylistItem(models.Model):
    playlist = models.ForeignKey(Playlist, on_delete=models.CASCADE, related_name="items")
    track = models.ForeignKey("core.Track", on_delete=models.CASCADE, related_name="playlist_items")
    position = models.PositiveIntegerField(default=0)
    # A slice of the track, for tracks longer than Yoto's 60-minute limit. Null = whole track.
    start_ms = models.BigIntegerField(null=True, blank=True)
    end_ms = models.BigIntegerField(null=True, blank=True)
    title = models.CharField(max_length=300, blank=True, help_text="Override the track title on the card")
    # What Yoto returned for this item's audio at the last sync.
    yoto_track = models.JSONField(default=dict, blank=True)
    icon = models.CharField(max_length=200, blank=True, help_text="Yoto icon reference, e.g. yoto:#abc")

    class Meta:
        ordering = ["position", "id"]


class Upload(TimeStamped):
    """Cache of files already transcoded by Yoto, keyed by the local file's content hash."""

    sha256 = models.CharField(max_length=64, unique=True)
    track_url = models.CharField(max_length=200)
    duration = models.FloatField(default=0)
    file_size = models.BigIntegerField(default=0)
    channels = models.CharField(max_length=10, blank=True)
    format = models.CharField(max_length=10, blank=True)
