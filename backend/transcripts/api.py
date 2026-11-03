import json
from datetime import datetime

from django.http import StreamingHttpResponse
from django.shortcuts import get_object_or_404
from ninja import Field, Router, Schema
from ninja.errors import HttpError

from core.api import JobOut, setting
from core.jobs import enqueue
from core.models import Track

from . import ask, stt
from .models import Conversation, Transcript
from .services import timeline, work_tracks
from .tasks import transcribe_tracks_task

router = Router(tags=["transcripts"])


class TranscribeIn(Schema):
    track_ids: list[int]
    force: bool = False


def _pending(track_ids: list[int], force: bool):
    qs = Track.objects.filter(pk__in=track_ids).exclude(file="")
    if not force:
        qs = qs.exclude(transcript__status=Transcript.Status.READY)
    return qs


@router.post("/estimate")
def estimate(request, payload: TranscribeIn):
    tracks = list(_pending(payload.track_ids, payload.force))
    model = setting("openai", "transcription_model") or "whisper-1"
    minutes = sum(t.duration_ms for t in tracks) / 60_000
    return {
        "tracks": len(tracks),
        "minutes": round(minutes),
        "model": model,
        "estimated_cost_usd": stt.estimate_cost(int(minutes * 60_000), model),
        "configured": bool(setting("openai", "api_key")),
    }


@router.post("/transcribe", response=JobOut)
def transcribe(request, payload: TranscribeIn):
    if not setting("openai", "api_key"):
        raise HttpError(400, "Add an OpenAI API key in Settings first")
    tracks = list(_pending(payload.track_ids, payload.force))
    if not tracks:
        raise HttpError(400, "Those tracks are already transcribed (or have no audio yet)")
    for t in tracks:
        Transcript.objects.update_or_create(track=t, defaults={"status": Transcript.Status.QUEUED})
    first = tracks[0]
    target = first.book or first.episode or first.collection
    return enqueue(
        "transcribe",
        f"Transcribe {len(tracks)} track(s)" + (f" of {target}" if target else ""),
        transcribe_tracks_task,
        [t.pk for t in tracks],
        target=target,
    )


class WorkQuery(Schema):
    book_id: int | None = None
    episode_id: int | None = None
    collection_id: int | None = None


@router.get("/work")
def work(
    request, book_id: int | None = None, episode_id: int | None = None, collection_id: int | None = None, q: str = ""
):
    """The transcript of a whole book, episode or folder, in listening order."""
    tracks = list(work_tracks(book_id, episode_id, collection_id).select_related("transcript"))
    if not tracks:
        raise HttpError(404, "Nothing to show yet; convert or download the audio first")
    rows = timeline(tracks, q=q.strip())
    statuses = {t.pk: getattr(getattr(t, "transcript", None), "status", None) for t in tracks}
    return {
        "tracks": [
            {
                "id": t.pk,
                "title": t.title,
                "duration_ms": t.duration_ms,
                "status": statuses[t.pk],
                "stream_url": f"/api/media/{t.best_file}" if t.best_file else None,
            }
            for t in tracks
        ],
        "segments": rows[:20000],
        "transcribed": sum(1 for s in statuses.values() if s == Transcript.Status.READY),
    }


class MessageOut(Schema):
    id: int
    role: str
    content: str
    position_ms: int
    citations: list
    model: str
    created_at: datetime


class ConversationOut(Schema):
    id: int
    title: str
    book_id: int | None
    episode_id: int | None
    collection_id: int | None
    updated_at: datetime


class ConversationDetailOut(ConversationOut):
    messages: list[MessageOut]

    @staticmethod
    def resolve_messages(obj: Conversation):
        return list(obj.messages.all())


@router.get("/conversations", response=list[ConversationOut])
def list_conversations(
    request, book_id: int | None = None, episode_id: int | None = None, collection_id: int | None = None
):
    qs = Conversation.objects.all()
    if book_id:
        qs = qs.filter(book_id=book_id)
    if episode_id:
        qs = qs.filter(episode_id=episode_id)
    if collection_id:
        qs = qs.filter(collection_id=collection_id)
    return qs[:100]


@router.post("/conversations", response=ConversationDetailOut)
def create_conversation(request, payload: WorkQuery):
    if not (payload.book_id or payload.episode_id or payload.collection_id):
        raise HttpError(400, "Pick a book, episode or folder")
    return Conversation.objects.create(owner=request.user, **payload.dict())


@router.get("/conversations/{cid}", response=ConversationDetailOut)
def get_conversation(request, cid: int):
    return get_object_or_404(Conversation, pk=cid)


@router.delete("/conversations/{cid}")
def delete_conversation(request, cid: int):
    get_object_or_404(Conversation, pk=cid).delete()
    return {"ok": True}


class AskIn(Schema):
    question: str = Field(min_length=1, max_length=4000)
    position_ms: int = Field(ge=0)


@router.post("/conversations/{cid}/ask")
def ask_question(request, cid: int, payload: AskIn):
    """Streams newline-delimited JSON events: {"type":"text"} deltas, then {"type":"done"} or {"type":"error"}."""
    conversation = get_object_or_404(
        Conversation.objects.select_related("book", "episode__podcast", "collection"), pk=cid
    )

    def events():
        try:
            for event in ask.stream_answer(conversation, payload.question.strip(), payload.position_ms):
                yield json.dumps(event) + "\n"
        except Exception as exc:  # surface to the chat UI rather than cutting the stream silently
            yield json.dumps({"type": "error", "error": str(exc)}) + "\n"

    response = StreamingHttpResponse(events(), content_type="application/x-ndjson")
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"
    return response
