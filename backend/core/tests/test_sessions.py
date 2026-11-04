from datetime import date

from django.conf import settings


def test_signed_in_sessions_renew_once_a_day(client, django_user_model):
    user = django_user_model.objects.create_user("ben", password="pw")
    client.force_login(user)

    first = client.get("/api/auth/session")
    cookie = first.cookies[settings.SESSION_COOKIE_NAME]
    assert first.json()["authenticated"]
    assert int(cookie["max-age"]) >= 399 * 24 * 3600
    assert client.session["renewed_on"] == date.today().isoformat()

    # Already renewed today: no new cookie, no session write.
    assert settings.SESSION_COOKIE_NAME not in client.get("/api/auth/session").cookies

    session = client.session
    session["renewed_on"] = "2000-01-01"
    session.save()
    assert settings.SESSION_COOKIE_NAME in client.get("/api/auth/session").cookies
