import shutil
import subprocess

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from core import ai


class FakeClient:
    def __init__(self, calls):
        self.audio = self
        self.transcriptions = self
        self.calls = calls

    def create(self, **kwargs):
        self.calls.append({**kwargs, "file": kwargs["file"].name})
        return type("Result", (), {"text": " Who is Mary's uncle? "})()


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")
@pytest.mark.django_db
def test_a_recorded_question_comes_back_as_text(client, django_user_model, monkeypatch, tmp_path):
    client.force_login(django_user_model.objects.create_user("ben", password="pw"))
    clip = tmp_path / "question.webm"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus",
         str(clip)],
        check=True,
    )  # fmt: skip
    calls = []
    monkeypatch.setattr(ai, "resolve", lambda kind, provider, model: ("groq", "whisper-large-v3-turbo"))
    monkeypatch.setattr(ai, "openai_client", lambda provider, timeout=600: FakeClient(calls))

    upload = SimpleUploadedFile("question.webm", clip.read_bytes(), content_type="audio/webm")
    response = client.post("/api/transcripts/dictate", {"audio": upload, "hint": "The Secret Garden"})

    assert response.status_code == 200, response.content
    assert response.json() == {"text": "Who is Mary's uncle?"}
    assert calls[0]["model"] == "whisper-large-v3-turbo"
    assert calls[0]["prompt"] == "The Secret Garden"  # helps spell names from the book
    assert calls[0]["file"].endswith(".mp3")  # converted from the browser's format first
