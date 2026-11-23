"""Session login. There is no open sign-up: people join by accepting an invitation from a super admin."""

from django.contrib.auth import authenticate, get_user_model, login, logout
from django.core.cache import cache
from django.db import transaction
from django.middleware.csrf import get_token
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError
from ninja.utils import check_csrf

from .models import Household, Invite, Member
from .tenancy import membership

router = Router(tags=["auth"])
User = get_user_model()

MAX_ATTEMPTS = 8
LOCKOUT_SECONDS = 15 * 60


class LoginIn(Schema):
    username: str  # a username or an email address
    password: str


class UserOut(Schema):
    id: int
    username: str
    first_name: str
    email: str
    is_admin: bool
    household_id: int
    household_name: str
    # What they chose in the wizard; empty means everything.
    features: list[str]
    onboarded: bool
    # Runs their household: invites, edits and removes the people in it.
    is_household_admin: bool = False
    # Set while a super admin is looking at the app as this person.
    impersonator: str | None = None

    @staticmethod
    def resolve_is_admin(obj) -> bool:
        return obj.is_superuser

    @staticmethod
    def resolve_is_household_admin(obj) -> bool:
        return membership(obj).is_household_admin

    @staticmethod
    def resolve_household_id(obj) -> int:
        return membership(obj).household_id

    @staticmethod
    def resolve_household_name(obj) -> str:
        return membership(obj).household.name

    @staticmethod
    def resolve_features(obj) -> list[str]:
        return membership(obj).features

    @staticmethod
    def resolve_onboarded(obj) -> bool:
        return membership(obj).onboarded_at is not None


class SessionOut(Schema):
    authenticated: bool
    user: UserOut | None = None
    csrf_token: str


def _client_ip(request) -> str:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    return forwarded.split(",")[0].strip() or request.META.get("REMOTE_ADDR", "")


def _throttle(request) -> str:
    key = f"login-attempts:{_client_ip(request)}"
    if cache.get(key, 0) >= MAX_ATTEMPTS:
        raise HttpError(429, "Too many attempts. Try again in a few minutes.")
    return key


def _failed(key: str) -> None:
    cache.set(key, cache.get(key, 0) + 1, LOCKOUT_SECONDS)


@router.get("/session", auth=None, response=SessionOut)
def session(request):
    user = request.user if request.user.is_authenticated else None
    if user is not None:
        user.impersonator = request.session.get("impersonator_name")
    return {"authenticated": user is not None, "user": user, "csrf_token": get_token(request)}


@router.post("/login", auth=None, response=SessionOut)
def do_login(request, payload: LoginIn):
    if check_csrf(request, do_login):
        raise HttpError(403, "CSRF check failed; reload the page")
    key = _throttle(request)
    name = payload.username.strip()
    user = authenticate(request, username=name, password=payload.password)
    if user is None and "@" in name:
        # Invited people sign in with their email; older logins may have a separate username.
        match = User.objects.filter(email__iexact=name, is_active=True).order_by("pk").first()
        if match is not None:
            user = authenticate(request, username=match.username, password=payload.password)
    if user is None:
        _failed(key)
        raise HttpError(401, "That email (or username) and password don't match.")
    cache.delete(key)
    login(request, user)
    return {"authenticated": True, "user": user, "csrf_token": get_token(request)}


@router.post("/logout")
def do_logout(request):
    logout(request)
    return {"ok": True}


# ---------- invitations ----------


class InviteInfo(Schema):
    email: str
    name: str
    inviter: str
    joining: str | None  # the household they'll share, or None for a library of their own
    status: str  # "ok" | "expired" | "accepted"
    has_login: bool


def _invite(token: str) -> Invite:
    invite = Invite.objects.select_related("invited_by", "household").filter(token=token).first()
    if invite is None:
        raise HttpError(404, "This invitation link isn't valid. Ask whoever invited you to send a new one.")
    return invite


def _status(invite: Invite) -> str:
    if invite.accepted_at:
        return "accepted"
    if invite.expires_at < timezone.now():
        return "expired"
    return "ok"


@router.get("/invites/{token}", auth=None, response=InviteInfo)
def invite_info(request, token: str):
    invite = _invite(token)
    inviter = invite.invited_by
    return {
        "email": invite.email,
        "name": invite.name,
        "inviter": (inviter.first_name or inviter.username) if inviter else "",
        "joining": invite.household.name if invite.household else None,
        "status": _status(invite),
        "has_login": User.objects.filter(email__iexact=invite.email).exists(),
    }


class AcceptIn(Schema):
    name: str
    password: str


@router.post("/invites/{token}/accept", auth=None, response=SessionOut)
def accept_invite(request, token: str, payload: AcceptIn):
    from .users import check_password_strength

    if check_csrf(request, accept_invite):
        raise HttpError(403, "CSRF check failed; reload the page")
    key = _throttle(request)
    invite = _invite(token)
    status = _status(invite)
    if status == "accepted":
        raise HttpError(400, "This invitation has already been used. Sign in with your email and password instead.")
    if status == "expired":
        _failed(key)
        raise HttpError(400, "This invitation has expired. Ask whoever invited you to send a new one.")
    email = invite.email.strip().lower()
    if User.objects.filter(email__iexact=email).exists() or User.objects.filter(username__iexact=email).exists():
        raise HttpError(400, "You already have a login. Sign in with your email and password instead.")
    name = payload.name.strip()[:150] or invite.name or email.split("@")[0]
    user = User(username=email, email=email, first_name=name)
    check_password_strength(payload.password, user)
    with transaction.atomic():
        if invite.make_admin:
            user.is_superuser = user.is_staff = True
        user.set_password(payload.password)
        user.save()
        household = invite.household
        if household is None:
            sponsor = membership(invite.invited_by).household if invite.share_ai_keys and invite.invited_by else None
            household = Household.objects.create(name=f"{name}'s library", ai_keys_from=sponsor)
        Member.objects.update_or_create(user=user, defaults={"household": household})
        invite.accepted_at = timezone.now()
        invite.accepted_user = user
        invite.save(update_fields=["accepted_at", "accepted_user", "updated_at"])
    cache.delete(key)
    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    return {"authenticated": True, "user": user, "csrf_token": get_token(request)}
