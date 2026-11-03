"""Speech-to-text with OpenAI. Audio is cut into ~10 minute mono chunks to stay well under the 25 MB upload cap."""

import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import openai

from core import audio
from core.api import setting

CHUNK_MS = 10 * 60 * 1000
# OpenAI's published price per audio minute; used only for the estimate shown before you start.
PRICE_PER_MINUTE = {"whisper-1": 0.006, "gpt-4o-transcribe": 0.006, "gpt-4o-mini-transcribe": 0.003}


def estimate_cost(duration_ms: int, model: str) -> float:
    return round(duration_ms / 60_000 * PRICE_PER_MINUTE.get(model, 0.006), 2)


def openai_client() -> openai.OpenAI:
    key = setting("openai", "api_key")
    if not key:
        raise RuntimeError("Add an OpenAI API key in Settings to transcribe audio.")
    return openai.OpenAI(api_key=key, timeout=600, max_retries=3)


def _transcribe_chunk(client: openai.OpenAI, model: str, path: Path, offset_ms: int, length_ms: int) -> list[dict]:
    with path.open("rb") as fh:
        if model == "whisper-1":
            result = client.audio.transcriptions.create(
                model=model, file=fh, response_format="verbose_json", timestamp_granularities=["segment"]
            )
            return [
                {
                    "start_ms": offset_ms + int(s.start * 1000),
                    "end_ms": offset_ms + int(s.end * 1000),
                    "text": s.text.strip(),
                }
                for s in (result.segments or [])
                if s.text.strip()
            ]
        # The gpt-4o transcribe models return plain text without timestamps, so a chunk becomes one segment.
        result = client.audio.transcriptions.create(model=model, file=fh, response_format="json")
        text = (result.text or "").strip()
        return [{"start_ms": offset_ms, "end_ms": offset_ms + length_ms, "text": text}] if text else []


def transcribe_file(path: Path, duration_ms: int, on_progress=None) -> tuple[str, list[dict]]:
    model = setting("openai", "transcription_model") or "whisper-1"
    client = openai_client()
    starts = list(range(0, max(duration_ms, 1), CHUNK_MS))
    done = 0
    with tempfile.TemporaryDirectory() as tmp:

        def work(start: int) -> list[dict]:
            nonlocal done
            end = min(start + CHUNK_MS, duration_ms) if duration_ms else start + CHUNK_MS
            chunk = Path(tmp) / f"{start}.mp3"
            # 32 kbps mono at 16 kHz is what the models listen at anyway; it keeps uploads ~2.4 MB.
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
            segments = _transcribe_chunk(client, model, chunk, start, end - start)
            chunk.unlink(missing_ok=True)
            done += 1
            if on_progress:
                on_progress(done / len(starts))
            return segments

        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(work, starts))
    segments = [s for chunk in results for s in chunk]
    return model, segments
