"use client";

/**
 * app/login/page.tsx
 * =============================================================================
 * Form login operator.
 *
 * Satu-satunya halaman yang boleh diakses tanpa sesi (lihat PUBLIC_PATHS di
 * middleware.ts). Setelah login berhasil, operator dikembalikan ke halaman yang
 * tadi hendak dibuka (query `next`), atau ke dashboard bila datang langsung.
 */

import React, { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Radio, LogIn, LoaderCircle, TriangleAlert } from "lucide-react";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.success) {
        setError(data?.error || "Login gagal. Coba lagi.");
        return;
      }

      // `next` hanya diterima bila berupa path relatif. Tanpa cek ini,
      // ?next=https://situs-lain akan mengubah halaman login kita menjadi
      // pengalih terbuka (open redirect) ke situs mana pun.
      const next = searchParams.get("next");
      const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

      router.replace(target);
      router.refresh();
    } catch {
      setError("Tidak bisa menghubungi server. Pastikan dashboard berjalan.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="username"
          className="text-xs font-semibold uppercase tracking-wider text-slate-400"
        >
          Username
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          autoFocus
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="rounded-lg bg-slate-900/70 border border-slate-700 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition focus:border-emerald-500/70 focus:ring-2 focus:ring-emerald-500/25"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="password"
          className="text-xs font-semibold uppercase tracking-wider text-slate-400"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg bg-slate-900/70 border border-slate-700 px-3.5 py-2.5 text-sm text-slate-100 outline-none transition focus:border-emerald-500/70 focus:ring-2 focus:ring-emerald-500/25"
        />
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-xs text-red-300"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="mt-1 flex items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? (
          <>
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Memverifikasi…
          </>
        ) : (
          <>
            <LogIn className="h-4 w-4" />
            Masuk
          </>
        )}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0b0f19] px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/20 p-3 text-emerald-400">
            <Radio className="h-7 w-7" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight text-white">
              DRONE-STACK MONOREPO
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              Masuk sebagai operator untuk mengakses dashboard kendali
            </p>
          </div>
        </div>

        <div className="glass-panel rounded-2xl border border-slate-700/60 p-6">
          {/* useSearchParams() butuh Suspense saat halaman di-prerender. */}
          <Suspense fallback={<p className="text-sm text-slate-400">Memuat…</p>}>
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-5 text-center text-[11px] leading-relaxed text-slate-500">
          Akun dibuat lewat{" "}
          <code className="rounded bg-slate-800/80 px-1.5 py-0.5 text-slate-400">
            npm run create-operator
          </code>
        </p>
      </div>
    </main>
  );
}
