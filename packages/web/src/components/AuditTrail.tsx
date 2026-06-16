import type { AuditEvent } from "../lib/api";
import { actorLabel, formatTokens, truncateHash } from "../lib/format";
import { JsonBlock } from "./JsonBlock";
import { RelTime } from "./ui";

/**
 * The audit trail: every hash-chained event for the run in seq order.
 * Enforcement events are rendered at maximum visual force — a regulator
 * should spot an SoD block from across the room.
 */
export function AuditTrail({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-stone-500">No audit events yet.</p>;
  }
  return (
    <ol className="divide-y divide-line border-y border-line">
      {events.map((event) => (
        <AuditEntry key={event.seq} event={event} />
      ))}
    </ol>
  );
}

const ACTOR_STYLE: Record<string, string> = {
  user: "bg-ink text-white",
  agent: "border border-stone-400 text-stone-700",
  system: "bg-stone-200 text-stone-600",
};

function ActorBadge({ event }: { event: AuditEvent }) {
  const type = event.actor?.type ?? "system";
  return (
    <span
      className={`inline-block rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.06em] ${
        ACTOR_STYLE[type] ?? ACTOR_STYLE.system
      }`}
      title={type}
    >
      {actorLabel(event.actor)}
    </span>
  );
}

function isEnforcement(eventType: string): boolean {
  return eventType === "enforcement.blocked" || eventType === "enforcement.sod_violation";
}

function AuditEntry({ event }: { event: AuditEvent }) {
  if (isEnforcement(event.event_type)) {
    return (
      <li className="border-l-4 border-blocked bg-red-50 px-3 py-3" role="alert">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-blocked">
            {event.event_type === "enforcement.sod_violation"
              ? "Blocked — segregation of duties"
              : "Blocked — enforcement"}
          </span>
          <span className="font-mono text-[10px] text-stone-400">#{event.seq}</span>
        </div>
        <p className="mt-1.5 text-sm font-medium leading-snug text-blocked">
          {typeof event.payload.reason === "string"
            ? event.payload.reason
            : "policy violation"}
        </p>
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-stone-500">
          <ActorBadge event={event} />
          <RelTime iso={event.occurred_at} />
        </div>
      </li>
    );
  }

  const tokens = event.event_type === "llm.call" ? formatTokens(event.payload.usage) : null;
  const hasPayload = Object.keys(event.payload ?? {}).length > 0;

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs text-ink">{event.event_type}</span>
        <span className="font-mono text-[10px] text-stone-400" title={event.hash}>
          #{event.seq} · {truncateHash(event.hash, 8)}
        </span>
      </div>
      {event.event_type === "llm.call" && (
        <p className="mt-1 text-[11px] text-stone-600">
          <span className="font-mono font-medium text-ink">
            {typeof event.payload.model === "string" ? event.payload.model : "model"}
          </span>
          {tokens && <span className="ml-2 font-mono text-stone-500">{tokens} tokens</span>}
        </p>
      )}
      <div className="mt-1 flex items-center gap-2 text-[11px] text-stone-500">
        <ActorBadge event={event} />
        <RelTime iso={event.occurred_at} />
      </div>
      {hasPayload && (
        <div className="mt-1.5">
          <JsonBlock label="Payload" value={event.payload} />
        </div>
      )}
    </li>
  );
}
