"""Households keep libraries apart; invitations bring new people in."""

import base64
import re

import pytest
from django.core import mail
from django.test import Client

from audible_books.models import AudibleAccount, Book
from core.models import Household, Invite, Member, Track
from core.secrets import save_credential
from local_audio.models import Collection
from podcasts.models import Podcast
from yoto.models import Playlist

PW = "a-long-enough-password-1"


@pytest.fixture(autouse=True)
def encryption_key(settings):
    settings.CREDENTIAL_ENCRYPTION_KEY = base64.urlsafe_b64encode(b"k" * 32).decode()


@pytest.fixture
def ben(client, django_user_model, household):
    user = django_user_model.objects.create_superuser("ben", password=PW, first_name="Ben")
    client.force_login(user)
    return user


def invite(client, **body):
    response = client.post(
        "/api/users/invites", {"email": "gran@example.com", **body}, content_type="application/json"
    )
    assert response.status_code == 200, response.content
    return response.json()


def accept(link: str, name="Gran", password=PW) -> Client:
    token = link.rsplit("/", 1)[-1]
    visitor = Client()
    visitor.get("/api/auth/session")
    response = visitor.post(
        f"/api/auth/invites/{token}/accept", {"name": name, "password": password}, content_type="application/json"
    )
    assert response.status_code == 200, response.content
    return visitor


def test_an_invite_makes_a_login_with_its_own_empty_library(client, ben, household, settings):
    AudibleAccount.objects.create(name="Ben")
    Podcast.objects.create(feed_url="https://example.com/feed", title="Ours")
    sent = invite(client, name="Gran")
    assert sent["emailed"] is False  # no mail server in tests: the link is shown to copy instead
    link = sent["invite"]["link"]
    assert client.get(f"/api/auth/invites/{link.rsplit('/', 1)[-1]}").json()["joining"] is None

    gran = accept(link)
    me = gran.get("/api/auth/session").json()["user"]
    assert me["first_name"] == "Gran" and me["onboarded"] is False and me["is_admin"] is False
    assert me["household_id"] != household.pk and me["household_name"] == "Gran's library"
    # Nothing of Ben's library is visible.
    assert gran.get("/api/audible/accounts").json() == []
    assert gran.get("/api/podcasts").json() == []
    # The link only works once; signing in with the email does.
    assert (
        Client()
        .post(
            f"/api/auth/invites/{link.rsplit('/', 1)[-1]}/accept",
            {"name": "x", "password": PW},
            content_type="application/json",
        )
        .status_code
        == 400
    )
    assert (
        Client()
        .post("/api/auth/login", {"username": "GRAN@example.com", "password": PW}, content_type="application/json")
        .status_code
        == 200
    )


def test_an_invite_can_share_the_inviters_library(client, ben, household):
    AudibleAccount.objects.create(name="Ben")
    link = invite(client, email="liz@example.com", join_my_library=True)["invite"]["link"]
    assert client.get(f"/api/auth/invites/{link.rsplit('/', 1)[-1]}").json()["joining"] == household.name
    liz = accept(link, name="Elizabeth")
    assert [a["name"] for a in liz.get("/api/audible/accounts").json()] == ["Ben"]
    assert liz.get("/api/onboarding").json()["shared_with"] == ["Ben"]


def test_invites_are_emailed_when_a_mail_server_is_set_up(client, ben, settings):
    settings.EMAIL_CONFIGURED = True
    settings.MAILERS = {"default": {"BACKEND": "django.core.mail.backends.locmem.EmailBackend"}}
    sent = invite(client, name="Gran")
    assert sent["emailed"] is True
    [message] = mail.outbox
    assert message.to == ["gran@example.com"] and "Ben invited you" in message.subject
    assert re.search(r"/invite/[\w-]+", message.body).group(0) in sent["invite"]["link"]


def test_only_super_admins_invite(client, django_user_model):
    kid = django_user_model.objects.create_user("kid", password=PW)
    client.force_login(kid)
    assert (
        client.post("/api/users/invites", {"email": "x@example.com"}, content_type="application/json").status_code
        == 403
    )
    assert client.get("/api/users/invites").status_code == 403


def test_expired_and_unknown_invites_are_refused(client, ben):
    link = invite(client)["invite"]["link"]
    Invite.objects.update(expires_at="2000-01-01T00:00:00Z")
    token = link.rsplit("/", 1)[-1]
    assert Client().get(f"/api/auth/invites/{token}").json()["status"] == "expired"
    assert (
        Client()
        .post(f"/api/auth/invites/{token}/accept", {"name": "x", "password": PW}, content_type="application/json")
        .status_code
        == 400
    )
    assert Client().get("/api/auth/invites/nope").status_code == 404


