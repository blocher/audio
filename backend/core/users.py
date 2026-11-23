"""The people who can sign in, the households they belong to, and invitations.

Super admins (``is_superuser``) see and manage everyone and invite new people anywhere. A household administrator
(``Member.is_household_admin``, the first person in each household) does the same for their own household only:
invites people into it, adds, edits, resets passwords for and removes the people in it, but never a super admin,
never anyone elsewhere, and never super admin status or moves between households. Everyone else sees the people in
their own household and manages only themselves.
"""

import logging
import secrets
from datetime import datetime, timedelta

from django.conf import settings
from django.contrib.auth import get_user_model, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.mail import send_mail
from django.core.validators import validate_email
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from audible_books.models import AudibleAccount, Listener

from .models import Household, Invite, Member
from .tenancy import household_id, membership

log = logging.getLogger(__name__)
router = Router(tags=["users"])
User = get_user_model()


class AccountRef(Schema):
    id: int
    name: str


class PersonOut(Schema):
    id: int
    username: str
    first_name: str
    email: str
    is_admin: bool
    audible_account_id: int | None
    last_login: datetime | None
    household_id: int
    household_name: str
    # The Audible accounts in their household, to pick theirs from.
    audible_accounts: list[AccountRef]
    features: list[str]
    onboarded: bool
    is_household_admin: bool = False
    is_me: bool = False

    @staticmethod
    def resolve_is_admin(obj) -> bool:
        return obj.is_superuser

    @staticmethod
    def resolve_is_household_admin(obj) -> bool:
        return membership(obj).is_household_admin

    @staticmethod
    def resolve_audible_account_id(obj) -> int | None:
        listener = getattr(obj, "audible_listener", None)
        return listener.account_id if listener else None

    @staticmethod
    def resolve_household_id(obj) -> int:
        return membership(obj).household_id

    @staticmethod
    def resolve_household_name(obj) -> str:
        return membership(obj).household.name

    @staticmethod
    def resolve_audible_accounts(obj) -> list[dict]:
        accounts = AudibleAccount.objects.filter(household_id=membership(obj).household_id).order_by("name", "pk")
        return [{"id": a.pk, "name": a.name} for a in accounts]

    @staticmethod
    def resolve_features(obj) -> list[str]:
        return membership(obj).features

    @staticmethod
    def resolve_onboarded(obj) -> bool:
        return membership(obj).onboarded_at is not None


class PersonIn(Schema):
    username: str
    first_name: str = ""
    email: str = ""
    password: str
    is_admin: bool = False
    is_household_admin: bool = False
    audible_account_id: int | None = None
    household_id: int | None = None  # default: the admin's own household


class PersonPatch(Schema):
    username: str | None = None
    first_name: str | None = None
    email: str | None = None
    is_admin: bool | None = None
    is_household_admin: bool | None = None
    # null clears it (back to the first connected account); leaving it out leaves it alone.
    audible_account_id: int | None = None
    household_id: int | None = None  # move them to another household (super admins only)


class PasswordIn(Schema):
    password: str
    current_password: str = ""


def _require_admin(request):
    if not request.user.is_superuser:
        raise HttpError(403, "Only a super admin can do that")


def _people():
    return User.objects.select_related("audible_listener", "member__household")


def _runs_household(user) -> int | None:
    """The household this person administers, if they're a household administrator."""
    member = Member.objects.filter(user=user, is_household_admin=True).values_list("household_id", flat=True).first()
    return member


def _require_people_admin(request) -> int | None:
    """A super admin (returns None: anywhere) or a household administrator (returns their household)."""
    if request.user.is_superuser:
        return None
    if (hid := _runs_household(request.user)) is None:
        raise HttpError(403, "Only a household administrator can do that")
    return hid


def _manageable(request, user_id: int):
    """Someone else the signed-in person may manage: anyone for a super admin; for a household administrator, people
    in their own household who aren't super admins. Anyone else gets the same 403, so nothing leaks about who
    exists."""
    hid = _require_people_admin(request)
    user = _people().filter(pk=user_id).first()
    if hid is None and user is not None:
        return user
    if user is None or user.is_superuser or not Member.objects.filter(user=user, household_id=hid).exists():
        raise HttpError(403, "You can only manage people in your own library")
    return user


def _person(request, user_id: int):
    """The user to act on: yourself, or someone you manage."""
    if user_id == request.user.pk:
        return get_object_or_404(_people(), pk=user_id)
    return _manageable(request, user_id)


