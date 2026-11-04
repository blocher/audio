import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export type StarKind = "book" | "podcast" | "folder";

export interface StarRow {
  kind: StarKind;
  id: number;
  starred_at: string;
}

const KEY = ["stars"];

/** The signed-in user's stars. Stars are personal; everyone shares the library itself. */
export function useStars() {
  const query = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<StarRow[]>("/stars"),
  });
  const when = new Map((query.data ?? []).map((s) => [`${s.kind}:${s.id}`, s.starred_at]));
  return {
    ...query,
    /** When this was starred, or undefined if it isn't. */
    starredAt: (kind: StarKind, id: number) => when.get(`${kind}:${id}`),
    isStarred: (kind: StarKind, id: number) => when.has(`${kind}:${id}`),
  };
}

export function useToggleStar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id, on }: { kind: StarKind; id: number; on: boolean }) =>
      on ? api.put(`/stars/${kind}/${id}`) : api.del(`/stars/${kind}/${id}`),
    // Flip it on screen straight away; the refetch afterwards settles the real state.
    onMutate: async ({ kind, id, on }) => {
      await qc.cancelQueries({ queryKey: KEY });
      const before = qc.getQueryData<StarRow[]>(KEY) ?? [];
      const rest = before.filter((s) => !(s.kind === kind && s.id === id));
      qc.setQueryData<StarRow[]>(KEY, on ? [{ kind, id, starred_at: new Date().toISOString() }, ...rest] : rest);
      return { before };
    },
    onError: (_e, _v, ctx) => ctx && qc.setQueryData(KEY, ctx.before),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
