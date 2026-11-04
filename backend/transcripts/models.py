from django.db import models

from core.models import TimeStamped


class Transcript(TimeStamped):
    """Speech-to-text for one track. Segment times are relative to the track's own start."""

    class Status(models.TextChoices):
        QUEUED = "queued"
        RUNNING = "running"
        READY = "ready"
        FAILED = "failed"

    track = models.OneToOneField("core.Track", on_delete=models.CASCADE, related_name="transcript")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.QUEUED)
    provider = models.CharField(max_length=20, blank=True)
    model = models.CharField(max_length=80, blank=True)
    language = models.CharField(max_length=20, blank=True)
    text = models.TextField(blank=True)
    word_count = models.PositiveIntegerField(default=0)
    audio_seconds = models.PositiveIntegerField(default=0)
    error = models.TextField(blank=True)

    def __str__(self) -> str:
        return f"Transcript of {self.track}"


class Segment(models.Model):
    transcript = models.ForeignKey(Transcript, on_delete=models.CASCADE, related_name="segments")
    start_ms = models.BigIntegerField()
    end_ms = models.BigIntegerField()
    text = models.TextField()

    class Meta:
        ordering = ["start_ms"]
        indexes = [models.Index(fields=["transcript", "start_ms"])]


class Conversation(TimeStamped):
    """An “Ask about this book” thread. Answers only use the transcript up to ``position_ms``."""

    book = models.ForeignKey(
        "audible_books.Book", null=True, blank=True, on_delete=models.CASCADE, related_name="conversations"
    )
    episode = models.ForeignKey(
        "podcasts.Episode", null=True, blank=True, on_delete=models.CASCADE, related_name="conversations"
    )
    collection = models.ForeignKey(
        "local_audio.Collection", null=True, blank=True, on_delete=models.CASCADE, related_name="conversations"
    )
    title = models.CharField(max_length=300, blank=True)
    owner = models.ForeignKey("auth.User", null=True, on_delete=models.SET_NULL)

    class Meta:
        ordering = ["-updated_at"]


class Message(TimeStamped):
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="messages")
    role = models.CharField(max_length=10)  # "user" | "assistant"
    content = models.TextField()
    position_ms = models.BigIntegerField(default=0, help_text="Spoiler horizon used for this question")
    whole_work = models.BooleanField(default=False, help_text="Asked about the whole work, spoilers allowed")
    citations = models.JSONField(default=list, blank=True)
    provider = models.CharField(max_length=20, blank=True)
    model = models.CharField(max_length=80, blank=True)
    input_tokens = models.PositiveIntegerField(default=0)
    output_tokens = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["created_at", "id"]
