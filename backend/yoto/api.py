from datetime import datetime

from django.core.cache import cache
from django.db import transaction
from django.db.models import Count
from django.http import HttpResponseRedirect
from django.shortcuts import get_object_or_404
from ninja import Router, Schema
from ninja.errors import HttpError

from core.api import JobOut, PackIn, TrackOut, card_summary, pack_limits, run_pack
from core.jobs import active_job, enqueue

from . import client, services
from .models import Playlist, PlaylistItem, YotoAccount
from .tasks import sync_playlists_task

router = Router(tags=["yoto"])


# ---------- accounts ----------


class AccountOut(Schema):
    id: int
    name: str
    email: str
    connected: bool
    last_error: str
    playlist_count: int = 0


@router.get("/accounts", response=list[AccountOut])
def list_accounts(request):
    return YotoAccount.objects.annotate(playlist_count=Count("playlists"))


class AccountIn(Schema):
    name: str = "Family"


@router.post("/accounts")
def connect_account(request, payload: AccountIn):
    """Create (or reuse an unconnected) account and return the Yoto sign-in URL to send the browser to."""
    account = YotoAccount.objects.filter(encrypted_tokens="").first() or YotoAccount.objects.create(
        name=payload.name.strip() or "Family"
    )
    try:
        return {"authorize_url": client.authorize_url(account), "account_id": account.pk}
    except client.YotoError as exc:
        raise HttpError(400, str(exc)) from exc


@router.post("/accounts/{account_id}/reconnect")
def reconnect(request, account_id: int):
    account = get_object_or_404(YotoAccount, pk=account_id)
    try:
        return {"authorize_url": client.authorize_url(account), "account_id": account.pk}
    except client.YotoError as exc:
        raise HttpError(400, str(exc)) from exc


@router.get("/callback")
def oauth_callback(request, code: str = "", state: str = "", error: str = "", error_description: str = ""):
    if error:
        return HttpResponseRedirect(f"/yoto?error={error_description or error}")
    account = next((a for a in YotoAccount.objects.all() if (a.pending_login or {}).get("state") == state), None)
    if account is None:
        return HttpResponseRedirect("/yoto?error=Sign-in expired; try again")
    try:
        client.finish_authorize(account, code, state)
    except client.YotoError as exc:
        return HttpResponseRedirect(f"/yoto?error={exc}")
    return HttpResponseRedirect("/yoto?connected=1")


@router.delete("/accounts/{account_id}")
def delete_account(request, account_id: int):
    get_object_or_404(YotoAccount, pk=account_id).delete()
    return {"ok": True}


@router.get("/accounts/{account_id}/cards")
def remote_cards(request, account_id: int):
    account = get_object_or_404(YotoAccount, pk=account_id)
    try:
        with client.Api(account) as api:
            cards = api.my_cards()
    except client.YotoError as exc:
        raise HttpError(502, str(exc)) from exc
    return [
        {
            "card_id": c.get("cardId"),
            "title": c.get("title"),
            "cover": ((c.get("metadata") or {}).get("cover") or {}).get("imageL"),
            "duration": ((c.get("metadata") or {}).get("media") or {}).get("duration"),
            "file_size": ((c.get("metadata") or {}).get("media") or {}).get("fileSize"),
            "updated_at": c.get("updatedAt"),
        }
        for c in cards
    ]


@router.get("/icons")
def icons(request):
    cached = cache.get("yoto-public-icons")
    if cached is not None:
        return cached
    account = YotoAccount.objects.exclude(encrypted_tokens="").first()
    if account is None:
        return []
    try:
        with client.Api(account) as api:
            rows = api.public_icons()
    except client.YotoError:
        return []
    out = [
        {
            "id": f"yoto:#{i['mediaId']}",
            "title": i.get("title", ""),
            "tags": i.get("publicTags", []),
            "url": i.get("url"),
        }
        for i in rows
        if i.get("mediaId")
    ]
    cache.set("yoto-public-icons", out, 60 * 60 * 24)
    return out


