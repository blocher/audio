import pytest

from core.models import Track
from local_audio.models import Collection
from podcasts.models import Episode, Podcast

PW = "a-long-enough-password-1"


@pytest.fixture
def people(client, django_user_model):
    me = django_user_model.objects.create_user("sam", password=PW)
    other = django_user_model.objects.create_user("kid", password=PW)
    client.force_login(me)
    return me, other


def put(client, track, ms, **extra):
    return client.put(f"/api/listening/{track.pk}", {"position_ms": ms, **extra}, content_type="application/json")


@pytest.mark.django_db
def test_positions_are_saved_per_person_with_what_they_belong_to(client, people):
    show = Podcast.objects.create(title="Show", feed_url="https://example.com/feed")
    episode = Episode.objects.create(podcast=show, guid="1", title="Ep 1", audio_url="https://example.com/1.mp3")
    heard = Track.objects.create(source=Track.Source.EPISODE, episode=episode, title="Ep 1", duration_ms=600_000)
    folder = Collection.objects.create(name="CDs")
    song = Track.objects.create(source=Track.Source.LOCAL, collection=folder, title="Song", duration_ms=200_000)

    assert put(client, heard, 120_000).json()["finished"] is False
    assert put(client, song, 190_000).json()["finished"] is True  # within 30 seconds of the end
    rows = {r["track_id"]: r for r in client.get("/api/listening").json()}
    assert rows[heard.pk]["podcast_id"] == show.pk and rows[heard.pk]["position_ms"] == 120_000
    assert rows[song.pk]["collection_id"] == folder.pk and rows[song.pk]["finished"] is True

    # Someone else in the same home has their own place.
    client.force_login(people[1])
    assert client.get("/api/listening").json() == []


@pytest.mark.django_db
def test_only_tracks_in_your_own_library(client, people):
    from core.models import Household

    elsewhere = Household.objects.create(name="Elsewhere")
    their_folder = Collection.objects.create(name="Theirs", household=elsewhere)
    theirs = Track.objects.create(source=Track.Source.LOCAL, collection=their_folder, title="Not mine")
    assert put(client, theirs, 1000).status_code == 404
