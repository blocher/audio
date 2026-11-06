from core.ai import BALANCED, BEST, FAST, ModelInfo, curate_chat, pretty_name


def picked(provider, ids):
    return [(m.id, m.extra.get("tier")) for m in curate_chat(provider, [ModelInfo(i) for i in ids])]


def test_claude_keeps_the_newest_opus_sonnet_and_haiku_only():
    ids = [
        "claude-fable-5-1",
        "claude-opus-5-5",
        "claude-opus-5",
        "claude-opus-4-1-20250805",
        "claude-sonnet-5-5",
        "claude-sonnet-4-5-20250929",
        "claude-haiku-4-5-20251001",
        "claude-haiku-5-5",
        "claude-3-5-haiku-20241022",
    ]
    assert picked("anthropic", ids) == [
        ("claude-opus-5-5", BEST),
        ("claude-sonnet-5-5", BALANCED),
        ("claude-haiku-5-5", FAST),
    ]


def test_other_providers_get_one_model_per_tier():
    assert picked("openai", ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5-mini", "o3"]) == [
        ("gpt-6.1-sol", BEST),
        ("gpt-6-astra", BALANCED),
        ("gpt-6-luna", FAST),
    ]
    assert picked(
        "gemini", ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.1-pro-preview", "gemini-3.8-flash-lite"]
    ) == [
        ("gemini-3.1-pro-preview", BEST),
        ("gemini-3.8-flash", BALANCED),
        ("gemini-3.8-flash-lite", FAST),
    ]
    assert picked("xai", ["grok-4.7", "grok-4.3", "grok-4.20-0309-non-reasoning", "grok-code-fast-1"]) == [
        ("grok-4.7", BEST),
        ("grok-4.20-0309-non-reasoning", FAST),
    ]


def test_unrecognised_names_fall_back_to_a_short_list():
    assert len(curate_chat("xai", [ModelInfo(f"mystery-{n}") for n in range(8)])) == 3


def test_pretty_names():
    assert pretty_name("gpt-6.1-sol") == "GPT-6.1 Sol"
    assert pretty_name("claude-opus-4-1-20250805") == "Claude Opus 4.1"
    assert pretty_name("gemini-3.8-flash") == "Gemini 3.8 Flash"
