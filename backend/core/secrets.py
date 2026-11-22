"""Encrypt integration secrets at rest with Fernet."""

import base64
import hashlib
import json

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured


def fernet() -> Fernet:
    key = settings.CREDENTIAL_ENCRYPTION_KEY
    if not key:
        if not settings.DEBUG:
            raise ImproperlyConfigured("CREDENTIAL_ENCRYPTION_KEY is required outside development")
        key = base64.urlsafe_b64encode(hashlib.sha256(settings.SECRET_KEY.encode()).digest()).decode()
    return Fernet(key.encode())


def encrypt_json(payload: dict) -> str:
    return fernet().encrypt(json.dumps(payload).encode()).decode()


def decrypt_json(token: str) -> dict:
    if not token:
        return {}
    try:
        return json.loads(fernet().decrypt(token.encode()).decode())
    except (InvalidToken, json.JSONDecodeError) as exc:
        raise ImproperlyConfigured("Stored credentials cannot be decrypted") from exc


# The whole site's, not one household's: the Yoto developer app every household signs in through.
SITE_SERVICES = {"yoto"}
_CURRENT = object()


def _owner(service: str, household_id) -> int | None:
    if service in SITE_SERVICES:
        return None
    if household_id is _CURRENT:
        from .tenancy import current_household_id

        return current_household_id()
    return household_id


def load_credential(service: str, household_id=_CURRENT) -> dict:
    """A service's stored values: the site's for site services, else the (current) household's."""
    from .models import Credential

    owner = _owner(service, household_id)
    if owner is None and service not in SITE_SERVICES:
        return {}
    row = Credential.objects.filter(service=service, household_id=owner).first()
    return decrypt_json(row.encrypted_payload) if row else {}


def save_credential(service: str, values: dict, household_id=_CURRENT) -> dict:
    """Merge non-empty values into the stored secret; an explicit None clears a key."""
    from .models import Credential

    owner = _owner(service, household_id)
    if owner is None and service not in SITE_SERVICES:
        raise ValueError(f"No household to save {service} settings for")
    merged = load_credential(service, owner)
    for key, value in values.items():
        if value is None:
            merged.pop(key, None)
        elif value != "":
            merged[key] = value
    Credential.objects.update_or_create(
        service=service, household_id=owner, defaults={"encrypted_payload": encrypt_json(merged)}
    )
    return merged


def mask(value: str) -> str:
    return f"••••{value[-4:]}" if value else ""
