import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileText, Folder, FolderInput, HardDrive, Plus, Search, Star, Upload } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useFilters, type Filter } from "../components/LibraryGrid";
import { StarButton } from "../components/StarButton";
import { BitratePicker } from "../components/Tools";
import { useStars } from "../hooks/stars";
import { Button, Empty, Modal, Note, PageHead, Progress, Spinner, errorText, useToast } from "../components/ui";
import { bytes, date, duration } from "../format";
import type { Collection, Job, SettingsData, Track } from "../types";
import { filesFromDrop, filesFromInput, type PickedFile } from "../upload";

export default function Folders() {
  const folders = useQuery({ queryKey: ["collections"], queryFn: () => api.get<Collection[]>("/local/collections") });
  const [importing, setImporting] = useState(false);
  const stars = useStars();
  const filters: Filter<Collection>[] = [
    { key: "starred", label: "Starred", icon: <Star size={15} />, test: (c) => stars.isStarred("folder", c.id) },
    { key: "transcribed", label: "Has transcripts", icon: <FileText size={15} />, test: (c) => c.transcribed_count > 0 },
    { key: "mp3", label: "MP3 ready", icon: <CheckCircle2 size={15} />, test: (c) => c.mp3_count > 0 },
  ];
  const { shown, chips, filtering } = useFilters(filters, folders.data ?? []);
  return (
    <>
      <PageHead
        eyebrow="Local folders"
        title="Your own recordings"
        lede="Drop in folders of audio — family stories, CDs you've ripped, anything — to downsize and put on Yoto cards."
        actions={
          <Button variant="primary" icon={<Plus size={18} />} onClick={() => setImporting(true)}>
            Import folder
          </Button>
        }
      />
      {folders.isLoading ? (
        <Spinner />
      ) : folders.data?.length ? (
        <>
          <div className="toolbar">{chips}</div>
          {!shown.length && filtering && (
            <Empty icon={<Search size={34} />} title="No folders match">
              Turn a filter off to see more.
            </Empty>
          )}
        <div className="list">
          {shown.map((c) => (
            <Link key={c.id} to={`/folders/${c.id}`} className="list-row" style={{ gridTemplateColumns: "48px minmax(0, 1fr) auto auto" }}>
              <div className="play-dot" style={{ width: 44, height: 44, borderRadius: 10, color: "var(--sage-strong)", background: "var(--sage-soft)", borderColor: "transparent" }}>
                <Folder size={20} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="title serif" style={{ fontSize: "var(--text-lg)" }}>{c.name}</div>
                <div className="sub">
                  <span>{c.track_count} files</span>
                  <span>{duration(c.total_duration_ms)}</span>
                  <span>{bytes(c.total_bytes)}</span>
                  <span>added {date(c.created_at)}</span>
                </div>
              </div>
              <StarButton kind="folder" id={c.id} title={c.name} overlay />
              <span className="muted">→</span>
            </Link>
          ))}
        </div>
        </>
      ) : (
        <Empty icon={<FolderInput size={40} />} title="No folders yet" action={<Button variant="primary" onClick={() => setImporting(true)}>Import a folder</Button>}>
          Upload a folder from this computer. Files keep their order by name (“2 - …” comes before “10 - …”).
        </Empty>
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}

export function ImportDialog({ onClose, collection }: { onClose: () => void; collection?: Collection }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsData>("/settings") });
  const [name, setName] = useState(collection?.name ?? "");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [error, setError] = useState("");
  const [paths, setPaths] = useState("");
  const [kbps, setKbps] = useState<number | null>(null);
  const [mono, setMono] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const roots = settings.data?.capabilities.local_import_roots ?? [];

  function addFiles(picked: PickedFile[]) {
    setFiles(picked);
    if (!name && picked[0]) setName(picked[0].path.split("/").length > 1 ? picked[0].path.split("/")[0] : "New folder");
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    addFiles(await filesFromDrop(e.dataTransfer.items));
  }

  async function upload() {
    setError("");
    try {
      const target = collection ?? (await api.post<Collection>("/local/collections", { name: name || "New folder" }));
      const uploaded: number[] = [];
      for (let i = 0; i < files.length; i++) {
        setProgress({ done: i, total: files.length, current: files[i].path });
        const form = new FormData();
        form.append("file", files[i].file);
        // Strip the top-level folder name; the collection already carries it.
        form.append("relative_path", files[i].path.includes("/") ? files[i].path.split("/").slice(1).join("/") : files[i].path);
        const track = await api.post<Track>(`/local/collections/${target.id}/upload`, form);
        uploaded.push(track.id);
      }
      if (kbps && uploaded.length) await api.post<Job>("/tracks/optimize", { track_ids: uploaded, kbps, mono });
      qc.invalidateQueries({ queryKey: ["collections"] });
      qc.invalidateQueries({ queryKey: ["collection"] });
      toast(`Imported ${files.length} file(s)${kbps ? " — downsizing now" : ""}`);
      onClose();
      navigate(`/folders/${target.id}`);
    } catch (e) {
      setError(errorText(e));
      setProgress(null);
    }
  }

  async function importPaths() {
    setError("");
    try {
      await api.post<Job>("/local/import-paths", {
        name,
        collection_id: collection?.id,
        paths: paths.split("\n").map((p) => p.trim()).filter(Boolean),
        kbps,
        mono,
      });
      qc.invalidateQueries({ queryKey: ["jobs"] });
      toast("Importing from disk in the background");
      onClose();
      navigate("/activity");
    } catch (e) {
      setError(errorText(e));
    }
  }

  const totalBytes = files.reduce((a, f) => a + f.file.size, 0);

  return (
    <Modal wide title={collection ? `Add files to ${collection.name}` : "Import a folder"} onClose={onClose}>
      <div className="stack" style={{ "--gap": "18px" } as React.CSSProperties}>
        {!collection && (
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Grandpa's stories" />
          </label>
        )}
        <div
          className={`dropzone ${over ? "over" : ""}`}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <Upload size={30} color="var(--terracotta)" />
          <strong style={{ color: "var(--ink)" }}>Drop folders or audio files here</strong>
          <span>or</span>
          <Button onClick={() => input.current?.click()} icon={<FolderInput size={16} />}>
            Choose a folder
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            // @ts-expect-error - non-standard but supported by every current browser
            webkitdirectory=""
            onChange={(e) => addFiles(filesFromInput(e.target.files))}
          />
          {files.length > 0 && (
            <span className="pill terracotta">
              {files.length} audio files · {bytes(totalBytes)}
            </span>
          )}
        </div>

        <div className="stack">
          <strong>Downsize after import (optional)</strong>
          <BitratePicker kbps={kbps} mono={mono} onChange={(k, m) => (setKbps(k), setMono(m))} allowOriginal />
        </div>

        {progress && (
          <div className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
            <Progress value={progress.done / progress.total} tone="terracotta" thick />
            <span className="muted truncate" style={{ fontSize: "var(--text-xs)" }}>
              Uploading {progress.done + 1} of {progress.total}: {progress.current}
            </span>
          </div>
        )}
        {error && <Note tone="error">{error}</Note>}

        <div className="row">
          <span className="spacer" />
          <Button variant="primary" icon={<Upload size={16} />} disabled={!files.length} loading={!!progress} onClick={upload}>
            Upload {files.length || ""} file{files.length === 1 ? "" : "s"}
          </Button>
        </div>

        {roots.length > 0 && (
          <>
            <div className="divider" style={{ margin: 0 }} />
            <div className="stack">
              <div className="row">
                <HardDrive size={16} />
                <strong>Or read straight from this computer's disk</strong>
              </div>
              <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
                Running locally, the server can copy folders under {roots.join(", ")} without uploading. One path per line.
              </p>
              <textarea className="textarea" value={paths} onChange={(e) => setPaths(e.target.value)} placeholder={`${roots[0]}/Audiobooks/Some Folder`} />
              <div className="row">
                <span className="spacer" />
                <Button disabled={!paths.trim()} onClick={importPaths}>Import from disk</Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
