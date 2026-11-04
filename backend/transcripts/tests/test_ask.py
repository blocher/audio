import pytest

from audible_books.models import AudibleAccount, Book
from core.models import Track
from transcripts.ask import citations, fit, passages, render
from transcripts.models import Conversation, Segment, Transcript
from transcripts.stt import group_words


def test_citations_parse_timestamps():
    assert citations("See [0:01:05] and [1:00:00], again [0:01:05].") == [65_000, 3_600_000]


@pytest.fixture
def book_conversation(db):
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
    return Conversation.objects.create(book=book)


def test_transcript_stops_at_listening_position(book_conversation):
    early = passages(book_conversation, position_ms=300_000)
    text = render(early, early)
    assert len(early) == 1 and "Opening words." in text and "butler" not in text
    assert "[0:00:05]" in text

    late = passages(book_conversation, position_ms=700_000)
    text = render(late, late)
    assert "## Chapter 2" in text and "[0:10:05] The butler did it." in text


def _passage(n: int, text: str) -> dict:
    return {"track_id": 1, "track_title": "Ch", "start_ms": n * 90_000, "text": f"[{n}] {text}"}


def test_fit_keeps_everything_when_it_fits():
    items = [_passage(n, "words " * 10) for n in range(5)]
    chosen, excerpted = fit(items, 10_000, "anything")
    assert chosen == items and not excerpted


def test_fit_keeps_recent_tail_and_relevant_earlier_passages():
    filler = "the weather was mild and people walked about town " * 4
    items = [_passage(n, filler) for n in range(60)]
    items[7] = _passage(7, "Mr Craven locked the garden after the accident " * 2)
    chosen, excerpted = fit(items, 3_000, "Why did Craven lock the garden?")
    assert excerpted
    assert items[-1] in chosen  # most recent passage always kept
    assert items[7] in chosen  # the relevant early passage is found
    assert sum(len(p["text"]) for p in chosen) <= 3_000
    assert "[…]" in render(chosen, items)


def test_group_words_into_sentences():
    words = [
        {"start_ms": i * 500, "end_ms": i * 500 + 400, "text": w}
        for i, w in enumerate("Once upon a time there lived a king . He was very sad indeed .".split())
    ]
    segments = group_words(words)
    assert segments[0]["text"].startswith("Once upon") and segments[0]["text"].endswith("king.")
    assert segments[1]["start_ms"] == words[9]["start_ms"]


@pytest.fixture
def fake_model(monkeypatch):
    from transcripts import ask

    seen = {}

    def stream(provider, model, system, context, messages):
        seen.update(system=system, context=context, messages=messages)
        yield "text", "An answer."
        yield "usage", {"model": model}

    monkeypatch.setattr(ask.ai, "resolve", lambda kind, provider, model: ("anthropic", "claude-test"))
    monkeypatch.setattr(ask, "budget_tokens", lambda *a: 100_000)
    monkeypatch.setattr(ask, "stream_model", stream)
    return seen


def test_whole_work_reads_past_the_position_and_allows_spoilers(book_conversation, fake_model):
    from transcripts.ask import SYSTEM_WHOLE, stream_answer

    events = list(stream_answer(book_conversation, "Who did it?", 300_000, whole_work=True))
    assert "butler" in fake_model["context"] and fake_model["system"] == SYSTEM_WHOLE
    assert events[-1]["type"] == "done"
    assert all(m.whole_work for m in book_conversation.messages.all())


def test_spoiler_safe_question_ignores_earlier_whole_work_answers(book_conversation, fake_model):
    from transcripts.ask import SYSTEM, stream_answer

    list(stream_answer(book_conversation, "Who did it?", 300_000, whole_work=True))
    list(stream_answer(book_conversation, "What happened so far?", 300_000))
    assert "butler" not in fake_model["context"] and fake_model["system"] == SYSTEM
    assert [m["content"] for m in fake_model["messages"]] == ["What happened so far?"]


def test_position_before_any_speech_explains_what_to_do(book_conversation, fake_model):
    from transcripts.ask import stream_answer

    with pytest.raises(RuntimeError, match="whole book"):
        list(stream_answer(book_conversation, "Hi?", 0))
