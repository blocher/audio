from datetime import date, datetime

from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from ninja import Field, Router, Schema
from ninja.errors import HttpError

from core.api import JobOut, TrackOut, preferences
from core.jobs import active_job, enqueue

from . import client, services
from .models import AudibleAccount, Book
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

    @staticmethod
    def resolve_login_pending(obj: AudibleAccount) -> bool:
        return bool(obj.pending_login)


class BookOut(Schema):
    id: int
    account_id: int
    account_name: str
    asin: str
    title: str
    subtitle: str
    authors: str
    narrators: str
    series: str
    series_position: str
    cover_url: str
    runtime_min: int
    release_date: date | None
    purchase_date: datetime | None
    percent_complete: float
    position_ms: int
    position_synced_at: datetime | None
    is_finished: bool
    status: str
    convert_kbps: int
    convert_mono: bool
    track_count: int = 0
    transcribed_count: int = 0

    @staticmethod
    def resolve_account_name(obj: Book) -> str:
        return obj.account.name


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


def accounts_qs():
    return AudibleAccount.objects.annotate(
        book_count=Count("books"), ready_count=Count("books", filter=Q(books__status=Book.Status.READY))
    )


@router.get("/locales")
def locales(request):
    return [{"code": k, "name": v} for k, v in client.LOCALES.items()]


@router.get("/accounts", response=list[AccountOut])
def list_accounts(request):
    return accounts_qs()


class AccountIn(Schema):
    name: str
    locale: str = "us"


@router.post("/accounts", response=AccountOut)
def create_account(request, payload: AccountIn):
    if payload.locale not in client.LOCALES:
        raise HttpError(400, "Unknown marketplace")
    account = AudibleAccount.objects.create(name=payload.name.strip() or "Audible", locale=payload.locale)
    return accounts_qs().get(pk=account.pk)


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
    return accounts_qs().get(pk=account.pk)


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


@router.delete("/accounts/{account_id}")
def delete_account(request, account_id: int, keep_books: bool = False):
    account = get_object_or_404(AudibleAccount, pk=account_id)
    if account.connected:
        try:
            client.disconnect(account)
        except Exception:  # noqa: BLE001 - still remove it locally
            pass
    for book in account.books.exclude(status=Book.Status.REMOTE):
        services.delete_audio(book)
    account.delete()
    return {"ok": True}


def books_qs():
    return Book.objects.select_related("account").annotate(
        track_count=Count("tracks", distinct=True),
        transcribed_count=Count("tracks", filter=Q(tracks__transcript__status="ready"), distinct=True),
    )


@router.get("/books", response=list[BookOut])
def list_books(
    request,
    account_id: int | None = None,
    q: str = "",
    status: str = "",
    sort: str = "-purchase_date",
):
    qs = books_qs()
    if account_id:
        qs = qs.filter(account_id=account_id)
    if q:
        qs = qs.filter(
            Q(title__icontains=q) | Q(authors__icontains=q) | Q(narrators__icontains=q) | Q(series__icontains=q)
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
    return get_object_or_404(books_qs(), pk=book_id)


class ConvertIn(Schema):
    kbps: int | None = Field(None, ge=16, le=320)
    mono: bool | None = None


@router.post("/books/{book_id}/convert", response=JobOut)
def convert(request, book_id: int, payload: ConvertIn):
    book = get_object_or_404(Book.objects.select_related("account"), pk=book_id)
    if not book.account.connected:
        raise HttpError(400, f"{book.account.name}'s Audible account needs reconnecting")
    if job := active_job(book, "audible_convert"):
        return job
    prefs = preferences()
    kbps = payload.kbps or int(prefs["default_kbps"])
    mono = payload.mono if payload.mono is not None else bool(prefs["default_mono"])
    return enqueue("audible_convert", f"Convert {book.title}", convert_book_task, book.pk, kbps, mono, target=book)


@router.post("/books/{book_id}/position", response=BookOut)
def refresh_position(request, book_id: int):
    book = get_object_or_404(Book.objects.select_related("account"), pk=book_id)
    try:
        services.sync_positions(book.account, [book])
    except Exception as exc:
        raise HttpError(502, f"Couldn't reach Audible: {exc}") from exc
    return books_qs().get(pk=book_id)


@router.delete("/books/{book_id}/audio", response=BookOut)
def delete_book_audio(request, book_id: int):
    book = get_object_or_404(Book, pk=book_id)
    services.delete_audio(book)
    return books_qs().get(pk=book_id)