def _other_household_admins(user) -> bool:
    hid = Member.objects.filter(user=user).values_list("household_id", flat=True).first()
    return Member.objects.filter(household_id=hid, is_household_admin=True).exclude(user=user).exists()


def _out(request, user):
    user = _people().get(pk=user.pk)
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


def _clean_email(email: str, user=None) -> str:
    email = email.strip()
    if email:
        try:
            validate_email(email)
        except ValidationError as exc:
            raise HttpError(400, "That email address doesn't look right") from exc
        taken = User.objects.filter(email__iexact=email)
        if user is not None:
            taken = taken.exclude(pk=user.pk)
        if taken.exists():
            raise HttpError(400, f"Someone already signs in with {email}")
    return email


def check_password_strength(password: str, user=None) -> None:
    try:
        validate_password(password, user)
    except ValidationError as exc:
        raise HttpError(400, " ".join(exc.messages)) from exc


def _set_audible_account(user, account_id: int | None) -> None:
    if not account_id:
        Listener.objects.filter(user=user).delete()
        return
    account = get_object_or_404(AudibleAccount, pk=account_id, household_id=membership(user).household_id)
    Listener.objects.update_or_create(user=user, defaults={"account": account})


def _other_admins(user) -> bool:
    return User.objects.filter(is_superuser=True, is_active=True).exclude(pk=user.pk).exists()


@router.get("", response=list[PersonOut])
def list_people(request):
    people = _people().order_by("first_name", "username")
    if not request.user.is_superuser:
        people = people.filter(member__household_id=household_id(request))
    people = list(people)
    for person in people:
        person.is_me = person.pk == request.user.pk
    return people


@router.post("", response=PersonOut)
@transaction.atomic
def add_person(request, payload: PersonIn):
    runs = _require_people_admin(request)
    if runs is not None and (payload.is_admin or (payload.household_id and payload.household_id != runs)):
        raise HttpError(403, "You can only add people to your own library")
    household = get_object_or_404(Household, pk=payload.household_id or household_id(request))
    user = User(
        username=_clean_username(payload.username),
        first_name=payload.first_name.strip()[:150],
        email=_clean_email(payload.email),
        is_superuser=payload.is_admin,
        is_staff=payload.is_admin,
    )
    check_password_strength(payload.password, user)
    user.set_password(payload.password)
    user.save()
    member, _ = Member.objects.update_or_create(
        user=user, defaults={"household": household, "onboarded_at": timezone.now()}
    )
    if payload.is_household_admin and not member.is_household_admin:
        Member.objects.filter(pk=member.pk).update(is_household_admin=True)
    _set_audible_account(user, payload.audible_account_id)
    return _out(request, user)


@router.patch("/{int:user_id}", response=PersonOut)
@transaction.atomic
def update_person(request, user_id: int, payload: PersonPatch):
    user = _person(request, user_id)
    fields = payload.dict(exclude_unset=True)
    if "username" in fields:
        user.username = _clean_username(payload.username or "", user)
    if "first_name" in fields:
        user.first_name = (payload.first_name or "").strip()[:150]
    if "email" in fields:
        user.email = _clean_email(payload.email or "", user)
    if "is_admin" in fields and payload.is_admin != user.is_superuser:
        _require_admin(request)
        if not payload.is_admin and not _other_admins(user):
            raise HttpError(400, "Someone has to stay a super admin")
        user.is_superuser = user.is_staff = bool(payload.is_admin)
    if "is_household_admin" in fields and payload.is_household_admin != membership(user).is_household_admin:
        # Only someone who runs this household (or a super admin) hands it on; nobody makes themselves one.
        runs = _require_people_admin(request)
        if runs is not None and runs != membership(user).household_id:
            raise HttpError(403, "You can only manage people in your own library")
        if not payload.is_household_admin and not _other_household_admins(user):
            raise HttpError(400, "Someone has to stay in charge of this library")
        Member.objects.filter(user=user).update(is_household_admin=bool(payload.is_household_admin))
        user._member_cache = None
    user.save()
    if fields.get("household_id") and fields["household_id"] != membership(user).household_id:
        _require_admin(request)
        household = get_object_or_404(Household, pk=payload.household_id)
        Member.objects.filter(user=user).update(household=household)
        user._member_cache = None
        Listener.objects.filter(user=user).delete()  # their Audible account was in the old household
    if "audible_account_id" in fields:
        _set_audible_account(user, payload.audible_account_id)
    return _out(request, user)