def test_households_cannot_reach_each_others_things(client, ben, household, django_user_model):
    account = AudibleAccount.objects.create(name="Ben")
    book = Book.objects.create(account=account, asin="B1", title="Ours")
    folder = Collection.objects.create(name="Folder")
    track = Track.objects.create(source="local", collection=folder, title="T", file="local/1/t.mp3")
    playlist = Playlist.objects.create(title="Card")

    other = Household.objects.create(name="Theirs")
    stranger = django_user_model.objects.create_user("stranger", password=PW)
    Member.objects.filter(user=stranger).update(household=other)
    them = Client()
    them.force_login(stranger)
    assert them.get(f"/api/audible/books/{book.pk}").status_code == 404
    assert them.get("/api/audible/books").json() == []
    assert them.get(f"/api/local/collections/{folder.pk}").status_code == 404
    assert them.get(f"/api/tracks?ids={track.pk}").json() == []
    assert them.get(f"/api/yoto/playlists/{playlist.pk}").status_code == 404
    assert them.post(f"/api/audible/accounts/{account.pk}/sync").status_code == 404
    assert them.put(f"/api/stars/book/{book.pk}").status_code == 404
    created = them.post("/api/transcripts/conversations", {"book_id": book.pk}, content_type="application/json")
    assert created.status_code == 404
    # The same book can be in both libraries, each its own row.
    theirs = AudibleAccount.objects.create(household=other, name="Them")
    assert Book.objects.create(household=other, account=theirs, asin="B1", title="Ours").pk != book.pk


def test_media_is_only_served_to_its_household(client, ben, settings, tmp_path, django_user_model):
    settings.MEDIA_ROOT = tmp_path
    (tmp_path / "local/1").mkdir(parents=True)
    (tmp_path / "local/1/t.mp3").write_bytes(b"ID3audio")
    folder = Collection.objects.create(name="Folder")
    Track.objects.create(source="local", collection=folder, title="T", file="local/1/t.mp3")
    assert client.get("/api/media/local/1/t.mp3").status_code == 200

    stranger = django_user_model.objects.create_user("stranger", password=PW)
    Member.objects.filter(user=stranger).update(household=Household.objects.create(name="Theirs"))
    them = Client()
    them.force_login(stranger)
    assert them.get("/api/media/local/1/t.mp3").status_code == 404


def test_ai_keys_are_per_household_and_can_be_shared(client, ben, household, django_user_model):
    save_credential("openai", {"api_key": "sk-ours-1234"}, household.pk)
    assert client.get("/api/settings").json()["openai"]["api_key"]["source"] == "own"

    link = invite(client, share_ai_keys=True)["invite"]["link"]
    gran = accept(link)
    key = gran.get("/api/settings").json()["openai"]["api_key"]
    assert key == {"set": True, "masked": "", "source": "shared"}  # usable, never shown
    assert gran.get("/api/onboarding").json()["ai"] == {"transcribe": True, "ask": True, "borrowed": True}

    # Without sharing, a new household has no keys, not even the server's.
    settings_link = invite(client, email="pal@example.com")["invite"]["link"]
    pal = accept(settings_link, name="Pal")
    assert pal.get("/api/settings").json()["openai"]["api_key"]["set"] is False

    # A super admin can turn sharing off later.
    gran_household = Member.objects.get(user__email="gran@example.com").household
    response = client.patch(
        f"/api/users/households/{gran_household.pk}", {"share_my_ai_keys": False}, content_type="application/json"
    )
    assert response.json()["shares_ai_keys_from"] is None
    assert gran.get("/api/settings").json()["openai"]["api_key"]["set"] is False


def test_only_super_admins_change_the_yoto_app(client, django_user_model):
    kid = django_user_model.objects.create_user("kid", password=PW)
    client.force_login(kid)
    body = {"service": "yoto", "values": {"client_id": "x"}}
    assert client.put("/api/settings", body, content_type="application/json").status_code == 403


def test_onboarding_remembers_the_choice_and_finishing(client, ben):
    status = client.get("/api/onboarding").json()
    assert status["audible"] == [] and status["yoto"]["connected"] == []
    done = client.patch("/api/onboarding", {"primary_use": "yoto", "done": True}, content_type="application/json")
    assert done.json()["primary_use"] == "yoto" and done.json()["onboarded"] is True
    assert client.get("/api/auth/session").json()["user"]["primary_use"] == "yoto"
    assert client.patch("/api/onboarding", {"primary_use": "nope"}, content_type="application/json").status_code == 400


def test_yoto_sign_in_comes_back_to_the_page_that_started_it(client, ben, monkeypatch):
    from yoto import client as yoto_client
    from yoto.models import YotoAccount

    save_credential("yoto", {"client_id": "app"})
    started = client.post("/api/yoto/accounts", {"return_to": "/welcome?step=yoto"}, content_type="application/json")
    state = re.search(r"state=([^&]+)", started.json()["authorize_url"]).group(1)
    monkeypatch.setattr(yoto_client, "finish_authorize", lambda account, code, state: None)
    back = client.get(f"/api/yoto/callback?code=c&state={state}")
    assert back.status_code == 302 and back["Location"] == "/welcome?step=yoto&connected=1"
    assert YotoAccount.objects.get().pending_login["return_to"] == "/welcome?step=yoto"
    # Only paths on this site.
    client.post("/api/yoto/accounts", {"return_to": "https://evil.example"}, content_type="application/json")
    assert YotoAccount.objects.get().pending_login["return_to"] == ""
