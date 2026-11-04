import pytest

from core.models import Job
from yoto import client, services
from yoto.models import Playlist, YotoAccount


class FakeApi:
    def __init__(self, error: Exception | None = None):
        self.deleted: list[str] = []
        self.error = error

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        pass

    def delete_content(self, card_id: str) -> None:
        if self.error:
            raise self.error
        self.deleted.append(card_id)


@pytest.fixture
def signed_in(client, django_user_model):
    client.force_login(django_user_model.objects.create_user("ben"))
    return client


@pytest.fixture
def synced():
    account = YotoAccount.objects.create(name="Family", encrypted_tokens="x")
    return Playlist.objects.create(title="Book 1", account=account, card_id="abcde", status=Playlist.Status.SYNCED)


def use(monkeypatch, fake: FakeApi) -> FakeApi:
    monkeypatch.setattr(services.client, "Api", lambda account: fake)
    return fake


@pytest.mark.django_db
def test_delete_from_yoto_only_keeps_the_playlist_as_a_draft(signed_in, synced, monkeypatch):
    fake = use(monkeypatch, FakeApi())

    response = signed_in.delete(f"/api/yoto/playlists/{synced.pk}/yoto")

    assert response.status_code == 200
    assert fake.deleted == ["abcde"]
    synced.refresh_from_db()
    assert synced.card_id == "" and synced.status == Playlist.Status.DRAFT and synced.last_synced_at is None
    assert response.json()["status"] == "draft"


@pytest.mark.django_db
def test_delete_everywhere_removes_the_card_then_the_playlist(signed_in, synced, monkeypatch):
    fake = use(monkeypatch, FakeApi())

    response = signed_in.delete(f"/api/yoto/playlists/{synced.pk}?remote=true")

    assert response.status_code == 200
    assert fake.deleted == ["abcde"]
    assert not Playlist.objects.filter(pk=synced.pk).exists()


@pytest.mark.django_db
def test_delete_here_only_leaves_yoto_alone(signed_in, synced, monkeypatch):
    fake = use(monkeypatch, FakeApi())

    assert signed_in.delete(f"/api/yoto/playlists/{synced.pk}").status_code == 200

    assert fake.deleted == []
    assert not Playlist.objects.filter(pk=synced.pk).exists()


@pytest.mark.django_db
def test_a_card_already_gone_from_yoto_counts_as_deleted(signed_in, synced, monkeypatch):
    use(monkeypatch, FakeApi(client.NotFound("Yoto DELETE /content/abcde → 404")))

    assert signed_in.delete(f"/api/yoto/playlists/{synced.pk}/yoto").status_code == 200

    synced.refresh_from_db()
    assert synced.card_id == ""


@pytest.mark.django_db
def test_a_yoto_failure_keeps_the_playlist_here(signed_in, synced, monkeypatch):
    use(monkeypatch, FakeApi(client.YotoError("Yoto DELETE /content/abcde → 403")))

    response = signed_in.delete(f"/api/yoto/playlists/{synced.pk}?remote=true")

    assert response.status_code == 502
    synced.refresh_from_db()
    assert synced.card_id == "abcde"


@pytest.mark.django_db
def test_cant_delete_from_yoto_while_the_card_is_syncing(signed_in, synced, monkeypatch):
    fake = use(monkeypatch, FakeApi())
    Playlist.objects.filter(pk=synced.pk).update(status=Playlist.Status.SYNCING)
    Job.objects.create(kind="yoto_sync", title="Sync 3 cards", status=Job.Status.RUNNING)

    assert signed_in.delete(f"/api/yoto/playlists/{synced.pk}/yoto").status_code == 409
    assert fake.deleted == []


@pytest.mark.django_db
def test_disconnected_account_explains_how_to_delete_on_yoto(signed_in, synced, monkeypatch):
    use(monkeypatch, FakeApi())
    synced.account.delete()

    response = signed_in.delete(f"/api/yoto/playlists/{synced.pk}/yoto")

    assert response.status_code == 502 and "reconnect" in response.json()["detail"]
