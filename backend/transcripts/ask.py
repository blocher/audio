"""“Ask about this book”: Claude answers from the transcript up to where the listener is, and no further."""

import re
from collections.abc import Iterator

import anthropic

from core.api import setting

from .models import Conversation, Message
from .services import fmt_time, timeline, work_tracks

SYSTEM = """You are a thoughtful listening companion for an audiobook or podcast. The listener is partway through \
and asks you questions about it.

You are given the transcript of everything they have heard so far, with timestamps in [h:mm:ss]. Ground every \
answer in that transcript.

Spoilers are the one thing that matters most here. The transcript stops at the listener's current position on \
purpose. Never reveal, hint at, or speculate about anything after that point — even if you recognise the work and \
know what happens later. If the honest answer depends on later events, say it hasn't been covered yet. General \
background the listener could know without reading on (historical context, what a word means, who a real person \
was) is fine.

Cite moments in the transcript with their timestamp in square brackets, like [1:02:13], so the listener can jump \
there. Keep answers conversational and reasonably short unless asked for depth. The transcript comes from automatic \
speech recognition, so names may be misspelled; use the most plausible spelling."""

MAX_TRANSCRIPT_CHARS = 3_000_000  # ~750k tokens; the model's context is 1M
_CITE_RE = re.compile(r"\[(\d+):(\d{2}):(\d{2})\]")


def target_kwargs(conversation: Conversation) -> dict:
    if conversation.book_id:
        return {"book_id": conversation.book_id}
    if conversation.episode_id:
        return {"episode_id": conversation.episode_id}
    return {"collection_id": conversation.collection_id}


def work_title(conversation: Conversation) -> str:
    if conversation.book_id:
        b = conversation.book
        return f"{b.title}{f' by {b.authors}' if b.authors else ''}"
    if conversation.episode_id:
        e = conversation.episode
        return f"{e.title} ({e.podcast.title})"
    return conversation.collection.name


def transcript_document(conversation: Conversation, position_ms: int) -> tuple[str, int]:
    """Render the heard-so-far transcript as text with a timestamp roughly every 30 seconds."""
    tracks = list(work_tracks(**target_kwargs(conversation)))
    rows = timeline(tracks, until_ms=position_ms)
    lines: list[str] = []
    current_track = None
    last_stamp = -(10**9)
    paragraph: list[str] = []

    def flush():
        if paragraph:
            lines.append(" ".join(paragraph))
            paragraph.clear()

    for row in rows:
        if row["track_id"] != current_track:
            flush()
            current_track = row["track_id"]
            lines.append(f"\n## {row['track_title']}")
        if row["start_ms"] - last_stamp >= 30_000:
            flush()
            paragraph.append(f"[{fmt_time(row['start_ms'])}]")
            last_stamp = row["start_ms"]
        paragraph.append(row["text"])
    flush()
    text = "\n".join(lines).strip()
    if len(text) > MAX_TRANSCRIPT_CHARS:
        # Very long works: keep the most recent part, which is what questions are usually about.
        text = "[Earlier transcript omitted for length.]\n" + text[-MAX_TRANSCRIPT_CHARS:]
    return text, len(rows)


def citations(text: str) -> list[int]:
    return sorted({int(h) * 3_600_000 + int(m) * 60_000 + int(s) * 1000 for h, m, s in _CITE_RE.findall(text)})


def stream_answer(conversation: Conversation, question: str, position_ms: int) -> Iterator[dict]:
    """Yield {"type": "text", "text": ...} deltas, then a final {"type": "done", ...} with the saved message."""
    key = setting("anthropic", "api_key")
    if not key:
        raise RuntimeError("Add an Anthropic API key in Settings to ask questions.")
    model = setting("anthropic", "model") or "claude-opus-5-5"
    document, segment_count = transcript_document(conversation, position_ms)
    if not segment_count:
        raise RuntimeError("Nothing has been transcribed up to this point yet.")

    history = [{"role": m.role, "content": m.content} for m in conversation.messages.order_by("created_at", "id")]
    Message.objects.create(conversation=conversation, role="user", content=question, position_ms=position_ms)
    context = (
        f"Work: {work_title(conversation)}\nListener's position: {fmt_time(position_ms)}\n\n"
        f"<transcript>\n{document}\n</transcript>"
    )
    client = anthropic.Anthropic(api_key=key)
    params = dict(
        model=model,
        max_tokens=16000,
        # The transcript sits in the system prompt with a cache breakpoint, so follow-up questions at the
        # same position reuse it instead of paying for the whole book again.
        system=[
            {"type": "text", "text": SYSTEM},
            {"type": "text", "text": context, "cache_control": {"type": "ephemeral", "ttl": "1h"}},
        ],
        messages=[*history, {"role": "user", "content": question}],
        output_config={"effort": "medium"},
    )
    # Server-side fallback reroutes a safety-classifier decline to another model inside the same call.
    if model in {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}:
        params.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    chunks: list[str] = []
    with client.beta.messages.stream(**params) as stream:
        for text in stream.text_stream:
            chunks.append(text)
            yield {"type": "text", "text": text}
        final = stream.get_final_message()
    answer = "".join(chunks).strip()
    if final.stop_reason == "refusal" and not answer:
        answer = "I can't help with that one."
    message = Message.objects.create(
        conversation=conversation,
        role="assistant",
        content=answer,
        position_ms=position_ms,
        citations=citations(answer),
        model=final.model,
        input_tokens=(final.usage.input_tokens or 0)
        + (final.usage.cache_read_input_tokens or 0)
        + (final.usage.cache_creation_input_tokens or 0),
        output_tokens=final.usage.output_tokens or 0,
    )
    if not conversation.title:
        conversation.title = question[:120]
    conversation.save(update_fields=["title", "updated_at"])
    yield {"type": "done", "message_id": message.pk, "citations": message.citations, "model": message.model}
