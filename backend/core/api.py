import mimetypes
import os
import re
import shutil
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.db.models import Sum
from django.http import FileResponse, Http404, HttpResponse, StreamingHttpResponse
from django.shortcuts import get_object_or_404
from ninja import Field, Router, Schema
from ninja.errors import HttpError

from . import audio, packing
from .jobs import enqueue
from .models import Job, Star, Track
from .secrets import SITE_SERVICES, load_credential, mask, save_credential
from .tenancy import household_id

router = Router(tags=["core"])


# ---------- schemas shared across apps ----------


class TrackOut(Schema):
    id: int
    source: str
    title: str
    position: int
    start_ms: int
    duration_ms: int
    size_bytes: int
    bitrate_kbps: int
    channels: int
    optimized_size_bytes: int
    optimized_bitrate_kbps: int
    optimized_mono: bool
    has_file: bool
    has_optimized: bool
    stream_url: str | None
    transcript_status: str | None
    book_id: int | None
    episode_id: int | None
    collection_id: int | None

    @staticmethod
    def resolve_has_file(obj: Track) -> bool:
        return bool(obj.file)

    @staticmethod
    def resolve_has_optimized(obj: Track) -> bool:
        return bool(obj.optimized_file)

    @staticmethod
    def resolve_stream_url(obj: Track) -> str | None:
        return f"/api/media/{obj.best_file}" if obj.best_file else None

    @staticmethod
    def resolve_transcript_status(obj: Track) -> str | None:
        transcript = getattr(obj, "transcript", None)
        return transcript.status if transcript else None


class JobOut(Schema):
    id: int
    kind: str
    title: str
    status: str
    progress: float
    message: str
    error: str
    target_type: str
    target_id: int | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


# ---------- jobs ----------


@router.get("/jobs", response=list[JobOut])
def list_jobs(request, active: bool = False, target_type: str = "", target_id: int | None = None, limit: int = 50):
    qs = Job.objects.filter(household_id=household_id(request))
    if active:
        qs = qs.filter(status__in=[Job.Status.QUEUED, Job.Status.RUNNING])
    if target_type:
        qs = qs.filter(target_type=target_type)
    if target_id is not None:
        qs = qs.filter(target_id=target_id)
    return qs[: min(limit, 200)]


@router.post("/jobs/{job_id}/cancel", response=JobOut)
def cancel_job(request, job_id: int):
    job = get_object_or_404(Job, pk=job_id, household_id=household_id(request))
    if job.status in (Job.Status.QUEUED, Job.Status.RUNNING):
        was_queued = job.status == Job.Status.QUEUED
        job.status = Job.Status.CANCELLED
        job.save(update_fields=["status", "updated_at"])
        if job.celery_id and was_queued:
            from config.celery import app

            app.control.revoke(job.celery_id)
    return job


@router.delete("/jobs/finished")
def clear_finished_jobs(request):
    mine = Job.objects.filter(household_id=household_id(request))
    deleted, _ = mine.exclude(status__in=[Job.Status.QUEUED, Job.Status.RUNNING]).delete()
    return {"deleted": deleted}


# ---------- settings & integrations ----------

SECRET_FIELDS = {
    "openai": ["api_key"],
    "anthropic": ["api_key"],
    "gemini": ["api_key"],
    "xai": ["api_key"],
    "groq": ["api_key"],
    "openrouter": ["api_key"],
    "yoto": ["client_secret"],
}
PLAIN_FIELDS = {
    "yoto": ["client_id"],
    "preferences": [
        "default_kbps",
        "default_mono",
        "card_limit_mb",
        "card_limit_hours",
        "pack_strategy",
        "stt_provider",
        "stt_model",
        "chat_provider",
        "chat_model",
        "groq_context_tokens",
    ],
}
DEFAULTS = {
    "preferences": {
        "default_kbps": audio.DEFAULT_KBPS,
        "default_mono": True,
        "card_limit_mb": 500,
        # Yoto's docs say 5 hours per card, but it accepts far longer cards (a 24-hour card syncs and plays),
        # so size is the real limit and the length check is off (0) unless someone turns it on in Settings.
        "card_limit_hours": 0,
        "pack_strategy": "sequential",
        "stt_provider": "",
        "stt_model": "",
        "chat_provider": "",
        "chat_model": "",
        # Groq's per-minute token limits are far below its models' context windows on most plans.
        "groq_context_tokens": 24000,
    },
}
ENV_FALLBACK = {
    ("openai", "api_key"): "OPENAI_API_KEY",
    ("anthropic", "api_key"): "ANTHROPIC_API_KEY",
    ("gemini", "api_key"): "GEMINI_API_KEY",
    ("xai", "api_key"): "XAI_API_KEY",
    ("groq", "api_key"): "GROQ_API_KEY",
    ("yoto", "client_id"): "YOTO_CLIENT_ID",
    ("yoto", "client_secret"): "YOTO_CLIENT_SECRET",
}


