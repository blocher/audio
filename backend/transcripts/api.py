import json
from datetime import datetime

from django.http import StreamingHttpResponse
from django.shortcuts import get_object_or_404
from ninja import Field, Router, Schema
from ninja.errors import HttpError

from core import ai
from core.api import JobOut
from core.jobs import enqueue
from core.models import Track

from . import ask, stt
from .models import Conversation, Message, Transcript
from .services import timeline, work_tracks
from .tasks import transcribe_tracks_task

router = Router(tags=["transcripts"])


class TranscribeIn(Schema):
    track_ids: list[int]
    force: bool = False
    provider: str | None = None
    model: str | None = None


def _pending(track_ids: list[int], force: bool):
    qs = Track.objects.filter(pk__in=track_ids).exclude(file="")
    if not force:
        qs = qs.exclude(transcript__status=Transcript.Status.READY)
    return qs


def _resolve(payload: TranscribeIn) -> tuple[str, str]:
    try:
        return ai.resolve("stt", payload.provider, payload.model)
    except RuntimeError as exc:
        raise HttpError(400, str(exc)) from exc


@router.post("/estimate")
def estimate(request, payload: TranscribeIn):
    tracks = list(_pending(payload.track_ids, payload.force))
    ms = sum(t.duration_ms for t in tracks)
    configured = any(ai.configured(p.id) for p in ai.PROVIDERS.values() if p.stt)
    provider, model = _resolve(payload) if configured else ("", "")
    return {
        "tracks": len(tracks),
        "minutes": round(ms / 60_000),
        "provider": provider,
        "model": model,
        "estimated_cost_usd": stt.estimate_cost(ms, provider, model) if provider else None,
        "configured": configured,
    }


@router.post("/transcribe", response=JobOut)
def transcribe(request, payload: TranscribeIn):
    provider, model = _resolve(payload)
    tracks = list(_pending(payload.track_ids, payload.force))
    if not tracks:
        raise HttpError(400, "Those tracks are already transcribed (or have no audio yet)")
    for t in tracks:
        Transcript.objects.update_or_create(track=t, defaults={"status": Transcript.Status.QUEUED})
    first = tracks[0]
    target = first.book or first.episode or first.collection
    return enqueue(
        "transcribe",
        f"Transcribe {len(tracks)} track(s)" + (f" of {target}" if target else "") + f" with {model}",
        transcribe_tracks_task,
        [t.pk for t in tracks],
        provider,
        model,
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
    whole_work: bool
    citations: list
    provider: str
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


def mine(request):
    """Conversations are private to whoever started them."""
    return Conversation.objects.filter(owner=request.user)


@router.get("/conversations", response=list[ConversationOut])
def list_conversations(
    request, book_id: int | None = None, episode_id: int | None = None, collection_id: int | None = None
):
    qs = mine(request)
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
    return get_object_or_404(mine(request), pk=cid)


@router.delete("/conversations/{cid}")
def delete_conversation(request, cid: int):
    get_object_or_404(mine(request), pk=cid).delete()
    return {"ok": True}


class AskIn(Schema):
    question: str = Field(min_length=1, max_length=4000)
    position_ms: int = Field(ge=0)
    whole_work: bool = False
    provider: str | None = None
    model: str | None = None


@router.post("/conversations/{cid}/ask")
def ask_question(request, cid: int, payload: AskIn):
    """Streams newline-delimited JSON events: {"type":"text"} deltas, then {"type":"done"} or {"type":"error"}."""
    conversation = get_object_or_404(mine(request).select_related("book", "episode__podcast", "collection"), pk=cid)

    def events():
        try:
            for event in ask.stream_answer(
                conversation,
                payload.question.strip(),
                payload.position_ms,
                payload.provider,
                payload.model,
                whole_work=payload.whole_work,
            ):
                yield json.dumps(event) + "\n"
        except Exception as exc:  # surface to the chat UI rather than cutting the stream silently
            # Kept in the history next to the question it answers; never sent back to the model.
            Message.objects.create(conversation=conversation, role="error", content=str(exc))
            yield json.dumps({"type": "error", "error": str(exc)}) + "\n"

    response = StreamingHttpResponse(events(), content_type="application/x-ndjson")
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"
    return response
