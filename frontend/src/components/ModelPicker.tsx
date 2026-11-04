import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api";
import type { AiCatalog } from "../types";

export type ModelKind = "chat" | "stt";
export interface ModelChoice {
  provider: string;
  model: string;
}

export function useModels(kind: ModelKind) {
  return useQuery({
    queryKey: ["ai-models", kind],
    queryFn: () => api.get<AiCatalog>(`/ai/models?kind=${kind}`),
    staleTime: 10 * 60_000,
  });
}

function contextLabel(tokens: number): string {
  if (!tokens) return "";
  return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(2)}M context` : `${Math.round(tokens / 1000)}k context`;
}

/**
 * One dropdown across every configured provider, grouped by provider. Picks the saved default (or the first
 * recommended model) when nothing valid is chosen yet.
 */
export default function ModelPicker({
  kind,
  value,
  onChange,
  compact,
}: {
  kind: ModelKind;
  value: ModelChoice | null;
  onChange: (choice: ModelChoice) => void;
  compact?: boolean;
}) {
  const catalog = useModels(kind);
  const data = catalog.data;

  useEffect(() => {
    if (!data || !data.providers.length) return;
    const exists = (c: ModelChoice | null) =>
      !!c && data.providers.some((p) => p.provider === c.provider && p.models.some((m) => m.id === c.model));
    if (exists(value)) return;
    if (exists(data.default)) return onChange(data.default);
    const first = data.providers.find((p) => p.models.length);
    if (first) onChange({ provider: first.provider, model: first.models[0].id });
  }, [data, value, onChange]);

  const style = compact ? { height: 34, fontSize: "var(--text-sm)", width: "auto", maxWidth: 300 } : undefined;
  if (catalog.isLoading)
    return (
      <select className="select" style={style} disabled>
        <option>Loading models…</option>
      </select>
    );
  if (!data?.providers.length)
    return (
      <select className="select" style={style} disabled>
        <option>No AI provider key yet — add one in Settings</option>
      </select>
    );

  return (
    <select
      className="select"
      style={style}
      value={value ? `${value.provider}::${value.model}` : ""}
      onChange={(e) => {
        const [provider, ...rest] = e.target.value.split("::");
        onChange({ provider, model: rest.join("::") });
      }}
      aria-label={kind === "stt" ? "Transcription model" : "Model"}
    >
      {data.providers.map((p) => (
        <optgroup key={p.provider} label={p.error ? `${p.label} (couldn't list models; showing defaults)` : p.label}>
          {p.models.map((m) => {
            const bits = [
              m.recommended ? "★" : "",
              kind === "stt" && m.price_per_hour !== undefined ? `$${m.price_per_hour.toFixed(2)}/hr` : "",
              kind === "stt" && m.timestamps === "segments" ? "timestamps every few seconds" : "",
              kind === "chat" && !compact ? contextLabel(m.context) : "",
              m.preview ? "preview" : "",
              m.note,
            ].filter(Boolean);
            return (
              <option key={m.id} value={`${p.provider}::${m.id}`}>
                {m.label}
                {bits.length ? ` — ${bits.join(" · ")}` : ""}
              </option>
            );
          })}
        </optgroup>
      ))}
    </select>
  );
}
