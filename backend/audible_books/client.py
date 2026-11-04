"""Thin wrapper over mkb79's ``audible`` package: device login, library, positions and licenses.

Audible has no public API; these are the endpoints the official apps use (see docs/research/audible.md).
"""

import secrets
from contextlib import contextmanager
from datetime import datetime
from urllib.parse import parse_qs, urlsplit

import audible
from audible.aescipher import decrypt_voucher_from_licenserequest
from audible.localization import Locale
from audible.login import build_oauth_url, create_code_verifier
from audible.register import register
from django.utils.dateparse import parse_date, parse_datetime

from core.secrets import decrypt_json, encrypt_json

from .models import AudibleAccount

LOCALES = {
    "us": "United States",
    "uk": "United Kingdom",
    "ca": "Canada",
    "au": "Australia",
    "de": "Germany",
    "fr": "France",
    "it": "Italy",
    "es": "Spain",
    "in": "India",
    "jp": "Japan",
    "br": "Brazil",
}
LIBRARY_GROUPS = (
    "contributors,media,product_attrs,product_desc,product_details,series,customer_rights,"
    "listening_status,is_finished,percent_complete"
)
LICENSE_HEADERS = {
    "X-ADP-SW": "37801821",
    "X-ADP-Transport": "WIFI",
    "X-ADP-LTO": "120",
    "X-Device-Type-Id": "A2CZJZGLK2JJVM",
    "device_idiom": "phone",
}
DOWNLOAD_USER_AGENT = "Audible/671 CFNetwork/1240.0.4 Darwin/20.6.0"


class AudibleError(Exception):
    pass


# ---------- login ----------


def start_login(account: AudibleAccount) -> str:
    """Step 1: make an Amazon sign-in URL and remember the PKCE verifier and device serial for step 2."""
    if account.locale not in LOCALES:
        raise AudibleError(f"Unknown marketplace {account.locale}")
    loc = Locale(account.locale)
    verifier = create_code_verifier()
    url, serial = build_oauth_url(
        country_code=loc.country_code,
        domain=loc.domain,
        market_place_id=loc.market_place_id,
        code_verifier=verifier,
    )
    account.pending_login = encrypt_json({"code_verifier": verifier.decode(), "serial": serial})
    account.save(update_fields=["pending_login", "updated_at"])
    return url


def finish_login(account: AudibleAccount, redirect_url: str) -> None:
    """Step 2: exchange the code in the pasted maplanding URL and register a device."""
    pending = decrypt_json(account.pending_login)
    if not pending:
        raise AudibleError("Start the sign-in again; the previous attempt expired.")
    code = parse_qs(urlsplit(redirect_url.strip()).query).get("openid.oa2.authorization_code", [""])[0]
    if not code:
        raise AudibleError(
            "That URL has no authorization code. Copy the full address of the page Amazon lands on after "
            "signing in (it contains “maplanding”)."
        )
    loc = Locale(account.locale)
    try:
        reg = register(
            authorization_code=code,
            code_verifier=pending["code_verifier"].encode(),
            domain=loc.domain,
            serial=pending["serial"],
        )
    except Exception as exc:
        raise AudibleError(f"Amazon refused the registration: {exc}") from exc
    auth = audible.Authenticator.from_dict({**reg, "locale_code": account.locale, "with_username": False})
    save_auth(account, auth)
    account.pending_login = ""
    account.last_error = ""
    try:
        profile = auth.user_profile()
        account.email = profile.get("email", "") or account.email
    except Exception:  # noqa: BLE001 - the profile is a nicety
        pass
    account.save(update_fields=["pending_login", "last_error", "email", "updated_at"])


def load_auth(account: AudibleAccount) -> audible.Authenticator:
    data = decrypt_json(account.encrypted_auth)
    if not data:
        raise AudibleError(f"{account.name}'s Audible account isn't connected")
    return audible.Authenticator.from_dict(dict(data))


def save_auth(account: AudibleAccount, auth: audible.Authenticator) -> None:
    account.encrypted_auth = encrypt_json(auth.to_dict())
    account.save(update_fields=["encrypted_auth", "updated_at"])


@contextmanager
def client_for(account: AudibleAccount, timeout: int = 60):
    """A signed client; writes the auth back afterwards in case tokens or activation bytes changed."""
    auth = load_auth(account)
    with audible.Client(auth=auth, timeout=timeout) as client:
        yield client
    save_auth(account, auth)


def disconnect(account: AudibleAccount) -> None:
    """Deregister the virtual device so it disappears from the Amazon device list."""
    try:
        load_auth(account).deregister_device()
    finally:
        account.encrypted_auth = ""
        account.save(update_fields=["encrypted_auth", "updated_at"])


# ---------- library ----------


def fetch_library(account: AudibleAccount) -> list[dict]:
    items: list[dict] = []
    with client_for(account, timeout=120) as client:
        page = 1
        while True:
            data = client.get(
                "1.0/library",
                num_results=1000,
                page=page,
                response_groups=LIBRARY_GROUPS,
                image_sizes="500,1215",
                sort_by="-PurchaseDate",
            )
            batch = data.get("items", [])
            items.extend(batch)
            if len(batch) < 1000:
                break
            page += 1
    return items


