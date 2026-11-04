"""“Ask about this book”: a chosen model answers from the transcript up to where the listener is, and no further.

Providers: Claude (Anthropic SDK), OpenAI and Grok (OpenAI SDK, Responses API), Groq (OpenAI-compatible chat
completions) and Gemini (google-genai). When the heard-so-far transcript is bigger than the model can take, it is
cut to the most recent stretch plus the passages that best match the question.
"""

import math
import re
from collections import Counter
from collections.abc import Iterator

from core import ai
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

EXCERPT_NOTE = """Note: the transcript below is too long for this model, so it contains the most recent part of \
what the listener has heard plus earlier passages that look relevant to the question; “[…]” marks gaps. If the \
answer may be in a gap, say so rather than guessing."""

CHARS_PER_TOKEN = 3.6
PASSAGE_MS = 90_000
_CITE_RE = re.compile(r"\[(\d+):(\d{2}):(\d{2})\]")
_WORD_RE = re.compile(r"[a-z0-9']+")
STOPWORDS = set(
    "the a an and or but of to in on at for with by from is was are were be been it its this that these those he she "
    "they them his her their we you i me my our your what who whom which when where why how did does do has have had "
    "not no so as if then than there here about into out up down just very can could would should will shall may "
    "might more most some any all again tell explain happened happen why".split()
)


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


# ---------- transcript → passages → text that fits the model ----------


def passages(conversation: Conversation, position_ms: int) -> list[dict]:
    """Heard-so-far transcript as ~90-second passages, each starting with a timestamp."""
    rows = timeline(list(work_tracks(**target_kwargs(conversation))), until_ms=position_ms)
    out: list[dict] = []
    for row in rows:
        last = out[-1] if out else None
        if last is None or last["track_id"] != row["track_id"] or row["start_ms"] - last["start_ms"] >= PASSAGE_MS:
            out.append(
                {
                    "track_id": row["track_id"],
                    "track_title": row["track_title"],
                    "start_ms": row["start_ms"],
                    "texts": [],
                }
            )
        out[-1]["texts"].append(row["text"])
    for p in out:
        p["text"] = f"[{fmt_time(p['start_ms'])}] " + " ".join(p["texts"])
    return out


def render(selected: list[dict], all_passages: list[dict]) -> str:
    index = {id(p): n for n, p in enumerate(all_passages)}
    lines: list[str] = []
    previous_index = -1
    previous_track = None
    for p in sorted(selected, key=lambda x: index[id(x)]):
        n = index[id(p)]
        if previous_index >= 0 and n != previous_index + 1:
            lines.append("[…]")
        if p["track_id"] != previous_track:
            lines.append(f"\n## {p['track_title']}")
            previous_track = p["track_id"]
        lines.append(p["text"])
        previous_index = n
    return "\n".join(lines).strip()


def _terms(text: str) -> list[str]:
    return [w for w in _WORD_RE.findall(text.lower()) if len(w) > 2 and w not in STOPWORDS]


def fit(all_passages: list[dict], budget_chars: int, question: str) -> tuple[list[dict], bool]:
    """Everything if it fits; otherwise the most recent ~40% of the budget plus the best-matching earlier passages."""
    total = sum(len(p["text"]) + 1 for p in all_passages)
    if total <= budget_chars:
        return all_passages, False
    chosen: list[dict] = []
    taken: set[int] = set()
    used = 0
    recent_budget = budget_chars * 0.4
    tail_start = len(all_passages)
    for p in reversed(all_passages):
        if used + len(p["text"]) > recent_budget:
            break
        chosen.append(p)
        taken.add(id(p))
        used += len(p["text"]) + 1
        tail_start -= 1

    earlier = all_passages[:tail_start]
    query = Counter(_terms(question))
    docs = [Counter(_terms(p["text"])) for p in earlier]
    df = Counter(term for d in docs for term in set(d))
    n_docs = max(len(docs), 1)

    def score(d: Counter) -> float:
        return sum(
            (d[t] * 2.2 / (d[t] + 1.2)) * math.log(1 + (n_docs - df[t] + 0.5) / (df[t] + 0.5)) for t in query if d[t]
        )

    ranked = sorted(range(len(earlier)), key=lambda i: score(docs[i]), reverse=True)
    for i in ranked:
        if score(docs[i]) <= 0:
            break
        # Take a little context on both sides of a hit.
        for j in (i - 1, i, i + 1):
            if 0 <= j < len(earlier) and id(earlier[j]) not in taken:
                if used + len(earlier[j]["text"]) > budget_chars:
                    break
                chosen.append(earlier[j])
                taken.add(id(earlier[j]))
                used += len(earlier[j]["text"]) + 1
        if used >= budget_chars * 0.97:
            break
    return chosen, True


