from core.packing import Group, Item, Limits, TrackTooLarge, pack, split_long

MB = 1024 * 1024
MIN = 60 * 1000


def items(*sizes_mb, minutes=10):
    return [Item(n, f"t{n}", int(s * MB), minutes * MIN) for n, s in enumerate(sizes_mb)]


def test_sequential_fills_cards_in_order():
    limits = Limits(max_bytes=100 * MB, max_duration_ms=0)
    cards = pack([Group("a", "Show", items(60, 30, 30, 50, 10))], limits)
    assert [[i.track_id for i in c.items] for c in cards] == [[0, 1], [2, 3, 4]]
    assert [c.title for c in cards] == ["Show (1 of 2)", "Show (2 of 2)"]


def test_compact_shares_cards_between_short_groups():
    limits = Limits(max_bytes=100 * MB, max_duration_ms=0)
    groups = [Group("a", "A", items(70)), Group("b", "B", items(20)), Group("c", "C", items(25))]
    assert len(pack(groups, limits, "sequential")) == 3
    compact = pack(groups, limits, "compact")
    assert len(compact) == 2
    assert all(c.bytes <= limits.max_bytes for c in compact)


def test_five_hour_limit_binds_before_size():
    limits = Limits(max_bytes=500 * MB)
    # 12 one-hour, 28 MB tracks (64 kbps mono): size allows 17, time allows 5.
    cards = pack([Group("a", "Book", items(*[28] * 12, minutes=59))], limits)
    assert [len(c.items) for c in cards] == [5, 5, 2]


def test_long_tracks_are_split_into_parts():
    parts = split_long(Item(1, "Epic", 150 * MB, 150 * MIN), Limits())
    assert len(parts) == 3
    assert parts[0].start_ms == 0 and parts[-1].end_ms == 150 * MIN
    assert all(p.duration_ms <= 60 * MIN and p.bytes <= 100 * MB for p in parts)


def test_track_over_whole_card_raises():
    limits = Limits(max_bytes=10 * MB, max_track_bytes=0, max_track_ms=0)
    try:
        pack([Group("a", "A", items(20))], limits)
    except TrackTooLarge:
        return
    raise AssertionError("expected TrackTooLarge")