# ---------- playlists ----------


class ItemOut(Schema):
    id: int
    position: int
    title: str
    icon: str
    start_ms: int | None
    end_ms: int | None
    track: TrackOut
    uploaded: bool

    @staticmethod
    def resolve_uploaded(obj: PlaylistItem) -> bool:
        return bool(obj.yoto_track)


class PlaylistOut(Schema):
    id: int
    title: str
    description: str
    author: str
    cover_url: str
    icon: str
    card_id: str
    status: str
    use_optimized: bool
    batch: str
    account_id: int | None
    last_synced_at: datetime | None
    last_error: str
    updated_at: datetime
    item_count: int = 0
    total_bytes: int = 0
    total_duration_ms: int = 0


class PlaylistDetailOut(PlaylistOut):
    items: list[ItemOut]
    active_job: JobOut | None = None

    @staticmethod
    def resolve_items(obj: Playlist):
        return list(obj.items.select_related("track", "track__transcript").order_by("position", "id"))

    @staticmethod
    def resolve_active_job(obj: Playlist):
        return active_job(obj)


def item_bytes(item: PlaylistItem, use_optimized: bool) -> int:
    size = item.track.best_size_bytes if use_optimized else item.track.size_bytes
    if item.start_ms is not None or item.end_ms is not None:
        span = (item.end_ms or item.track.duration_ms) - (item.start_ms or 0)
        return int(size * span / max(item.track.duration_ms, 1))
    return size


def with_totals(playlist: Playlist) -> Playlist:
    items = list(playlist.items.select_related("track"))
    playlist.item_count = len(items)
    playlist.total_bytes = sum(item_bytes(i, playlist.use_optimized) for i in items)
    playlist.total_duration_ms = sum(((i.end_ms or i.track.duration_ms) - (i.start_ms or 0)) for i in items)
    return playlist


@router.get("/playlists", response=list[PlaylistOut])
def list_playlists(request, batch: str = ""):
    qs = Playlist.objects.all()
    if batch:
        qs = qs.filter(batch=batch)
    return [with_totals(p) for p in qs]


class PlaylistIn(Schema):
    title: str
    track_ids: list[int] = []
    account_id: int | None = None
    cover_url: str = ""
    author: str = ""


@router.post("/playlists", response=PlaylistDetailOut)
def create_playlist(request, payload: PlaylistIn):
    account = YotoAccount.objects.filter(pk=payload.account_id).first() if payload.account_id else None
    playlist = services.create_playlist(
        payload.title, payload.track_ids, account, payload.cover_url, author=payload.author
    )
    return with_totals(playlist)


class FromPackIn(PackIn):
    account_id: int | None = None
    cover_url: str = ""
    downsize_first: bool = False
    mono: bool = True


@router.post("/playlists/from-pack")
def create_from_pack(request, payload: FromPackIn):
    """Turn a card plan into draft playlists (one per card). Optionally queue downsizing to the planned bitrate."""
    cards, limits = run_pack(payload)
    if not cards:
        raise HttpError(400, "Nothing to put on a card")
    account = YotoAccount.objects.filter(pk=payload.account_id).first() if payload.account_id else None
    playlists = services.create_from_cards(cards, account, payload.cover_url)
    job = None
    if payload.downsize_first and payload.kbps:
        from core.models import Track
        from core.tasks import optimize_tracks_task

        ids = sorted({i.track_id for c in cards for i in c.items})
        stale = Track.objects.filter(pk__in=ids).exclude(
            optimized_bitrate_kbps=payload.kbps, optimized_mono=payload.mono
        )
        if stale.exists():
            job = enqueue(
                "optimize",
                f"Downsize {stale.count()} track(s) to {payload.kbps} kbps for {len(cards)} card(s)",
                optimize_tracks_task,
                list(stale.values_list("pk", flat=True)),
                payload.kbps,
                payload.mono,
            )
    return {
        "batch": playlists[0].batch,
        "playlists": [PlaylistOut.from_orm(with_totals(p)).dict() for p in playlists],
        "cards": [card_summary(c, limits) for c in cards],
        "downsize_job": JobOut.from_orm(job).dict() if job else None,
    }