def budget_tokens(provider: str, model: str, history_chars: int) -> int:
    context = ai.model_context(provider, model)
    budget = int(context * 0.6) - int(history_chars / CHARS_PER_TOKEN) - 2000
    if provider == "groq":
        budget = min(budget, int(setting("preferences", "groq_context_tokens") or 24000))
    return max(budget, 4000)


def citations(text: str) -> list[int]:
    return sorted({int(h) * 3_600_000 + int(m) * 60_000 + int(s) * 1000 for h, m, s in _CITE_RE.findall(text)})


# ---------- provider streaming: each yields ("text", str) and finally ("usage", dict) ----------


def _anthropic(model: str, system: str, context: str, messages: list[dict]) -> Iterator[tuple[str, object]]:
    client = ai.anthropic_client()
    params: dict = dict(
        model=model,
        max_tokens=16000,
        # The transcript has its own cache breakpoint, so follow-ups at the same position reuse it.
        system=[
            {"type": "text", "text": system},
            {"type": "text", "text": context, "cache_control": {"type": "ephemeral", "ttl": "1h"}},
        ],
        messages=messages,
    )
    if re.match(r"claude-(opus|sonnet|haiku|fable)-5", model) or re.match(r"claude-opus-4-[5-8]", model):
        params["output_config"] = {"effort": "medium"}
    # Server-side fallback reroutes a safety-classifier decline to another model inside the same call.
    if model in {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}:
        params.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    with client.beta.messages.stream(**params) as stream:
        for text in stream.text_stream:
            yield "text", text
        final = stream.get_final_message()
    usage = final.usage
    yield (
        "usage",
        {
            "model": final.model,
            "refused": final.stop_reason == "refusal",
            "input": (usage.input_tokens or 0)
            + (usage.cache_read_input_tokens or 0)
            + (usage.cache_creation_input_tokens or 0),
            "output": usage.output_tokens or 0,
        },
    )


def _responses(provider: str, model: str, system: str, context: str, messages: list[dict]):
    """OpenAI and xAI: the Responses API, which both providers now recommend."""
    client = ai.openai_client(provider)
    stream = client.responses.create(
        model=model,
        instructions=f"{system}\n\n{context}",
        input=[{"role": m["role"], "content": m["content"]} for m in messages],
        stream=True,
    )
    usage = {"model": model, "input": 0, "output": 0}
    for event in stream:
        kind = getattr(event, "type", "")
        if kind == "response.output_text.delta":
            yield "text", event.delta
        elif kind == "response.completed":
            u = getattr(event.response, "usage", None)
            if u is not None:
                usage.update(input=getattr(u, "input_tokens", 0) or 0, output=getattr(u, "output_tokens", 0) or 0)
        elif kind in ("response.failed", "error"):
            detail = getattr(getattr(event, "response", None), "error", None) or getattr(event, "message", "")
            raise RuntimeError(f"{ai.PROVIDERS[provider].label} error: {detail}")
    yield "usage", usage


def _groq(model: str, system: str, context: str, messages: list[dict]):
    client = ai.openai_client("groq")
    stream = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": f"{system}\n\n{context}"}, *messages],
        stream=True,
    )
    usage = {"model": model, "input": 0, "output": 0}
    for chunk in stream:
        if chunk.choices and (text := chunk.choices[0].delta.content):
            yield "text", text
        extra = getattr(chunk, "x_groq", None) or {}
        u = extra.get("usage") if isinstance(extra, dict) else getattr(extra, "usage", None)
        if u:
            usage.update(input=_val(u, "prompt_tokens"), output=_val(u, "completion_tokens"))
    yield "usage", usage