AI_SERVICES = {"openai", "anthropic", "gemini", "xai", "groq", "openrouter"}


def _household():
    from .models import Household
    from .tenancy import current_household_id

    hid = current_household_id()
    return Household.objects.select_related("ai_keys_from").filter(pk=hid).first() if hid else None


def lookup(service: str, key: str) -> tuple[object, str]:
    """A setting's value and where it came from: "own", "shared" (another household's AI key), "server" or ""."""
    stored = load_credential(service)
    if stored.get(key) not in (None, ""):
        return stored[key], "own"
    household = _household() if service in AI_SERVICES else None
    sponsor = household.ai_keys_from if household else None
    if sponsor is not None:
        shared = load_credential(service, sponsor.pk)
        if shared.get(key) not in (None, ""):
            return shared[key], "shared"
    env = ENV_FALLBACK.get((service, key))
    # Keys in the server's environment are the first household's; others only get them when it shares its keys.
    env_allowed = service not in AI_SERVICES or any(h is not None and h.uses_server_keys for h in (household, sponsor))
    if env and env_allowed and (value := getattr(settings, env, "")):
        return value, "server"
    return DEFAULTS.get(service, {}).get(key), ""


def setting(service: str, key: str):
    return lookup(service, key)[0]


def preferences() -> dict:
    return {k: setting("preferences", k) for k in PLAIN_FIELDS["preferences"]}


def yoto_scopes() -> list[str]:
    from yoto.client import SCOPES

    return SCOPES.split()


@router.get("/settings")
def get_settings(request):
    out = {}
    for service in set(SECRET_FIELDS) | set(PLAIN_FIELDS):
        values = {}
        for key in SECRET_FIELDS.get(service, []):
            value, source = lookup(service, key)
            value = value or ""
            # Someone else's key is only ever shown as "set", never even masked.
            values[key] = {"set": bool(value), "masked": mask(value) if source == "own" else "", "source": source}
        for key in PLAIN_FIELDS.get(service, []):
            values[key] = setting(service, key)
        out[service] = values
    out["capabilities"] = {
        "local_import_roots": [str(p) for p in settings.LOCAL_IMPORT_ROOTS],
        "ffmpeg": shutil.which(settings.FFMPEG_BINARY) is not None,
        "yoto_redirect_uri": f"{settings.PUBLIC_BASE_URL}/api/yoto/callback",
        "yoto_scopes": yoto_scopes(),
        "yoto_ready": bool(setting("yoto", "client_id")),
        "email": bool(settings.EMAIL_CONFIGURED),
    }
    if not request.user.is_superuser:
        out["yoto"]["client_secret"]["masked"] = ""
    from .ai import PROVIDERS

    out["providers"] = [
        {"id": p.id, "label": p.label, "stt": p.stt, "chat": p.chat, "key_url": p.key_url} for p in PROVIDERS.values()
    ]
    return out


@router.get("/ai/models")
def ai_models(request, kind: str = "chat", refresh: bool = False):
    """Configured providers and their live model lists, for the model pickers."""
    from . import ai

    if kind not in ("chat", "stt"):
        raise HttpError(400, "kind must be chat or stt")
    if refresh:
        for p in ai.PROVIDERS.values():
            if ai.configured(p.id):
                ai.provider_models(p.id, refresh=True)
    prefs = preferences()
    return {
        "providers": ai.catalog(kind),
        "default": {"provider": prefs[f"{kind}_provider"], "model": prefs[f"{kind}_model"]},
    }


