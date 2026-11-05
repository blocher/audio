from audible_books.client import book_fields


def test_keeps_every_series_audible_lists():
    fields = book_fields(
        {
            "title": "Harry Potter and the Prisoner of Azkaban, Book 3",
            "series": [
                {"title": "Wizarding World Collection", "sequence": "3"},
                {"title": "Harry Potter", "sequence": "3"},
            ],
        }
    )
    assert fields["series"] == "Wizarding World Collection"
    assert fields["series_position"] == "3"
    assert fields["series_list"] == [
        {"title": "Wizarding World Collection", "position": "3"},
        {"title": "Harry Potter", "position": "3"},
    ]


def test_book_without_a_series():
    fields = book_fields({"title": "Piranesi", "series": None})
    assert (fields["series"], fields["series_position"], fields["series_list"]) == ("", "", [])


def test_book_size_is_current_and_not_multiplied(db):
    from django.contrib.auth import get_user_model

    from audible_books.api import books_qs
    from audible_books.models import AudibleAccount, Book, LibraryEntry
    from core.models import Track

    user = get_user_model().objects.create_user("u")
    accounts = [AudibleAccount.objects.create(name=f"acct{n}") for n in (1, 2)]
    book = Book.objects.create(account=accounts[0], asin="A1", title="Book")
    for acct in accounts:  # in two libraries, so the entries join doubles rows
        LibraryEntry.objects.create(account=acct, book=book)
    Track.objects.create(source="audible", book=book, title="1", size_bytes=30, optimized_size_bytes=10)
    Track.objects.create(source="audible", book=book, title="2", size_bytes=20)
    assert books_qs(user).get(pk=book.pk).size_bytes == 30
