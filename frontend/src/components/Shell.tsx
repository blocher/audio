import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AudioLines,
  BookOpen,
  Download,
  Folder,
  LibraryBig,
  LogOut,
  Menu,
  Mic,
  Settings as SettingsIcon,
  ShieldCheck,
  SquareStack,
  Star,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useScrollTopOnNavigate } from "../hooks/listMemory";
import { useJobs } from "../hooks/queries";
import { clearUserCaches, promptInstall, usePwa } from "../pwa";
import type { AudibleAccount, User, YotoAccount } from "../types";
import { usePlayer } from "../player";
import PlayerBar from "./PlayerBar";
import { Button, SourceIcon, useToast } from "./ui";

export default function Shell({ user, children }: { user: User; children: ReactNode }) {
  const qc = useQueryClient();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const player = usePlayer();
  const pwa = usePwa();
  const jobs = useJobs();
  const running = (jobs.data ?? []).filter((j) => j.status === "running" || j.status === "queued").length;
  const audible = useQuery({ queryKey: ["audible-accounts"], queryFn: () => api.get<AudibleAccount[]>("/audible/accounts") });
  const yoto = useQuery({ queryKey: ["yoto-accounts"], queryFn: () => api.get<YotoAccount[]>("/yoto/accounts") });

  useEffect(() => setOpen(false), [location.pathname]);
  useScrollTopOnNavigate();

  async function logout() {
    await api.post("/auth/logout");
    await clearUserCaches();
    qc.clear();
    // A fresh page, so nothing of theirs (the player, a half-played chapter) carries over to the sign-in screen.
    window.location.replace("/");
  }

  // Coming back from signing in to Yoto (this tab went to Yoto and back): say so, refresh, and tidy the address.
  const toast = useToast();
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("service") !== "yoto") return;
    if (params.get("error")) toast(`Yoto sign-in didn't finish: ${params.get("error")}`, "error");
    else if (params.get("connected")) toast("Your Yoto account is connected");
    for (const key of ["yoto-accounts", "onboarding", "playlists"]) qc.invalidateQueries({ queryKey: [key] });
    for (const key of ["service", "connected", "error"]) params.delete(key);
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [location.search, location.pathname, navigate, qc, toast]);

  // The menu follows how the site is used: your audio (all of it, then each kind), then the Yoto cards made from it.
  // Everyone gets the whole menu; what they picked in the setup wizard only shapes setup and Home.
  const kind = new URLSearchParams(location.search).get("kind");
  const at = (path: string, k: string | null = null) => location.pathname === path && (k === null ? !kind : kind === k);
  type Item = { to: string; label: string; icon: ReactNode; active: boolean; count?: number; sub?: boolean };
  const audio: Item[] = [
    { to: "/library", label: "Library", icon: <LibraryBig size={20} />, active: at("/library") },
    { to: "/library?kind=books", label: "Audiobooks", icon: <BookOpen size={18} />, active: at("/library", "books") || location.pathname.startsWith("/books/"), sub: true },
    { to: "/podcasts", label: "Podcasts", icon: <Mic size={18} />, active: location.pathname.startsWith("/podcasts") || at("/library", "podcasts"), sub: true },
    { to: "/folders", label: "My own files", icon: <Folder size={18} />, active: location.pathname.startsWith("/folders") || at("/library", "local"), sub: true },
    { to: "/shelf", label: "My Shelf", icon: <Star size={20} />, active: location.pathname === "/shelf" },
  ];
  const link = (item: Item) => (
    <Link key={item.to} to={item.to} className={`${item.active ? "active" : ""} ${item.sub ? "sub" : ""}`} aria-current={item.active ? "page" : undefined}>
      {item.icon}
      {item.label}
      {item.count ? <span className="count">{item.count}</span> : null}
    </Link>
  );

  return (
    <div className={`shell ${player.current ? "" : "no-player"}`}>
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <Link to="/library" className={`brand ${player.playing ? "playing" : ""}`} title={player.playing ? "Playing" : undefined}>
          <AudioLines size={26} /> Audio
        </Link>
        <nav className="nav" aria-label="Main">
          <div className="nav-group" style={{ marginTop: 0 }}>
            <div className="sidebar-label">Your audio</div>
            {audio.map(link)}
          </div>
          <div className="nav-group">
            <div className="sidebar-label">Make</div>
            {link({ to: "/yoto", label: "Yoto cards", icon: <SquareStack size={20} />, active: location.pathname.startsWith("/yoto") })}
            <p className="nav-hint">Pick anything in your library and tap Send to Yoto.</p>
          </div>
          <div className="nav-group">
            {link({ to: "/activity", label: "Activity", icon: <Activity size={20} />, active: location.pathname === "/activity", count: running || undefined })}
            {user.is_admin && link({ to: "/superadmin", label: "Super admin", icon: <ShieldCheck size={20} />, active: location.pathname === "/superadmin" })}
          </div>
        </nav>

        <div className="sidebar-section">
          <div className="sidebar-label">Connected accounts</div>
          {(audible.data ?? []).map((a) => (
            <Link key={a.id} to={`/library?account=${a.id}`} className="source-link">
              <SourceIcon kind="audible" size={18} />
              <span className="truncate">{a.name} · Audible</span>
              <span className={`dot ${a.connected ? "" : "off"}`} title={a.connected ? "Connected" : "Not connected"} />
            </Link>
          ))}
          {(yoto.data ?? []).filter((y) => y.connected).map((y) => (
            <Link key={`y${y.id}`} to="/yoto" className="source-link">
              <SquareStack size={16} />
              <span className="truncate">{y.name} · Yoto</span>
              <span className="dot" />
            </Link>
          ))}
          {!audible.data?.length && !yoto.data?.some((y) => y.connected) && (
            <Link to="/welcome?step=audible" className="source-link" style={{ color: "var(--walnut-muted)" }}>
              Connect Audible or Yoto →
            </Link>
          )}
        </div>

        <nav className="nav" aria-label="Settings">
          <NavLink to="/settings">
            <SettingsIcon size={20} /> Settings
          </NavLink>
        </nav>

        {pwa.canInstall && !pwa.standalone && (
          <button className="sidebar-install" onClick={() => void promptInstall()}>
            <Download size={18} /> Install Audio as an app
          </button>
        )}

        <div className="sidebar-foot">
          <span className="avatar">{(user.first_name || user.username).slice(0, 1).toUpperCase()}</span>
          <span className="truncate" style={{ flex: 1, color: "var(--walnut-ink)", lineHeight: 1.2 }}>
            {user.first_name || user.username}
            <small className="truncate" style={{ display: "block", color: "var(--walnut-muted)" }}>{user.household_name}</small>
          </span>
          <button onClick={logout} title="Sign out" aria-label="Sign out">
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          <Button className="menu-btn" variant="ghost" iconOnly onClick={() => setOpen(true)} icon={<Menu size={20} />} aria-label="Menu" />
          <div key={location.pathname} className="page-enter">
            {children}
          </div>
        </div>
      </main>
      <PlayerBar />
    </div>
  );
}
