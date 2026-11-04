import base64
import hashlib
from urllib.parse import parse_qs, urlsplit

import pytest

from core.secrets import save_credential
from yoto.client import authorize_url
from yoto.models import YotoAccount


@pytest.mark.django_db
def test_authorize_url_uses_pkce():
    save_credential("yoto", {"client_id": "tpc_test", "client_secret": "s3cret"})
    account = YotoAccount.objects.create()
    query = parse_qs(urlsplit(authorize_url(account)).query)

    verifier = account.pending_login["code_verifier"]
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    assert query["code_challenge"] == [expected]
    assert query["code_challenge_method"] == ["S256"]
    assert query["state"] == [account.pending_login["state"]]
