import tempfile
from datetime import datetime
from pathlib import Path

from django.db.models import Count, Sum
from django.shortcuts import get_object_or_404
from ninja import File, Form, Router, Schema, UploadedFile
from ninja.errors import HttpError

from core import audio
from core.api import JobOut, TrackOut
from core.jobs import enqueue

from .models import Collection
from .services import add_file, allowed_path, renumber
from .tasks import import_paths_task

router = Router(tags=["local"])


class CollectionOut(Schema):
    id: int
    name: str
    description: str
    source_paths: list
    created_at: datetime
    track_count: int = 0
    total_bytes: int = 0
    total_duration_ms: int = 0


class CollectionDetailOut(CollectionOut):
    tracks: list[TrackOut]


class CollectionIn(Schema):
    name: str
    description: str = ""


def annotated():
    return Collection.objects.annotate(
        track_count=Count("tracks"),
        total_bytes=Sum("tracks__size_bytes"),
        total_duration_ms=Sum("tracks__duration_ms"),
    )


def _one(pk: int):
    c = get_object_or_404(annotated(), pk=pk)
    c.total_bytes = c.total_bytes or 0
    c.total_duration_ms = c.total_duration_ms or 0
    return c


@router.get("/collections", response=list[CollectionOut])
def list_collections(request):
    rows = list(annotated())
    for c in rows:
        c.total_bytes = c.total_bytes or 0
        c.total_duration_ms = c.total_duration_ms or 0
    return rows


@router.post("/collections", response=CollectionOut)
def create_collection(request, payload: CollectionIn):
    c = Collection.objects.create(name=payload.name.strip() or "Untitled", description=payload.description)
    return _one(c.pk)


@router.get("/collections/{cid}", response=CollectionDetailOut)
def get_collection(request, cid: int):
    c = _one(cid)
    c.tracks = list(c.tracks.select_related("transcript").order_by("position", "id"))
    return c


@router.patch("/collections/{cid}", response=CollectionOut)
def update_collection(request, cid: int, payload: CollectionIn):
    c = get_object_or_404(Collection, pk=cid)
    c.name = payload.name.strip() or c.name
    c.description = payload.description
    c.save()
    return _one(cid)


@router.delete("/collections/{cid}")
def delete_collection(request, cid: int):
    import shutil

    c = get_object_or_404(Collection, pk=cid)
    for track in c.tracks.all():
        if track.optimized_file:
            audio.media_path(track.optimized_file).unlink(missing_ok=True)
    shutil.rmtree(audio.media_path(f"local/{c.pk}"), ignore_errors=True)
    c.delete()
    return {"ok": True}


@router.post("/collections/{cid}/upload", response=TrackOut)
def upload(request, cid: int, file: File[UploadedFile], relative_path: Form[str] = ""):
    """Upload one file of a folder. The browser sends files one by one with their path inside the folder."""
    c = get_object_or_404(Collection, pk=cid)
    name = relative_path or file.name or "audio"
    if Path(name).suffix.lower() not in audio.AUDIO_EXTENSIONS:
        raise HttpError(400, f"{name} isn't an audio file")
    with tempfile.NamedTemporaryFile(suffix=Path(name).suffix, delete=False) as tmp:
        for chunk in file.chunks():
            tmp.write(chunk)
    try:
        track = add_file(c, Path(tmp.name), name, move=True)
    except Exception as exc:
        Path(tmp.name).unlink(missing_ok=True)
        raise HttpError(400, f"Couldn't read {name}: {exc}") from exc
    renumber(c)
    track.refresh_from_db()
    return track


class ImportPathsIn(Schema):
    name: str = ""
    collection_id: int | None = None
    paths: list[str]
    kbps: int | None = None
    mono: bool = True


@router.post("/import-paths", response=JobOut)
def import_paths(request, payload: ImportPathsIn):
    """Copy folders the server can see (local dev) into a collection."""
    paths = [Path(p).expanduser() for p in payload.paths if p.strip()]
    if not paths:
        raise HttpError(400, "Add at least one folder")
    for p in paths:
        if not allowed_path(p):
            raise HttpError(403, f"{p} is outside LOCAL_IMPORT_ROOTS")
        if not p.exists():
            raise HttpError(400, f"{p} doesn't exist")
    if payload.collection_id:
        c = get_object_or_404(Collection, pk=payload.collection_id)
    else:
        c = Collection.objects.create(name=payload.name.strip() or paths[0].name, source_paths=[str(p) for p in paths])
    return enqueue(
        "local_import",
        f"Import {', '.join(p.name for p in paths)}",
        import_paths_task,
        c.pk,
        [str(p) for p in paths],
        payload.kbps,
        payload.mono,
        target=c,
    )


class ReorderIn(Schema):
    track_ids: list[int]


@router.post("/collections/{cid}/reorder")
def reorder(request, cid: int, payload: ReorderIn):
    c = get_object_or_404(Collection, pk=cid)
    tracks = {t.pk: t for t in c.tracks.all()}
    for n, tid in enumerate(payload.track_ids):
        if t := tracks.get(tid):
            t.position = n
            t.save(update_fields=["position"])
    return {"ok": True}


@router.delete("/tracks/{track_id}")
def delete_track(request, track_id: int):
    from core.models import Track

    track = get_object_or_404(Track, pk=track_id, source=Track.Source.LOCAL)
    for f in (track.file, track.optimized_file):
        if f:
            audio.media_path(f).unlink(missing_ok=True)
    track.delete()
    return {"ok": True}
