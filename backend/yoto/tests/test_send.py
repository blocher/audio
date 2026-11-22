import base64

import pytest

from audible_books import services as book_services
from audible_books.models import AudibleAccount, Book
from core.models import Job, Track
from core.secrets import save_credential
from yoto import api as yoto_api
from yoto import tasks
from yoto.models import Playlist, YotoAccount

MB = 1024 * 1024


@pytest.fixture
def setup(client, django_user_model, monkeypatch, settings):
    settings.CREDENTIAL_ENCRYPTION_KEY = base64.urlsafe_b64encode(b"k" * 32).decode()
    client.force_login(django_user_model.objects.create_user("ben", password="pw"))
    save_credential("preferences", {"default_kbps": 48, "default_mono": True})
    queued = []

    def fake_enqueue(kind, title, task, *args, target=None):
        queued.append(args)
        return Job.objects.create(kind=kind, title=title)

    monkeypatch.setattr(yoto_api, "enqueue", fake_enqueue)
    monkeypatch.setattr(book_services, "download_account", lambda book: book.account)
    account = AudibleAccount.objects.create(name="Ben", encrypted_auth="x")
    book = Book.objects.create(asin="B1", title="The Book", account=account)
    return client, book, queued


def connect_yoto():
    return YotoAccount.objects.create(name="Family", encrypted_tokens="t")


def add_track(book, n, size=40 * MB):
    return Track.objects.create(
        source=Track.Source.BOOK,
        book=book,
        title=f"Ch {n}",
        position=n,
        file=f"b/{n}.mp3",
        size_bytes=size,
        duration_ms=40 * 60 * 1000,
    )


@pytest.mark.django_db
def test_send_needs_a_yoto_account(setup):
    client, book, _ = setup
    res = client.post("/api/yoto/send", {"book_id": book.pk}, content_type="application/json")
    assert res.status_code == 400
    assert "Connect your Yoto account" in res.json()["detail"]


@pytest.mark.django_db
def test_sending_a_book_not_yet_downloaded_converts_it_first(setup):
    client, book, queued = setup
    connect_yoto()
    res = client.post("/api/yoto/send", {"book_id": book.pk}, content_type="application/json")
    assert res.status_code == 200, res.content
    groups, strategy, kbps, mono, name, cover, batch, book_id, convert_kbps = queued[0]
    assert (book_id, convert_kbps, kbps) == (book.pk, 48, None)  # converted straight at the default size


@pytest.mark.django_db
def test_sending_a_converted_book_keeps_its_files_unless_asked(setup):
    client, book, queued = setup
    connect_yoto()
    add_track(book, 1)
    client.post("/api/yoto/send", {"book_id": book.pk}, content_type="application/json")
    client.post("/api/yoto/send", {"book_id": book.pk, "kbps": 32}, content_type="application/json")
    assert [(q[2], q[8]) for q in queued] == [(None, None), (32, None)]


@pytest.mark.django_db
def test_the_task_makes_the_cards_and_uploads_them(setup, monkeypatch):
    _, book, _ = setup
    connect_yoto()
    for n in range(1, 16):  # 15 × 40 MB = 600 MB: two cards
        add_track(book, n)
    synced = []

    def fake_sync(playlist, on_progress=None):
        synced.append(playlist.title)
        playlist.status = Playlist.Status.SYNCED
        playlist.save()

    monkeypatch.setattr(tasks, "sync_playlist", fake_sync)
    job = Job.objects.create(kind="yoto_send", title="t")
    tasks.send_to_yoto_task.run(job.pk, [], "sequential", None, True, "", "", "abc123", book.pk, None)
    job.refresh_from_db()
    assert job.status == Job.Status.SUCCEEDED, job.error
    assert synced == ["The Book (1 of 2)", "The Book (2 of 2)"]
    assert Playlist.objects.filter(batch="abc123").count() == 2

    # The book now knows it's on Yoto.
    data = setup[0].get(f"/api/audible/books/{book.pk}").json()
    assert data["yoto_status"] == "synced"
    assert len(data["yoto_playlist_ids"]) == 2


@pytest.mark.django_db
def test_a_restarted_send_reuses_the_cards_it_already_made(setup, monkeypatch):
    _, book, _ = setup
    connect_yoto()
    add_track(book, 1)
    monkeypatch.setattr(tasks, "sync_playlist", lambda p, on_progress=None: None)
    for _ in range(2):
        job = Job.objects.create(kind="yoto_send", title="t")
        tasks.send_to_yoto_task.run(job.pk, [], "sequential", None, True, "", "", "same", book.pk, None)
    assert Playlist.objects.filter(batch="same").count() == 1


@pytest.mark.django_db
def test_options_count_cards_for_each_size(setup):
    client, book, _ = setup
    tracks = [add_track(book, n) for n in range(1, 16)]  # 600 MB at about 140 kbps
    body = {"groups": [{"key": "b", "title": "B", "track_ids": [t.pk for t in tracks]}]}
    data = client.post("/api/pack/options", body, content_type="application/json").json()
    as_is = data["options"][0]
    assert as_is["kbps"] is None and as_is["cards"] == 2
    assert all(o["kbps"] < data["current_kbps"] for o in data["options"][1:])
    assert min(o["cards"] for o in data["options"][1:]) == 1


@pytest.mark.django_db
def test_options_estimate_a_book_from_its_length(setup):
    client, _, _ = setup
    hours_20 = 20 * 3600 * 1000
    body = {"groups": [], "estimate_ms": hours_20}
    data = client.post("/api/pack/options", body, content_type="application/json").json()
    by_kbps = {o["kbps"]: o["cards"] for o in data["options"]}
    assert None not in by_kbps
    assert by_kbps[32] < by_kbps[128]


@pytest.mark.django_db
def test_trying_again_carries_on_with_the_same_cards(setup):
    client, book, queued = setup
    connect_yoto()
    add_track(book, 1)
    body = {"book_id": book.pk, "batch": "0123abcd"}
    client.post("/api/yoto/send", body, content_type="application/json")
    client.post("/api/yoto/send", {**body, "batch": "not hex!"}, content_type="application/json")
    assert queued[0][6] == "0123abcd"
    assert queued[1][6] != "not hex!"
