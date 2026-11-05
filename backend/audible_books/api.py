from datetime import date, datetime

from django.db.models import (
    BigIntegerField,
    BooleanField,
    Case,
    Count,
    Exists,
    FloatField,
    OuterRef,
    Q,
    Subquery,
    Sum,
    Value,
    When,
)
from django.db.models.functions import Coalesce
from django.shortcuts import get_object_or_404
from ninja import Field, Router, Schema
from ninja.errors import HttpError

from core.api import JobOut, TrackOut, preferences
from core.jobs import active_job, enqueue
from core.models import Track

from . import client, services
from .models import AudibleAccount, Book, LibraryEntry, Listener
from .tasks import convert_book_task, sync_library_task

router = Router(tags=["audible"])


class AccountOut(Schema):
    id: int
    name: str
    locale: str
    email: str
    connected: bool
    login_pending: bool
    last_synced_at: datetime | None
    last_error: str
    book_count: int = 0
    ready_count: int = 0
    is_mine: bool = False

    @staticmethod
    def resolve_login_pending(obj: AudibleAccount) -> bool:
        return bool(obj.pending_login)


class BookOut(Schema):
    id: int
    # Every library the book is in (family sharing puts one book in several).
    account_ids: list[int]
    account_names: list[str]
    asin: str
    title: str
    subtitle: str
    authors: str
    narrators: str
    series: str
    series_position: str
    series_list: list[dict]
    cover_url: str
    runtime_min: int
    release_date: date | None
    purchase_date: datetime | None
    # Listening state from the viewer's own Audible account, or another library's when it isn't in theirs.
    percent_complete: float
    position_ms: int
    position_synced_at: datetime | None
    is_finished: bool
    position_account: str | None
    position_is_mine: bool
    status: str
    convert_kbps: int
    convert_mono: bool
    track_count: int = 0
    transcribed_count: int = 0
    size_bytes: int = 0  # the chapters at their current size: downsized where done, original otherwise

    @staticmethod
    def resolve_account_ids(obj: Book) -> list[int]:
        return [e.account_id for e in obj.entries.all()]

    @staticmethod
    def resolve_account_names(obj: Book) -> list[str]:
        return [e.account.name for e in obj.entries.all()]


class BookDetailOut(BookOut):
    summary: str
    tracks: list[TrackOut]
    active_job: JobOut | None = None

    @staticmethod
    def resolve_tracks(obj: Book):
        return list(obj.tracks.select_related("transcript").order_by("position"))

    @staticmethod
    def resolve_active_job(obj: Book):
        return active_job(obj)


def accounts_qs(user):
    mine = services.my_account_id(user)
    return AudibleAccount.objects.annotate(
        book_count=Count("entries"),
        ready_count=Count("entries", filter=Q(entries__book__status=Book.Status.READY)),
        is_mine=Case(When(pk=mine, then=Value(True)), default=Value(False), output_field=BooleanField()),
    ).order_by("name", "pk")


@router.get("/locales")
def locales(request):
    return [{"code": k, "name": v} for k, v in client.LOCALES.items()]


@router.get("/accounts", response=list[AccountOut])
def list_accounts(request):
    return accounts_qs(request.user)


class AccountIn(Schema):
    name: str
    locale: str = "us"


@router.post("/accounts", response=AccountOut)
def create_account(request, payload: AccountIn):
    if payload.locale not in client.LOCALES:
        raise HttpError(400, "Unknown marketplace")
    account = AudibleAccount.objects.create(name=payload.name.strip() or "Audible", locale=payload.locale)
    return accounts_qs(request.user).get(pk=account.pk)


@router.post("/accounts/{account_id}/login/start")
def login_start(request, account_id: int):
    account = get_object_or_404(AudibleAccount, pk=account_id)
    return {"login_url": client.start_login(account)}


class LoginFinishIn(Schema):
    redirect_url: str


