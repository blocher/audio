import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Mic, Plus, Rss, Search } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Button, Cover, Empty, Modal, Note, PageHead, Progress, Spinner, errorText } from "../components/ui";
import { bytes } from "../format";
import type { Podcast, SearchResult } from "../types";

export default function Podcasts() {
  const podcasts = useQuery({ queryKey: ["podcasts"], queryFn: () => api.get<Podcast[]>("/podcasts") });
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHead
        eyebrow="Podcasts"
        title="Shows you follow"
        lede="Paste an Apple Podcasts link or RSS feed; download every episode or just the ones you want."
        actions={
          <Button variant="primary" icon={<Plus size={18} />} onClick={() => setAdding(true)}>
            Add podcast
          </Button>
        }
      />
      {podcasts.isLoading ? (
        <Spinner />
      ) : podcasts.data?.length ? (
        <div className="cover-grid">
          {podcasts.data.map((p) => (
            <Link key={p.id} to={`/podcasts/${p.id}`} className="cover-card">
              <Cover src={p.image_url} title={p.title} />
              <div className="cover-title">{p.title}</div>
              <div className="cover-meta">
                <span className="truncate">{p.author}</span>
              </div>
              <Progress value={p.episode_count ? p.downloaded_count / p.episode_count : 0} />
              <div className="cover-meta tabular">
                {p.downloaded_count}/{p.episode_count} saved · {bytes(p.downloaded_bytes)}
                {p.downsized_count > 0 && <> → {bytes(p.downsized_bytes)}</>}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Empty icon={<Mic size={40} />} title="No podcasts yet" action={<Button variant="primary" onClick={() => setAdding(true)}>Add your first podcast</Button>}>
          Follow a show by Apple Podcasts link, RSS URL, or search.
        </Empty>
      )}
      {adding && <AddPodcast onClose={() => setAdding(false)} />}
    </>
  );
}

export function AddPodcast({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(term.trim()), 350);
    return () => window.clearTimeout(id);
  }, [term]);
  const results = useQuery({
    queryKey: ["podcast-search", debounced],
    queryFn: () => api.get<SearchResult[]>(`/podcasts/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length > 1,
  });

  async function subscribe(target: string) {
    setBusy(target);
    setError("");
    try {
      const podcast = await api.post<Podcast>("/podcasts", { url: target });
      qc.invalidateQueries({ queryKey: ["podcasts"] });
      onClose();
      navigate(`/podcasts/${podcast.id}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title="Add a podcast" onClose={onClose} wide>
      <div className="stack" style={{ "--gap": "18px" } as React.CSSProperties}>
        <form
          className="row"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (url.trim()) subscribe(url.trim());
          }}
        >
          <div className="search" style={{ flex: 1 }}>
            <Link2 size={17} />
            <input className="input" placeholder="https://podcasts.apple.com/… or https://feeds…/rss" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
          </div>
          <Button variant="primary" type="submit" loading={busy === url.trim() && !!url} icon={<Rss size={16} />}>
            Follow
          </Button>
        </form>
        {error && <Note tone="error">{error}</Note>}
        <div className="divider" style={{ margin: 0 }} />
        <div className="search">
          <Search size={17} />
          <input className="input" placeholder="…or search Apple Podcasts" value={term} onChange={(e) => setTerm(e.target.value)} />
        </div>
        {results.isFetching && <Spinner />}
        <div className="stack" style={{ "--gap": "4px" } as React.CSSProperties}>
          {(results.data ?? []).map((r) => (
            <div key={r.feed_url} className="list-row" style={{ gridTemplateColumns: "56px 1fr auto", border: 0, borderRadius: 10 }}>
              <img src={r.image_url} alt="" style={{ width: 56, height: 56, borderRadius: 8, objectFit: "cover" }} />
              <div style={{ minWidth: 0 }}>
                <div className="title truncate">{r.title}</div>
                <div className="sub">
                  <span className="truncate">{r.author}</span>
                  <span>{r.episode_count} episodes</span>
                  {r.genre && <span className="pill">{r.genre}</span>}
                </div>
              </div>
              <Button size="sm" loading={busy === (r.apple_url || r.feed_url)} onClick={() => subscribe(r.apple_url || r.feed_url)}>
                Follow
              </Button>
            </div>
          ))}
        </div>
        {debounced.length > 1 && results.data && !results.data.length && <p className="muted">No shows found.</p>}
      </div>
    </Modal>
  );
}
