from datetime import timedelta

import pytest
from django.utils import timezone

from core.models import Job, Track
from podcasts import tasks
from podcasts.models import Episode, Podcast


@pytest.fixture
def show(db, settings, tmp_path):
    settings.MEDIA_ROOT = str(tmp_path)
    podcast = Podcast.objects.create(feed_url="https://example.com/feed", title="Show")
    episodes = []
    for n in range(3):
        episodes.append(
            Episode.objects.create(
                podcast=podcast,
                guid=f"g{n}",
                title=f"Ep {n}",
                published_at=timezone.now() - timedelta(days=10 - n),
                audio_url=f"https://example.com/{n}.mp3",
            )
        )
    return episodes


@pytest.fixture
def calls(monkeypatch):
    log = {"download": [], "optimize": []}

    def download(episode, on_progress=None):
        log["download"].append(episode.title)
        episode.status = Episode.Status.READY
        episode.save()
        defaults = {"source": "episode", "title": episode.title}
        return Track.objects.update_or_create(episode=episode, defaults=defaults)[0]

    def optimize(track, kbps, mono, on_progress=None):
        log["optimize"].append(track.title)

    monkeypatch.setattr(tasks, "download_episode", download)
    monkeypatch.setattr(tasks, "optimize_track", optimize)
    return log


def downsized(episode, tmp_path, kbps=48, mono=True):
    (tmp_path / f"{episode.pk}.mp3").write_bytes(b"x")
    return Track.objects.create(
        episode=episode,
        source="episode",
        title=episode.title,
        optimized_file=f"{episode.pk}.mp3",
        optimized_bitrate_kbps=kbps,
        optimized_mono=mono,
    )


def test_resumed_download_skips_what_the_first_run_finished(show, calls, tmp_path):
    first, second, third = show
    job = Job.objects.create(
        kind="podcast_download", title="x", status="queued", started_at=timezone.now() - timedelta(minutes=30)
    )
    # The first run downloaded and downsized episode 0, and was killed while downsizing episode 1.
    Episode.objects.filter(pk__in=[first.pk, second.pk]).update(status=Episode.Status.READY)
    downsized(first, tmp_path)
    Track.objects.create(episode=second, source="episode", title=second.title)

    tasks.download_episodes_task(job.pk, [e.pk for e in show], 48, True)

    assert calls == {"download": ["Ep 2"], "optimize": ["Ep 1", "Ep 2"]}
    job.refresh_from_db()
    assert job.status == Job.Status.SUCCEEDED


def test_fresh_download_redoes_episodes_it_was_asked_for(show, calls, tmp_path):
    first = show[0]
    first.status = Episode.Status.READY
    first.save()
    downsized(first, tmp_path)
    job = Job.objects.create(kind="podcast_download", title="x")

    tasks.download_episodes_task(job.pk, [first.pk], 48, True)

    assert calls == {"download": ["Ep 0"], "optimize": ["Ep 0"]}
