from datetime import datetime
from urllib.parse import urlencode

from django.core.cache import cache
from django.db import transaction
from django.db.models import Count
from django.http import HttpResponseRedirect
from django.shortcuts import get_object_or_404
from ninja import Router, Schema
from ninja.errors import HttpError

from core import packing
from core.api import JobOut, PackIn, TrackOut, build_groups, card_summary, pack_limits, run_pack
from core.jobs import active_job, enqueue
from core.models import Job, Track
from core.tenancy import household_id

from . import client, services
from .models import Playlist, PlaylistItem, YotoAccount
from .tasks import send_to_yoto_task, sync_playlists_task

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
    return YotoAccount.objects.filter(household_id=household_id(request)).annotate(playlist_count=Count("playlists"))


class AccountIn(Schema):
    name: str = "Family"
    return_to: str = ""  # where to land after signing in, e.g. the welcome wizard
    popup: bool = False  # signing in in a popup window, which closes itself afterwards


@router.post("/accounts")
def connect_account(request, payload: AccountIn):
    """Create (or reuse an unconnected) account and return the Yoto sign-in URL to send the browser to."""
    mine = YotoAccount.objects.filter(household_id=household_id(request))
    account = mine.filter(encrypted_tokens="").first() or YotoAccount.objects.create(
        household_id=household_id(request), name=payload.name.strip() or "Family"
    )
    try:
        url = client.authorize_url(account, payload.return_to, payload.popup)
        return {"authorize_url": url, "account_id": account.pk}
    except client.YotoError as exc:
        raise HttpError(400, str(exc)) from exc


@router.post("/accounts/{account_id}/reconnect")
def reconnect(request, account_id: int, return_to: str = ""):
    account = get_object_or_404(YotoAccount, pk=account_id, household_id=household_id(request))
    try:
        return {"authorize_url": client.authorize_url(account, return_to), "account_id": account.pk}
    except client.YotoError as exc:
        raise HttpError(400, str(exc)) from exc


def _back_to_yoto(return_to: str = "", popup: bool = False, **params) -> HttpResponseRedirect:
    if popup:
        from core.connect import finished_page

        return finished_page("yoto", True, return_to or "/yoto", **params)
    page = return_to or "/yoto"
    joiner = "&" if "?" in page else "?"
    return HttpResponseRedirect(f"{page}{joiner}{urlencode({**params, 'service': 'yoto'})}")


@router.get("/callback")
def oauth_callback(request, code: str = "", state: str = "", error: str = "", error_description: str = ""):
    mine = YotoAccount.objects.filter(household_id=household_id(request))
    account = next((a for a in mine if state and (a.pending_login or {}).get("state") == state), None)
    pending = (account.pending_login or {}) if account else {}
    return_to, popup = pending.get("return_to", ""), bool(pending.get("popup"))
    if error:
        if "pre-approved" in error_description:
            scopes = ", ".join(client.SCOPES.split())
            return _back_to_yoto(
                return_to,
                popup,
                error=f"Your Yoto app isn't allowed all the scopes it needs. At dashboard.yoto.dev, open the app, "
                f"tick {scopes}, save, then connect again.",
            )
        return _back_to_yoto(return_to, popup, error=error_description or error)
    if account is None:
        return _back_to_yoto(error="Sign-in expired; try again")
    try:
        client.finish_authorize(account, code, state)
    except client.YotoError as exc:
        return _back_to_yoto(return_to, popup, error=str(exc))
    return _back_to_yoto(return_to, popup, connected=1)


@router.delete("/accounts/{account_id}")
def delete_account(request, account_id: int):
    get_object_or_404(YotoAccount, pk=account_id, household_id=household_id(request)).delete()
    return {"ok": True}


@router.get("/accounts/{account_id}/cards")
def remote_cards(request, account_id: int):
    account = get_object_or_404(YotoAccount, pk=account_id, household_id=household_id(request))
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


