import { Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";

import { ApiKeyProvider, useApiKey } from "./ApiKeyContext";

const NAV = [
  { to: "/", label: "Runs", exact: true },
  { to: "/approvals", label: "Approvals", exact: false },
  { to: "/agents", label: "Agents", exact: false },
  { to: "/skills", label: "Skills", exact: false },
  { to: "/roles", label: "Roles", exact: false },
  { to: "/flows", label: "Flows", exact: false },
] as const;

/** The shell: wordmark, nav, 401 key banner, and the routed page. */
export function Layout() {
  return (
    <ApiKeyProvider>
      <div className="min-h-screen">
        <header className="border-b border-line bg-white">
          <div className="mx-auto flex max-w-6xl items-baseline gap-8 px-6 py-3">
            <Link to="/" className="text-sm font-semibold tracking-tight text-ink">
              MakerChecker
            </Link>
            <nav className="flex gap-5 text-[13px] text-stone-500">
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  activeOptions={{ exact: item.exact }}
                  activeProps={{ className: "font-medium text-ink" }}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <ApiKeyBanner />
        <main className="mx-auto max-w-6xl px-6 py-8">
          <Outlet />
        </main>
      </div>
    </ApiKeyProvider>
  );
}

export function ApiKeyBanner() {
  const { unauthorized, saveKey } = useApiKey();
  const [draft, setDraft] = useState("");
  if (!unauthorized) return null;
  return (
    <div className="border-b border-waiting/30 bg-amber-50">
      <form
        className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          saveKey(draft);
        }}
      >
        <span className="text-xs font-medium text-waiting">
          API key required — requests are being rejected (401).
        </span>
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="mk_..."
          aria-label="API key"
          className="w-64 rounded border border-line bg-white px-2 py-1 font-mono text-xs"
        />
        <button
          type="submit"
          className="rounded border border-ink bg-ink px-3 py-1 text-xs font-medium text-white"
        >
          Save key
        </button>
      </form>
    </div>
  );
}
