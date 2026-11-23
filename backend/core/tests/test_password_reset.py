import re

import pytest
from django.core import mail
from django.core.cache import cache
from django.test import Client

PW = "a-long-new-passphrase-9"


@pytest.fixture
def mailing(settings):
    settings.EMAIL_CONFIGURED = True
    settings.MAILERS = {"default": {"BACKEND": "django.core.mail.backends.locmem.EmailBackend"}}
    cache.clear()


@pytest.fixture
def gran(django_user_model):
    return django_user_model.objects.create_user(
        "gran@example.com", "gran@example.com", "old-password-123", first_name="Gran"
    )


def _link() -> str:
    return re.search(r"/reset/(\S+)/(\S+)", mail.outbox[-1].body).groups()


@pytest.mark.django_db
def test_forgot_password_emails_a_link_that_sets_a_new_password_once(client, mailing, gran):
    assert client.get("/api/auth/session").json()["can_reset_password"] is True
    res = client.post("/api/auth/password/forgot", {"email": " Gran@Example.com "}, content_type="application/json")
    assert res.status_code == 200
    assert len(mail.outbox) == 1 and mail.outbox[0].to == ["gran@example.com"]
    uid, token = _link()

    assert client.get(f"/api/auth/password/reset/{uid}/{token}").json() == {
        "valid": True,
        "email": "gran@example.com",
        "name": "Gran",
    }
    weak = client.post(f"/api/auth/password/reset/{uid}/{token}", {"password": "123"}, content_type="application/json")
    assert weak.status_code == 400
    res = client.post(f"/api/auth/password/reset/{uid}/{token}", {"password": PW}, content_type="application/json")
    assert res.status_code == 200, res.content
    assert res.json()["authenticated"] is True
    gran.refresh_from_db()
    assert gran.check_password(PW)

    # The link is spent, and the new password signs in.
    assert client.get(f"/api/auth/password/reset/{uid}/{token}").json()["valid"] is False
    again = client.post(
        f"/api/auth/password/reset/{uid}/{token}", {"password": PW + "x"}, content_type="application/json"
    )
    assert again.status_code == 400
    fresh = Client()
    login = fresh.post(
        "/api/auth/login", {"username": "gran@example.com", "password": PW}, content_type="application/json"
    )
    assert login.status_code == 200


@pytest.mark.django_db
def test_the_answer_is_the_same_for_an_unknown_address(client, mailing, gran):
    known = client.post("/api/auth/password/forgot", {"email": "gran@example.com"}, content_type="application/json")
    unknown = client.post(
        "/api/auth/password/forgot", {"email": "nobody@example.com"}, content_type="application/json"
    )
    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()
    assert len(mail.outbox) == 1


@pytest.mark.django_db
def test_one_address_gets_only_a_few_links(mailing, gran):
    for n in range(5):
        Client(REMOTE_ADDR=f"10.0.0.{n}").post(
            "/api/auth/password/forgot", {"email": "gran@example.com"}, content_type="application/json"
        )
    assert len(mail.outbox) == 3


@pytest.mark.django_db
def test_a_made_up_link_is_refused(client, mailing, gran):
    assert client.get("/api/auth/password/reset/Mg/not-a-token").json()["valid"] is False
    res = client.post("/api/auth/password/reset/Mg/not-a-token", {"password": PW}, content_type="application/json")
    assert res.status_code == 400
    gran.refresh_from_db()
    assert gran.check_password("old-password-123")


@pytest.mark.django_db
def test_without_email_there_is_no_reset(client, settings, gran):
    settings.EMAIL_CONFIGURED = False
    cache.clear()
    assert client.get("/api/auth/session").json()["can_reset_password"] is False
    res = client.post("/api/auth/password/forgot", {"email": "gran@example.com"}, content_type="application/json")
    assert res.status_code == 400
