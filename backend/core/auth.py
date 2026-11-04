"""Session login for the one or two people who use this app. There is no sign-up."""

from django.contrib.auth import authenticate, login, logout
from django.core.cache import cache
from django.middleware.csrf import get_token
from ninja import Router, Schema
from ninja.errors import HttpError
from ninja.utils import check_csrf

router = Router(tags=["auth"])

MAX_ATTEMPTS = 8
LOCKOUT_SECONDS = 15 * 60


class LoginIn(Schema):
    username: str
    password: str


class UserOut(Schema):
    id: int
    username: str
    first_name: str
    email: str
    is_admin: bool

    @staticmethod
    def resolve_is_admin(obj) -> bool:
        return obj.is_superuser


class SessionOut(Schema):
    authenticated: bool
    user: UserOut | None = None
    csrf_token: str


def _client_ip(request) -> str:
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    return forwarded.split(",")[0].strip() or request.META.get("REMOTE_ADDR", "")


@router.get("/session", auth=None, response=SessionOut)
def session(request):
    user = request.user if request.user.is_authenticated else None
    return {"authenticated": user is not None, "user": user, "csrf_token": get_token(request)}


@router.post("/login", auth=None, response=SessionOut)
def do_login(request, payload: LoginIn):
    if check_csrf(request, do_login):
        raise HttpError(403, "CSRF check failed; reload the page")
    key = f"login-attempts:{_client_ip(request)}"
    attempts = cache.get(key, 0)
    if attempts >= MAX_ATTEMPTS:
        raise HttpError(429, "Too many attempts. Try again in a few minutes.")
    user = authenticate(request, username=payload.username.strip(), password=payload.password)
    if user is None:
        cache.set(key, attempts + 1, LOCKOUT_SECONDS)
        raise HttpError(401, "That username and password don't match.")
    cache.delete(key)
    login(request, user)
    return {"authenticated": True, "user": user, "csrf_token": get_token(request)}


@router.post("/logout")
def do_logout(request):
    logout(request)
    return {"ok": True}
