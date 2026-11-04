import pytest

from audible_books import services
from audible_books.models import AudibleAccount, Book


@pytest.mark.django_db
def test_check_is_recorded_even_when_audible_has_no_position(monkeypatch):
    account = AudibleAccount.objects.create(name="Ben")
    heard = Book.objects.create(account=account, asin="A1", title="Heard")
    unheard = Book.objects.create(account=account, asin="A2", title="Unheard", position_ms=5000)
    monkeypatch.setattr(services.client, "fetch_positions", lambda acct, asins: {"A1": (120_000, None)})

    services.sync_positions(account, [heard, unheard])

    heard.refresh_from_db()
    unheard.refresh_from_db()
    assert heard.position_ms == 120_000
    assert unheard.position_ms == 5000  # nothing from Audible: keep what we had
    assert heard.position_synced_at and unheard.position_synced_at
