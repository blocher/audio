import pytest

from core.models import Track
from yoto.models import Playlist, PlaylistItem


@pytest.fixture
def signed_in(client, django_user_model):
    client.force_login(django_user_model.objects.create_user("ben"))
    return client


@pytest.mark.django_db
def test_added_tracks_go_on_the_end_and_long_ones_are_split(signed_in):
    short = Track.objects.create(source="local", title="Short", duration_ms=10 * 60_000, size_bytes=5_000_000)
    long = Track.objects.create(source="local", title="Long", duration_ms=90 * 60_000, size_bytes=40_000_000)
    playlist = Playlist.objects.create(title="Card")
    PlaylistItem.objects.create(playlist=playlist, track=short, position=0)

    response = signed_in.patch(
        f"/api/yoto/playlists/{playlist.pk}", {"add_track_ids": [long.pk]}, content_type="application/json"
    )
    assert response.status_code == 200
    items = response.json()["items"]
    assert [i["track"]["id"] for i in items] == [short.pk, long.pk, long.pk]
    assert items[1]["start_ms"] == 0 and items[2]["end_ms"] == long.duration_ms
    assert "part 1 of 2" in items[1]["title"]


@pytest.mark.django_db
def test_reorder_keeps_listed_items_in_the_given_order(signed_in):
    playlist = Playlist.objects.create(title="Card")
    items = [
        PlaylistItem.objects.create(
            playlist=playlist,
            track=Track.objects.create(source="local", title=f"T{n}", duration_ms=60_000),
            position=n,
        )
        for n in range(4)
    ]
    order = [items[2].pk, items[3].pk, items[0].pk, items[1].pk]
    response = signed_in.patch(
        f"/api/yoto/playlists/{playlist.pk}", {"item_ids": order}, content_type="application/json"
    )
    assert [i["id"] for i in response.json()["items"]] == order
