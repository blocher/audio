"""Pack tracks onto as few Yoto cards as possible.

A *group* is an ordered run of tracks that belongs together (a book's chapters, a podcast's episodes, a folder).
Two strategies:

* ``sequential`` keeps every group in order and fills each card before starting the next. For ordered content this
  greedy fill is optimal: no contiguous split uses fewer cards.
* ``compact`` splits each group into full cards plus a remainder, then bin-packs the remainders with first-fit
  decreasing so short groups share cards. Groups are never interleaved; within a card each group stays in order.
"""

from dataclasses import dataclass, field


@dataclass
class Item:
    track_id: int
    title: str
    bytes: int
    duration_ms: int
    # A slice of the track (for tracks longer than Yoto allows); None means the whole track.
    start_ms: int | None = None
    end_ms: int | None = None


@dataclass
class Group:
    key: str
    title: str
    items: list[Item]


@dataclass
class Limits:
    """Yoto's published MYO limits: 100 tracks, 500 MB and 5 hours per card; 100 MB and 60 minutes per track."""

    max_bytes: int = 500 * 1024 * 1024
    max_tracks: int = 100
    max_duration_ms: int = 5 * 60 * 60 * 1000  # 0 = no limit
    max_track_bytes: int = 100 * 1024 * 1024
    max_track_ms: int = 60 * 60 * 1000


def split_long(item: Item, limits: Limits) -> list[Item]:
    """Cut a track that breaks the per-track limits into equal parts that don't."""
    parts = 1
    if limits.max_track_ms and item.duration_ms > limits.max_track_ms:
        parts = max(parts, -(-item.duration_ms // (limits.max_track_ms - 60_000)))
    if limits.max_track_bytes and item.bytes > limits.max_track_bytes:
        parts = max(parts, -(-item.bytes // int(limits.max_track_bytes * 0.95)))
    if parts == 1:
        return [item]
    length = item.duration_ms / parts
    out = []
    for n in range(parts):
        start, end = round(n * length), round((n + 1) * length) if n < parts - 1 else item.duration_ms
        out.append(
            Item(
                item.track_id,
                f"{item.title} (part {n + 1} of {parts})",
                item.bytes // parts,
                end - start,
                start,
                end,
            )
        )
    return out


@dataclass
class Segment:
    group: Group
    items: list[Item]
    part: int = 1
    parts: int = 1

    @property
    def bytes(self) -> int:
        return sum(i.bytes for i in self.items)

    @property
    def duration_ms(self) -> int:
        return sum(i.duration_ms for i in self.items)


@dataclass
class Card:
    segments: list[Segment] = field(default_factory=list)

    @property
    def items(self) -> list[Item]:
        return [i for s in self.segments for i in s.items]

    @property
    def bytes(self) -> int:
        return sum(s.bytes for s in self.segments)

    @property
    def duration_ms(self) -> int:
        return sum(s.duration_ms for s in self.segments)

    def fits(self, items: list[Item], limits: Limits) -> bool:
        if len(self.items) + len(items) > limits.max_tracks:
            return False
        if self.bytes + sum(i.bytes for i in items) > limits.max_bytes:
            return False
        if limits.max_duration_ms and self.duration_ms + sum(i.duration_ms for i in items) > limits.max_duration_ms:
            return False
        return True

    @property
    def title(self) -> str:
        if len(self.segments) == 1:
            seg = self.segments[0]
            return seg.group.title if seg.parts == 1 else f"{seg.group.title} ({seg.part} of {seg.parts})"
        names = [s.group.title for s in self.segments]
        return " · ".join(names) if len(names) <= 3 else f"{' · '.join(names[:2])} + {len(names) - 2} more"


class TrackTooLarge(ValueError):
    pass


def _split(group: Group, limits: Limits) -> list[Segment]:
    """Cut one group into consecutive card-sized segments (greedy, so all but the last are full)."""
    segments: list[Segment] = []
    current = Card()
    for item in group.items:
        if not Card().fits([item], limits):
            raise TrackTooLarge(f"“{item.title}” is larger than a whole card; downsize it or raise the limit.")
        if not current.fits([item], limits):
            segments.append(Segment(group, current.items))
            current = Card()
        current.segments = [Segment(group, current.items + [item])]
    if current.items:
        segments.append(Segment(group, current.items))
    for n, seg in enumerate(segments, start=1):
        seg.part, seg.parts = n, len(segments)
    return segments


def pack(groups: list[Group], limits: Limits | None = None, strategy: str = "sequential") -> list[Card]:
    limits = limits or Limits()
    groups = [Group(g.key, g.title, [p for i in g.items for p in split_long(i, limits)]) for g in groups if g.items]
    if strategy == "sequential":
        cards: list[Card] = []
        for group in groups:
            cards.extend(Card([seg]) for seg in _split(group, limits))
        return cards

    full: list[Card] = []
    leftovers: list[Segment] = []
    for group in groups:
        segs = _split(group, limits)
        if len(segs) > 1:
            full.extend(Card([s]) for s in segs[:-1])
        leftovers.append(segs[-1])

    bins: list[Card] = []
    for seg in sorted(leftovers, key=lambda s: s.bytes, reverse=True):
        target = next((c for c in bins if c.fits(seg.items, limits)), None)
        if target is None:
            bins.append(Card([seg]))
        else:
            target.segments.append(seg)
    # Keep a group's parts together and in order in the final listing.
    order = {g.key: n for n, g in enumerate(groups)}
    bins.sort(key=lambda c: min(order[s.group.key] for s in c.segments))
    for card in bins:
        card.segments.sort(key=lambda s: order[s.group.key])
    result = full + bins
    result.sort(key=lambda c: (order[c.segments[0].group.key], c.segments[0].part))
    return result
