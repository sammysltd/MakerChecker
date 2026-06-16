import type { ReactNode } from "react";

import {
  formatAbsolute,
  formatRelative,
  riskTierKind,
  statusKind,
  type StatusKind,
} from "../lib/format";

const DOT: Record<StatusKind, string> = {
  good: "bg-verified",
  waiting: "bg-waiting",
  bad: "bg-blocked",
  neutral: "bg-stone-400",
};

const TEXT: Record<StatusKind, string> = {
  good: "text-verified",
  waiting: "text-waiting",
  bad: "text-blocked",
  neutral: "text-stone-500",
};

/** Uppercase letterspaced status label with a colored dot — never a filled pill. */
export function StatusPill({ status }: { status: string }) {
  const kind = statusKind(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] ${TEXT[kind]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[kind]}`} aria-hidden="true" />
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function RiskBadge({ tier }: { tier: string }) {
  const kind = riskTierKind(tier);
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] ${TEXT[kind]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[kind]}`} aria-hidden="true" />
      {tier} risk
    </span>
  );
}

/** A skill reference chip: monospace name@version on a hairline border. */
export function SkillChip({ skillRef }: { skillRef: string }) {
  return (
    <span className="inline-block rounded border border-line bg-white px-1.5 py-0.5 font-mono text-[11px] text-stone-700">
      {skillRef}
    </span>
  );
}

/** Relative age with the absolute timestamp on hover. */
export function RelTime({ iso }: { iso: string | null }) {
  return <time title={formatAbsolute(iso)}>{formatRelative(iso)}</time>;
}

export function Loading({ what }: { what: string }) {
  return <p className="py-8 text-sm text-stone-500">Loading {what}…</p>;
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p className="border-l-4 border-blocked bg-red-50 px-4 py-3 text-sm text-blocked" role="alert">
      Failed to load: {message}
    </p>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="py-8 text-sm text-stone-500">{children}</p>;
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-xl font-semibold tracking-tight text-ink">{children}</h1>;
}
