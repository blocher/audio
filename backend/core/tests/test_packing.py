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


def test_continuous_starts_the_next_book_where_the_last_one_ended():
    limits = Limits(max_bytes=100 * MB, max_duration_ms=0)
    groups = [Group("a", "Book 1", items(60, 30, 30)), Group("b", "Book 2", items(20, 50, 40))]
    sequential = pack(groups, limits, "sequential")
    continuous = pack(groups, limits, "continuous")
    # Book-per-card leaves Book 1's second card 70% empty; back to back lets Book 2 fill it.
    assert len(sequential) == 4
    assert len(continuous) == 3
    assert [[s.group.key for s in c.segments] for c in continuous] == [["a"], ["a", "b"], ["b"]]
    assert all(c.bytes <= limits.max_bytes for c in continuous)
    # Order is preserved end to end.
    flat = [(s.group.key, i.track_id) for c in continuous for s in c.segments for i in s.items]
    assert flat == [("a", 0), ("a", 1), ("a", 2), ("b", 0), ("b", 1), ("b", 2)]


def test_continuous_numbers_each_books_pieces_and_labels_shared_cards():
    limits = Limits(max_bytes=100 * MB, max_duration_ms=0)
    groups = [Group("a", "Book 1", items(60, 30, 30)), Group("b", "Book 2", items(20, 50, 40))]
    cards = pack(groups, limits, "continuous")
    assert [c.title for c in cards] == ["Book 1 (1 of 2)", "Book 1 · Book 2", "Book 2 (2 of 2)"]
    shared = cards[1]
    assert [i.title for i in shared.items] == ["Book 1 – t2", "Book 2 – t0", "Book 2 – t1"]
    assert all(i.custom_title for i in shared.items)
    assert not any(i.custom_title for i in cards[0].items)


def test_continuous_series_uses_fewer_cards_than_a_card_per_book():
    # Seven books of 30-minute chapters, 8.5 to 25 hours long, under the 5-hour cap.
    hours = [8.5, 9.5, 12, 21, 25, 16, 19.5]
    groups = [Group(str(n), f"Book {n}", items(*[14] * int(h * 2), minutes=30)) for n, h in enumerate(hours, 1)]
    per_book = pack(groups, Limits(), "sequential")
    back_to_back = pack(groups, Limits(), "continuous")
    assert len(per_book) == 25
    assert len(back_to_back) == 23  # ceil(111.5 / 5): no card but the last has room left
    assert all(c.duration_ms <= 5 * 60 * MIN for c in back_to_back)
    assert sum(len(c.items) for c in back_to_back) == sum(len(g.items) for g in groups)


def test_continuous_with_one_group_matches_sequential():
    limits = Limits(max_bytes=100 * MB, max_duration_ms=0)
    group = [Group("a", "Show", items(60, 30, 30, 50, 10))]
    assert [c.title for c in pack(group, limits, "continuous")] == ["Show (1 of 2)", "Show (2 of 2)"]
