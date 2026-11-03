import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { Job } from "../types";

/** Active jobs, polled quickly while anything is running. Finished jobs invalidate everything they touched. */
export function useJobs() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["jobs"],
    queryFn: async () => {
      const jobs = await api.get<Job[]>("/jobs?limit=40");
      const previous = qc.getQueryData<Job[]>(["jobs"]) ?? [];
      const wasActive = new Set(previous.filter((j) => j.status === "queued" || j.status === "running").map((j) => j.id));
      if (jobs.some((j) => wasActive.has(j.id) && j.status !== "queued" && j.status !== "running")) {
        qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "jobs" });
      }
      return jobs;
    },
    refetchInterval: (query) =>
      (query.state.data ?? []).some((j) => j.status === "queued" || j.status === "running") ? 1500 : 10000,
  });
}

export function useActiveJob(targetType: string, targetId: number | undefined) {
  const { data } = useJobs();
  return data?.find(
    (j) => j.target_type === targetType && j.target_id === targetId && (j.status === "queued" || j.status === "running"),
  );
}

/** Mutation that refreshes job polling and the listed query keys on success. */
export function useAction<TIn = void, TOut = unknown>(fn: (input: TIn) => Promise<TOut>, invalidate: unknown[][] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      invalidate.forEach((key) => qc.invalidateQueries({ queryKey: key }));
    },
  });
}