@router.post("/{int:user_id}/password")
def set_password(request, user_id: int, payload: PasswordIn):
    user = _person(request, user_id)
    is_me = user.pk == request.user.pk
    # Changing your own needs the current one, so a borrowed signed-in phone can't lock you out.
    if is_me and not user.check_password(payload.current_password):
        raise HttpError(400, "Your current password isn't right")
    check_password_strength(payload.password, user)
    user.set_password(payload.password)
    user.save(update_fields=["password"])
    if is_me:
        update_session_auth_hash(request, user)  # stay signed in here; other devices are signed out
    return {"ok": True}


@router.delete("/{int:user_id}")
def remove_person(request, user_id: int, everything: bool = False):
    """Remove a login. With ``everything``, also their conversations and invitations, and their library (books,
    downloads, podcasts, folders, cards, keys) when nobody else shares it: as if they had never been here. A household
    administrator only removes people from their own household, which they share, so its library always stays."""
    if user_id == request.user.pk:
        raise HttpError(400, "You can't remove yourself")
    user = _manageable(request, user_id)
    if not everything:
        # Their login goes, and with it any invitation to them, so it doesn't linger on the dashboard.
        Invite.objects.filter(accepted_user=user).delete()
        if user.email:
            Invite.objects.filter(email__iexact=user.email).delete()
        user.delete()
        return {"ok": True, "library_deleted": False}
    from .purge import purge_person

    return {"ok": True, **purge_person(user)}


# ---------- households ----------


class HouseholdOut(Schema):
    id: int
    name: str
    members: list[str]
    shares_ai_keys_from: str | None
    is_mine: bool


def _household_out(request, household: Household) -> dict:
    members = Member.objects.filter(household=household).select_related("user").order_by("user__first_name")
    return {
        "id": household.pk,
        "name": household.name,
        "members": [m.user.first_name or m.user.username for m in members],
        "shares_ai_keys_from": household.ai_keys_from.name if household.ai_keys_from else None,
        "is_mine": household.pk == household_id(request),
    }


@router.get("/households", response=list[HouseholdOut])
def list_households(request):
    _require_admin(request)
    return [_household_out(request, h) for h in Household.objects.select_related("ai_keys_from")]


class HouseholdPatch(Schema):
    name: str | None = None
    # true: use the signed-in super admin's household's AI keys; false: only their own.
    share_my_ai_keys: bool | None = None


@router.patch("/households/{hid}", response=HouseholdOut)
def update_household(request, hid: int, payload: HouseholdPatch):
    if hid != household_id(request) or payload.share_my_ai_keys is not None:
        _require_admin(request)
    elif _require_people_admin(request) not in (None, hid):
        raise HttpError(403, "Only a household administrator can rename the library")
    household = get_object_or_404(Household, pk=hid)
    if payload.name is not None and payload.name.strip():
        household.name = payload.name.strip()[:150]
    if payload.share_my_ai_keys is not None and hid != household_id(request):
        household.ai_keys_from_id = household_id(request) if payload.share_my_ai_keys else None
    household.save()
    return _household_out(request, Household.objects.select_related("ai_keys_from").get(pk=hid))


# ---------- invitations ----------


class InviteOut(Schema):
    id: int
    email: str
    name: str
    joining: str | None
    share_ai_keys: bool
    make_admin: bool
    created_at: datetime
    expires_at: datetime
    emailed_at: datetime | None
    expired: bool
    link: str
    invited_by: str

    @staticmethod
    def resolve_joining(obj: Invite) -> str | None:
        return obj.household.name if obj.household else None

    @staticmethod
    def resolve_expired(obj: Invite) -> bool:
        return obj.expires_at < timezone.now()

    @staticmethod
    def resolve_link(obj: Invite) -> str:
        return invite_link(obj)

    @staticmethod
    def resolve_invited_by(obj: Invite) -> str:
        return (obj.invited_by.first_name or obj.invited_by.username) if obj.invited_by else ""


class InviteIn(Schema):
    email: str
    name: str = ""
    # True: they share the inviter's library (Audible, Yoto, everything). False: a library of their own.
    join_my_library: bool = False
    share_ai_keys: bool = False
    make_admin: bool = False


