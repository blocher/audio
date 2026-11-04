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
