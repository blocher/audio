"""Yoto developer API: OAuth (confidential client), audio upload/transcode, MYO card content.

See docs/research/yoto-api.md for the sources behind each call.
"""

import hashlib
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx
from django.conf import settings
from django.db import transaction

from core.secrets import decrypt_json, encrypt_json, load_credential

from .models import YotoAccount

AUTH_BASE = "https://login.yotoplay.com"
API_BASE = "https://api.yotoplay.com"
AUDIENCE = "https://api.yotoplay.com"
SCOPES = "offline_access user:content:manage profile"
# “Music notes” from Yoto's public icon library; used when a chapter has no icon of its own.
DEFAULT_ICON = "yoto:#_WWpLHoOj6iqeREcGkJnGlsis2QSF6znM0UPFdXTjf8"


class YotoError(Exception):
    pass


def app_credentials() -> tuple[str, str]:
    stored = load_credential("yoto")
    client_id = stored.get("client_id") or settings.YOTO_CLIENT_ID
    secret = stored.get("client_secret") or getattr(settings, "YOTO_CLIENT_SECRET", "")
    if not client_id:
        raise YotoError("Add your Yoto app's client ID and secret in Settings (create the app at dashboard.yoto.dev).")
    return client_id, secret


def redirect_uri() -> str:
    return f"{settings.PUBLIC_BASE_URL}/api/yoto/callback"


# ---------- OAuth ----------


def authorize_url(account: YotoAccount) -> str:
    client_id, _ = app_credentials()
    state = secrets.token_urlsafe(24)
    account.pending_login = {"state": state, "created": time.time()}
    account.save(update_fields=["pending_login", "updated_at"])
    query = {
        "audience": AUDIENCE,
        "scope": SCOPES,
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri(),
        "state": state,
    }
    return f"{AUTH_BASE}/authorize?{urlencode(query)}"


def _token_request(data: dict) -> dict:
    client_id, secret = app_credentials()
    body = {"client_id": client_id, **({"client_secret": secret} if secret else {}), **data}
    response = httpx.post(f"{AUTH_BASE}/oauth/token", data=body, timeout=30)
    if response.status_code >= 400:
        try:
            detail = response.json().get("error_description") or response.json().get("error")
        except ValueError:
            detail = response.text[:300]
        raise YotoError(f"Yoto sign-in failed: {detail}")
    tokens = response.json()
    tokens["expires_at"] = time.time() + int(tokens.get("expires_in") or 3600)
    return tokens


def finish_authorize(account: YotoAccount, code: str, state: str) -> None:
    if not state or state != (account.pending_login or {}).get("state"):
        raise YotoError("That sign-in link expired or didn't come from here. Try connecting again.")
    tokens = _token_request({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri()})
    account.encrypted_tokens = encrypt_json(tokens)
    account.pending_login = {}
    account.last_error = ""
    account.email = _email_from_id_token(tokens.get("id_token", "")) or account.email
    account.save()


def _email_from_id_token(token: str) -> str:
    import base64
    import json

    try:
        payload = token.split(".")[1]
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return data.get("email") or data.get("name") or ""
    except (IndexError, ValueError):
        return ""


