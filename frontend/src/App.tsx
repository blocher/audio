import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import Shell from "./components/Shell";
import { Spinner, ToastProvider } from "./components/ui";
import Activity from "./pages/Activity";
import BookDetail from "./pages/BookDetail";
import FolderDetail from "./pages/FolderDetail";
import Folders from "./pages/Folders";
import Home from "./pages/Home";
import Library from "./pages/Library";
import Login from "./pages/Login";
import PlaylistDetail from "./pages/PlaylistDetail";
import PodcastDetail from "./pages/PodcastDetail";
import Podcasts from "./pages/Podcasts";
import Settings from "./pages/Settings";
import Yoto from "./pages/Yoto";
import type { Session } from "./types";

export default function App() {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: () => api.get<Session>("/auth/session"), staleTime: Infinity });

  useEffect(() => {
    const onUnauthorized = () => qc.invalidateQueries({ queryKey: ["session"] });
    window.addEventListener("audio:unauthorized", onUnauthorized);
    return () => window.removeEventListener("audio:unauthorized", onUnauthorized);
  }, [qc]);

  if (session.isLoading) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh", color: "var(--ink-muted)" }}>
        <Spinner size={28} />
      </div>
    );
  }

  return (
    <ToastProvider>
      {!session.data?.authenticated ? (
        <Login />
      ) : (
        <Shell user={session.data.user!}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/library" element={<Library />} />
            <Route path="/books/:id" element={<BookDetail />} />
            <Route path="/podcasts" element={<Podcasts />} />
            <Route path="/podcasts/:id" element={<PodcastDetail />} />
            <Route path="/folders" element={<Folders />} />
            <Route path="/folders/:id" element={<FolderDetail />} />
            <Route path="/yoto" element={<Yoto />} />
            <Route path="/yoto/playlists/:id" element={<PlaylistDetail />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      )}
    </ToastProvider>
  );
}
