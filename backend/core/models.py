from django.db import models


class TimeStamped(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Credential(TimeStamped):
    """An encrypted secret blob for one integration (OpenAI, Anthropic, Yoto app settings...)."""

    service = models.CharField(max_length=40, unique=True)
    encrypted_payload = models.TextField()

    def __str__(self) -> str:
        return self.service


class Job(TimeStamped):
    """A background task the UI can watch: conversion, download, transcription, sync."""

    class Status(models.TextChoices):
        QUEUED = "queued"
        RUNNING = "running"
        SUCCEEDED = "succeeded"
        FAILED = "failed"
        CANCELLED = "cancelled"

    kind = models.CharField(max_length=40)
    title = models.CharField(max_length=300)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.QUEUED)
    progress = models.FloatField(default=0)
    message = models.CharField(max_length=500, blank=True)
    error = models.TextField(blank=True)
    celery_id = models.CharField(max_length=64, blank=True)
    # Loose pointer to what the job works on, e.g. ("book", 12); used to show a job next to its object.
    target_type = models.CharField(max_length=30, blank=True)
    target_id = models.BigIntegerField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["target_type", "target_id"])]

    def __str__(self) -> str:
        return f"{self.kind}: {self.title} ({self.status})"


class Track(TimeStamped):
    """One playable audio file — a book chapter, a podcast episode or a local file.

    Tracks are what get downsized, transcribed and put on Yoto cards, whatever their source.
    """

    class Source(models.TextChoices):
        BOOK = "book"
        EPISODE = "episode"
        LOCAL = "local"

    source = models.CharField(max_length=10, choices=Source.choices)
    book = models.ForeignKey(
        "audible_books.Book", null=True, blank=True, on_delete=models.CASCADE, related_name="tracks"
    )
    episode = models.OneToOneField(
        "podcasts.Episode", null=True, blank=True, on_delete=models.CASCADE, related_name="track"
    )
    collection = models.ForeignKey(
        "local_audio.Collection", null=True, blank=True, on_delete=models.CASCADE, related_name="tracks"
    )
    title = models.CharField(max_length=500)
    position = models.PositiveIntegerField(default=0)
    # Offset of this track within its parent work (books: chapter start), so transcripts line up with the book.
    start_ms = models.BigIntegerField(default=0)
    duration_ms = models.BigIntegerField(default=0)

    file = models.CharField(max_length=1000, blank=True, help_text="Path relative to MEDIA_ROOT")
    size_bytes = models.BigIntegerField(default=0)
    bitrate_kbps = models.PositiveIntegerField(default=0)
    channels = models.PositiveSmallIntegerField(default=0)

    optimized_file = models.CharField(max_length=1000, blank=True)
    optimized_size_bytes = models.BigIntegerField(default=0)
    optimized_bitrate_kbps = models.PositiveIntegerField(default=0)
    optimized_mono = models.BooleanField(default=False)

    class Meta:
        ordering = ["book_id", "collection_id", "position", "id"]

    def __str__(self) -> str:
        return self.title

    @property
    def best_file(self) -> str:
        return self.optimized_file or self.file

    @property
    def best_size_bytes(self) -> int:
        return self.optimized_size_bytes or self.size_bytes


class Star(TimeStamped):
    """Something one user has starred to keep it on their home page. Starring is personal; the library is shared."""

    class Kind(models.TextChoices):
        BOOK = "book"
        PODCAST = "podcast"
        FOLDER = "folder"

    user = models.ForeignKey("auth.User", on_delete=models.CASCADE, related_name="stars")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    book = models.ForeignKey("audible_books.Book", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    podcast = models.ForeignKey("podcasts.Podcast", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    folder = models.ForeignKey(
        "local_audio.Collection", null=True, blank=True, on_delete=models.CASCADE, related_name="+"
    )

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["user", "book"], name="one_star_per_book"),
            models.UniqueConstraint(fields=["user", "podcast"], name="one_star_per_podcast"),
            models.UniqueConstraint(fields=["user", "folder"], name="one_star_per_folder"),
        ]

    @property
    def target_id(self) -> int:
        return getattr(self, f"{self.kind}_id")