class SettingsIn(Schema):
    service: str
    values: dict


@router.put("/settings")
def put_settings(request, payload: SettingsIn):
    allowed = set(SECRET_FIELDS.get(payload.service, [])) | set(PLAIN_FIELDS.get(payload.service, []))
    if not allowed:
        raise HttpError(400, "Unknown settings group")
    if payload.service in SITE_SERVICES and not request.user.is_superuser:
        raise HttpError(403, "Only a super admin can change the Yoto app")
    save_credential(payload.service, {k: v for k, v in payload.values.items() if k in allowed})
    return get_settings(request)


# ---------- tracks & downsizing ----------


@router.get("/tracks", response=list[TrackOut])
def list_tracks(request, ids: str = "", book_id: int | None = None, collection_id: int | None = None):
    qs = Track.objects.for_household(household_id(request)).select_related("transcript")
    if ids:
        qs = qs.filter(pk__in=[int(i) for i in ids.split(",") if i.strip().isdigit()])
    if book_id:
        qs = qs.filter(book_id=book_id)
    if collection_id:
        qs = qs.filter(collection_id=collection_id)
    return qs


class OptimizeIn(Schema):
    track_ids: list[int]
    kbps: int = Field(audio.DEFAULT_KBPS, ge=16, le=320)
    mono: bool = True


@router.post("/tracks/optimize", response=JobOut)
def optimize_tracks(request, payload: OptimizeIn):
    from .tasks import optimize_tracks_task

    tracks = Track.objects.for_household(household_id(request)).filter(pk__in=payload.track_ids).exclude(file="")
    if not tracks.exists():
        raise HttpError(400, "None of those tracks have audio yet")
    label = f"{payload.kbps} kbps {'mono' if payload.mono else 'stereo'}"
    return enqueue(
        "optimize",
        f"Downsize {tracks.count()} track(s) to {label}",
        optimize_tracks_task,
        list(tracks.values_list("pk", flat=True)),
        payload.kbps,
        payload.mono,
    )


@router.get("/audio/presets")
def bitrate_presets(request):
    prefs = preferences()
    card = int(prefs["card_limit_mb"]) * 1024 * 1024
    return {
        # The saved preference, not the built-in default: dialogs preselect whatever Settings says.
        "default_kbps": int(prefs["default_kbps"] or audio.DEFAULT_KBPS),
        "default_mono": bool(prefs["default_mono"]),
        "presets": [
            {**p, "hours_per_card_mono": round(audio.hours_per_card(p["kbps"], card), 1)}
            for p in audio.BITRATE_PRESETS
        ],
    }


class PackIn(Schema):
    groups: list[dict]  # [{"key": "book:1", "title": "...", "track_ids": [..]}]
    strategy: str = "sequential"
    kbps: int | None = None  # estimate sizes as if downsized to this bitrate
    use_optimized: bool = True
    max_mb: int | None = None
    max_hours: float | None = None
    max_tracks: int = 100


def _item_bytes(track: Track, kbps: int | None, use_optimized: bool) -> int:
    if kbps:
        return audio.estimate_bytes(track.duration_ms, kbps)
    if use_optimized and track.optimized_size_bytes:
        return track.optimized_size_bytes
    return track.size_bytes or audio.estimate_bytes(track.duration_ms, 128)


def build_groups(groups: list[dict], kbps: int | None, use_optimized: bool) -> list[packing.Group]:
    from .tenancy import current_household_id

    ids = [int(t) for g in groups for t in g.get("track_ids", [])]
    tracks = Track.objects.for_household(current_household_id()).in_bulk(ids)
    result = []
    for g in groups:
        items = [
            packing.Item(t.pk, t.title, _item_bytes(t, kbps, use_optimized), t.duration_ms)
            for tid in g.get("track_ids", [])
            if (t := tracks.get(int(tid)))
        ]
        result.append(
            packing.Group(key=str(g.get("key") or len(result)), title=g.get("title") or "Playlist", items=items)
        )
    return result


