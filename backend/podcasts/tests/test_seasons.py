from core.models import Track
from podcasts.api import _one, list_podcasts
from podcasts.models import Episode, Podcast


def _episode(show, n, season, saved):
    ep = Episode.objects.create(
        podcast=show, guid=f"g{n}", title=f"Ep {n}", audio_url=f"https://example.com/{n}.mp3", season=season
    )
    if saved:
        Track.objects.create(source="episode", episode=ep, title=ep.title, duration_ms=60_000)
    return ep


def test_seasons_in_order_with_unnumbered_last(db):
    show = Podcast.objects.create(feed_url="https://example.com/feed", title="Show")
    _episode(show, 1, None, True)  # trailer
    _episode(show, 2, 2, True)
    _episode(show, 3, 1, True)
    _episode(show, 4, 1, False)
    seasons = _one(show.pk).seasons
    assert [(s["season"], s["episode_count"], s["downloaded_count"]) for s in seasons] == [
        (1, 2, 1),
        (2, 1, 1),
        (None, 1, 1),
    ]
    assert seasons[0]["downloaded_duration_ms"] == 60_000


def test_show_without_season_data_is_one_season(db):
    show = Podcast.objects.create(feed_url="https://example.com/feed", title="Show")
    _episode(show, 1, None, True)
    _episode(show, 2, None, False)
    [p] = list_podcasts(None)
    assert [(s["season"], s["episode_count"], s["downloaded_count"]) for s in p.seasons] == [(None, 2, 1)]
