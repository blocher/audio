import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { FEATURES, SOURCES, type Feature, type Onboarding, type Session, type User } from "../types";

export function useSession() {
  return useQuery({ queryKey: ["session"], queryFn: () => api.get<Session>("/auth/session"), staleTime: Infinity });
}

/** The signed-in person. Only call inside the signed-in app. */
export function useMe(): User | undefined {
  return useSession().data?.user ?? undefined;
}

/** What's connected: Audible, Yoto, AI keys. Drives the wizard, setup reminders and which features show. */
export function useOnboarding() {
  return useQuery({ queryKey: ["onboarding"], queryFn: () => api.get<Onboarding>("/onboarding"), staleTime: 30_000 });
}

/** The features and sources this person chose; nothing chosen means everything. */
export function featureSet(chosen: Feature[] | undefined): Set<Feature> {
  return new Set(chosen?.length ? chosen : [...FEATURES, ...SOURCES]);
}

/** `has("yoto")`: whether to show that part of the app to this person. */
export function useFeatures(): (feature: Feature) => boolean {
  const set = featureSet(useMe()?.features);
  return (feature) => set.has(feature);
}

/** Whether Ask-related buttons are worth showing: they chose Ask, or an AI key is set up anyway. */
export function useAskVisible(): boolean {
  const has = useFeatures();
  const status = useOnboarding();
  return has("ask") || !!(status.data?.ai.transcribe || status.data?.ai.ask);
}