def pack_limits(payload: PackIn) -> packing.Limits:
    prefs = preferences()
    max_mb = payload.max_mb or int(prefs["card_limit_mb"])
    # A card is 500 MB. Yoto's docs mention 5 hours, but it accepts far longer cards, so length is only checked when a
    # caller asks for it; the old "card length limit" preference no longer applies.
    hours = payload.max_hours or 0
    return packing.Limits(
        max_bytes=max_mb * 1024 * 1024,
        max_tracks=payload.max_tracks,
        max_duration_ms=int(hours * 3600 * 1000),
    )


def run_pack(payload: PackIn) -> tuple[list[packing.Card], packing.Limits]:
    limits = pack_limits(payload)
    groups = build_groups(payload.groups, payload.kbps, payload.use_optimized)
    try:
        return packing.pack(groups, limits, payload.strategy), limits
    except packing.TrackTooLarge as exc:
        raise HttpError(400, str(exc)) from exc


def card_summary(card: packing.Card, limits: packing.Limits) -> dict:
    fill_bytes = card.bytes / limits.max_bytes
    fill_time = card.duration_ms / limits.max_duration_ms if limits.max_duration_ms else 0
    return {
        "title": card.title,
        "bytes": card.bytes,
        "duration_ms": card.duration_ms,
        "track_count": len(card.items),
        "items": [
            {
                "track_id": i.track_id,
                "title": i.title,
                "start_ms": i.start_ms,
                "end_ms": i.end_ms,
                "bytes": i.bytes,
                "duration_ms": i.duration_ms,
            }
            for i in card.items
        ],
        "segments": [{"group": s.group.key, "title": s.group.title, "count": len(s.items)} for s in card.segments],
        "fill": max(fill_bytes, fill_time),
        "bound_by": "time" if fill_time > fill_bytes else "size",
    }


class OptionsIn(PackIn):
    # An Audible book that isn't downloaded yet has no tracks: plan from its length alone.
    estimate_ms: int = 0