def _account(request, account_id: int | None) -> YotoAccount | None:
    if not account_id:
        return None
    return YotoAccount.objects.filter(pk=account_id, household_id=household_id(request)).first()


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
    qs = Playlist.objects.filter(household_id=household_id(request))
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
    account = _account(request, payload.account_id)
    mine = Track.objects.for_household(household_id(request))
    track_ids = list(mine.filter(pk__in=payload.track_ids).values_list("pk", flat=True))
    track_ids.sort(key=payload.track_ids.index)
    playlist = services.create_playlist(
        payload.title, track_ids, account, payload.cover_url, author=payload.author, household_id=household_id(request)
    )
    return with_totals(playlist)


class FromPackIn(PackIn):
    account_id: int | None = None
    cover_url: str = ""
    name: str = ""  # titles the cards "Name (n of N)"; blank names each card after what's on it
    downsize_first: bool = False
    mono: bool = True


@router.post("/playlists/from-pack")
def create_from_pack(request, payload: FromPackIn):
    """Turn a card plan into draft playlists (one per card). Optionally queue downsizing to the planned bitrate."""
    cards, limits = run_pack(payload)
    if not cards:
        raise HttpError(400, "Nothing to put on a card")
    account = _account(request, payload.account_id)
    playlists = services.create_from_cards(cards, account, payload.cover_url, payload.name)
    job = None
    if payload.downsize_first and payload.kbps:
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
    return with_totals(get_object_or_404(Playlist, pk=pid, household_id=household_id(request)))


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
    playlist = get_object_or_404(Playlist, pk=pid, household_id=household_id(request))
    with transaction.atomic():
        for field in ("title", "description", "author", "icon", "use_optimized"):
            value = getattr(payload, field)
            if value is not None:
                setattr(playlist, field, value)
        if payload.cover_url is not None and payload.cover_url != playlist.cover_url:
            playlist.cover_url = payload.cover_url
            playlist.yoto_cover_url = ""
        if payload.account_id is not None:
            playlist.account = _account(request, payload.account_id)
        playlist.save()
        if payload.item_ids is not None:
            keep = {i.pk: i for i in playlist.items.all()}
            playlist.items.exclude(pk__in=payload.item_ids).delete()
            for n, iid in enumerate(payload.item_ids):
                if item := keep.get(iid):
                    item.position = n
                    item.save(update_fields=["position"])
        if payload.add_track_ids:
            # Added tracks go on the end, cut into parts like the planner does when they break Yoto's per-track limits.
            [group] = build_groups([{"track_ids": payload.add_track_ids}], None, playlist.use_optimized)
            limits = packing.Limits()
            start = playlist.items.count()
            parts = [p for i in group.items for p in packing.split_long(i, limits)]
            for n, item in enumerate(parts):
                PlaylistItem.objects.create(
                    playlist=playlist,
                    track_id=item.track_id,
                    position=start + n,
                    start_ms=item.start_ms,
                    end_ms=item.end_ms,
                    title=item.title[:300] if item.custom_title else "",
                )
    services.mark_changed(playlist)
    return with_totals(playlist)


def _remove_from_yoto(playlist: Playlist) -> None:
    # A batch sync has no single target, so also catch a playlist that's mid-sync while any sync is running.
    batch_syncing = (
        playlist.status == Playlist.Status.SYNCING
        and Job.objects.filter(
            household_id=playlist.household_id, kind="yoto_sync", status__in=[Job.Status.QUEUED, Job.Status.RUNNING]
        ).exists()
    )
    if active_job(playlist, "yoto_sync") or batch_syncing:
        raise HttpError(409, "This card is syncing to Yoto; wait for it to finish, then delete it.")
    try:
        services.remove_from_yoto(playlist)
    except client.YotoError as exc:
        raise HttpError(502, f"Couldn't delete it on Yoto: {exc}") from exc


@router.delete("/playlists/{pid}")
def delete_playlist(request, pid: int, remote: bool = False):
    """Delete the playlist here. With remote, delete its card from the Yoto account first."""
    playlist = get_object_or_404(Playlist, pk=pid, household_id=household_id(request))
    if remote:
        _remove_from_yoto(playlist)
    playlist.delete()
    return {"ok": True}


@router.delete("/playlists/{pid}/yoto", response=PlaylistDetailOut)
def delete_from_yoto(request, pid: int):
    """Delete the card from the Yoto account but keep the playlist here as a draft."""
    playlist = get_object_or_404(Playlist, pk=pid, household_id=household_id(request))
    _remove_from_yoto(playlist)
    return with_totals(playlist)


