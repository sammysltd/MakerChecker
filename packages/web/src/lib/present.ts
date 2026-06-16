import type { ChartSpec } from "../components/charts";

/* ---------------------------------------------------------------------------
   present.ts — turn a real agent-step output into a readable artifact.

   The run viewer used to dump step output as raw JSON. These pure adapters
   recognise the structured shapes the demo flows actually emit (cold-chain
   stability assessment, gross-to-net margin, alert/complaint/case triage, cash
   reconciliation, disposition, drafts) and project them into a Presentation —
   a title, headline stats, an optional chart, and labelled sections — so a
   human approver sees WHAT they are signing off on, not a JSON blob.

   Unknown shapes return null; the caller falls back to the raw JSON view. No
   server changes: this reads the output the skills already produce.
--------------------------------------------------------------------------- */

export type Tone = "good" | "bad" | "warn" | "neutral";

export interface Stat {
  label: string;
  value: string;
  tone?: Tone;
}
export interface Item {
  title: string;
  detail?: string;
  tone?: Tone;
}
export interface Section {
  heading: string;
  items: Item[];
}
export interface Presentation {
  title: string;
  stats: Stat[];
  chart?: ChartSpec;
  body?: string[];
  footnotes?: string[];
  sections: Section[];
}

type Rec = Record<string, unknown>;