@router.post("/accounts/{account_id}/login/finish", response=AccountOut)
def login_finish(request, account_id: int, payload: LoginFinishIn):
    account = get_object_or_404(AudibleAccount, pk=account_id)
    try:
        client.finish_login(account, payload.redirect_url)
    except client.AudibleError as exc:
        raise HttpError(400, str(exc)) from exc
    enqueue("audible_sync", f"Sync {account.name}'s Audible library", sync_library_task, account.pk, target=account)
    return accounts_qs(request.user).get(pk=account.pk)


@router.post("/accounts/{account_id}/sync", response=JobOut)
def sync(request, account_id: int):
    account = get_object_or_404(AudibleAccount, pk=account_id)
    if not account.connected:
        raise HttpError(400, "Connect this account first")
    if job := active_job(account, "audible_sync"):
        return job
    return enqueue(
        "audible_sync", f"Sync {account.name}'s Audible library", sync_library_task, account.pk, target=account
    )


@router.post("/accounts/{account_id}/mine", response=AccountOut)
def make_mine(request, account_id: int):
    """Use this account's listening positions for whoever is signed in."""
    account = get_object_or_404(AudibleAccount, pk=account_id)
    Listener.objects.update_or_create(user=request.user, defaults={"account": account})
    return accounts_qs(request.user).get(pk=account.pk)


@router.delete("/accounts/{account_id}")
def delete_account(request, account_id: int):
    account = get_object_or_404(AudibleAccount, pk=account_id)
    if account.connected:
        try:
            client.disconnect(account)
        except Exception:  # noqa: BLE001 - still remove it locally
            pass
    services.remove_account(account)
    return {"ok": True}


def books_qs(user):
    """Each book once, with the listening state of the viewer's own copy (or another library's if not theirs)."""
    mine = services.my_account_id(user)
    entries = (
        LibraryEntry.objects.filter(book=OuterRef("pk"))
        .annotate(theirs=Case(When(account_id=mine, then=Value(0)), default=Value(1)))
        .order_by("theirs", "account__name", "pk")
    )

    # A subquery, so the sum isn't multiplied by the other joins.
    current_bytes = (
        Track.objects.filter(book=OuterRef("pk"))
        .order_by()
        .values("book")
        .annotate(total=Sum(Case(When(optimized_size_bytes__gt=0, then="optimized_size_bytes"), default="size_bytes")))
        .values("total")
    )

    def pick(field: str):
        return Subquery(entries.values(field)[:1])

    return (
        Book.objects.select_related("account")
        .prefetch_related("entries__account")
        .annotate(
            track_count=Count("tracks", distinct=True),
            transcribed_count=Count("tracks", filter=Q(tracks__transcript__status="ready"), distinct=True),
            size_bytes=Coalesce(Subquery(current_bytes), Value(0), output_field=BigIntegerField()),
            purchase_date=pick("purchase_date"),
            percent_complete=Coalesce(pick("percent_complete"), Value(0.0), output_field=FloatField()),
            position_ms=Coalesce(pick("position_ms"), Value(0), output_field=BigIntegerField()),
            position_synced_at=pick("position_synced_at"),
            is_finished=Coalesce(pick("is_finished"), Value(False)),
            position_account=pick("account__name"),
            position_is_mine=Exists(LibraryEntry.objects.filter(book=OuterRef("pk"), account_id=mine)),
        )
    )


@router.get("/books", response=list[BookOut])
def list_books(
    request,
    account_id: int | None = None,
    q: str = "",
    status: str = "",
    sort: str = "-purchase_date",
):
    qs = books_qs(request.user)
    if account_id:
        qs = qs.filter(Exists(LibraryEntry.objects.filter(book=OuterRef("pk"), account_id=account_id)))
    if q:
        qs = qs.filter(
            Q(title__icontains=q)
            | Q(authors__icontains=q)
            | Q(narrators__icontains=q)
            | Q(series__icontains=q)
            | Q(series_list__icontains=q)
        )
    if status == "converted":
        qs = qs.filter(status=Book.Status.READY)
    elif status == "in_progress":
        qs = qs.filter(percent_complete__gt=0, is_finished=False)
    elif status == "finished":
        qs = qs.filter(is_finished=True)
    allowed = {
        "title",
        "-title",
        "-purchase_date",
        "purchase_date",
        "authors",
        "-runtime_min",
        "runtime_min",
        "-release_date",
        "-percent_complete",
    }
    if sort in allowed:
        qs = qs.order_by(sort, "title")
    return qs


