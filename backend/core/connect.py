"""One-click connections that hand this app a key, so nobody copies and pastes one.

OpenRouter (one account for Claude, GPT, Gemini and Whisper) has an OAuth PKCE flow that returns an API key for the
person who signs in: https://openrouter.ai/docs/use-cases/oauth-pkce. The browser opens it in a popup; when it
comes back, ``/connected`` (a page of the app) tells the window that opened it and closes itself. Without a popup
(blocked, or a phone that opened a tab) the same page carries on to where the person started.
"""

import base64
import hashlib
import secrets
from urllib.parse import urlencode

import httpx
from django.conf import settings
from django.http import HttpResponseRedirect
from ninja import Router, Schema

from .secrets import save_credential
from .tenancy import household_id, membership

router = Router(tags=["connect"])

OPENROUTER_AUTH = "https://openrouter.ai/auth"
OPENROUTER_KEYS = "https://openrouter.ai/api/v1/auth/keys"
PENDING = "connect-pending"


def safe_return(path: str) -> str:
    """Only pages on this site."""
    return path if path.startswith("/") and not path.startswith("//") else ""


def finished_page(service: str, popup: bool, return_to: str, **result) -> HttpResponseRedirect:
    """Where every connection ends: the app's /connected page, which closes the popup or carries on."""
    query = {"service": service, **({"popup": 1} if popup else {}), "return_to": return_to or "/", **result}
    return HttpResponseRedirect(f"/connected?{urlencode(query)}")


class StartIn(Schema):
    return_to: str = ""
    popup: bool = True


@router.post("/openrouter/start")
def openrouter_start(request, payload: StartIn):
    """The OpenRouter sign-in address. The code verifier waits in the session until OpenRouter sends them back."""
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    pending = request.session.get(PENDING, {})
    pending[state] = {"verifier": verifier, "return_to": safe_return(payload.return_to), "popup": payload.popup}
    request.session[PENDING] = dict(list(pending.items())[-5:])  # a few tries at most
    query = {
        "callback_url": f"{settings.PUBLIC_BASE_URL}/api/connect/openrouter/callback",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "key_label": f"Audio · {membership(request.user).household.name}"[:60],
    }
    return {"url": f"{OPENROUTER_AUTH}?{urlencode(query)}"}


@router.get("/openrouter/callback")
def openrouter_callback(request, code: str = "", state: str = "", error: str = ""):
    pending = request.session.get(PENDING, {})
    # OpenRouter echoes state; if it ever doesn't, the most recent attempt is the one coming back.
    attempt = pending.pop(state, None) or (pending.pop(next(reversed(pending)), None) if pending else None)
    request.session[PENDING] = pending
    if attempt is None:
        return finished_page("openrouter", False, "", error="That sign-in expired. Try connecting again.")
    popup, return_to = attempt["popup"], attempt["return_to"]
    if error or not code:
        return finished_page("openrouter", popup, return_to, error="OpenRouter sign-in was cancelled.")
    try:
        response = httpx.post(
            OPENROUTER_KEYS,
            json={"code": code, "code_verifier": attempt["verifier"], "code_challenge_method": "S256"},
            timeout=30,
        )
        response.raise_for_status()
        key = response.json()["key"]
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        return finished_page("openrouter", popup, return_to, error=f"OpenRouter didn't hand over a key ({exc}).")
    save_credential("openrouter", {"api_key": key}, household_id(request))
    return finished_page("openrouter", popup, return_to, connected=1)


@router.post("/openrouter/disconnect")
def openrouter_disconnect(request):
    save_credential("openrouter", {"api_key": None}, household_id(request))
    return {"ok": True}

