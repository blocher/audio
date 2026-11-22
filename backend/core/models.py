from django.db import models


class TimeStamped(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class InHousehold(models.Model):
    """For models with a ``household`` field: rows made without one belong to the household being worked on."""

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if self.household_id is None:
            from .tenancy import current_household_id

            self.household_id = current_household_id()
        super().save(*args, **kwargs)


class Household(TimeStamped):
    """People who share one library: its Audible and Yoto accounts, podcasts, folders, cards and AI keys."""

    name = models.CharField(max_length=150)
    # Another household whose AI keys this one may use when it has none of its own (a super admin's gift).
    ai_keys_from = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="borrowers"
    )
    # Whether keys from the server's environment (OPENAI_API_KEY...) count as this household's. Only the first.
    uses_server_keys = models.BooleanField(default=False)

    class Meta:
        ordering = ["pk"]

    def __str__(self) -> str:
        return self.name


class Member(TimeStamped):
    """Which household a login belongs to, and how they like to use the app."""

    # What they use the app for ("yoto", "ask", "listen") and where their audio comes from ("audible", "podcasts",
    # "folders"). The wizard only sets up these, and the app shows these first. Empty means everything.
    FEATURES = ("yoto", "ask", "listen")
    SOURCES = ("audible", "podcasts", "folders")

    user = models.OneToOneField("auth.User", on_delete=models.CASCADE, related_name="member")
    household = models.ForeignKey(Household, on_delete=models.PROTECT, related_name="members")
    features = models.JSONField(default=list, blank=True)
    # Set when they finish (or skip) the welcome wizard; until then the app opens on it.
    onboarded_at = models.DateTimeField(null=True, blank=True)

    def __str__(self) -> str:
        return f"{self.user} in {self.household}"


class Invite(TimeStamped):
    """An emailed invitation to make a login. Accepting it creates the user (and a household, unless joining one)."""

    email = models.EmailField()
    name = models.CharField(max_length=150, blank=True)
    token = models.CharField(max_length=64, unique=True)
    invited_by = models.ForeignKey("auth.User", null=True, on_delete=models.SET_NULL, related_name="+")
    # Join this household; null gives them a library of their own.
    household = models.ForeignKey(Household, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    share_ai_keys = models.BooleanField(default=False, help_text="Let their new household use the inviter's AI keys")
    make_admin = models.BooleanField(default=False)
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    accepted_user = models.ForeignKey("auth.User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    emailed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]


class Credential(TimeStamped):
    """An encrypted secret blob for one integration (OpenAI keys, preferences, the Yoto app...).

    Most belong to a household; a few (the Yoto developer app) are the whole site's and have no household.
    """

    household = models.ForeignKey(Household, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    service = models.CharField(max_length=40)
    encrypted_payload = models.TextField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["household", "service"], name="one_credential_per_household"),
            models.UniqueConstraint(
                fields=["service"], condition=models.Q(household__isnull=True), name="one_site_credential"
            ),
        ]

    def __str__(self) -> str:
        return self.service


class Job(InHousehold, TimeStamped):
    """A background task the UI can watch: conversion, download, transcription, sync."""

    class Status(models.TextChoices):
        QUEUED = "queued"
        RUNNING = "running"
        SUCCEEDED = "succeeded"
        FAILED = "failed"
        CANCELLED = "cancelled"

    household = models.ForeignKey(Household, null=True, blank=True, on_delete=models.CASCADE, related_name="jobs")
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


class TrackQuerySet(models.QuerySet):
    def for_household(self, household_id: int | None):
        """Tracks from this household's books, podcasts and folders."""
        return self.filter(
            models.Q(book__household_id=household_id)
            | models.Q(episode__podcast__household_id=household_id)
            | models.Q(collection__household_id=household_id)
        )


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

    objects = TrackQuerySet.as_manager()

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
