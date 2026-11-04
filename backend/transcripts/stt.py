"""Speech-to-text across providers (OpenAI, Groq, Gemini).

Audio is cut into mono 16 kHz chunks first, which keeps every upload far under provider size caps. Models that
return segment timestamps get 10-minute chunks; models that return plain text get 2-minute chunks so each chunk's
start time is still a useful timestamp.
"""

import base64
import json
import re
import tempfile
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from core import ai, audio

LONG_CHUNK_MS = 10 * 60 * 1000
SHORT_CHUNK_MS = 2 * 60 * 1000

GEMINI_PROMPT = (
    "Transcribe this audio verbatim. Return JSON: an array of segments in order, each with `start` (the time the "
    "segment begins, as MM:SS from the start of this clip) and `text`. Start a new segment every sentence or about "
    "every 10 seconds. Do not summarise or skip anything."
)
GEMINI_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {"start": {"type": "STRING"}, "text": {"type": "STRING"}},
        "required": ["start", "text"],
    },
}


def estimate_cost(duration_ms: int, provider: str, model: str) -> float | None:
    rate = ai.STT_PRICE_PER_HOUR.get((provider, model))
    return round(duration_ms / 3_600_000 * rate, 2) if rate is not None else None


def chunk_ms(provider: str, model: str) -> int:
    if provider == "gemini" or model in ai.SEGMENT_STT_MODELS:
        return LONG_CHUNK_MS
    return SHORT_CHUNK_MS


# ---------- per-provider chunk transcription; all return [{start_ms, end_ms, text}] relative to the chunk ----------


def _openai_compatible(provider: str, model: str, path: Path, length_ms: int) -> list[dict]:
    client = ai.openai_client(provider)
    with path.open("rb") as fh:
        if model in ai.SEGMENT_STT_MODELS:
            result = client.audio.transcriptions.create(
                model=model, file=fh, response_format="verbose_json", timestamp_granularities=["segment"]
            )
            segments = getattr(result, "segments", None) or []
            return [
                {
                    "start_ms": int(_get(s, "start") * 1000),
                    "end_ms": int(_get(s, "end") * 1000),
                    "text": _get(s, "text").strip(),
                }
                for s in segments
                if _get(s, "text", "").strip()
            ]
        result = client.audio.transcriptions.create(model=model, file=fh, response_format="json")
    text = (getattr(result, "text", "") or "").strip()
    return [{"start_ms": 0, "end_ms": length_ms, "text": text}] if text else []


def _get(obj, name: str, default=None):
    return obj.get(name, default) if isinstance(obj, dict) else getattr(obj, name, default)


def _seconds(value) -> float:
    """Gemini offsets look like "1.250s"; also accept numbers."""
    if isinstance(value, int | float):
        return float(value)
    return float(str(value or "0").rstrip("s") or 0)


def group_words(words: list[dict]) -> list[dict]:
    """Turn word timings into sentence-ish segments: break after end punctuation (≥4 s) or at 15 s."""
    segments: list[dict] = []
    current: list[dict] = []
    for word in words:
        current.append(word)
        span = current[-1]["end_ms"] - current[0]["start_ms"]
        ends_sentence = re.search(r"[.!?…]['\"”’)]?$", word["text"])
        if (ends_sentence and span >= 4000) or span >= 15000:
            segments.append(_join(current))
            current = []
    if current:
        segments.append(_join(current))
    return segments


def _join(words: list[dict]) -> dict:
    text = " ".join(w["text"] for w in words)
    text = re.sub(r"\s+([,.!?;:…])", r"\1", text)
    return {"start_ms": words[0]["start_ms"], "end_ms": words[-1]["end_ms"], "text": text.strip()}


