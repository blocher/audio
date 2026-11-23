import base64
import shutil
import subprocess

import pytest

from core import ai
from core.models import Household
from core.secrets import save_credential
from core.tenancy import use_household
from transcripts import stt


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")
@pytest.mark.django_db(transaction=True)
def test_every_chunk_uses_the_households_own_key(monkeypatch, tmp_path, settings):
    """Chunks are transcribed side by side on worker threads; each must still find the household's key."""
    settings.CREDENTIAL_ENCRYPTION_KEY = base64.urlsafe_b64encode(b"k" * 32).decode()
    household = Household.objects.create(name="Ours")
    save_credential("openrouter", {"api_key": "sk-or-ours"}, household.pk)
    clip = tmp_path / "book.mp3"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", str(clip)], check=True
    )
    keys = []

    def fake_chunk(provider, model, path, length_ms):
        keys.append(ai.api_key(provider))
        return [{"start_ms": 0, "end_ms": length_ms, "text": "hello"}]

    monkeypatch.setattr(stt, "chunk_ms", lambda provider, model: 1000)
    monkeypatch.setattr(stt, "transcribe_chunk", fake_chunk)

    with use_household(household.pk):
        provider, model, segments = stt.transcribe_file(clip, 3000, "openrouter", "openai/whisper-large-v3")

    assert provider == "openrouter"
    assert keys == ["sk-or-ours"] * 3
    assert [s["start_ms"] for s in segments] == [0, 1000, 2000]


def _provider_error(cls, status, url):
    import httpx

    response = httpx.Response(status, request=httpx.Request("POST", url))
    return cls("boom", response=response, body=None)


def test_provider_errors_read_as_plain_language():
    import openai

    rejected = _provider_error(openai.AuthenticationError, 401, "https://openrouter.ai/api/v1/audio/transcriptions")
    assert ai.explain(rejected) == "OpenRouter turned down the key. Connect it again in Settings, then try again."
    broke = _provider_error(openai.APIStatusError, 402, "https://openrouter.ai/api/v1/chat/completions")
    assert "out of credits" in ai.explain(broke)
    busy = _provider_error(openai.RateLimitError, 429, "https://api.openai.com/v1/audio/transcriptions")
    assert ai.explain(busy).startswith("OpenAI is busy")
    assert ai.explain(ValueError("something else")) is None


@pytest.mark.django_db
def test_a_library_without_the_key_is_told_to_connect_it(settings):
    settings.CREDENTIAL_ENCRYPTION_KEY = base64.urlsafe_b64encode(b"k" * 32).decode()
    household = Household.objects.create(name="Ours")
    with use_household(household.pk), pytest.raises(ai.MissingKey, match="OpenRouter isn't connected"):
        ai.openai_client("openrouter")
