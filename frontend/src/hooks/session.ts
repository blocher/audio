import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { Onboarding, Session, User } from "../types";

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

/** Whether Ask-related buttons are worth showing: AI is set up, or this person said they mostly want Ask. */
export function useAskVisible(): boolean {
  const me = useMe();
  const status = useOnboarding();
  if (status.data?.ai.transcribe || status.data?.ai.ask) return true;
  return me?.primary_use !== "yoto";
}