def _gemini_transcribe_model(model: str, path: Path, length_ms: int) -> list[dict]:
    client = ai.gemini_client()
    data = base64.b64encode(path.read_bytes()).decode()
    response = client.interactions.create(
        model=model,
        input=[{"type": "audio", "data": data, "mime_type": "audio/mp3"}],
        generation_config={
            "transcription_config": {"mode": {"type": "verbatim", "timestamp_granularities": ["word"]}}
        },
    )
    words = []
    for step in _get(response, "steps", None) or []:
        for content in _get(step, "content", None) or []:
            for annotation in _get(content, "annotations", None) or []:
                if _get(annotation, "type") == "word_info":
                    words.append(
                        {
                            "start_ms": int(_seconds(_get(annotation, "start_offset")) * 1000),
                            "end_ms": int(_seconds(_get(annotation, "end_offset")) * 1000),
                            "text": str(_get(annotation, "text", "")).strip(),
                        }
                    )
    words = [w for w in words if w["text"]]
    if words:
        return group_words(words)
    text = (_get(response, "output_text", "") or "").strip()
    return [{"start_ms": 0, "end_ms": length_ms, "text": text}] if text else []


def _clock_ms(value: str) -> int:
    parts = [float(p) for p in re.findall(r"\d+(?:\.\d+)?", value or "0")] or [0.0]
    seconds = 0.0
    for p in parts[-3:]:
        seconds = seconds * 60 + p
    return int(seconds * 1000)


def _gemini_general_model(model: str, path: Path, length_ms: int) -> list[dict]:
    from google.genai import types

    client = ai.gemini_client()
    response = client.models.generate_content(
        model=model,
        contents=[types.Part.from_bytes(data=path.read_bytes(), mime_type="audio/mp3"), GEMINI_PROMPT],
        config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=GEMINI_SCHEMA),
    )
    rows = json.loads(response.text or "[]")
    segments = []
    for n, row in enumerate(rows):
        start = min(_clock_ms(row.get("start", "")), length_ms)
        end = _clock_ms(rows[n + 1].get("start", "")) if n + 1 < len(rows) else length_ms
        if text := (row.get("text") or "").strip():
            segments.append({"start_ms": start, "end_ms": max(start, min(end, length_ms)), "text": text})
    return segments


def transcribe_chunk(provider: str, model: str, path: Path, length_ms: int) -> list[dict]:
    if provider == "gemini":
        if "transcribe" in model:
            return _gemini_transcribe_model(model, path, length_ms)
        return _gemini_general_model(model, path, length_ms)
    return _openai_compatible(provider, model, path, length_ms)


def transcribe_file(
    path: Path,
    duration_ms: int,
    provider: str | None = None,
    model: str | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> tuple[str, str, list[dict]]:
    """Returns (provider, model, segments) with segment times relative to the file's start."""
    provider, model = ai.resolve("stt", provider, model)
    step = chunk_ms(provider, model)
    starts = list(range(0, max(duration_ms, 1), step))
    done = 0
    with tempfile.TemporaryDirectory() as tmp:

        def work(start: int) -> list[dict]:
            nonlocal done
            end = min(start + step, duration_ms) if duration_ms else start + step
            chunk = Path(tmp) / f"{start}.mp3"
            # 32 kbps mono at 16 kHz is what speech models listen at anyway; 10 minutes is ~2.4 MB.
            audio.run_ffmpeg(
                [
                    "-ss",
                    f"{start / 1000:.3f}",
                    "-to",
                    f"{end / 1000:.3f}",
                    "-i",
                    str(path),
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "libmp3lame",
                    "-b:a",
                    "32k",
                    str(chunk),
                ]
            )
            segments = transcribe_chunk(provider, model, chunk, end - start)
            chunk.unlink(missing_ok=True)
            done += 1
            if on_progress:
                on_progress(done / len(starts))
            return [{**s, "start_ms": s["start_ms"] + start, "end_ms": s["end_ms"] + start} for s in segments]

        # Groq's free tier meters audio-seconds per hour; stay gentle there.
        with ThreadPoolExecutor(max_workers=2 if provider == "groq" else 3) as pool:
            results = list(pool.map(work, starts))
    return provider, model, [s for chunk in results for s in chunk]
