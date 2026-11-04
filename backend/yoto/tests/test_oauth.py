import base64
import hashlib
from urllib.parse import parse_qs, urlsplit

import pytest

from core.secrets import save_credential
from yoto.client import authorize_url
from yoto.models import YotoAccount


@pytest.mark.django_db
def test_authorize_url_uses_pkce(settings):
    settings.CREDENTIAL_ENCRYPTION_KEY = base64.urlsafe_b64encode(b"k" * 32).decode()
    save_credential("yoto", {"client_id": "tpc_test", "client_secret": "s3cret"})
    account = YotoAccount.objects.create()
    query = parse_qs(urlsplit(authorize_url(account)).query)

    verifier = account.pending_login["code_verifier"]
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    assert query["code_challenge"] == [expected]
    assert query["code_challenge_method"] == ["S256"]
    assert query["state"] == [account.pending_login["state"]]


@pytest.mark.django_db
def test_unapproved_scope_error_explains_the_dashboard_fix(client, django_user_model):
    client.force_login(django_user_model.objects.create_user("ben"))
    response = client.get(
        "/api/yoto/callback",
        {
            "error": "access_denied",
            "error_description": "...scopes that have not been pre-approved: offline_access...",
        },
    )
    assert response.status_code == 302
    location = response["Location"]
    assert location.startswith("/yoto?error=") and "dashboard.yoto.dev" in location and "offline_access" in location
