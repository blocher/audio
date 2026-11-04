import pytest

from core.models import Track
from core.packing import Card, Group, Item, Limits, pack
from yoto.client import DEFAULT_ICON
from yoto.services import build_content, create_from_cards


@pytest.mark.django_db
def test_cards_become_playlists_with_one_chapter_per_track():
    tracks = [
        Track.objects.create(source="local", title=f"Song {n}", duration_ms=90 * 60_000, size_bytes=40_000_000)
        for n in range(2)
    ]
    groups = [Group("g", "Mix", [Item(t.pk, t.title, t.size_bytes, t.duration_ms) for t in tracks])]
    cards: list[Card] = pack(groups, Limits())
    playlists = create_from_cards(cards, account=None)
    assert len({p.batch for p in playlists}) == 1

    first = playlists[0]
    items = list(first.items.select_related("track"))
    # 90-minute tracks exceed Yoto's 60-minute track limit, so they arrive as slices.
    assert items[0].start_ms == 0 and items[0].end_ms is not None
    assert "part 1 of 2" in items[0].title

    uploaded = [
        (i, {"trackUrl": "yoto:#x", "duration": 2700, "fileSize": 1000, "channels": "mono", "format": "aac"})
        for i in items
    ]
    body = build_content(first, uploaded)
    chapters = body["content"]["chapters"]
    assert [c["key"] for c in chapters] == [f"{n:02d}" for n in range(1, len(items) + 1)]
    assert chapters[0]["display"]["icon16x16"] == DEFAULT_ICON
    assert body["metadata"]["media"]["duration"] == 2700 * len(items)
    assert "cardId" not in body


@pytest.mark.django_db
def test_named_set_titles_cards_in_order_and_keeps_shared_track_labels():
    tracks = [
        Track.objects.create(source="local", title=f"Chapter {n}", duration_ms=50 * 60_000, size_bytes=20_000_000)
        for n in range(8)
    ]
    groups = [
        Group("a", "Book 1", [Item(t.pk, t.title, t.size_bytes, t.duration_ms) for t in tracks[:4]]),
        Group("b", "Book 2", [Item(t.pk, t.title, t.size_bytes, t.duration_ms) for t in tracks[4:]]),
    ]
    cards = pack(groups, Limits(), "continuous")  # 8 × 50 min = 6h40 → two cards, Book 2 starts on card 1
    playlists = create_from_cards(cards, account=None, name="Series")
    assert [p.title for p in playlists] == ["Series (1 of 2)", "Series (2 of 2)"]
    titles = list(playlists[0].items.values_list("title", flat=True))
    assert titles == [
        "Book 1 – Chapter 0",
        "Book 1 – Chapter 1",
        "Book 1 – Chapter 2",
        "Book 1 – Chapter 3",
        "Book 2 – Chapter 4",
        "Book 2 – Chapter 5",
    ]
    # A card holding only one book keeps the tracks' own titles (stored blank, so renames follow).
    assert set(playlists[1].items.values_list("title", flat=True)) == {""}
