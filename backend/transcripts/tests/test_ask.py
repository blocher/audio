import pytest

from audible_books.models import AudibleAccount, Book
from core.models import Track
from transcripts.ask import citations, transcript_document
from transcripts.models import Conversation, Segment, Transcript


def test_citations_parse_timestamps():
    assert citations("See [0:01:05] and [1:00:00], again [0:01:05].") == [65_000, 3_600_000]


@pytest.mark.django_db
def test_transcript_stops_at_listening_position():
    book = Book.objects.create(account=AudibleAccount.objects.create(name="Ben"), asin="B1", title="Book")
    for n, (start, words) in enumerate([(0, "Opening words."), (600_000, "The butler did it.")]):
        track = Track.objects.create(
            source="book",
            book=book,
            title=f"Chapter {n + 1}",
            position=n,
            start_ms=start,
            duration_ms=600_000,
            file=f"x{n}.mp3",
        )
        t = Transcript.objects.create(track=track, status="ready")
        Segment.objects.create(transcript=t, start_ms=5_000, end_ms=9_000, text=words)
    convo = Conversation.objects.create(book=book)

    early, count = transcript_document(convo, position_ms=300_000)
    assert count == 1 and "Opening words." in early and "butler" not in early
    assert "[0:00:05]" in early

    late, count = transcript_document(convo, position_ms=700_000)
    assert count == 2 and "## Chapter 2" in late and "[0:10:05] The butler did it." in late