def _estimate_groups(duration_ms: int, kbps: int) -> list[packing.Group]:
    part = 30 * 60 * 1000
    count = max(1, -(-duration_ms // part))
    length = duration_ms // count
    items = [packing.Item(0, f"Part {n + 1}", audio.estimate_bytes(length, kbps), length) for n in range(count)]
    return [packing.Group("estimate", "Book", items)]


@router.post("/pack/options")
def pack_options(request, payload: OptionsIn):
    """How many cards each audio size needs: "as is" (the files as they are now) and every downsizing preset."""
    limits = pack_limits(payload)
    current_kbps = None
    choices: list[int | None] = [p["kbps"] for p in audio.BITRATE_PRESETS]
    if not payload.estimate_ms:
        base = build_groups(payload.groups, None, payload.use_optimized)
        total_bytes = sum(i.bytes for g in base for i in g.items)
        total_ms = sum(i.duration_ms for g in base for i in g.items)
        if total_ms:
            current_kbps = round(total_bytes * 8 / (total_ms / 1000) / 1000 / 1.01)
        # Re-encoding at a higher bitrate than the files already have only makes them bigger.
        choices = [None] + [k for k in choices if current_kbps is None or k < current_kbps * 0.9]
    out = []
    for kbps in choices:
        if payload.estimate_ms:
            groups = _estimate_groups(payload.estimate_ms, kbps or audio.DEFAULT_KBPS)
        else:
            groups = build_groups(payload.groups, kbps, payload.use_optimized)
        try:
            cards = packing.pack(groups, limits, payload.strategy)
        except packing.TrackTooLarge:
            out.append({"kbps": kbps, "cards": None, "bytes": 0, "last_fill": 0})
            continue
        out.append(
            {
                "kbps": kbps,
                "cards": len(cards),
                "bytes": sum(c.bytes for c in cards),
                "last_fill": cards[-1].bytes / limits.max_bytes if cards else 0,
            }
        )
    return {"options": out, "current_kbps": current_kbps, "card_bytes": limits.max_bytes}


@router.post("/pack/preview")
def pack_preview(request, payload: PackIn):
    cards, limits = run_pack(payload)
    return {
        "cards": [card_summary(c, limits) for c in cards],
        "total_bytes": sum(c.bytes for c in cards),
        "total_duration_ms": sum(c.duration_ms for c in cards),
        "limit_bytes": limits.max_bytes,
        "limit_duration_ms": limits.max_duration_ms,
    }


# ---------- storage & media ----------


@router.get("/storage")
def storage(request):
    root = Path(settings.MEDIA_ROOT)
    root.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(root)
    mine = Track.objects.for_household(household_id(request))
    agg = mine.aggregate(original=Sum("size_bytes"), optimized=Sum("optimized_size_bytes"))
    return {
        "disk_total": usage.total,
        "disk_free": usage.free,
        "tracks_original_bytes": agg["original"] or 0,
        "tracks_optimized_bytes": agg["optimized"] or 0,
        "track_count": mine.count(),
    }


def media_household(relative: str) -> int | None:
    """Whose audio file this is, so one household can't play another's. Cached: players fetch in many ranges."""
    from django.core.cache import cache
    from django.db.models import Q

    key = f"media-household:{relative}"
    if (cached := cache.get(key)) is not None:
        return cached or None
    track = (
        Track.objects.filter(Q(file=relative) | Q(optimized_file=relative))
        .select_related("book", "episode__podcast", "collection")
        .first()
    )
    owner = track_household_id(track) if track else None
    cache.set(key, owner or 0, 600)
    return owner


def track_household_id(track: Track) -> int | None:
    if track.book_id:
        return track.book.household_id
    if track.episode_id:
        return track.episode.podcast.household_id
    if track.collection_id:
        return track.collection.household_id
    return None


_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


@router.get("/media/{path:path}", url_name="media")
def media(request, path: str):
    """Serve a media file to signed-in users only. nginx does the byte-serving in production."""
    root = Path(settings.MEDIA_ROOT).resolve()
    target = (root / path).resolve()
    if root not in target.parents or not target.is_file():
        raise Http404()
    if media_household(str(target.relative_to(root))) != household_id(request):
        raise Http404()
    if accel := os.getenv("MEDIA_ACCEL_PREFIX"):
        response = HttpResponse()
        response["X-Accel-Redirect"] = f"{accel.rstrip('/')}/{target.relative_to(root)}"
        response["Content-Type"] = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return response
    size = target.stat().st_size
    content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    match = _RANGE_RE.match(request.headers.get("Range", ""))
    if not match:
        response = FileResponse(target.open("rb"), content_type=content_type)
        response["Accept-Ranges"] = "bytes"
        return response
    start = int(match.group(1) or 0)
    end = int(match.group(2) or size - 1)
    end = min(end, size - 1)
    length = end - start + 1

    def chunks():
        with target.open("rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                data = fh.read(min(65536, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    response = StreamingHttpResponse(chunks(), status=206, content_type=content_type)
    response["Content-Range"] = f"bytes {start}-{end}/{size}"
    response["Content-Length"] = str(length)
    response["Accept-Ranges"] = "bytes"
    return response


# ---------- stars (per user) ----------


class StarOut(Schema):
    kind: Star.Kind
    id: int = Field(alias="target_id")
    starred_at: datetime = Field(alias="created_at")


def _star_target(kind: Star.Kind, pk: int, household_id: int):
    from audible_books.models import Book
    from local_audio.models import Collection
    from podcasts.models import Podcast

    model = {Star.Kind.BOOK: Book, Star.Kind.PODCAST: Podcast, Star.Kind.FOLDER: Collection}[kind]
    return get_object_or_404(model, pk=pk, household_id=household_id)


@router.get("/stars", response=list[StarOut])
def list_stars(request):
    return Star.objects.filter(user=request.user)


@router.put("/stars/{kind}/{pk}", response=StarOut)
def add_star(request, kind: Star.Kind, pk: int):
    target = _star_target(kind, pk, household_id(request))
    star, _ = Star.objects.get_or_create(user=request.user, kind=kind, **{kind.value: target})
    return star


@router.delete("/stars/{kind}/{pk}")
def remove_star(request, kind: Star.Kind, pk: int):
    Star.objects.filter(user=request.user, kind=kind, **{f"{kind.value}_id": pk}).delete()
    return {"ok": True}
