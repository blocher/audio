"""AI providers: which are configured, which models they offer, and SDK clients for them.

Model lists come live from each provider's own models endpoint (cached for an hour) so new models appear without a
code change; the fallbacks below are only used when a provider's listing call fails.
"""

import hashlib
import logging
import re
from dataclasses import dataclass, field

from django.core.cache import cache

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    stt: bool
    chat: bool
    base_url: str | None = None  # for OpenAI-compatible SDK use
    key_url: str = ""
    fallback_chat: tuple[str, ...] = ()
    fallback_stt: tuple[str, ...] = ()
    preferred_chat: tuple[str, ...] = ()
    preferred_stt: tuple[str, ...] = ()


PROVIDERS: dict[str, Provider] = {
    p.id: p
    for p in [
        Provider(
            "anthropic",
            "Claude (Anthropic)",
            stt=False,
            chat=True,
            key_url="https://console.anthropic.com/settings/keys",
            fallback_chat=("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"),
            preferred_chat=("claude-opus-5-5", "claude-sonnet-5-5"),
        ),
        Provider(
            "openai",
            "OpenAI",
            stt=True,
            chat=True,
            key_url="https://platform.openai.com/api-keys",
            fallback_chat=("gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"),
            fallback_stt=("gpt-transcribe", "whisper-1"),
            preferred_chat=("gpt-6.1-sol", "gpt-6-astra"),
            preferred_stt=("whisper-1", "gpt-transcribe"),
        ),
        Provider(
            "gemini",
            "Gemini (Google)",
            stt=True,
            chat=True,
            key_url="https://aistudio.google.com/apikey",
            fallback_chat=("gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.1-pro-preview"),
            fallback_stt=("gemini-3.5-transcribe", "gemini-3.8-flash"),
            preferred_chat=("gemini-3.8-flash", "gemini-3.6-flash"),
            preferred_stt=("gemini-3.5-transcribe",),
        ),
        Provider(
            "xai",
            "Grok (xAI)",
            stt=False,
            chat=True,
            base_url="https://api.x.ai/v1",
            key_url="https://console.x.ai/",
            fallback_chat=("grok-4.7", "grok-4.3", "grok-4.20-0309-non-reasoning"),
            preferred_chat=("grok-4.7", "grok-4.3"),
        ),
        Provider(
            "groq",
            "Groq",
            stt=True,
            chat=True,
            base_url="https://api.groq.com/openai/v1",
            key_url="https://console.groq.com/keys",
            fallback_chat=("openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile"),
            fallback_stt=("whisper-large-v3-turbo", "whisper-large-v3"),
            preferred_chat=("openai/gpt-oss-120b",),
            preferred_stt=("whisper-large-v3-turbo",),
        ),
    ]
}

# Speech-to-text price per audio hour (USD), where the provider publishes one.
STT_PRICE_PER_HOUR = {
    ("groq", "whisper-large-v3-turbo"): 0.04,
    ("groq", "whisper-large-v3"): 0.111,
    ("openai", "whisper-1"): 0.36,
    ("openai", "gpt-4o-transcribe"): 0.36,
    ("openai", "gpt-4o-mini-transcribe"): 0.18,
}

# Models whose transcription API returns segment timestamps (verbose_json). Others are cut into short chunks.
SEGMENT_STT_MODELS = {"whisper-1", "whisper-large-v3", "whisper-large-v3-turbo"}


@dataclass
class ModelInfo:
    id: str
    label: str = ""
    context: int = 0  # input tokens, 0 = unknown
    note: str = ""
    preview: bool = False
    extra: dict = field(default_factory=dict)


def api_key(provider: str) -> str:
    from .api import setting

    return setting(provider, "api_key") or ""


def configured(provider: str) -> bool:
    return bool(api_key(provider))


# ---------- clients ----------


def openai_client(provider: str, timeout: float = 600):
    import openai

    p = PROVIDERS[provider]
    return openai.OpenAI(api_key=api_key(provider), base_url=p.base_url, timeout=timeout, max_retries=4)