function asRecord(v: unknown): Rec | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}
function arr(o: Rec, key: string): Rec[] {
  const v = o[key];
  return Array.isArray(v) ? (v.filter((x) => asRecord(x) !== null) as Rec[]) : [];
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function money(v: unknown): string {
  return "$" + num(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Tone for a cold-chain / triage classification. */
function classTone(c: string): Tone {
  if (c === "beyond" || c === "destroy") return "bad";
  if (c === "borderline" || c === "escalate") return "warn";
  if (c === "within" || c === "release") return "good";
  return "neutral";
}

/* ---------- adapters (specific → general) ---------- */

/**
 * Cold-chain incident: a single shipment with a temperature time-series and a
 * footnoted incident report. Renders as a line chart (temperature vs limit,
 * excursion shaded) plus the report body and footnotes.
 */
function coldChain(o: Rec): Presentation | null {
  const report = asRecord(o.report);
  if (!Array.isArray(o.readings) || report === null) return null;
  const incident = asRecord(o.incident) ?? {};
  const readings = arr(o, "readings");
  const classification = str(o.classification);
  const minutesOverLimit = num(o.minutesOverLimit);
  const maxExcursionMinutes = num(o.maxExcursionMinutes);
  const peakTempC = num(o.peakTempC);
  const limitC = num(o.limitC);
  const reportTitle = str(report.title);
  const ref = str(report.ref);
  const body = (Array.isArray(report.body) ? report.body : []).map((b) => str(b));
  const footnotes = (Array.isArray(report.footnotes) ? report.footnotes : []).map((f) => str(f));
  return {
    title: ref ? `${reportTitle} · ${ref}` : reportTitle,
    stats: [
      { label: "Peak temperature", value: `${peakTempC} °C`, tone: classification === "beyond" ? "bad" : "neutral" },
      {
        label: "Time over limit",
        value: `${minutesOverLimit} min`,
        tone: minutesOverLimit > maxExcursionMinutes ? "bad" : "neutral",
      },
      { label: "Stability limit", value: `${limitC} °C` },
      { label: "Classification", value: classification, tone: classTone(classification) },
      { label: "Recommended", value: str(o.recommendedDisposition), tone: classTone(str(o.recommendedDisposition)) },
      { label: "Units", value: num(incident.units).toLocaleString() },
    ],
    chart: {
      kind: "line",
      points: readings.map((r) => num(r.tempC)),
      limit: num(limitC),
      unit: "°C",
      caption: `Shipment ${str(incident.shipment)} — temperature vs ${limitC} °C limit (excursion shaded)`,
    },
    body,
    footnotes,
    sections: [],
  };
}

/** Gross-to-net margin: per-market bridge + consolidated + integrity exceptions. */
function grossToNet(o: Rec): Presentation | null {
  const perMarket = arr(o, "perMarket");
  const consolidated = asRecord(o.consolidated);
  if (perMarket.length === 0 || !consolidated) return null;
  const gross = num(consolidated.grossRevenue);
  const net = num(consolidated.netRevenue);
  const exceptions = arr(o, "exceptions");
  return {
    title: "Gross-to-net margin",
    stats: [
      { label: "Markets", value: String(num(consolidated.markets) || perMarket.length) },
      { label: "Gross revenue", value: money(gross) },
      { label: "Net revenue", value: money(net) },
      { label: "Net margin", value: `${(num(consolidated.netMarginPct) * 100).toFixed(1)}%` },
      { label: "Exceptions", value: String(exceptions.length), tone: exceptions.length ? "bad" : "good" },
    ],
    chart: {
      kind: "waterfall",
      items: [
        { label: "Gross", value: gross },
        { label: "Rebates & discounts", value: -(gross - net) },
      ],
      unit: "",
      caption: "Consolidated gross-to-net bridge (units-weighted)",
    },
    sections: [
      {
        heading: "Per market",
        items: perMarket.map((m) => ({
          title: str(m.market),
          detail: `gross ${money(m.grossRevenue)} → net ${money(m.netRevenue)} (${(num(m.netMarginPct) * 100).toFixed(1)}% margin)`,
          tone: "neutral" as Tone,
        })),
      },
      ...(exceptions.length
        ? [
            {
              heading: "Data-integrity exceptions",
              items: exceptions.map((e) => ({
                title: `${str(e.market)} / ${str(e.sku)}`,
                detail: str(e.rationale),
                tone: "bad" as Tone,
              })),
            },
          ]
        : []),
    ],
  };
}

/** Disposition acted at the gate: released / destroyed / held lots + values. */
function disposition(o: Rec): Presentation | null {
  if (!Array.isArray(o.released) || !Array.isArray(o.destroyed)) return null;
  const released = arr(o, "released");
  const destroyed = arr(o, "destroyed");
  const held = arr(o, "heldForJudgment");
  return {
    title: "Disposition executed",
    stats: [
      { label: "Released", value: String(released.length), tone: "good" },
      { label: "Destroyed", value: String(destroyed.length), tone: "bad" },
      { label: "Held for QA", value: String(held.length), tone: held.length ? "warn" : "neutral" },
      { label: "Value released", value: money(o.releasedValue), tone: "good" },
      { label: "Value destroyed", value: money(o.destroyedValue), tone: destroyed.length ? "bad" : "neutral" },
    ],
    chart: {
      kind: "bars",
      items: [
        { label: "Released", value: released.length },
        { label: "Destroyed", value: destroyed.length, flag: true },
        { label: "Held", value: held.length },
      ],
      caption: "Lots by executed disposition",
    },
    sections: [],
  };
}

/** Rule-based triage: escalations (AML/MDR) or expedited (PV) vs cleared. */
function triage(o: Rec): Presentation | null {
  const escKey = Array.isArray(o.escalations) ? "escalations" : Array.isArray(o.expedited) ? "expedited" : null;
  if (!escKey) return null;
  const clearedKey = Array.isArray(o.cleared) ? "cleared" : Array.isArray(o.periodic) ? "periodic" : null;
  const escalated = arr(o, escKey);
  const cleared = clearedKey ? arr(o, clearedKey) : [];
  const total =
    num(o.alertCount) || num(o.complaintCount) || num(o.caseCount) || escalated.length + cleared.length;
  return {
    title: escKey === "expedited" ? "Adverse-event case triage" : "Alert triage",
    stats: [
      { label: "Reviewed", value: String(total) },
      { label: escKey === "expedited" ? "Expedited" : "Escalated", value: String(escalated.length), tone: escalated.length ? "warn" : "neutral" },
      { label: clearedKey === "periodic" ? "Periodic" : "Cleared", value: String(cleared.length), tone: "good" },
    ],
    chart: {
      kind: "bars",
      items: [
        { label: escKey === "expedited" ? "Expedited" : "Escalated", value: escalated.length, flag: true },
        { label: clearedKey === "periodic" ? "Periodic" : "Cleared", value: cleared.length },
      ],
      caption: "Cases by triage outcome",
    },
    sections: [
      {
        heading: escKey === "expedited" ? "Expedited cases" : "Escalated for officer decision",
        items: escalated.map((e) => ({
          title: str(e.alertId || e.complaintId || e.caseId || e.customer || e.device || e.drug),
          detail: [str(e.clock), str(e.rationale)].filter(Boolean).join(" — "),
          tone: "warn" as Tone,
        })),
      },
    ],
  };
}

/** Post-gate drafting: SAR / MDR / ICSR narratives or drafts. */
function drafts(o: Rec): Presentation | null {
  const key = Array.isArray(o.narratives) ? "narratives" : Array.isArray(o.drafts) ? "drafts" : null;
  if (!key) return null;
  const items = arr(o, key);
  return {
    title: "Drafted reports",
    stats: [{ label: "Drafts", value: String(items.length), tone: "good" }],
    sections: [
      {
        heading: "Prepared for filing",
        items: items.map((d) => ({
          title: str(d.caseId || d.alertId || d.complaintId),
          detail: str(d.narrative || d.draft),
          tone: "neutral" as Tone,
        })),
      },
    ],
  };
}

/** Cash reconciliation: matched vs exceptions. */
function reconciliation(o: Rec): Presentation | null {
  if (typeof o.matchedCount !== "number" || !Array.isArray(o.exceptions)) return null;
  const exceptions = arr(o, "exceptions");
  const matchedCount = num(o.matchedCount);
  const report = str(o.report);
  return {
    title: "Cash reconciliation",
    stats: [
      { label: "Matched", value: String(matchedCount), tone: "good" },
      { label: "Exceptions", value: String(exceptions.length), tone: exceptions.length ? "bad" : "good" },
    ],
    chart: {
      kind: "bars",
      items: [
        { label: "Matched", value: matchedCount },
        { label: "Exceptions", value: exceptions.length, flag: exceptions.length > 0 },
      ],
      caption: "Transactions matched vs exceptions",
    },
    sections: [
      ...(exceptions.length
        ? [
            {
              heading: "Exceptions",
              items: exceptions.map((e) => ({
                title: `${str(e.type)} · ${str(e.txnId || e.txnRef || e.entryId)}`,
                detail: str(e.detail),
                tone: "bad" as Tone,
              })),
            },
          ]
        : []),
      ...(report ? [{ heading: "Report", items: [{ title: report }] }] : []),
    ],
  };
}

/** Generic notification ack (a step that ends in notify@1). */
function notification(o: Rec): Presentation | null {
  if (typeof o.message !== "string" || typeof o.channel !== "string") return null;
  return {
    title: "Notification",
    stats: [{ label: "Channel", value: str(o.channel) }],
    sections: [{ heading: "Message", items: [{ title: str(o.message) }] }],
  };
}

const ADAPTERS: ((o: Rec) => Presentation | null)[] = [
  coldChain,
  grossToNet,
  disposition,
  triage,
  drafts,
  reconciliation,
  notification,
];

/**
 * Project a step output into a Presentation, or null if no adapter recognises
 * it (caller renders raw JSON). Order matters: specific shapes before general.
 */
export function presentOutput(output: unknown): Presentation | null {
  const o = asRecord(output);
  if (!o) return null;
  for (const adapt of ADAPTERS) {
    const p = adapt(o);
    if (p) return p;
  }
  return null;
}
