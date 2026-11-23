import pytest

from audible_books import api as books_api
from audible_books.models import AudibleAccount
from core.models import Household, Job
from core.tenancy import membership


@pytest.mark.django_db
def test_refresh_syncs_every_connected_account_in_this_library_only(client, django_user_model, monkeypatch):
    ben = django_user_model.objects.create_user("ben", password="pw")
    client.force_login(ben)
    ours = membership(ben).household
    queued = []

    def enqueue(kind, title, task, *args, target=None):
        queued.append(args[0])
        return Job.objects.create(kind=kind, title=title, household=ours)

    monkeypatch.setattr(books_api, "enqueue", enqueue)
    sam = AudibleAccount.objects.create(name="Sam", encrypted_auth="x", household=ours)
    kid = AudibleAccount.objects.create(name="Kid", encrypted_auth="x", household=ours)
    AudibleAccount.objects.create(name="Signed out", encrypted_auth="", household=ours)
    AudibleAccount.objects.create(name="Theirs", encrypted_auth="x", household=Household.objects.create(name="Other"))

    response = client.post("/api/audible/sync")

    assert response.status_code == 200, response.content
    assert sorted(queued) == sorted([sam.pk, kid.pk])
    assert len(response.json()) == 2


@pytest.mark.django_db
def test_refresh_without_an_audible_account_says_so(client, django_user_model):
    client.force_login(django_user_model.objects.create_user("ben", password="pw"))
    response = client.post("/api/audible/sync")
    assert response.status_code == 400
    assert "Connect an Audible account" in response.json()["detail"]


@pytest.mark.django_db
def test_the_quiet_check_skips_accounts_checked_recently(client, django_user_model, monkeypatch):
    from datetime import timedelta

    from django.utils import timezone

    ben = django_user_model.objects.create_user("ben", password="pw")
    client.force_login(ben)
    ours = membership(ben).household
    queued = []
    monkeypatch.setattr(
        books_api,
        "enqueue",
        lambda kind, title, task, *args, target=None: (
            queued.append(args[0]) or Job.objects.create(kind=kind, title=title, household=ours)
        ),
    )
    now = timezone.now()
    fresh = AudibleAccount.objects.create(name="Fresh", encrypted_auth="x", household=ours, last_synced_at=now)
    stale = AudibleAccount.objects.create(
        name="Stale", encrypted_auth="x", household=ours, last_synced_at=now - timedelta(hours=3)
    )
    never = AudibleAccount.objects.create(name="Never", encrypted_auth="x", household=ours)
    broken = AudibleAccount.objects.create(name="Broken", encrypted_auth="x", household=ours)
    Job.objects.create(
        kind="audible_sync",
        title="t",
        household=ours,
        status="failed",
        target_type="audibleaccount",
        target_id=broken.pk,
    )

    assert client.post("/api/audible/sync?if_older_than_minutes=60").status_code == 200
    assert sorted(queued) == sorted([stale.pk, never.pk])

    queued.clear()
    assert client.post("/api/audible/sync").status_code == 200  # the button always checks everything
    assert sorted(queued) == sorted([fresh.pk, stale.pk, never.pk, broken.pk])