def _names(people) -> str:
    return ", ".join(p.get("name", "") for p in (people or []) if p.get("name"))


def book_fields(item: dict) -> dict:
    status = item.get("listening_status") or {}
    all_series = [
        {"title": (s.get("title") or "")[:300], "position": str(s.get("sequence") or "")[:20]}
        for s in (item.get("series") or [])
        if s and s.get("title")
    ]
    series = all_series[0] if all_series else {"title": "", "position": ""}
    images = item.get("product_images") or {}
    release = item.get("release_date")
    purchased = item.get("purchase_date")
    percent = status.get("percent_complete")
    if percent is None:
        percent = item.get("percent_complete") or 0
    return {
        "title": (item.get("title") or "Untitled")[:500],
        "subtitle": (item.get("subtitle") or "")[:500],
        "authors": _names(item.get("authors"))[:500],
        "narrators": _names(item.get("narrators"))[:500],
        "series": series["title"],
        "series_position": series["position"],
        "series_list": all_series,
        "summary": item.get("merchandising_summary") or item.get("publisher_summary") or "",
        "cover_url": images.get("1215") or images.get("500") or "",
        "runtime_min": item.get("runtime_length_min") or 0,
        "release_date": parse_date(release) if release else None,
        "purchase_date": parse_datetime(purchased) if purchased else None,
        "percent_complete": float(percent or 0),
        "is_finished": bool(status.get("is_finished") or item.get("is_finished")),
        "content_type": item.get("content_delivery_type") or item.get("content_type") or "",
        "raw": {
            k: item.get(k) for k in ("asin", "content_delivery_type", "customer_rights", "language", "publisher_name")
        },
    }


def fetch_positions(account: AudibleAccount, asins: list[str]) -> dict[str, tuple[int, datetime | None]]:
    """Last-heard position per ASIN in ms. Audible accepts about 25 ASINs per call."""
    out: dict[str, tuple[int, datetime | None]] = {}
    with client_for(account) as client:
        for i in range(0, len(asins), 25):
            data = client.get("1.0/annotations/lastpositions", asins=",".join(asins[i : i + 25]))
            for row in data.get("asin_last_position_heard_annots", []):
                heard = row.get("last_position_heard") or {}
                if heard.get("status") == "Exists":
                    updated = heard.get("last_updated")
                    out[row["asin"]] = (
                        int(heard.get("position_ms") or 0),
                        parse_datetime(updated) if updated else None,
                    )
    return out


# ---------- download ----------


def license_request(account: AudibleAccount, asin: str) -> dict:
    """Ask for an offline license. Returns url, format, key/iv (AAXC) and chapter info."""
    auth = load_auth(account)
    with audible.Client(auth=auth, timeout=60) as client:
        lr = client.post(
            f"1.0/content/{asin}/licenserequest",
            body={
                "supported_drm_types": ["Mpeg", "Adrm"],
                "quality": "High",
                "consumption_type": "Download",
                "response_groups": "last_position_heard,pdf_url,content_reference,chapter_info",
            },
            headers={**LICENSE_HEADERS, "X-Amzn-RequestId": secrets.token_hex(20).upper()},
        )
    content = lr.get("content_license") or {}
    if content.get("status_code") == "Denied":
        reasons = "; ".join(r.get("message", "") for r in content.get("license_denial_reasons", []))
        raise AudibleError(
            f"Audible denied a download license: {reasons or content.get('message', 'no reason given')}"
        )
    meta = content.get("content_metadata") or {}
    url = (meta.get("content_url") or {}).get("offline_url")
    if not url:
        raise AudibleError("Audible didn't offer a download for this title (multi-part books need each part).")
    fmt = ((meta.get("content_reference") or {}).get("content_format") or "").lower()
    drm: dict = {}
    if fmt != "mpeg":
        voucher = decrypt_voucher_from_licenserequest(auth, lr)
        drm = {"key": voucher["key"], "iv": voucher["iv"]}
    chapters = flatten_chapters((meta.get("chapter_info") or {}).get("chapters", []))
    position = ((meta.get("last_position_heard") or {}).get("position_ms")) or 0
    return {"url": url, "format": fmt or "aaxc", "drm": drm, "chapters": chapters, "position_ms": int(position)}


def flatten_chapters(chapters: list[dict]) -> list[dict]:
    """Audible may nest chapters (parts → chapters); flatten to start/end in book time."""
    flat: list[dict] = []

    def walk(nodes):
        for c in nodes:
            if "start_offset_ms" in c:
                flat.append(
                    {"title": c.get("title") or f"Chapter {len(flat) + 1}", "start_ms": int(c["start_offset_ms"])}
                )
            walk(c.get("chapters") or [])

    walk(chapters)
    flat.sort(key=lambda c: c["start_ms"])
    return flat
