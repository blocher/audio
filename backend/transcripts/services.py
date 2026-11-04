from django.db import transaction

from core import audio
from core.models import Track

from . import stt
from .models import Segment, Transcript


def transcribe_track(
    track: Track, provider: str | None = None, model: str | None = None, on_progress=None
) -> Transcript:
    transcript, _ = Transcript.objects.get_or_create(track=track)
    transcript.status = Transcript.Status.RUNNING
    transcript.error = ""
    transcript.save(update_fields=["status", "error", "updated_at"])
    try:
        # Transcribe the smallest copy we have; speech models don't benefit from higher bitrates.
        provider, model, segments = stt.transcribe_file(
            audio.media_path(track.best_file), track.duration_ms, provider, model, on_progress
        )
    except Exception as exc:
        transcript.status = Transcript.Status.FAILED
        transcript.error = str(exc)[:4000]
        transcript.save(update_fields=["status", "error", "updated_at"])
        raise
    with transaction.atomic():
        transcript.segments.all().delete()
        Segment.objects.bulk_create(Segment(transcript=transcript, **s) for s in segments)
        transcript.text = "\n".join(s["text"] for s in segments)
        transcript.word_count = len(transcript.text.split())
        transcript.audio_seconds = track.duration_ms // 1000
        transcript.provider = provider
        transcript.model = model
        transcript.status = Transcript.Status.READY
        transcript.save()
    return transcript


def fmt_time(ms: int) -> str:
    seconds = max(0, ms) // 1000
    return f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def work_tracks(book_id=None, episode_id=None, collection_id=None):
    qs = Track.objects.all()
    if book_id:
        qs = qs.filter(book_id=book_id)
    elif episode_id:
        qs = qs.filter(episode_id=episode_id)
    elif collection_id:
        qs = qs.filter(collection_id=collection_id)
    else:
        return Track.objects.none()
    return qs.order_by("position", "id")


def work_offsets(tracks: list[Track]) -> dict[int, int]:
    """Where each track starts in the work's timeline. Book chapters already know; others are laid end to end."""
    offsets, cursor = {}, 0
    for t in tracks:
        offsets[t.pk] = t.start_ms if t.source == Track.Source.BOOK else cursor
        cursor = offsets[t.pk] + t.duration_ms
    return offsets


def timeline(tracks: list[Track], until_ms: int | None = None, q: str = "") -> list[dict]:
    """Every transcript segment of a work in listening order, in work time, optionally cut at ``until_ms``."""
    offsets = work_offsets(tracks)
    titles = {t.pk: t.title for t in tracks}
    segs = Segment.objects.filter(transcript__track__in=tracks, transcript__status=Transcript.Status.READY)
    if q:
        segs = segs.filter(text__icontains=q)
    rows = []
    for s in segs.select_related("transcript").order_by("transcript__track__position", "start_ms"):
        track_id = s.transcript.track_id
        start = offsets[track_id] + s.start_ms
        if until_ms is not None and start >= until_ms:
            continue
        rows.append(
            {
                "track_id": track_id,
                "track_title": titles[track_id],
                "start_ms": start,
                "end_ms": offsets[track_id] + s.end_ms,
                "track_start_ms": s.start_ms,
                "text": s.text,
            }
        )
    rows.sort(key=lambda r: r["start_ms"])
    return rows
