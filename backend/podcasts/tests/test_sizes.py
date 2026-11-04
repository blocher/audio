import pytest

from core.models import Track
from podcasts.api import _one, list_podcasts
from podcasts.models import Episode, Podcast

MB = 1024**2


@pytest.fixture
def podcast(db):
    show = Podcast.objects.create(feed_url="https://example.com/feed", title="Show")
    sizes = [(30 * MB, 10 * MB), (20 * MB, 0), (None, None)]  # downsized, original only, not downloaded
    for n, (size, optimized) in enumerate(sizes):
        episode = Episode.objects.create(podcast=show, guid=f"g{n}", title=f"Ep {n}", audio_url=f"https://example.com/{n}.mp3")
        if size is not None:
            Track.objects.create(source="episode", episode=episode, title=episode.title, size_bytes=size, optimized_size_bytes=optimized)
    return show


def test_totals_show_originals_and_downsized(podcast):
    p = _one(podcast.pk)
    assert p.downloaded_bytes == 50 * MB
    assert p.downsized_count == 1
    assert p.downsized_bytes == 30 * MB  # 10 MB downsized + 20 MB still original


def test_list_without_downloads_reports_zero(db):
    Podcast.objects.create(feed_url="https://example.com/other", title="Empty")
    [p] = list_podcasts(None)
    assert (p.downloaded_bytes, p.downsized_count, p.downsized_bytes) == (0, 0, 0)
