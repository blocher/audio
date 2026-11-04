"""Managing the people who can sign in. Admins manage everyone; everyone else manages only themselves."""

from datetime import datetime

from django.contrib.auth import get_user_model, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import transaction
from django.shortcuts import get_object_or_404
from ninja import Router, Schema
from ninja.errors import HttpError

from audible_books.models import AudibleAccount, Listener

router = Router(tags=["users"])
User = get_user_model()


class PersonOut(Schema):
    id: int
    username: str
    first_name: str
    email: str
    is_admin: bool
    audible_account_id: int | None
    last_login: datetime | None
    is_me: bool = False

    @staticmethod
    def resolve_is_admin(obj) -> bool:
        return obj.is_superuser

    @staticmethod
    def resolve_audible_account_id(obj) -> int | None:
        listener = getattr(obj, "audible_listener", None)
        return listener.account_id if listener else None


class PersonIn(Schema):
    username: str
    first_name: str = ""
    email: str = ""
    password: str
    is_admin: bool = False
    audible_account_id: int | None = None


class PersonPatch(Schema):
    username: str | None = None
    first_name: str | None = None
    email: str | None = None
    is_admin: bool | None = None
    # null clears it (back to the first connected account); leaving it out leaves it alone.
    audible_account_id: int | None = None


class PasswordIn(Schema):
    password: str
    current_password: str = ""


def _require_admin(request):
    if not request.user.is_superuser:
        raise HttpError(403, "Only an admin can do that")


def _person(request, user_id: int):
    """The user to act on: anyone for an admin, only yourself otherwise."""
    if user_id != request.user.pk:
        _require_admin(request)
    return get_object_or_404(User.objects.select_related("audible_listener"), pk=user_id)


def _out(request, user):
    user = User.objects.select_related("audible_listener").get(pk=user.pk)
    user.is_me = user.pk == request.user.pk
    return user


def _clean_username(username: str, user=None) -> str:
    username = username.strip()
    if not username:
        raise HttpError(400, "A username is needed")
    taken = User.objects.filter(username__iexact=username)
    if user is not None:
        taken = taken.exclude(pk=user.pk)
    if taken.exists():
        raise HttpError(400, f"Someone is already called “{username}”")
    return username


def _clean_email(email: str) -> str:
    email = email.strip()
    if email:
        try:
            validate_email(email)
        except ValidationError as exc:
            raise HttpError(400, "That email address doesn't look right") from exc
    return email


def _check_password(password: str, user=None) -> None:
    try:
        validate_password(password, user)
    except ValidationError as exc:
        raise HttpError(400, " ".join(exc.messages)) from exc


def _set_audible_account(user, account_id: int | None) -> None:
    if not account_id:
        Listener.objects.filter(user=user).delete()
        return
    account = get_object_or_404(AudibleAccount, pk=account_id)
    Listener.objects.update_or_create(user=user, defaults={"account": account})


def _other_admins(user) -> bool:
    return User.objects.filter(is_superuser=True, is_active=True).exclude(pk=user.pk).exists()


@router.get("", response=list[PersonOut])
def list_people(request):
    people = User.objects.select_related("audible_listener").order_by("first_name", "username")
    if not request.user.is_superuser:
        people = people.filter(pk=request.user.pk)
    people = list(people)
    for person in people:
        person.is_me = person.pk == request.user.pk
    return people


@router.post("", response=PersonOut)
@transaction.atomic
def add_person(request, payload: PersonIn):
    _require_admin(request)
    user = User(
        username=_clean_username(payload.username),
        first_name=payload.first_name.strip()[:150],
        email=_clean_email(payload.email),
        is_superuser=payload.is_admin,
        is_staff=payload.is_admin,
    )
    _check_password(payload.password, user)
    user.set_password(payload.password)
    user.save()
    _set_audible_account(user, payload.audible_account_id)
    return _out(request, user)


@router.patch("/{user_id}", response=PersonOut)
@transaction.atomic
def update_person(request, user_id: int, payload: PersonPatch):
    user = _person(request, user_id)
    fields = payload.dict(exclude_unset=True)
    if "username" in fields:
        user.username = _clean_username(payload.username or "", user)
    if "first_name" in fields:
        user.first_name = (payload.first_name or "").strip()[:150]
    if "email" in fields:
        user.email = _clean_email(payload.email or "")
    if "is_admin" in fields and payload.is_admin != user.is_superuser:
        _require_admin(request)
        if not payload.is_admin and not _other_admins(user):
            raise HttpError(400, "Someone has to stay an admin")
        user.is_superuser = user.is_staff = bool(payload.is_admin)
    user.save()
    if "audible_account_id" in fields:
        _set_audible_account(user, payload.audible_account_id)
    return _out(request, user)


@router.post("/{user_id}/password")
def set_password(request, user_id: int, payload: PasswordIn):
    user = _person(request, user_id)
    is_me = user.pk == request.user.pk
    # Changing your own needs the current one, so a borrowed signed-in phone can't lock you out.
    if is_me and not user.check_password(payload.current_password):
        raise HttpError(400, "Your current password isn't right")
    _check_password(payload.password, user)
    user.set_password(payload.password)
    user.save(update_fields=["password"])
    if is_me:
        update_session_auth_hash(request, user)  # stay signed in here; other devices are signed out
    return {"ok": True}


@router.delete("/{user_id}")
def remove_person(request, user_id: int):
    _require_admin(request)
    user = get_object_or_404(User, pk=user_id)
    if user.pk == request.user.pk:
        raise HttpError(400, "You can't remove yourself")
    user.delete()
    return {"ok": True}
