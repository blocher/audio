from datetime import datetime

from django.db.models import Count, Q, Sum
from django.shortcuts import get_object_or_404
from ninja import Field, Router, Schema
from ninja.errors import HttpError

from core.api import JobOut, TrackOut
from core.jobs import enqueue

from .feeds import FeedError, search_apple
from .models import Episode, Podcast
from .services import refresh, subscribe
from .tasks import download_episodes_task

router = Router(tags=["podcasts"])


class PodcastOut(Schema):
    id: int
    title: str
    author: str
    description: str
    image_url: str
    feed_url: str
    apple_url: str
    link: str
    last_refreshed_at: datetime | None
    episode_count: int = 0
    downloaded_count: int = 0
    downloaded_bytes: int = 0
    total_duration_ms: int = 0
    transcribed_count: int = 0


class EpisodeOut(Schema):
    id: int
    title: str
    description: str
    published_at: datetime | None
    audio_url: str
    image_url: str
    duration_ms: int
    enclosure_bytes: int
    season: int | None
    number: int | None
    status: str
    track: TrackOut | None = None

    @staticmethod
    def resolve_track(obj: Episode):
        return getattr(obj, "track", None)


class PodcastDetailOut(PodcastOut):
    episodes: list[EpisodeOut]

    @staticmethod
    def resolve_episodes(obj: Podcast):
        return list(obj.episodes.select_related("track", "track__transcript").order_by("-published_at", "-id"))


def annotated():
    return Podcast.objects.annotate(
        episode_count=Count("episodes", distinct=True),
        downloaded_count=Count("episodes", filter=Q(episodes__status=Episode.Status.READY), distinct=True),
        downloaded_bytes=Sum("episodes__track__size_bytes"),
        total_duration_ms=Sum("episodes__duration_ms"),
        transcribed_count=Count(
            "episodes", filter=Q(episodes__track__transcript__status="ready"), distinct=True
        ),
    )


@router.get("", response=list[PodcastOut])
def list_podcasts(request):
    rows = list(annotated())
    for row in rows:
        row.downloaded_bytes = row.downloaded_bytes or 0
        row.total_duration_ms = row.total_duration_ms or 0
    return rows


@router.get("/search")
def search(request, q: str):
    if len(q.strip()) < 2:
        return []
    return search_apple(q.strip())


class SubscribeIn(Schema):
    url: str


@router.post("", response=PodcastOut)
def add_podcast(request, payload: SubscribeIn):
    try:
        podcast = subscribe(payload.url)
    except FeedError as exc:
        raise HttpError(400, str(exc)) from exc
    except Exception as exc:
        raise HttpError(502, f"Couldn't read that feed: {exc}") from exc
    return _one(podcast.pk)


def _one(pk: int) -> Podcast:
    podcast = get_object_or_404(annotated(), pk=pk)
    podcast.downloaded_bytes = podcast.downloaded_bytes or 0
    podcast.total_duration_ms = podcast.total_duration_ms or 0
    return podcast


@router.get("/{podcast_id}", response=PodcastDetailOut)
def get_podcast(request, podcast_id: int):
    return _one(podcast_id)


@router.post("/{podcast_id}/refresh", response=PodcastOut)
def refresh_podcast(request, podcast_id: int):
    podcast = get_object_or_404(Podcast, pk=podcast_id)
    try:
        refresh(podcast)
    except Exception as exc:
        raise HttpError(502, f"Couldn't refresh: {exc}") from exc
    return _one(podcast_id)


@router.delete("/{podcast_id}")
def delete_podcast(request, podcast_id: int):
    from core.audio import media_path

    podcast = get_object_or_404(Podcast, pk=podcast_id)
    for episode in podcast.episodes.select_related("track"):
        track = getattr(episode, "track", None)
        if track:
            for f in (track.file, track.optimized_file):
                if f:
                    media_path(f).unlink(missing_ok=True)
    podcast.delete()
    return {"ok": True}


class DownloadIn(Schema):
    episode_ids: list[int] = Field(default_factory=list, description="Empty = every episode not yet downloaded")
    kbps: int | None = Field(None, ge=16, le=320, description="Downsize after download")
    mono: bool = True


@router.post("/{podcast_id}/download", response=JobOut)
def download(request, podcast_id: int, payload: DownloadIn):
    podcast = get_object_or_404(Podcast, pk=podcast_id)
    qs = podcast.episodes.all()
    if payload.episode_ids:
        qs = qs.filter(pk__in=payload.episode_ids)
    else:
        qs = qs.exclude(status=Episode.Status.READY)
    ids = list(qs.values_list("pk", flat=True))
    if not ids:
        raise HttpError(400, "Nothing to download")
    return enqueue(
        "podcast_download",
        f"Download {len(ids)} episode(s) of {podcast.title}",
        download_episodes_task,
        ids,
        payload.kbps,
        payload.mono,
        target=podcast,
    )