def access_token(account: YotoAccount) -> str:
    """A valid access token, refreshing under a row lock because Yoto refresh tokens are single-use."""
    tokens = decrypt_json(account.encrypted_tokens)
    if not tokens:
        raise YotoError("Connect your Yoto account first.")
    if tokens.get("expires_at", 0) - 60 > time.time():
        return tokens["access_token"]
    with transaction.atomic():
        locked = YotoAccount.objects.select_for_update().get(pk=account.pk)
        tokens = decrypt_json(locked.encrypted_tokens)
        if tokens.get("expires_at", 0) - 60 <= time.time():
            if not tokens.get("refresh_token"):
                raise YotoError("Yoto session expired; reconnect the account.")
            try:
                fresh = _token_request({"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
            except YotoError as exc:
                locked.last_error = str(exc)
                locked.save(update_fields=["last_error"])
                raise YotoError("Yoto session expired; reconnect the account.") from exc
            fresh.setdefault("refresh_token", tokens["refresh_token"])
            tokens = fresh
            locked.encrypted_tokens = encrypt_json(tokens)
            locked.save(update_fields=["encrypted_tokens", "updated_at"])
        account.encrypted_tokens = locked.encrypted_tokens
    return tokens["access_token"]


# ---------- API ----------


class Api:
    def __init__(self, account: YotoAccount):
        self.account = account
        self.http = httpx.Client(base_url=API_BASE, timeout=60)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.http.close()

    def request(self, method: str, path: str, **kwargs) -> dict:
        extra_headers = kwargs.pop("headers", None) or {}
        for attempt in range(5):
            headers = {"Authorization": f"Bearer {access_token(self.account)}", "Accept": "application/json"}
            headers.update(extra_headers)
            try:
                response = self.http.request(method, path, headers=headers, **kwargs)
            except httpx.TransportError:
                if attempt == 4:
                    raise
                time.sleep(2**attempt)
                continue
            if response.status_code == 429 or response.status_code >= 500:
                if attempt == 4:
                    break
                time.sleep(float(response.headers.get("retry-after") or 2**attempt))
                continue
            if response.status_code >= 400:
                raise YotoError(f"Yoto {method} {path} → {response.status_code}: {response.text[:500]}")
            return response.json() if response.content else {}
        raise YotoError(f"Yoto {method} {path} kept failing ({response.status_code})")

    # ----- audio -----

    def upload_audio(self, path: Path, on_progress=None, timeout_s: int = 900) -> dict:
        """Upload (or reuse) a file and wait for Yoto's transcode. Returns transcodedSha256 and transcodedInfo."""
        sha = sha256(path)
        upload = self.request(
            "GET", "/media/transcode/audio/uploadUrl", params={"sha256": sha, "filename": path.name}
        )["upload"]
        if upload.get("uploadUrl"):
            with path.open("rb") as fh:
                put = httpx.put(upload["uploadUrl"], content=fh, headers={"Content-Type": "audio/mpeg"}, timeout=1800)
            if put.status_code >= 400:
                raise YotoError(f"Upload to Yoto storage failed ({put.status_code})")
        if on_progress:
            on_progress(0.5)
        deadline = time.monotonic() + timeout_s
        delay = 2.0
        while time.monotonic() < deadline:
            data = self.request("GET", f"/media/upload/{upload['uploadId']}/transcoded", params={"loudnorm": "false"})
            transcode = data.get("transcode") or {}
            if transcode.get("transcodedSha256"):
                return {"source_sha256": sha, **transcode}
            percent = ((transcode.get("progress") or {}).get("percent")) or 0
            if on_progress:
                on_progress(0.5 + min(percent, 100) / 200)
            time.sleep(delay)
            delay = min(delay * 1.5, 10)
        raise YotoError(f"Yoto is still transcoding {path.name} after {timeout_s // 60} minutes; try syncing again.")

    def upload_cover(self, image: bytes, content_type: str) -> str:
        data = self.request(
            "POST",
            "/media/coverImage/user/me/upload",
            params={"autoconvert": "true", "coverType": "default"},
            content=image,
            headers={"Content-Type": content_type},
        )
        return data["coverImage"]["mediaUrl"]

    def upload_cover_from_url(self, url: str) -> str:
        data = self.request(
            "POST",
            "/media/coverImage/user/me/upload",
            params={"autoconvert": "true", "coverType": "default", "imageUrl": url},
        )
        return data["coverImage"]["mediaUrl"]

    # ----- content -----

    def save_content(self, body: dict) -> dict:
        return self.request("POST", "/content", json=body)["card"]

    def get_content(self, card_id: str) -> dict:
        return self.request("GET", f"/content/{card_id}")["card"]

    def my_cards(self) -> list[dict]:
        return self.request("GET", "/content/mine")["cards"]

    def delete_content(self, card_id: str) -> None:
        self.request("DELETE", f"/content/{card_id}")

    def public_icons(self) -> list[dict]:
        return self.request("GET", "/media/displayIcons/user/yoto").get("displayIcons", [])


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
