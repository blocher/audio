"""Resolve Apple Podcasts links to RSS feeds and parse feeds into episodes."""

import re
from datetime import UTC, datetime
from time import struct_time

import feedparser
import httpx

USER_AGENT = "Mozilla/5.0 (Macintosh) AudioShelf/1.0 (+https://audio.benlocher.com)"
APPLE_ID_RE = re.compile(r"(?:podcasts\.apple\.com|itunes\.apple\.com)/.*?id(\d+)")


class FeedError(ValueError):
    pass


def http() -> httpx.Client:
    return httpx.Client(headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=30)


def resolve_feed_url(url: str) -> tuple[str, str]:
    """Return (feed_url, apple_url). Accepts an Apple Podcasts page link or a plain RSS URL."""
    url = url.strip()
    if match := APPLE_ID_RE.search(url):
        with http() as client:
            data = client.get(
                "https://itunes.apple.com/lookup", params={"id": match.group(1), "entity": "podcast"}
            ).json()
        results = [r for r in data.get("results", []) if r.get("feedUrl")]
        if not results:
            raise FeedError("Apple didn't return an RSS feed for that podcast (it may be Apple-exclusive).")
        return results[0]["feedUrl"], url
    if not url.startswith(("http://", "https://")):
        raise FeedError("Paste an Apple Podcasts link or an RSS feed URL.")
    return url, ""


def search_apple(term: str, limit: int = 12) -> list[dict]:
    with http() as client:
        data = client.get(
            "https://itunes.apple.com/search", params={"term": term, "media": "podcast", "limit": limit}
        ).json()
    return [
        {
            "title": r.get("collectionName", ""),
            "author": r.get("artistName", ""),
            "feed_url": r.get("feedUrl", ""),
            "apple_url": r.get("collectionViewUrl", ""),
            "image_url": r.get("artworkUrl600") or r.get("artworkUrl100", ""),
            "episode_count": r.get("trackCount", 0),
            "genre": r.get("primaryGenreName", ""),
        }
        for r in data.get("results", [])
        if r.get("feedUrl")
    ]


def parse_duration(value) -> int:
    """itunes:duration may be seconds, MM:SS or HH:MM:SS. Returns milliseconds."""
    if not value:
        return 0
    value = str(value).strip()
    try:
        parts = [float(p) for p in value.split(":")]
    except ValueError:
        return 0
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + part
    return int(seconds * 1000)


def _date(entry) -> datetime | None:
    parsed: struct_time | None = entry.get("published_parsed") or entry.get("updated_parsed")
    return datetime(*parsed[:6], tzinfo=UTC) if parsed else None


def _int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def fetch_feed(feed_url: str) -> dict:
    with http() as client:
        response = client.get(feed_url)
        response.raise_for_status()
    parsed = feedparser.parse(response.content)
    if parsed.bozo and not parsed.entries:
        raise FeedError(f"That doesn't look like a podcast feed ({parsed.bozo_exception}).")
    feed = parsed.feed
    image = (feed.get("image") or {}).get("href") or (feed.get("itunes_image") or {}).get("href", "")
    episodes = []
    for entry in parsed.entries:
        enclosure = next(
            (
                link
                for link in entry.get("links", [])
                if link.get("rel") == "enclosure" and str(link.get("type", "audio")).startswith("audio")
            ),
            None,
        ) or next((link for link in entry.get("links", []) if link.get("rel") == "enclosure"), None)
        if not enclosure or not enclosure.get("href"):
            continue
        episodes.append(
            {
                "guid": entry.get("id") or enclosure["href"],
                "title": entry.get("title", "Untitled episode")[:500],
                "description": entry.get("summary", ""),
                "published_at": _date(entry),
                "audio_url": enclosure["href"],
                "enclosure_bytes": _int(enclosure.get("length")) or 0,
                "duration_ms": parse_duration(entry.get("itunes_duration")),
                "image_url": (entry.get("image") or {}).get("href", "")
                if isinstance(entry.get("image"), dict)
                else "",
                "season": _int(entry.get("itunes_season")),
                "number": _int(entry.get("itunes_episode")),
            }
        )
    return {
        "title": feed.get("title", "Untitled podcast")[:500],
        "author": feed.get("author") or feed.get("itunes_author", ""),
        "description": feed.get("summary") or feed.get("subtitle", ""),
        "image_url": image,
        "link": feed.get("link", ""),
        "episodes": episodes,
    }
