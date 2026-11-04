import threading
import time

import httpx
import pytest

from core.models import Track
from yoto import client, services
from yoto.models import Playlist, Upload, YotoAccount


class FakeClock:
    """Stands in for the time module inside yoto.client, so backoff sleeps cost nothing."""

    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def make_api(monkeypatch, handler) -> client.Api:
    monkeypatch.setattr(client, "access_token", lambda account: "token")
    api = client.Api(YotoAccount())
    api.http = httpx.Client(base_url=client.API_BASE, transport=httpx.MockTransport(handler))
    return api


def test_a_429_on_one_thread_pauses_requests_on_the_others(monkeypatch):
    throttled = threading.Event()
    arrivals = {}

    def handler(request):
        path = request.url.path
        if path == "/a" and "/a" not in arrivals:
            arrivals["/a"] = time.monotonic()
            throttled.set()
            return httpx.Response(429, headers={"Retry-After": "0.4"})
        arrivals.setdefault(path, time.monotonic())
        return httpx.Response(200, json={})

    api = make_api(monkeypatch, handler)
    first = threading.Thread(target=api.request, args=("GET", "/a"))
    first.start()
    throttled.wait(5)
    time.sleep(0.05)  # let the throttled thread record its pause
    api.request("GET", "/b")
    first.join(5)

    assert arrivals["/b"] - arrivals["/a"] >= 0.35


def test_persistent_429_raises_throttled(monkeypatch):
    clock = FakeClock()
    monkeypatch.setattr(client, "time", clock)
    api = make_api(monkeypatch, lambda request: httpx.Response(429))
    with pytest.raises(client.Throttled):
        api.request("GET", "/content/mine")
    assert clock.now > 0  # it backed off between tries


def test_transcode_status_check_outlasts_throttling(monkeypatch, tmp_path):
    clock = FakeClock()
    monkeypatch.setattr(client, "time", clock)
    checks = []

    def handler(request):
        if request.url.path.endswith("/uploadUrl"):
            return httpx.Response(200, json={"upload": {"uploadId": "u1", "uploadUrl": None}})
        checks.append(clock.now)
        if len(checks) <= 7:  # more 429s than one request will retry
            return httpx.Response(429)
        return httpx.Response(200, json={"transcode": {"transcodedSha256": "done", "transcodedInfo": {}}})

    audio = tmp_path / "a.mp3"
    audio.write_bytes(b"audio")
    result = make_api(monkeypatch, handler).upload_audio(audio)
    assert result["transcodedSha256"] == "done"


class FakeApi:
    """Records how many uploads run at once; ``fail_path`` makes that file's upload fail."""

    def __init__(self, account, delay=0.2, fail_path=None):
        self.delay = delay
        self.fail_path = fail_path
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.saved = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        pass

    def upload_audio(self, path, on_progress=None, sha=""):
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if path == self.fail_path:
                time.sleep(0.05)
                raise client.YotoError("transcode failed")
            for _ in range(int(self.delay / 0.02)):
                on_progress(0.6)
                time.sleep(0.02)
            return {"transcodedSha256": f"t-{sha[:8]}", "transcodedInfo": {"duration": 60, "fileSize": 100}}
        finally:
            with self.lock:
                self.active -= 1

    def save_content(self, body):
        self.saved = body
        return {"cardId": "abcde"}


def make_playlist(tmp_path, monkeypatch, count):
    tracks = [
        Track.objects.create(source="local", title=f"Ch {n}", duration_ms=60_000, size_bytes=100, file=f"{n}.mp3")
        for n in range(count)
    ]
    account = YotoAccount.objects.create(encrypted_tokens="x")
    playlist = services.create_playlist("Book", [t.pk for t in tracks], account)
    files = {}
    for t in tracks:
        files[t.pk] = tmp_path / f"{t.pk}.mp3"
        files[t.pk].write_bytes(f"audio {t.pk}".encode())
    monkeypatch.setattr(services, "item_file", lambda item, use_optimized: files[item.track_id])
    return playlist, [files[t.pk] for t in tracks]


@pytest.mark.django_db(transaction=True)
def test_sync_uploads_tracks_in_parallel_and_keeps_chapter_order(tmp_path, monkeypatch):
    playlist, files = make_playlist(tmp_path, monkeypatch, 6)
    fake = FakeApi(None)
    monkeypatch.setattr(services.client, "Api", lambda account: fake)

    services.sync_playlist(playlist)

    assert fake.max_active == services.UPLOAD_THREADS
    urls = [c["tracks"][0]["trackUrl"] for c in fake.saved["content"]["chapters"]]
    assert urls == [f"yoto:#t-{client.sha256(f)[:8]}" for f in files]
    assert Upload.objects.count() == 6
    playlist.refresh_from_db()
    assert playlist.status == Playlist.Status.SYNCED and playlist.card_id == "abcde"


@pytest.mark.django_db(transaction=True)
def test_one_failed_track_stops_the_others_and_fails_the_card(tmp_path, monkeypatch):
    playlist, files = make_playlist(tmp_path, monkeypatch, 4)
    fake = FakeApi(None, delay=5, fail_path=files[1])
    monkeypatch.setattr(services.client, "Api", lambda account: fake)

    started = time.monotonic()
    with pytest.raises(client.YotoError, match="transcode failed"):
        services.sync_playlist(playlist)

    assert time.monotonic() - started < 2  # the other uploads gave up instead of running their full 5 s
    assert fake.saved is None
    playlist.refresh_from_db()
    assert playlist.status == Playlist.Status.FAILED
