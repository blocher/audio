import { useQueryClient } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { api } from "../api";
import type { User } from "../types";

/** Shown across the top while a super admin is viewing the app as someone else. */
export default function ImpersonationBar({ user }: { user: User }) {
  const qc = useQueryClient();
  if (!user.impersonator) return null;

  async function stop() {
    await api.post("/superadmin/impersonate/stop");
    qc.clear();
    window.location.assign("/superadmin");
  }

  return (
    <div className="impersonation-bar" role="status">
      <Eye size={16} />
      <span>
        {user.impersonator}, you're viewing Audio as <b>{user.first_name || user.username}</b> ({user.household_name}).
        What you change here is changed for them.
      </span>
      <button type="button" onClick={() => void stop()}>
        Back to my account
      </button>
    </div>
  );
}