def anthropic_client():
    import anthropic

    return anthropic.Anthropic(api_key=api_key("anthropic"), max_retries=3)


def gemini_client():
    from google import genai

    return genai.Client(api_key=api_key("gemini"))


# ---------- model discovery ----------

_SKIP_OPENAI_CHAT = re.compile(
    r"audio|realtime|transcribe|tts|image|embedding|search|moderation|whisper|dall-e|sora|live"
)


def _list_openai(provider: str) -> tuple[list[ModelInfo], list[ModelInfo]]:
    ids = sorted((m.id for m in openai_client(provider, timeout=20).models.list()), reverse=True)
    chat = [ModelInfo(i) for i in ids if re.match(r"(gpt-|o\d|chatgpt)", i) and not _SKIP_OPENAI_CHAT.search(i)]
    stt = [
        ModelInfo(i)
        for i in ids
        if ("transcribe" in i or "whisper" in i) and not re.search(r"live|realtime|diarize", i)
    ]
    for m in chat:
        m.context = 1_050_000 if m.id.startswith("gpt-6") else 400_000 if m.id.startswith("gpt-5") else 128_000
    return chat, stt


def _list_xai() -> tuple[list[ModelInfo], list[ModelInfo]]:
    ids = sorted((m.id for m in openai_client("xai", timeout=20).models.list()), reverse=True)
    chat = [ModelInfo(i) for i in ids if i.startswith("grok") and not re.search(r"image|imagine|voice|vision", i)]
    for m in chat:
        m.context = (
            1_000_000 if re.match(r"grok-4\.(3|20)", m.id) else 500_000 if m.id.startswith("grok-4") else 256_000
        )
    return chat, []


def _list_groq() -> tuple[list[ModelInfo], list[ModelInfo]]:
    rows = openai_client("groq", timeout=20).models.list()
    chat, stt = [], []
    for m in rows:
        data = m.model_dump() if hasattr(m, "model_dump") else dict(m)
        mid = data["id"]
        if not data.get("active", True):
            continue
        if "whisper" in mid:
            stt.append(ModelInfo(mid))
        elif not re.search(r"orpheus|guard|tts|playai|compound", mid):
            chat.append(ModelInfo(mid, context=int(data.get("context_window") or 0)))
    return sorted(chat, key=lambda m: m.id), sorted(stt, key=lambda m: m.id, reverse=True)


def _list_gemini() -> tuple[list[ModelInfo], list[ModelInfo]]:
    chat, stt = [], []
    for m in gemini_client().models.list():
        mid = (m.name or "").removeprefix("models/")
        if not mid.startswith("gemini"):
            continue
        actions = set(getattr(m, "supported_actions", None) or [])
        context = int(getattr(m, "input_token_limit", 0) or 0)
        if re.search(r"live|tts|image|embedding|native-audio|robotics|computer-use", mid):
            continue
        if "transcribe" in mid:
            stt.append(ModelInfo(mid, preview="preview" in mid))
        elif not actions or "generateContent" in actions:
            info = ModelInfo(mid, context=context, preview="preview" in mid or "exp" in mid)
            chat.append(info)
            if "flash" in mid or "pro" in mid:
                stt.append(ModelInfo(mid, note="general model; timestamps are approximate", preview=info.preview))
    chat.sort(key=lambda m: m.id, reverse=True)
    stt.sort(key=lambda m: ("transcribe" not in m.id, m.id))
    return chat, stt


def _list_anthropic() -> tuple[list[ModelInfo], list[ModelInfo]]:
    chat = []
    for m in anthropic_client().models.list():
        chat.append(
            ModelInfo(
                m.id, label=getattr(m, "display_name", "") or "", context=int(getattr(m, "max_input_tokens", 0) or 0)
            )
        )
    return chat, []


# ---------- the short list of chat models people pick from ----------

