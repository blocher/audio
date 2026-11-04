import pytest

from audible_books.models import AudibleAccount

PW = "a-long-enough-password-1"


@pytest.fixture
def admin(client, django_user_model):
    user = django_user_model.objects.create_superuser("ben", password=PW)
    client.force_login(user)
    return user


def test_admin_adds_edits_and_removes_people(client, admin, django_user_model):
    sam_account = AudibleAccount.objects.create(name="Sam")
    made = client.post(
        "/api/users",
        {"username": "sam", "first_name": "Sam", "password": PW, "audible_account_id": sam_account.pk},
        content_type="application/json",
    ).json()
    assert made["audible_account_id"] == sam_account.pk and made["is_admin"] is False
    sam = django_user_model.objects.get(username="sam")
    assert sam.check_password(PW)

    changed = client.patch(
        f"/api/users/{sam.pk}",
        {"email": "sam@example.com", "audible_account_id": None},
        content_type="application/json",
    ).json()
    assert changed["email"] == "sam@example.com" and changed["audible_account_id"] is None

    # An admin sets someone else's password without knowing the old one.
    assert (
        client.post(
            f"/api/users/{sam.pk}/password", {"password": "another-long-one-2"}, content_type="application/json"
        ).status_code
        == 200
    )
    sam.refresh_from_db()
    assert sam.check_password("another-long-one-2")

    assert [p["username"] for p in client.get("/api/users").json()] == ["ben", "sam"]
    assert client.delete(f"/api/users/{sam.pk}").status_code == 200
    assert not django_user_model.objects.filter(username="sam").exists()


def test_bad_input_is_refused(client, admin):
    def add(**body):
        return client.post("/api/users", {"username": "x", "password": PW, **body}, content_type="application/json")

    assert add(username="BEN").status_code == 400  # taken, whatever the case
    assert add(password="short").status_code == 400
    assert add(email="not-an-email").status_code == 400
    assert client.delete(f"/api/users/{admin.pk}").status_code == 400  # not yourself
    assert (
        client.patch(f"/api/users/{admin.pk}", {"is_admin": False}, content_type="application/json").status_code == 400
    )


def test_everyone_else_manages_only_themselves(client, django_user_model, admin):
    kid = django_user_model.objects.create_user("kid", password=PW)
    client.force_login(kid)
    assert [p["username"] for p in client.get("/api/users").json()] == ["kid"]
    assert (
        client.post("/api/users", {"username": "x", "password": PW}, content_type="application/json").status_code
        == 403
    )
    assert (
        client.patch(f"/api/users/{admin.pk}", {"email": "a@b.co"}, content_type="application/json").status_code == 403
    )
    assert client.patch(f"/api/users/{kid.pk}", {"is_admin": True}, content_type="application/json").status_code == 403
    assert client.delete(f"/api/users/{admin.pk}").status_code == 403

    # Your own password needs the current one, and you stay signed in after.
    bad = client.post(
        f"/api/users/{kid.pk}/password",
        {"password": "new-long-password-3", "current_password": "nope"},
        content_type="application/json",
    )
    assert bad.status_code == 400
    ok = client.post(
        f"/api/users/{kid.pk}/password",
        {"password": "new-long-password-3", "current_password": PW},
        content_type="application/json",
    )
    assert ok.status_code == 200
    assert client.get("/api/auth/session").json()["authenticated"] is True