def _val(obj, name: str) -> int:
    return int((obj.get(name) if isinstance(obj, dict) else getattr(obj, name, 0)) or 0)


def _gemini(model: str, system: str, context: str, messages: list[dict]):
    from google.genai import types

    client = ai.gemini_client()
    contents = [
        types.Content(role="model" if m["role"] == "assistant" else "user", parts=[types.Part(text=m["content"])])
        for m in messages
    ]
    usage = {"model": model, "input": 0, "output": 0}
    for chunk in client.models.generate_content_stream(
        model=model, contents=contents, config=types.GenerateContentConfig(system_instruction=f"{system}\n\n{context}")
    ):
        if chunk.text:
            yield "text", chunk.text
        if meta := getattr(chunk, "usage_metadata", None):
            usage.update(input=meta.prompt_token_count or 0, output=meta.candidates_token_count or 0)
    yield "usage", usage


def stream_model(provider: str, model: str, system: str, context: str, messages: list[dict]):
    if provider == "anthropic":
        return _anthropic(model, system, context, messages)
    if provider in ("openai", "xai"):
        return _responses(provider, model, system, context, messages)
    if provider == "groq":
        return _groq(model, system, context, messages)
    if provider == "gemini":
        return _gemini(model, system, context, messages)
    raise RuntimeError(f"Unknown provider {provider}")


def stream_answer(
    conversation: Conversation,
    question: str,
    position_ms: int,
    provider: str | None = None,
    model: str | None = None,
) -> Iterator[dict]:
    """Yield {"type": "text", "text": ...} deltas, then a final {"type": "done", ...} with the saved message."""
    provider, model = ai.resolve("chat", provider, model)
    all_passages = passages(conversation, position_ms)
    if not all_passages:
        raise RuntimeError("Nothing has been transcribed up to this point yet.")

    history = [{"role": m.role, "content": m.content} for m in conversation.messages.order_by("created_at", "id")]
    history_chars = sum(len(m["content"]) for m in history) + len(question)
    budget_chars = int(budget_tokens(provider, model, history_chars) * CHARS_PER_TOKEN)
    selected, excerpted = fit(all_passages, budget_chars, question)

    Message.objects.create(conversation=conversation, role="user", content=question, position_ms=position_ms)
    context = (
        f"Work: {work_title(conversation)}\nListener's position: {fmt_time(position_ms)}\n\n"
        + (f"{EXCERPT_NOTE}\n\n" if excerpted else "")
        + f"<transcript>\n{render(selected, all_passages)}\n</transcript>"
    )
    if excerpted:
        yield {
            "type": "notice",
            "text": "Too long for this model at once, so it read the recent part plus relevant excerpts.",
        }

    chunks: list[str] = []
    usage: dict = {}
    for kind, value in stream_model(
        provider, model, SYSTEM, context, [*history, {"role": "user", "content": question}]
    ):
        if kind == "text":
            chunks.append(value)
            yield {"type": "text", "text": value}
        else:
            usage = value
    answer = "".join(chunks).strip()
    if not answer:
        answer = "I can't help with that one." if usage.get("refused") else "(No answer came back.)"
    message = Message.objects.create(
        conversation=conversation,
        role="assistant",
        content=answer,
        position_ms=position_ms,
        citations=citations(answer),
        provider=provider,
        model=usage.get("model") or model,
        input_tokens=usage.get("input", 0),
        output_tokens=usage.get("output", 0),
    )
    if not conversation.title:
        conversation.title = question[:120]
    conversation.save(update_fields=["title", "updated_at"])
    yield {
        "type": "done",
        "message_id": message.pk,
        "citations": message.citations,
        "model": message.model,
        "provider": provider,
        "excerpted": excerpted,
    }
