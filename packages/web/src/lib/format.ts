/** Pure formatting helpers; every branch is unit-tested. */

import type { ActorRef } from "./api";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** "12s ago", "2m ago", "3h ago", "5d ago" — absolute timestamp goes in title. */
export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = now - t;
  if (diff < 5_000) return "just now";
  if (diff < MINUTE) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
}

export function formatAbsolute(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** Duration between two instants; open intervals run against `now`. */
export function formatDuration(
  start: string | null,
  end: string | null,
  now: number = Date.now(),
): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : now;
  const ms = Math.max(0, e - s);
  if (ms < 1000) return `${ms}ms`;
  if (ms < MINUTE) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / MINUTE);
  const seconds = Math.round((ms % MINUTE) / 1000);
  if (ms < HOUR) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(ms / HOUR);
  return `${hours}h ${Math.floor((ms % HOUR) / MINUTE)}m`;
}

export function truncateHash(hash: string | null, length = 12): string {
  if (!hash) return "—";
  return hash.length <= length ? hash : `${hash.slice(0, length)}…`;
}

export function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

export function actorLabel(actor: ActorRef | null | undefined): string {
  if (!actor) return "unknown";
  return actor.name ?? actor.id ?? actor.type;
}

/** Visual category for a status string; drives pill colors. */
export type StatusKind = "good" | "waiting" | "bad" | "neutral";

export function statusKind(status: string): StatusKind {
  switch (status) {
    case "completed":
    case "approved":
    case "published":
    case "active":
      return "good";
    case "running":
    case "pending":
    case "waiting_approval":
    case "queued":
      return "waiting";
    case "failed":
    case "rejected":
    case "blocked":
    case "suspended":
    case "retired":
    case "deprecated":
      return "bad";
    default:
      return "neutral";
  }
}

export function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function formatTokens(usage: unknown): string | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = u.inputTokens ?? u.input_tokens;
  const output = u.outputTokens ?? u.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  return `${input.toLocaleString("en-US")} in / ${output.toLocaleString("en-US")} out`;
}

/** Risk tiers get their own coloring: high is always loud. */
export function riskTierKind(tier: string): StatusKind {
  if (tier === "high") return "bad";
  if (tier === "medium") return "waiting";
  if (tier === "low") return "good";
  return "neutral";
}
