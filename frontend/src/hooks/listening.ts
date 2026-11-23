import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api";
import type { Collection } from "../types";

/** How far the signed-in person has got in one track, listening in this app. */
export interface ListenPosition {
  track_id: number;
  position_ms: number;
  finished: boolean;
  updated_at: string;
  book_id: number | null;
  collection_id: number | null;
  podcast_id: number | null;
}

export const LISTENING_KEY = ["listening"];

export function useListening() {
  return useQuery({ queryKey: LISTENING_KEY, queryFn: () => api.get<ListenPosition[]>("/listening"), staleTime: 60_000 });
}

/** Started and not finished: a track you're partway through. */
export const partway = (p: ListenPosition | undefined) => !!p && !p.finished && p.position_ms > 5000;

/**
 * What's in progress here, by show and folder. A show is in progress when you're partway through an episode; a
 * folder when you're partway through a file, or have heard some of its files but not all.
 */
export function useListeningState() {
  const { data } = useListening();
  return useMemo(() => {
    const byTrack = new Map<number, ListenPosition>();
    const showLast = new Map<number, string>();
    const showPartway = new Set<number>();
    const folder = new Map<number, { finished: number; partway: boolean; last: string }>();
    for (const p of data ?? []) {
      byTrack.set(p.track_id, p);
      if (p.podcast_id) {
        if (partway(p)) showPartway.add(p.podcast_id);
        if ((showLast.get(p.podcast_id) ?? "") < p.updated_at) showLast.set(p.podcast_id, p.updated_at);
      }
      if (p.collection_id) {
        const f = folder.get(p.collection_id) ?? { finished: 0, partway: false, last: "" };
        if (p.finished) f.finished += 1;
        if (partway(p)) f.partway = true;
        if (f.last < p.updated_at) f.last = p.updated_at;
        folder.set(p.collection_id, f);
      }
    }
    return {
      track: (id: number) => byTrack.get(id),
      podcastInProgress: (id: number) => showPartway.has(id),
      podcastListenedAt: (id: number) => (showPartway.has(id) ? showLast.get(id) : undefined),
      folderInProgress: (c: Pick<Collection, "id" | "track_count">) => {
        const f = folder.get(c.id);
        return !!f && (f.partway || (f.finished > 0 && f.finished < c.track_count));
      },
      folderListenedAt: (id: number) => folder.get(id)?.last,
      folderHeard: (id: number) => folder.get(id)?.finished ?? 0,
    };
  }, [data]);
}
