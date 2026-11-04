import pytest

from audible_books import services
from audible_books.models import AudibleAccount, Book, LibraryEntry


def item(asin, title, percent=0, finished=False):
    return {"asin": asin, "title": title, "listening_status": {"percent_complete": percent, "is_finished": finished}}


@pytest.fixture
def libraries(monkeypatch):
    """Ben and Sam share one book through family sharing; each also has one of their own."""
    ben = AudibleAccount.objects.create(name="Ben", encrypted_auth="x")
    sam = AudibleAccount.objects.create(name="Sam", encrypted_auth="x")
    library = {
        ben.pk: [item("SHARED", "Shared", percent=20), item("BEN", "Ben's")],
        sam.pk: [item("SHARED", "Shared", percent=75), item("SAM", "Sam's")],
    }
    monkeypatch.setattr(services.client, "fetch_library", lambda account: library[account.pk])
    services.sync_library(ben)
    services.sync_library(sam)
    return ben, sam, library


@pytest.mark.django_db
def test_check_is_recorded_even_when_audible_has_no_position(monkeypatch, libraries):
    ben, _, _ = libraries
    LibraryEntry.objects.filter(account=ben, book__asin="BEN").update(position_ms=5000)
    monkeypatch.setattr(services.client, "fetch_positions", lambda acct, asins: {"SHARED": (120_000, None)})

    services.sync_positions(ben)

    entries = {e.book.asin: e for e in ben.entries.select_related("book")}
    assert entries["SHARED"].position_ms == 120_000
    assert entries["BEN"].position_ms == 5000  # nothing from Audible: keep what we had
    assert all(e.position_synced_at for e in entries.values())


@pytest.mark.django_db
def test_a_shared_book_is_one_book_with_each_persons_progress(libraries):
    ben, sam, _ = libraries
    shared = Book.objects.get(asin="SHARED")
    assert Book.objects.count() == 3
    assert shared.account == ben  # whoever synced it first downloads it
    assert {e.account.name: e.percent_complete for e in shared.entries.all()} == {"Ben": 20, "Sam": 75}


@pytest.mark.django_db
def test_each_login_sees_their_own_accounts_position(client, django_user_model, libraries):
    ben, sam, _ = libraries
    LibraryEntry.objects.filter(account=ben).update(position_ms=1_000)
    LibraryEntry.objects.filter(account=sam).update(position_ms=9_000)
    user = django_user_model.objects.create_user("sam", password="pw")
    client.force_login(user)

    def positions():
        books = client.get("/api/audible/books").json()
        return {b["asin"]: (b["position_ms"], b["position_account"], b["position_is_mine"]) for b in books}

    # Not picked yet: the first connected account.
    assert positions()["SHARED"] == (1_000, "Ben", True)
    assert client.post(f"/api/audible/accounts/{sam.pk}/mine").json()["is_mine"] is True
    seen = positions()
    assert seen["SHARED"] == (9_000, "Sam", True)
    assert seen["BEN"] == (1_000, "Ben", False)  # not in Sam's library: Ben's progress, labelled as his
    shared = next(b for b in client.get("/api/audible/books").json() if b["asin"] == "SHARED")
    assert shared["account_names"] == ["Ben", "Sam"]


@pytest.mark.django_db
def test_leaving_one_library_keeps_the_book_for_the_other(monkeypatch, libraries):
    ben, sam, library = libraries
    library[ben.pk] = [item("BEN", "Ben's")]
    services.sync_library(ben)
    shared = Book.objects.get(asin="SHARED")
    assert shared.account == sam
    assert list(shared.entries.values_list("account__name", flat=True)) == ["Sam"]


@pytest.mark.django_db
def test_removing_an_account_keeps_books_the_other_has(libraries):
    ben, sam, _ = libraries
    services.remove_account(ben)
    assert set(Book.objects.values_list("asin", flat=True)) == {"SHARED", "SAM"}
    assert Book.objects.get(asin="SHARED").account == sam
