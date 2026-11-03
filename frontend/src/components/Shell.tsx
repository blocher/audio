import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AudioLines,
  Folder,
  LibraryBig,
  LogOut,
  Menu,
  Mic,
  Settings as SettingsIcon,
  SquareStack,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { api } from "../api";
import { useJobs } from "../hooks/queries";
import type { AudibleAccount, User, YotoAccount } from "../types";
import PlayerBar from "./PlayerBar";
import { Button, SourceIcon } from "./ui";

export default function Shell({ user, children }: { user: User; children: ReactNode }) {
  const qc = useQueryClient();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const jobs = useJobs();
  const running = (jobs.data ?? []).filter((j) => j.status === "running" || j.status === "queued").length;
  const audible = useQuery({ queryKey: ["audible-accounts"], queryFn: () => api.get<AudibleAccount[]>("/audible/accounts") });
  const yoto = useQuery({ queryKey: ["yoto-accounts"], queryFn: () => api.get<YotoAccount[]>("/yoto/accounts") });

  useEffect(() => setOpen(false), [location.pathname]);

  async function logout() {
    await api.post("/auth/logout");
    qc.clear();
    qc.invalidateQueries({ queryKey: ["session"] });
  }

  const nav = [
    { to: "/", label: "Library", icon: <LibraryBig size={20} />, end: true },
    { to: "/podcasts", label: "Podcasts", icon: <Mic size={20} /> },
    { to: "/folders", label: "Local folders", icon: <Folder size={20} /> },
    { to: "/yoto", label: "Yoto cards", icon: <SquareStack size={20} /> },
    { to: "/activity", label: "Activity", icon: <Activity size={20} />, count: running || undefined },
  ];

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <Link to="/" className="brand">
          <AudioLines size={26} /> Audio
        </Link>
        <nav className="nav" aria-label="Main">
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              {item.icon}
              {item.label}
              {item.count ? <span className="count">{item.count}</span> : null}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-section">
          <div className="sidebar-label">Connected accounts</div>
          {(audible.data ?? []).map((a) => (
            <Link key={a.id} to={`/?account=${a.id}`} className="source-link">
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
            <Link to="/settings" className="source-link" style={{ color: "var(--walnut-muted)" }}>
              Connect Audible or Yoto →
            </Link>
          )}
        </div>

        <nav className="nav" aria-label="Settings">
          <NavLink to="/settings">
            <SettingsIcon size={20} /> Settings
          </NavLink>
        </nav>

        <div className="sidebar-foot">
          <span className="avatar">{(user.first_name || user.username).slice(0, 1).toUpperCase()}</span>
          <span className="truncate" style={{ flex: 1, color: "var(--walnut-ink)" }}>
            {user.first_name || user.username}
          </span>
          <button onClick={logout} title="Sign out" aria-label="Sign out">
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          <Button className="menu-btn" variant="ghost" iconOnly onClick={() => setOpen(true)} icon={<Menu size={20} />} aria-label="Menu" />
          {children}
        </div>
      </main>
      <PlayerBar />
    </div>
  );
}
