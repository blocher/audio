import pytest

from audible_books.models import AudibleAccount, Book
from local_audio.models import Collection
from podcasts.models import Podcast


@pytest.fixture
def library(db):
    book = Book.objects.create(account=AudibleAccount.objects.create(name="Ben"), asin="B1", title="Book")
    return {
        "book": book.pk,
        "podcast": Podcast.objects.create(title="Show", feed_url="https://example.com/feed").pk,
        "folder": Collection.objects.create(name="Tapes").pk,
    }


def login(client, django_user_model, name):
    client.force_login(django_user_model.objects.create_user(name, password="pw"))


def test_stars_belong_to_whoever_starred(client, django_user_model, library):
    login(client, django_user_model, "ben")
    for kind, pk in library.items():
        assert client.put(f"/api/stars/{kind}/{pk}").status_code == 200
    client.put(f"/api/stars/book/{library['book']}")  # starring twice is harmless
    assert sorted((s["kind"], s["id"]) for s in client.get("/api/stars").json()) == sorted(library.items())

    login(client, django_user_model, "kid")
    assert client.get("/api/stars").json() == []

    login(client, django_user_model, "other")
    client.put(f"/api/stars/folder/{library['folder']}")
    client.delete(f"/api/stars/folder/{library['folder']}")
    assert client.get("/api/stars").json() == []


def test_starring_something_missing_or_unknown_fails(client, django_user_model, library):
    login(client, django_user_model, "ben")
    assert client.put("/api/stars/book/9999").status_code == 404
    assert client.put(f"/api/stars/episode/{library['book']}").status_code == 422