class SyncIn(Schema):
    playlist_ids: list[int] = []
    batch: str = ""


@router.post("/sync", response=JobOut)
def sync(request, payload: SyncIn):
    qs = Playlist.objects.filter(household_id=household_id(request))
    if payload.batch:
        qs = qs.filter(batch=payload.batch)
    elif payload.playlist_ids:
        qs = qs.filter(pk__in=payload.playlist_ids)
    else:
        raise HttpError(400, "Choose playlists to sync")
    playlists = list(qs)
    if not playlists:
        raise HttpError(404, "No such playlists")
    if not YotoAccount.objects.filter(household_id=household_id(request)).exclude(encrypted_tokens="").exists():
        raise HttpError(400, "Connect a Yoto account first")
    target = playlists[0] if len(playlists) == 1 else None
    if target and (job := active_job(target, "yoto_sync")):
        return job
    title = f"Sync “{playlists[0].title}” to Yoto" if target else f"Sync {len(playlists)} cards to Yoto"
    return enqueue("yoto_sync", title, sync_playlists_task, [p.pk for p in playlists], target=target)


class SendIn(Schema):
    groups: list[dict] = []  # tracks already here: [{"key", "title", "track_ids"}]
    book_id: int | None = None  # or an Audible book, converted first if it isn't yet
    strategy: str = "sequential"
    kbps: int | None = None  # downsize (or, for a book not converted yet, convert) to this bitrate; None = as is
    mono: bool | None = None
    name: str = ""
    cover_url: str = ""
    # Chosen by the browser, so "Try again" after a failure carries on with the same cards instead of making more.
    batch: str = ""


@router.post("/send", response=JobOut)
def send(request, payload: SendIn):
    """Make the cards and put them on Yoto in one go, as a single background job."""
    import re
    import uuid

    from audible_books.models import Book
    from audible_books.services import download_account
    from core.api import preferences

    hid = household_id(request)
    if not YotoAccount.objects.filter(household_id=hid).exclude(encrypted_tokens="").exists():
        raise HttpError(400, "Connect your Yoto account first")
    prefs = preferences()
    mono = payload.mono if payload.mono is not None else bool(prefs["default_mono"])
    kbps, convert_kbps, target, groups = payload.kbps, None, None, payload.groups
    strategy = payload.strategy if payload.strategy in ("continuous", "sequential", "compact") else "sequential"
    if payload.book_id is not None:
        book = get_object_or_404(Book.objects.select_related("account"), pk=payload.book_id, household_id=hid)
        target = book
        if job := active_job(book, "yoto_send"):
            return job
        if active_job(book, "audible_convert") or active_job(book, "audible_askable"):
            raise HttpError(409, "This book is still being downloaded. Try again once that's finished.")
        if not book.tracks.exclude(file="").exists():
            if download_account(book) is None:
                raise HttpError(400, f"{book.account.name}'s Audible account needs signing in again")
            convert_kbps, kbps = payload.kbps or int(prefs["default_kbps"]), None
        title, strategy = book.title, "sequential"
    else:
        if not any(g.get("track_ids") for g in groups):
            raise HttpError(400, "Pick something to put on the cards")
        title = payload.name.strip() or (groups[0].get("title") if len(groups) == 1 else f"{len(groups)} picks")
    if convert_kbps is None:
        # Check it fits before queueing, so a track that's too big shows up here rather than minutes later.
        probe = groups
        if payload.book_id is not None:
            ids = list(target.tracks.exclude(file="").values_list("pk", flat=True))
            probe = [{"key": "book", "title": title, "track_ids": ids}]
        run_pack(PackIn(groups=probe, strategy=strategy, kbps=kbps, use_optimized=True))
    return enqueue(
        "yoto_send",
        f"Send “{title}” to Yoto",
        send_to_yoto_task,
        groups,
        strategy,
        kbps,
        mono,
        payload.name,
        payload.cover_url,
        payload.batch if re.fullmatch(r"[0-9a-f]{8,32}", payload.batch) else uuid.uuid4().hex[:12],
        payload.book_id,
        convert_kbps,
        target=target,
    )


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
