"""One-click connections: OpenRouter's sign-in hands over a key; popups land on /connected."""

import base64
import hashlib
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from core.models import Household, Member
from core.secrets import load_credential, save_credential

PW = "a-long-enough-password-1"


@pytest.fixture(autouse=True)
def encryption_key(settings):
    settings.CREDENTIAL_ENCRYPTION_KEY = base64.urlsafe_b64encode(b"k" * 32).decode()


@pytest.fixture
def me(client, django_user_model):
    user = django_user_model.objects.create_user("sam", password=PW, first_name="Sam")
    client.force_login(user)
    return user


def start(client, **body) -> dict:
    url = client.post("/api/connect/openrouter/start", body, content_type="application/json").json()["url"]
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


def test_openrouter_sign_in_saves_the_key_it_hands_over(client, me, household, monkeypatch, settings):
    query = start(client, return_to="/welcome?step=ai")
    assert query["code_challenge_method"] == "S256"
    assert query["callback_url"] == f"{settings.PUBLIC_BASE_URL}/api/connect/openrouter/callback"
    sent = {}

    def fake_post(url, json, timeout):
        sent.update(url=url, **json)
        return httpx.Response(200, json={"key": "sk-or-v1-abc"}, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    back = client.get(f"/api/connect/openrouter/callback?code=c0de&state={query['state']}")
    assert back.status_code == 302
    landing = parse_qs(urlparse(back["Location"]).query)
    assert urlparse(back["Location"]).path == "/connected"
    assert landing["connected"] == ["1"] and landing["popup"] == ["1"] and landing["return_to"] == ["/welcome?step=ai"]
    # The verifier matches the challenge OpenRouter was shown.
    digest = base64.urlsafe_b64encode(hashlib.sha256(sent["code_verifier"].encode()).digest()).rstrip(b"=").decode()
    assert digest == query["code_challenge"] and sent["code"] == "c0de"
    assert load_credential("openrouter", household.pk)["api_key"] == "sk-or-v1-abc"
    assert client.get("/api/onboarding").json()["ai"] == {"transcribe": True, "ask": True, "borrowed": False}
    # The same code can't be replayed.
    again = client.get(f"/api/connect/openrouter/callback?code=c0de&state={query['state']}")
    assert "error" in parse_qs(urlparse(again["Location"]).query)


def test_a_cancelled_or_failed_sign_in_says_so(client, me, household, monkeypatch):
    query = start(client)
    cancelled = client.get(f"/api/connect/openrouter/callback?error=access_denied&state={query['state']}")
    assert "cancelled" in parse_qs(urlparse(cancelled["Location"]).query)["error"][0]

    query = start(client)
    monkeypatch.setattr(
        httpx, "post", lambda url, json, timeout: httpx.Response(403, request=httpx.Request("POST", url))
    )
    failed = client.get(f"/api/connect/openrouter/callback?code=x&state={query['state']}")
    assert "error" in parse_qs(urlparse(failed["Location"]).query)
    assert load_credential("openrouter", household.pk) == {}


def test_the_key_belongs_to_the_household_that_signed_in(client, me, household, django_user_model, monkeypatch):
    other = Household.objects.create(name="Theirs")
    query = start(client)
    monkeypatch.setattr(
        httpx,
        "post",
        lambda url, json, timeout: httpx.Response(200, json={"key": "sk-or-1"}, request=httpx.Request("POST", url)),
    )
    client.get(f"/api/connect/openrouter/callback?code=c&state={query['state']}")
    assert load_credential("openrouter", other.pk) == {}
    assert client.post("/api/connect/openrouter/disconnect").status_code == 200
    assert load_credential("openrouter", household.pk) == {}


def test_yoto_in_a_popup_lands_on_the_connected_page(client, me, monkeypatch):
    import re

    from yoto import client as yoto_client

    save_credential("yoto", {"client_id": "app"})
    started = client.post(
        "/api/yoto/accounts", {"return_to": "/welcome?step=yoto", "popup": True}, content_type="application/json"
    )
    state = re.search(r"state=([^&]+)", started.json()["authorize_url"]).group(1)
    monkeypatch.setattr(yoto_client, "finish_authorize", lambda account, code, state: None)
    back = client.get(f"/api/yoto/callback?code=c&state={state}")
    assert urlparse(back["Location"]).path == "/connected"
    assert parse_qs(urlparse(back["Location"]).query)["service"] == ["yoto"]
    denied = client.post("/api/yoto/accounts", {"popup": True}, content_type="application/json")
    state = re.search(r"state=([^&]+)", denied.json()["authorize_url"]).group(1)
    back = client.get(f"/api/yoto/callback?error=access_denied&state={state}")
    assert urlparse(back["Location"]).path == "/connected"


def test_openrouter_is_listed_as_a_provider(client, me):
    providers = {p["id"]: p for p in client.get("/api/settings").json()["providers"]}
    assert providers["openrouter"]["stt"] and providers["openrouter"]["chat"]
    assert Member.objects.get(user=me)
