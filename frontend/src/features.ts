import type { Feature } from "./types";

/** How each feature and source is named and explained wherever people pick them. */
export const FEATURE_LABELS: Record<Feature, { label: string; hint: string }> = {
  yoto: { label: "Yoto cards", hint: "Put audio onto Make Your Own cards" },
  ask: { label: "Ask about books", hint: "Questions with no spoilers; needs an AI key" },
  listen: { label: "Listen here", hint: "The player, with lock-screen controls" },
  audible: { label: "Audible", hint: "Audiobooks you own" },
  podcasts: { label: "Podcasts", hint: "Shows you follow" },
  folders: { label: "My own files", hint: "Folders of audio from a computer" },
};
