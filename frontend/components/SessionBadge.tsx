"use client";

/**
 * components/SessionBadge.tsx
 * =============================================================================
 * Menampilkan operator yang sedang login + tombol keluar, di header dashboard.
 *
 * Identitas diambil dari /api/auth/me (bukan dari cookie langsung) karena cookie
 * sesi bersifat httpOnly — memang sengaja tidak bisa dibaca JavaScript.
 */

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, UserRound } from "lucide-react";

type SessionUser = { id: number; username: string; role: string };

export function SessionBadge() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data?.success) setUser(data.user);
      })
      .catch(() => {
        /* Header tanpa nama operator masih berguna — tidak perlu ganggu UI. */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // replace(), bukan push(): tombol "back" tidak boleh membawa operator
      // kembali ke dashboard yang sudah tidak punya sesi.
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="hidden items-center gap-2 rounded-full glass-panel border border-slate-700 px-3 py-1.5 sm:flex">
        <UserRound className="h-3.5 w-3.5 text-slate-400" />
        <span className="font-semibold text-slate-300">
          {user?.username ?? "…"}
        </span>
        {user && (
          <span className="rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
            {user.role}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={handleLogout}
        disabled={loggingOut}
        title="Keluar"
        className="flex items-center gap-1.5 rounded-full border border-slate-700 glass-panel px-3 py-1.5 font-semibold text-slate-300 transition hover:border-red-500/50 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-red-500/30 disabled:opacity-60"
      >
        <LogOut className="h-3.5 w-3.5" />
        {loggingOut ? "Keluar…" : "Keluar"}
      </button>
    </div>
  );
}