@router.get("/books/{book_id}", response=BookDetailOut)
def get_book(request, book_id: int):
    return get_object_or_404(books_qs(request.user), pk=book_id)


class ConvertIn(Schema):
    kbps: int | None = Field(None, ge=16, le=320)
    mono: bool | None = None


@router.post("/books/{book_id}/convert", response=JobOut)
def convert(request, book_id: int, payload: ConvertIn):
    book = get_object_or_404(Book.objects.select_related("account"), pk=book_id)
    if services.download_account(book) is None:
        raise HttpError(400, f"{book.account.name}'s Audible account needs reconnecting")
    if job := active_job(book, "audible_convert"):
        return job
    prefs = preferences()
    kbps = payload.kbps or int(prefs["default_kbps"])
    mono = payload.mono if payload.mono is not None else bool(prefs["default_mono"])
    return enqueue("audible_convert", f"Convert {book.title}", convert_book_task, book.pk, kbps, mono, target=book)


class AskableIn(Schema):
    provider: str | None = None
    model: str | None = None


@router.post("/books/{book_id}/askable", response=JobOut)
def make_askable(request, book_id: int, payload: AskableIn):
    """Convert at the default bitrate (when the book isn't already in it) and transcribe with the default model."""
    from core import ai
    from transcripts.models import Transcript

    from .tasks import make_askable_task

    book = get_object_or_404(Book.objects.select_related("account"), pk=book_id)
    for kind in ("audible_askable", "audible_convert", "transcribe"):
        if job := active_job(book, kind):
            return job
    try:
        provider, model = ai.resolve("stt", payload.provider, payload.model)
    except RuntimeError as exc:
        raise HttpError(400, str(exc)) from exc
    prefs = preferences()
    kbps, mono = int(prefs["default_kbps"]), bool(prefs["default_mono"])
    tracks = book.tracks.exclude(file="")
    transcribed = tracks.filter(transcript__status=Transcript.Status.READY).count()
    # Re-converting replaces the tracks and with them any transcripts, so only redo a conversion nothing depends on.
    in_default = tracks.exists() and (book.convert_kbps, book.convert_mono) == (kbps, mono)
    convert = not tracks.exists() or (not in_default and transcribed == 0)
    if not convert and transcribed == tracks.count():
        raise HttpError(400, "This book is already transcribed; ask away")
    if convert and services.download_account(book) is None:
        raise HttpError(400, f"{book.account.name}'s Audible account needs reconnecting")
    return enqueue(
        "audible_askable",
        f"Make {book.title} askable",
        make_askable_task,
        book.pk,
        kbps if convert else None,
        mono,
        provider,
        model,
        target=book,
    )


@router.post("/books/{book_id}/position", response=BookOut)
def refresh_position(request, book_id: int):
    book = get_object_or_404(Book, pk=book_id)
    entry = services.entry_for(book, request.user)
    if entry is None:
        raise HttpError(400, "This book isn't in any connected Audible library")
    if not entry.account.connected:
        raise HttpError(400, f"{entry.account.name}'s Audible account needs signing in again")
    try:
        services.sync_positions(entry.account, [book])
    except Exception as exc:
        raise HttpError(502, f"Couldn't reach Audible: {exc}") from exc
    return books_qs(request.user).get(pk=book_id)


@router.delete("/books/{book_id}/audio", response=BookOut)
def delete_book_audio(request, book_id: int):
    book = get_object_or_404(Book, pk=book_id)
    services.delete_audio(book)
    return books_qs(request.user).get(pk=book_id)
