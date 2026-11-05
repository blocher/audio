import base64

import pytest

from audible_books import api as books_api
from audible_books import services
from audible_books.models import AudibleAccount, Book
from core import ai
from core.models import Track
from core.secrets import save_credential
from transcripts.models import Transcript


@pytest.fixture
def setup(client, django_user_model, monkeypatch, settings):
    settings.CREDENTIAL_ENCRYPTION_KEY = base64.urlsafe_b64encode(b"k" * 32).decode()
    client.force_login(django_user_model.objects.create_user("ben", password="pw"))
    save_credential("preferences", {"default_kbps": 48, "default_mono": True})
    monkeypatch.setattr(ai, "resolve", lambda kind, provider, model: ("groq", "whisper-large-v3-turbo"))
    monkeypatch.setattr(services, "download_account", lambda book: book.account)
    queued = []
    monkeypatch.setattr(
        books_api, "enqueue", lambda kind, title, task, *args, target=None: queued.append(args) or _job()
    )
    account = AudibleAccount.objects.create(name="Ben", encrypted_auth="x")
    book = Book.objects.create(asin="B1", title="Book", account=account)
    return client, book, queued


def _job():
    from core.models import Job

    return Job.objects.create(kind="audible_askable", title="t")


def add_track(book, n, transcribed=False):
    t = Track.objects.create(source=Track.Source.BOOK, book=book, title=f"Ch {n}", position=n, file=f"b/{n}.mp3")
    if transcribed:
        Transcript.objects.create(track=t, status=Transcript.Status.READY)
    return t


@pytest.mark.django_db
def test_presets_preselect_the_saved_default(setup):
    client, _, _ = setup
    data = client.get("/api/audio/presets").json()
    assert data["default_kbps"] == 48
    assert data["default_mono"] is True


@pytest.mark.django_db
def test_an_unconverted_book_is_converted_at_the_default_then_transcribed(setup):
    client, book, queued = setup
    assert client.post(f"/api/audible/books/{book.pk}/askable", {}, content_type="application/json").status_code == 200
    book_id, kbps, mono, provider, model = queued[0]
    assert (book_id, kbps, mono, provider) == (book.pk, 48, True, "groq")


@pytest.mark.django_db
def test_a_book_in_another_bitrate_is_reconverted_only_when_nothing_is_transcribed(setup):
    client, book, queued = setup
    Book.objects.filter(pk=book.pk).update(convert_kbps=64, convert_mono=True)
    add_track(book, 1)
    client.post(f"/api/audible/books/{book.pk}/askable", {}, content_type="application/json")
    assert queued[-1][1] == 48

    add_track(book, 2, transcribed=True)
    client.post(f"/api/audible/books/{book.pk}/askable", {}, content_type="application/json")
    assert queued[-1][1] is None  # keep the tracks (and their transcript); just transcribe the rest


@pytest.mark.django_db
def test_a_fully_transcribed_book_is_already_askable(setup):
    client, book, queued = setup
    Book.objects.filter(pk=book.pk).update(convert_kbps=48, convert_mono=True)
    add_track(book, 1, transcribed=True)
    response = client.post(f"/api/audible/books/{book.pk}/askable", {}, content_type="application/json")
    assert response.status_code == 400
    assert not queued
