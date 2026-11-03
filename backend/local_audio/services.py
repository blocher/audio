import re
import shutil
from pathlib import Path, PurePosixPath

from django.conf import settings

from core import audio
from core.models import Track

from .models import Collection


def natural_key(text: str):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def collection_dir(collection: Collection) -> Path:
    return audio.media_path(f"local/{collection.pk}")


def safe_relative(relative: str) -> PurePosixPath:
    parts = [p for p in PurePosixPath(relative.replace("\\", "/")).parts if p not in ("", ".", "..", "/")]
    if not parts:
        raise ValueError("Empty file name")
    return PurePosixPath(*parts)


def title_from(path: PurePosixPath | Path, probe: audio.Probe) -> str:
    if probe.title:
        return probe.title
    stem = re.sub(r"^\d+[\s._-]+", "", path.stem).replace("_", " ").strip()
    return stem or path.stem


def add_file(collection: Collection, src: Path, relative: str, move: bool = False) -> Track:
    rel = safe_relative(relative)
    dest = collection_dir(collection) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if move:
        shutil.move(src, dest)
    else:
        shutil.copy2(src, dest)
    probe = audio.ffprobe(dest)
    return Track.objects.create(
        source=Track.Source.LOCAL,
        collection=collection,
        title=title_from(rel, probe)[:500],
        file=audio.relative_media(dest),
        duration_ms=probe.duration_ms,
        size_bytes=probe.size_bytes,
        bitrate_kbps=probe.bitrate_kbps,
        channels=probe.channels,
        position=0,
    )


def renumber(collection: Collection) -> None:
    """Order tracks by folder then natural file name — “2 - x.mp3” before “10 - y.mp3”."""
    tracks = sorted(collection.tracks.all(), key=lambda t: natural_key(t.file))
    for n, track in enumerate(tracks):
        if track.position != n:
            track.position = n
            track.save(update_fields=["position"])


def allowed_path(path: Path) -> bool:
    path = path.expanduser().resolve()
    return any(path == root.resolve() or root.resolve() in path.parents for root in settings.LOCAL_IMPORT_ROOTS)


def scan(paths: list[Path]) -> list[tuple[Path, str]]:
    """Find audio files under each folder; returns (absolute path, path relative to the import)."""
    found = []
    for base in paths:
        base = base.expanduser().resolve()
        if base.is_file() and base.suffix.lower() in audio.AUDIO_EXTENSIONS:
            found.append((base, base.name))
            continue
        for file in sorted(base.rglob("*"), key=lambda p: natural_key(str(p))):
            if file.is_file() and file.suffix.lower() in audio.AUDIO_EXTENSIONS and not file.name.startswith("."):
                rel = file.relative_to(base.parent) if len(paths) > 1 else file.relative_to(base)
                found.append((file, str(rel)))
    return found
