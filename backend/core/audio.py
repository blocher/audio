"""ffmpeg/ffprobe helpers: probing, re-encoding to smaller MP3s, and splitting chapters."""

import json
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from django.conf import settings

AUDIO_EXTENSIONS = {".mp3", ".m4a", ".m4b", ".aac", ".wav", ".flac", ".ogg", ".opus", ".aiff", ".aif", ".wma"}

# Spoken word stays clear far below music bitrates. Mono halves the data for the same perceived quality.
BITRATE_PRESETS = [
    {"kbps": 32, "label": "Tiny", "note": "Speech only; noticeably thin"},
    {"kbps": 48, "label": "Compact", "note": "Good for audiobooks and talk podcasts"},
    {"kbps": 64, "label": "Balanced", "note": "Recommended: clear speech, light music"},
    {"kbps": 96, "label": "Rich", "note": "Music-heavy shows"},
    {"kbps": 128, "label": "Full", "note": "Near-original for most podcasts"},
]
DEFAULT_KBPS = 64


@dataclass
class Probe:
    duration_ms: int
    size_bytes: int
    bitrate_kbps: int
    channels: int
    sample_rate: int
    codec: str
    title: str
    chapters: list[dict]


def ffprobe(path: Path) -> Probe:
    out = subprocess.run(
        [
            settings.FFPROBE_BINARY,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            "-show_chapters",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    data = json.loads(out.stdout or "{}")
    fmt = data.get("format", {})
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), {})
    duration = float(fmt.get("duration") or audio.get("duration") or 0)
    bit_rate = int(audio.get("bit_rate") or fmt.get("bit_rate") or 0)
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    chapters = [
        {
            "title": (c.get("tags") or {}).get("title") or f"Chapter {i + 1}",
            "start_ms": int(float(c["start_time"]) * 1000),
            "end_ms": int(float(c["end_time"]) * 1000),
        }
        for i, c in enumerate(data.get("chapters", []))
    ]
    return Probe(
        duration_ms=int(duration * 1000),
        size_bytes=int(fmt.get("size") or path.stat().st_size),
        bitrate_kbps=round(bit_rate / 1000),
        channels=int(audio.get("channels") or 0),
        sample_rate=int(audio.get("sample_rate") or 0),
        codec=audio.get("codec_name", ""),
        title=tags.get("title", ""),
        chapters=chapters,
    )


_TIME_RE = re.compile(r"out_time_us=(\d+)")


def run_ffmpeg(args: list[str], duration_ms: int = 0, on_progress: Callable[[float], None] | None = None) -> None:
    """Run ffmpeg, reporting 0–1 progress from its -progress stream when the input duration is known."""
    cmd = [
        settings.FFMPEG_BINARY,
        "-hide_banner",
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        *args,
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert proc.stdout is not None
    for line in proc.stdout:
        match = _TIME_RE.match(line.strip())
        if match and duration_ms and on_progress:
            on_progress(min(1.0, int(match.group(1)) / 1000 / duration_ms))
    stderr = proc.stderr.read() if proc.stderr else ""
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg failed: {stderr.strip()[-2000:]}")


def mp3_args(kbps: int, mono: bool) -> list[str]:
    # 22.05 kHz is plenty for speech at low bitrates and lets LAME spend bits on clarity.
    sample_rate = "22050" if kbps <= 48 else "44100"
    return [
        "-vn",
        "-map_metadata",
        "-1",
        "-c:a",
        "libmp3lame",
        "-b:a",
        f"{kbps}k",
        "-ar",
        sample_rate,
        *(["-ac", "1"] if mono else []),
    ]


def transcode_mp3(
    src: Path,
    dest: Path,
    kbps: int = DEFAULT_KBPS,
    mono: bool = True,
    title: str = "",
    start_ms: int | None = None,
    end_ms: int | None = None,
    pre_input: list[str] | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part.mp3")
    seek: list[str] = []
    if start_ms is not None:
        seek += ["-ss", f"{start_ms / 1000:.3f}"]
    if end_ms is not None:
        seek += ["-to", f"{end_ms / 1000:.3f}"]
    duration = (end_ms - (start_ms or 0)) if end_ms is not None else ffprobe_duration_ms(src, pre_input)
    run_ffmpeg(
        [
            *(pre_input or []),
            *seek,
            "-i",
            str(src),
            *mp3_args(kbps, mono),
            *(["-metadata", f"title={title}"] if title else []),
            str(tmp),
        ],
        duration_ms=duration,
        on_progress=on_progress,
    )
    tmp.replace(dest)


def ffprobe_duration_ms(path: Path, pre_input: list[str] | None = None) -> int:
    try:
        return ffprobe(path).duration_ms
    except (subprocess.CalledProcessError, ValueError):
        return 0


def estimate_bytes(duration_ms: int, kbps: int) -> int:
    """MP3 CBR size: bitrate × duration, plus ~1% framing overhead."""
    return int(kbps * 1000 / 8 * duration_ms / 1000 * 1.01)


def hours_per_card(kbps: int, card_bytes: int) -> float:
    return card_bytes / (kbps * 1000 / 8 * 1.01) / 3600


def media_path(relative: str) -> Path:
    return Path(settings.MEDIA_ROOT) / relative


def relative_media(path: Path) -> str:
    return str(path.resolve().relative_to(Path(settings.MEDIA_ROOT)))