BEST, BALANCED, FAST = "Best reasoning", "Balanced", "Fast"
_V = r"(?P<v>\d+(?:[.-]\d+)?)"  # 5-5, 6.1, 4.20, or just 4
_DATED = r"(?P<dated>-\d{4}(?:-?\d{2}){2}|-\d{4})?"  # -20250805, -2025-08-07, -0309
_PREVIEW = r"(?P<preview>-preview(?:-[\d-]+)?)?"

# Per provider, each tier's model families; the newest match across a tier's patterns wins (ties go to the earlier
# pattern, then to a stable, undated alias). Families no tier names are left out of the picker.
CHAT_TIERS: dict[str, list[tuple[str, list[str]]]] = {
    "anthropic": [
        (BEST, [rf"claude-opus-(?P<v>\d+(?:-\d)?){_DATED}"]),
        (BALANCED, [rf"claude-sonnet-(?P<v>\d+(?:-\d)?){_DATED}"]),
        (FAST, [rf"claude-haiku-(?P<v>\d+(?:-\d)?){_DATED}"]),
    ],
    "openai": [
        (BEST, [rf"gpt-{_V}-sol{_DATED}", rf"gpt-{_V}{_DATED}"]),
        (BALANCED, [rf"gpt-{_V}-astra{_DATED}", rf"gpt-{_V}-mini{_DATED}"]),
        (FAST, [rf"gpt-{_V}-luna{_DATED}", rf"gpt-{_V}-nano{_DATED}"]),
    ],
    "gemini": [
        (BEST, [rf"gemini-{_V}-pro{_PREVIEW}"]),
        (BALANCED, [rf"gemini-{_V}-flash{_PREVIEW}"]),
        (FAST, [rf"gemini-{_V}-flash-lite{_PREVIEW}"]),
    ],
    "xai": [
        (BEST, [rf"grok-{_V}{_DATED}(?:-reasoning)?"]),
        (FAST, [rf"grok-{_V}{_DATED}-fast(?:-reasoning|-non-reasoning)?", rf"grok-{_V}{_DATED}-non-reasoning"]),
    ],
    "groq": [
        (BEST, [r"openai/gpt-oss-120b"]),
        (BALANCED, [r"llama-3\.3-70b-versatile"]),
        (FAST, [r"openai/gpt-oss-20b", r"llama-3\.1-8b-instant"]),
    ],
}


def _version(text: str | None) -> float:
    """ "5-5" → 5.5, "6.1" → 6.1, "4.20" → 4.2, "4" → 4.0."""
    if not text:
        return 0.0
    major, _, minor = re.sub(r"-", ".", text).partition(".")
    return float(f"{major}.{minor or 0}")


def pretty_name(model_id: str) -> str:
    """gpt-6.1-sol → GPT-6.1 Sol, gemini-3.8-flash → Gemini 3.8 Flash, claude-opus-5-5 → Claude Opus 5.5."""
    name = model_id.split("/")[-1]
    name = re.sub(r"(\d+)-(\d)(?=-|$)", r"\1.\2", name)
    name = re.sub(r"-\d{4}(?:-?\d{2}){2}\b|-\d{4}\b", "", name).replace("non-reasoning", "non\u2011reasoning")
    words = [w.upper() if w in {"gpt", "oss"} else w.capitalize() for w in name.split("-")]
    out = " ".join(words)
    return re.sub(r"^(GPT) (\d)", r"\1-\2", out)


def curate_chat(provider: str, models: list[ModelInfo]) -> list[ModelInfo]:
    """The newest model in each tier (best reasoning, balanced, fast), labelled with its tier."""
    by_id = {m.id: m for m in models}
    chosen: list[ModelInfo] = []
    for tier, patterns in CHAT_TIERS.get(provider, []):
        best_key, best = None, None
        for rank, pattern in enumerate(patterns):
            for m in models:
                match = re.fullmatch(pattern, m.id)
                if not match:
                    continue
                groups = match.groupdict()
                key = (_version(groups.get("v")), -rank, not groups.get("preview"), not groups.get("dated"))
                if best_key is None or key > best_key:
                    best_key, best = key, m
        if best and best not in chosen:
            chosen.append(best)
            best.extra["tier"] = tier
    if not chosen:
        # A provider whose model names we don't recognise: its known defaults, else the top of its own list.
        known = [by_id[i] for i in PROVIDERS[provider].fallback_chat if i in by_id]
        chosen = (known or models)[:3]
    for m in chosen:
        m.label = m.label or pretty_name(m.id)
    return chosen


