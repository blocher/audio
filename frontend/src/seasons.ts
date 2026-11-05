import type { Episode, PackGroup } from "./types";

/**
 * Podcast seasons, treated the way books in a series are: each season is its own source on the cards,
 * in order. A feed with no season numbers is one season. When some episodes have a season and others
 * don't (trailers, bonus episodes), the ones without go last as "Extras".
 */
export type Season = { season: number | null; label: string; episodes: Episode[] };

export const seasonLabel = (season: number | null, several: boolean) => (season === null ? (several ? "Extras" : "All episodes") : `Season ${season}`);

/** A season's listening order: by episode number when every episode has one, else by release date. */
export function listeningOrder(episodes: Episode[]): Episode[] {
  const numbered = episodes.every((e) => e.number !== null);
  const byDate = (a: Episode, b: Episode) => (a.published_at ?? "").localeCompare(b.published_at ?? "") || a.id - b.id;
  return [...episodes].sort((a, b) => (numbered ? a.number! - b.number! : 0) || byDate(a, b));
}

/** Every episode of a show, split into seasons in order. */
export function bySeason(episodes: Episode[]): Season[] {
  const map = new Map<number | null, Episode[]>();
  for (const e of episodes) map.set(e.season, [...(map.get(e.season) ?? []), e]);
  const several = map.size > 1;
  return [...map.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
    .map(([season, list]) => ({ season, label: seasonLabel(season, several), episodes: listeningOrder(list) }));
}

/** The planner key for one season of a show; a show with a single season keeps the plain podcast key. */
export const seasonKey = (podcastId: number, season: number | null, several: boolean) =>
  several ? `podcast:${podcastId}:s${season ?? "x"}` : `podcast:${podcastId}`;

/**
 * Card-planner sources for a show: one per season with saved episodes (optionally only the episodes
 * `include` accepts). Seasons are named "Show – Season 2" and share the show as their series, so a
 * set of seasons suggests the show's name for the cards.
 */
export function seasonGroups(podcast: { id: number; title: string }, episodes: Episode[], include?: (e: Episode) => boolean): PackGroup[] {
  const seasons = bySeason(episodes);
  const several = seasons.length > 1;
  return seasons
    .map((s) => ({
      key: seasonKey(podcast.id, s.season, several),
      title: several ? `${podcast.title} – ${s.label}` : podcast.title,
      series: several ? podcast.title : undefined,
      track_ids: s.episodes.filter((e) => e.track && (!include || include(e))).map((e) => e.track!.id),
    }))
    .filter((g) => g.track_ids.length > 0);
}