@router.get("/playlists/{pid}", response=PlaylistDetailOut)
def get_playlist(request, pid: int):
    return with_totals(get_object_or_404(Playlist, pk=pid))


class PlaylistPatch(Schema):
    title: str | None = None
    description: str | None = None
    author: str | None = None
    cover_url: str | None = None
    icon: str | None = None
    use_optimized: bool | None = None
    account_id: int | None = None
    item_ids: list[int] | None = None  # new order; items left out are removed
    add_track_ids: list[int] | None = None


@router.patch("/playlists/{pid}", response=PlaylistDetailOut)
def update_playlist(request, pid: int, payload: PlaylistPatch):
    playlist = get_object_or_404(Playlist, pk=pid)
    with transaction.atomic():
        for field in ("title", "description", "author", "icon", "use_optimized"):
            value = getattr(payload, field)
            if value is not None:
                setattr(playlist, field, value)
        if payload.cover_url is not None and payload.cover_url != playlist.cover_url:
            playlist.cover_url = payload.cover_url
            playlist.yoto_cover_url = ""
        if payload.account_id is not None:
            playlist.account = YotoAccount.objects.filter(pk=payload.account_id).first()
        playlist.save()
        if payload.item_ids is not None:
            keep = {i.pk: i for i in playlist.items.all()}
            playlist.items.exclude(pk__in=payload.item_ids).delete()
            for n, iid in enumerate(payload.item_ids):
                if item := keep.get(iid):
                    item.position = n
                    item.save(update_fields=["position"])
        if payload.add_track_ids:
            start = playlist.items.count()
            for n, tid in enumerate(payload.add_track_ids):
                PlaylistItem.objects.create(playlist=playlist, track_id=tid, position=start + n)
    services.mark_changed(playlist)
    return with_totals(playlist)


@router.delete("/playlists/{pid}")
def delete_playlist(request, pid: int, remote: bool = False):
    playlist = get_object_or_404(Playlist, pk=pid)
    if remote and playlist.card_id and playlist.account:
        try:
            with client.Api(playlist.account) as api:
                api.delete_content(playlist.card_id)
        except client.YotoError as exc:
            raise HttpError(502, f"Couldn't delete it on Yoto: {exc}") from exc
    playlist.delete()
    return {"ok": True}


class SyncIn(Schema):
    playlist_ids: list[int] = []
    batch: str = ""


@router.post("/sync", response=JobOut)
def sync(request, payload: SyncIn):
    qs = Playlist.objects.all()
    if payload.batch:
        qs = qs.filter(batch=payload.batch)
    elif payload.playlist_ids:
        qs = qs.filter(pk__in=payload.playlist_ids)
    else:
        raise HttpError(400, "Choose playlists to sync")
    playlists = list(qs)
    if not playlists:
        raise HttpError(404, "No such playlists")
    if not YotoAccount.objects.exclude(encrypted_tokens="").exists():
        raise HttpError(400, "Connect a Yoto account first")
    target = playlists[0] if len(playlists) == 1 else None
    if target and (job := active_job(target, "yoto_sync")):
        return job
    title = f"Sync “{playlists[0].title}” to Yoto" if target else f"Sync {len(playlists)} cards to Yoto"
    return enqueue("yoto_sync", title, sync_playlists_task, [p.pk for p in playlists], target=target)


@router.get("/limits")
def limits(request):
    payload = PackIn(groups=[])
    lim = pack_limits(payload)
    return {
        "card_bytes": lim.max_bytes,
        "card_duration_ms": lim.max_duration_ms,
        "card_tracks": lim.max_tracks,
        "track_bytes": lim.max_track_bytes,
        "track_duration_ms": lim.max_track_ms,
    }