LISTERS = {
    "openai": lambda: _list_openai("openai"),
    "xai": _list_xai,
    "groq": _list_groq,
    "gemini": _list_gemini,
    "anthropic": _list_anthropic,
}


def provider_models(provider: str, refresh: bool = False) -> dict:
    """{"chat": [...], "stt": [...], "error": str} for one configured provider."""
    p = PROVIDERS[provider]
    key = f"ai-models:v2:{provider}:{hashlib.sha256(api_key(provider).encode()).hexdigest()[:12]}"
    if not refresh and (cached := cache.get(key)):
        return cached
    error = ""
    try:
        chat, stt = LISTERS[provider]()
    except Exception as exc:  # noqa: BLE001 - fall back to known models; the UI shows the error
        log.warning("Listing %s models failed: %s", provider, exc)
        error = str(exc)[:300]
        chat = [ModelInfo(i) for i in p.fallback_chat]
        stt = [ModelInfo(i) for i in p.fallback_stt]
    if not p.stt:
        stt = []
    chat = curate_chat(provider, chat)

    def order(models: list[ModelInfo], preferred: tuple[str, ...]) -> list[dict]:
        rank = {mid: n for n, mid in enumerate(preferred)}
        if any(m.extra.get("tier") for m in models):
            # Tiered chat models stay in tier order, best first.
            rank = {m.id: n for n, m in enumerate(models)}
        models = sorted(models, key=lambda m: rank.get(m.id, len(rank)))
        out = []
        for m in models:
            row = {
                "id": m.id,
                "label": m.label or m.id,
                "context": m.context,
                "note": m.note,
                "preview": m.preview,
                "recommended": m.id in rank,
            }
            if m.extra.get("tier"):
                row["tier"] = m.extra["tier"]
            if (provider, m.id) in STT_PRICE_PER_HOUR:
                row["price_per_hour"] = STT_PRICE_PER_HOUR[(provider, m.id)]
            if m.id in SEGMENT_STT_MODELS:
                row["timestamps"] = "segments"
            out.append(row)
        return out

    result = {
        "chat": order(chat, p.preferred_chat),
        "stt": order(stt, p.preferred_stt),
        "error": error,
    }
    cache.set(key, result, 3600 if not error else 120)
    return result


def catalog(kind: str) -> list[dict]:
    """Every configured provider that can do ``kind`` ("chat" or "stt"), with its models."""
    out = []
    for p in PROVIDERS.values():
        if not getattr(p, kind) or not configured(p.id):
            continue
        models = provider_models(p.id)
        out.append({"provider": p.id, "label": p.label, "models": models[kind], "error": models["error"]})
    return out


def model_context(provider: str, model: str) -> int:
    for row in provider_models(provider)["chat"]:
        if row["id"] == model and row["context"]:
            return row["context"]
    return 128_000


def resolve(kind: str, provider: str | None, model: str | None) -> tuple[str, str]:
    """Pick a usable provider/model: the requested one, else the saved default, else the first configured."""
    from .api import setting

    if not provider:
        provider = setting("preferences", f"{kind}_provider")
        model = model or setting("preferences", f"{kind}_model")
    if provider and provider in PROVIDERS and configured(provider):
        if not model:
            options = provider_models(provider)[kind]
            model = options[0]["id"] if options else ""
        if model:
            return provider, model
    for p in PROVIDERS.values():
        if getattr(p, kind) and configured(p.id):
            options = provider_models(p.id)[kind]
            if options:
                return p.id, options[0]["id"]
    what = "transcribe" if kind == "stt" else "answer questions"
    raise RuntimeError(f"Add an API key in Settings for a provider that can {what}.")