class InviteSent(Schema):
    invite: InviteOut
    emailed: bool
    email_error: str = ""


def invite_link(invite: Invite) -> str:
    return f"{settings.PUBLIC_BASE_URL}/invite/{invite.token}"


def send_invite(invite: Invite) -> tuple[bool, str]:
    """Email the invitation. Returns (sent, error); with no mail server set up, nothing is sent."""
    if not settings.EMAIL_CONFIGURED:
        return False, ""
    inviter = invite.invited_by.first_name or invite.invited_by.username if invite.invited_by else "Someone"
    greeting = f"Hi {invite.name}," if invite.name else "Hi,"
    what = f"to share {invite.household.name}" if invite.household else "to set up your own audio library"
    body = (
        f"{greeting}\n\n"
        f"{inviter} has invited you {what} on Audio, a private family audiobook app. You can use it to put "
        "audiobooks and podcasts on Yoto cards, and to ask questions about the book you're listening to.\n\n"
        f"Open this link to accept and choose a password:\n{invite_link(invite)}\n\n"
        "It takes about five minutes, and the app walks you through each step. "
        f"The link works for {settings.INVITE_DAYS} days.\n"
    )
    try:
        send_mail(f"{inviter} invited you to Audio", body, None, [invite.email])
    except Exception as exc:  # noqa: BLE001 - the link can still be shared by hand
        log.warning("Couldn't email invite %s: %s", invite.pk, exc)
        return False, str(exc)[:200]
    invite.emailed_at = timezone.now()
    invite.save(update_fields=["emailed_at", "updated_at"])
    return True, ""


def _pending_invites():
    return Invite.objects.filter(accepted_at__isnull=True).select_related("household", "invited_by")


def _invites_for(request):
    """The invitations the signed-in person may see and act on: all for a super admin, their household's otherwise."""
    runs = _require_people_admin(request)
    invites = _pending_invites()
    return invites if runs is None else invites.filter(household_id=runs)


@router.get("/invites", response=list[InviteOut])
def list_invites(request):
    return _invites_for(request)


@router.post("/invites", response=InviteSent)
def create_invite(request, payload: InviteIn):
    runs = _require_people_admin(request)
    if runs is not None and (not payload.join_my_library or payload.share_ai_keys or payload.make_admin):
        raise HttpError(
            403, "You can invite people to share your library. A new library of their own needs a super admin."
        )
    email = payload.email.strip().lower()
    try:
        validate_email(email)
    except ValidationError as exc:
        raise HttpError(400, "That email address doesn't look right") from exc
    if User.objects.filter(email__iexact=email).exists() or User.objects.filter(username__iexact=email).exists():
        raise HttpError(400, f"{email} already has a login")
    # Inviting the same address again replaces the earlier invitation, so only the newest link works.
    _pending_invites().filter(email__iexact=email).delete()
    invite = Invite.objects.create(
        email=email,
        name=payload.name.strip()[:150],
        token=secrets.token_urlsafe(32),
        invited_by=request.user,
        household_id=household_id(request) if payload.join_my_library else None,
        share_ai_keys=payload.share_ai_keys and not payload.join_my_library,
        make_admin=payload.make_admin,
        expires_at=timezone.now() + timedelta(days=settings.INVITE_DAYS),
    )
    emailed, error = send_invite(invite)
    return {"invite": _pending_invites().get(pk=invite.pk), "emailed": emailed, "email_error": error}


@router.post("/invites/{invite_id}/resend", response=InviteSent)
def resend_invite(request, invite_id: int):
    invite = _invites_for(request).filter(pk=invite_id).first()
    if invite is None:
        raise HttpError(404, "No such invitation")
    invite.expires_at = timezone.now() + timedelta(days=settings.INVITE_DAYS)
    invite.save(update_fields=["expires_at", "updated_at"])
    emailed, error = send_invite(invite)
    return {"invite": _pending_invites().get(pk=invite.pk), "emailed": emailed, "email_error": error}


@router.delete("/invites/{invite_id}")
def cancel_invite(request, invite_id: int):
    runs = _require_people_admin(request)
    # Waiting or accepted: either way the record goes for good (an accepted one's login is untouched).
    invites = Invite.objects.all() if runs is None else Invite.objects.filter(household_id=runs)
    get_object_or_404(invites, pk=invite_id).delete()
    return {"ok": True}
