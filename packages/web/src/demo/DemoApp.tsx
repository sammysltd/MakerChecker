import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AuditTrail } from "../components/AuditTrail";
import { ChainBadge } from "../components/ChainBadge";
import { ACCENT, Chart, Prose, type ChartSpec } from "../components/charts";
import { StatusPill } from "../components/ui";
import type { AuditEvent, RunDetail, VerifyResult } from "../lib/api";
import amlFixture from "./fixtures/aml.json";
import coldchainFixture from "./fixtures/coldchain.json";
import gtnFixture from "./fixtures/gtn.json";
import mdrFixture from "./fixtures/mdr.json";

/* ---------------------------------------------------------------------------
   The live demo — a cinematic, guided walkthrough.

   A modal narrates each beat (page dims, glowing-blue halo); pressing Next
   plays the action on the lit page. The agent's work is rendered as a real
   ANALYST REPORT — a titled document with footnoted citations and a chart —
   then the agent tries to sign its own report and MakerChecker BLOCKS it; the
   human makes the call with a real decision button. The audit trail + chain
   badge alongside are the REAL product components, fed by fixtures captured
   from real seeded runs (drift-guarded in CI). Four scenarios.
--------------------------------------------------------------------------- */

interface Fixture {
  actors: { officer: { name: string } };
  scenes: { running: RunDetail; waiting: RunDetail; completed: RunDetail };
  verify: VerifyResult;
}

interface Scenario {
  id: string;
  tab: string;
  domain: string;
  fixture: Fixture;
  agent: string;
  officerRole: string;
  report: {
    docType: string;
    ref: string;
    date: string;
    body: string[];
    footnotes: string[];
    chart: ChartSpec;
    blockedNote: string;
    decisionQ: string;
    primary: string;
    secondary: string;
  };
  stops: { title: string; body: string; cta?: string }[];
}

const SCENARIOS: Scenario[] = [
  {
    id: "coldchain",
    tab: "Cold chain",
    domain: "Vaccine disposition",
    fixture: coldchainFixture as unknown as Fixture,
    agent: "cold-chain-monitor",
    officerRole: "QA",
    report: {
      docType: "Cold-Chain Incident Report",
      ref: "CCIR-2026-0613",
      date: "13 Jun 2026",
      body: [
        "A temperature excursion was detected on shipment VAX-2026-114 carrying VaxFlu Quad vaccine. Eight lots were exposed; the logger recorded a peak of 15 °C against a labelled 2–8 °C limit [1].",
        "Against the product stability profile, the cumulative time-above-limit compromises potency for the most-exposed lots [2]. Three lots stayed within cumulative-excursion allowance and are recommended for release; three exceeded it and are recommended for destruction; two need quality judgement [3].",
        "Quarantine has been placed on all eight lots. Disposition is a one-way door and must be decided by the independent quality unit (21 CFR 211.22) — it is not the agent's to make.",
      ],
      footnotes: [
        "Datalogger trace DL-114-2026.csv",
        "Stability Study SR-2024-118 — VaxFlu Quad",
        "SOP QA-014 — Excursion Disposition",
      ],
      chart: {
        kind: "line",
        points: [4, 4, 5, 6, 9, 12, 15, 14, 11, 9, 7, 6, 5],
        limit: 8,
        unit: "°C",
        caption: "Shipment VAX-2026-114 — temperature vs 8 °C limit (excursion shaded)",
      },
      blockedNote: "The agent attempted to disposition the lots it assessed.",
      decisionQ: "Disposition decision — independent quality unit",
      primary: "Release",
      secondary: "Destroy",
    },
    stops: [
      {
        title: "An AI agent catches an excursion",
        body: "MakerChecker, governing a real vaccine cold-chain workflow. An agent just caught a temperature excursion on a shipment and is assessing the affected lots against their stability limits. Press start to watch it work.",
        cta: "Start the run",
      },
      {
        title: "It produced an incident report",
        body: "The agent wrote a full Cold-Chain Incident Report — the excursion, the stability rationale with sources, a chart, and a recommendation. But releasing or destroying stock isn't the agent's call. Watch what happens when it tries to sign its own report.",
        cta: "Let it try to self-approve",
      },
      {
        title: "Blocked — the maker cannot be the checker",
        body: "Disposition belongs to an independent quality unit (21 CFR 211.22). MakerChecker refused to let the agent that assessed the excursion also decide it, and recorded the attempt. Now it's your call.",
        cta: "I'll decide it myself",
      },
      {
        title: "An agent in production, under control",
        body: "The agent caught the excursion and drafted the case in seconds; a named QA person owned the release-or-destroy decision; and the whole run is a signed, tamper-evident record an inspector can verify offline.",
      },
    ],
  },
  {
    id: "mdr",
    tab: "Medical devices",
    domain: "MDR reportability",
    fixture: mdrFixture as unknown as Fixture,
    agent: "mdr-complaint-analyst",
    officerRole: "the regulatory officer",
    report: {
      docType: "Adverse-Event Reportability Assessment",
      ref: "MDR-2026-3004",
      date: "13 Jun 2026",
      body: [
        "Complaint C-3004 concerns an InsuFlow MX insulin pump that over-delivered insulin overnight; the patient was hospitalised with severe hypoglycaemia [1]. This is a serious injury and a reportable event; the 30-calendar-day MDR clock under 21 CFR 803.50 runs from awareness on 2 June 2026 [2].",
        "A second complaint, C-3008 (VentAssist 300 ventilator), is a malfunction likely to recur and is also recommended reportable [3]. Eight further complaints were reviewed and cleared as non-reportable.",
        "Recommendation: confirm both as reportable and file within the clock. Reportability is a regulated decision and is not the agent's to make.",
      ],
      footnotes: [
        "Complaint record C-3004",
        "21 CFR 803.50 — MDR timelines",
        "Triage ruleset MDR-RULES-v3",
      ],
      chart: {
        kind: "bars",
        items: [
          { label: "Serious injury", value: 1, flag: true },
          { label: "Malfunction (recurs)", value: 1, flag: true },
          { label: "User error", value: 4 },
          { label: "Cosmetic", value: 2 },
          { label: "Packaging", value: 1 },
          { label: "Malfunction (low)", value: 1 },
        ],
        caption: "10 complaints triaged — 2 reportable (flagged)",
      },
      blockedNote: "The agent attempted to sign off the reportability it assessed.",
      decisionQ: "Reportability decision — regulatory officer",
      primary: "Confirm reportable",
      secondary: "Not reportable",
    },
    stops: [
      {
        title: "An AI agent triages complaints",
        body: "MakerChecker, governing a real FDA medical-device reporting workflow. An agent is triaging today's device complaints against the reportability rules. Press start to watch it run.",
        cta: "Start the run",
      },
      {
        title: "It produced a reportability assessment",
        body: "The agent wrote a full Adverse-Event Reportability Assessment — the insulin-pump injury, the 30-day MDR clock, sources, and a chart of the day's complaints. But it cannot decide reportability itself. Watch it try to sign its own assessment.",
        cta: "Let it try to self-approve",
      },
      {
        title: "Blocked — the maker cannot be the checker",
        body: "MakerChecker refused to let the agent approve its own reportability decision, and wrote the attempt to the audit trail. This is segregation of duties, enforced. Now it's your call.",
        cta: "I'll decide it myself",
      },
      {
        title: "An agent in production, under control",
        body: "The agent triaged at machine speed; a named regulatory officer owned the reportability decision; and every step is a signed, tamper-evident record a regulator can verify offline.",
      },
    ],
  },
  {
    id: "gtn",
    tab: "Pharma pricing",
    domain: "Gross-to-net",
    fixture: gtnFixture as unknown as Fixture,
    agent: "gtn-market-analyst",
    officerRole: "the controller",
    report: {
      docType: "Gross-to-Net Margin Certification",
      ref: "GTN-2026-Q2",
      date: "13 Jun 2026",
      body: [
        "The consolidated gross-to-net accrual across three markets reconciles to a net margin of 80.7%, with a total rebate accrual of $10.1M [1].",
        "One data-integrity exception was flagged and held back: DE / PUMP-MX shows total deductions of 122% of list — an impossible negative net, consistent with a double-counted austerity discount — and is excluded pending source correction [2].",
        "Recommendation: certify the consolidated accrual for the financial close, excluding the flagged exception. The figure that enters the financials is a controlled certification and is not the agent's to sign [3].",
      ],
      footnotes: [
        "SAP extract GTN-2026-Q2.xlsx",
        "Rebate contract register RC-DE-014",
        "Finance SOP FIN-022 — Accrual Certification (SOX)",
      ],
      chart: {
        kind: "waterfall",
        items: [
          { label: "Gross", value: 52.5 },
          { label: "Statutory rebate", value: -4.0 },
          { label: "Austerity discount", value: -5.1 },
          { label: "Clawback", value: -1.0 },
        ],
        unit: "$M",
        caption: "Gross-to-net waterfall — consolidated, net margin 80.7%",
      },
      blockedNote: "The agent attempted to certify the accrual it prepared.",
      decisionQ: "Accrual certification — controller",
      primary: "Certify",
      secondary: "Send back",
    },
    stops: [
      {
        title: "An AI agent builds the accrual",
        body: "MakerChecker, governing a pharma commercial-pricing workflow. A gross-to-net analyst agent is building today's margin waterfall from the ERP — every figure traced to source. Press start.",
        cta: "Start the run",
      },
      {
        title: "It produced a certification pack",
        body: "The agent wrote a Gross-to-Net Margin Certification — the consolidated accrual, a flagged data-integrity exception, sources, and a waterfall chart. But the number that hits the financials isn't the agent's to certify. Watch it try.",
        cta: "Let it try to self-certify",
      },
      {
        title: "Blocked — the maker cannot be the checker",
        body: "A figure that enters the financials needs a second signature; MakerChecker won't let whoever prepared the accrual certify it, and recorded the attempt. A SOX-grade control. Now it's your call.",
        cta: "I'll decide it myself",
      },
      {
        title: "An agent in production, under control",
        body: "The agent reconciled gross-to-net at machine speed; a named controller owned the certified number; and the whole run is a signed, verifiable record — a SOX-grade control, by construction.",
      },
    ],
  },
  {
    id: "aml",
    tab: "Financial crime",
    domain: "AML alert triage",
    fixture: amlFixture as unknown as Fixture,
    agent: "aml-l1-analyst",
    officerRole: "the BSA officer",
    report: {
      docType: "Suspicious Activity Assessment",
      ref: "SAR-2026-2005",
      date: "13 Jun 2026",
      body: [
        "Alert A-2005 flags a $61,000 transfer to Sable Trading FZE that near-matches an OFAC sanctions entry [1]. A near-match requires a named-officer disposition regardless of score.",
        "Alert A-2007 (Northgate Vending) shows a structuring pattern at risk score 86, above the escalation threshold [2]. Eight further alerts scored below threshold and were cleared.",
        "Recommendation: escalate both for SAR consideration. The suspicious-activity decision is a mandated human gate and is not the agent's to make [3].",
      ],
      footnotes: [
        "Sanctions list snapshot OFAC-2026-06",
        "Transaction-monitoring rule TM-STR-07",
        "BSA SOP AML-031 — SAR Filing",
      ],
      chart: {
        kind: "bars",
        items: [
          { label: "2001", value: 35 },
          { label: "2002", value: 42 },
          { label: "2003", value: 55 },
          { label: "2004", value: 28 },
          { label: "2005", value: 74, flag: true },
          { label: "2006", value: 31 },
          { label: "2007", value: 86, flag: true },
          { label: "2008", value: 47 },
          { label: "2009", value: 39 },
          { label: "2010", value: 22 },
        ],
        threshold: 80,
        thresholdLabel: "escalation 80",
        caption: "Alert risk scores — A-2005 (sanctions) & A-2007 (>80) escalated",
      },
      blockedNote: "The agent attempted to disposition the alert it raised.",
      decisionQ: "SAR filing decision — BSA officer",
      primary: "File SAR",
      secondary: "Dismiss",
    },
    stops: [
      {
        title: "An AI agent triages alerts",
        body: "MakerChecker, governing a real financial-crime workflow. An AML analyst agent is triaging today's transaction-monitoring alerts. Press start to watch it clear the queue.",
        cta: "Start the run",
      },
      {
        title: "It produced a suspicious-activity assessment",
        body: "The agent wrote a Suspicious Activity Assessment — the sanctions near-match, a structuring pattern, sources, and a chart of alert scores. But the SAR decision isn't the agent's to make. Watch it try to disposition its own assessment.",
        cta: "Let it try to self-approve",
      },
      {
        title: "Blocked — the maker cannot be the checker",
        body: "The four-eye control fired: the agent that raised the alert is barred from deciding it, and the attempt is recorded. The Wolfsberg standard, enforced at runtime. Now it's your call.",
        cta: "I'll decide it myself",
      },
      {
        title: "An agent in production, under control",
        body: "The agent cleared the alert queue at machine speed; a named BSA officer owned the SAR decision; and every step is a signed, verifiable record — NYDFS Part 504 certification support, by construction.",
      },
    ],
  },
];

const BOOK_DEMO = "mailto:hello@makerchecker.ai?subject=MakerChecker%20demo";

/* ---------- audit/chain views from the captured fixture ---------- */

function chainVerify(events: AuditEvent[]): VerifyResult {
  const head = events.length > 0 ? events[events.length - 1] : undefined;
  if (!head) return { ok: true, count: 0, headHash: null } as VerifyResult;
  return { ok: true, count: Number(head.seq), headHash: head.hash } as VerifyResult;
}

function upToNth(events: AuditEvent[], type: string, n: number): AuditEvent[] {
  let seen = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e && e.event_type === type) {
      seen += 1;
      if (seen === n) return events.slice(0, i + 1);
    }
  }
  return events;
}

type Scene = "drafting" | "produced" | "blocked" | "awaiting" | "decided";

function evidenceFor(fixture: Fixture, scene: Scene): { events: AuditEvent[]; verify: VerifyResult; status: string } {
  const all = fixture.scenes.completed.auditEvents;
  if (scene === "drafting") {
    const e = fixture.scenes.running.auditEvents;
    return { events: e, verify: chainVerify(e), status: "running" };
  }
  if (scene === "produced") {
    const e = fixture.scenes.waiting.auditEvents;
    return { events: e, verify: chainVerify(e), status: "waiting_approval" };
  }
  if (scene === "blocked" || scene === "awaiting") {
    const e = upToNth(all, "approval.decision_denied", 1);
    return { events: e, verify: chainVerify(e), status: "waiting_approval" };
  }
  return { events: all, verify: fixture.verify, status: "completed" };
}

/* ---------- the agent's report document ---------- */

function ReportDoc({
  sc,
  scene,
  choice,
  onDecide,
}: {
  sc: Scenario;
  scene: Scene;
  choice: string | null;
  onDecide: (c: string) => void;
}) {
  const r = sc.report;
  if (scene === "drafting") {
    return (
      <div className="rounded-lg border border-line bg-white p-6">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-stone-400">
          {sc.agent} is drafting…
        </p>
        <div className="mt-4 space-y-2.5">
          {[90, 80, 95, 70].map((w, i) => (
            <div key={i} className="h-2.5 animate-pulse rounded bg-stone-100" style={{ width: `${w}%` }} />
          ))}
          <div className="mt-4 h-28 animate-pulse rounded bg-stone-100" />
        </div>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-white">
      {/* Document header band */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line bg-stone-50 px-6 py-3.5">
        <div>
          <h3 className="font-display text-lg font-medium leading-tight text-ink">{r.docType}</h3>
          <p className="mt-0.5 font-mono text-[11px] text-stone-500">
            Ref {r.ref} · {r.date} · prepared by {sc.agent}
          </p>
        </div>
        <span
          className="rounded-pill px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-white"
          style={{ background: ACCENT }}
        >
          AI-generated draft
        </span>
      </div>

      <div className="px-6 py-5">
        {r.body.map((p, i) => (
          <p key={i} className="mb-3 font-sans text-[14px] leading-relaxed text-stone-700 last:mb-0">
            <Prose text={p} />
          </p>
        ))}

        <Chart chart={r.chart} />

        {/* Footnotes */}
        <ol className="mt-5 space-y-1 border-t border-line pt-4">
          {r.footnotes.map((f, i) => (
            <li key={i} id={`fn-${i + 1}`} className="font-sans text-[11px] text-stone-500">
              <span className="mr-1 font-medium" style={{ color: ACCENT }}>
                [{i + 1}]
              </span>
              <a href="#fn" className="underline decoration-stone-300 underline-offset-2 hover:decoration-stone-500">
                {f}
              </a>
            </li>
          ))}
        </ol>
      </div>

      {/* The self-approval block — stays visible while the human decides. */}
      {(scene === "blocked" || scene === "awaiting") && (
        <div className="border-t-4 border-blocked bg-red-50 px-6 py-4" role="alert">
          <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-blocked">
            Decision denied — segregation of duties
          </p>
          <p className="mt-1 text-sm leading-snug text-blocked">
            {r.blockedNote} Whoever prepared this report cannot approve it (forbid_requester) — the attempt is on the audit trail.
          </p>
        </div>
      )}

      {/* The human decision */}
      <div
        className={`border-t px-6 py-4 ${scene === "awaiting" ? "border-line" : "border-line"}`}
        style={scene === "awaiting" ? { boxShadow: `inset 0 0 0 2px ${ACCENT}33` } : undefined}
      >
        <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-stone-400">{r.decisionQ}</p>
        {scene === "decided" && choice ? (
          <p className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-verified">
            <span className="h-1.5 w-1.5 rounded-full bg-verified" aria-hidden /> {choice} — approved by {sc.officerRole}, recorded in the audit trail.
          </p>
        ) : (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {scene === "awaiting" && (
              <span className="mr-1 font-sans text-xs font-medium" style={{ color: ACCENT }}>
                Your call →
              </span>
            )}
            <button
              type="button"
              disabled={scene !== "awaiting"}
              onClick={() => onDecide(r.primary)}
              className="rounded border border-verified bg-verified px-3.5 py-1.5 text-xs font-medium text-white enabled:hover:opacity-90 disabled:opacity-40"
            >
              {r.primary}
            </button>
            <button
              type="button"
              disabled={scene !== "awaiting"}
              onClick={() => onDecide(r.secondary)}
              className="rounded border border-blocked px-3.5 py-1.5 text-xs font-medium text-blocked enabled:hover:bg-red-50 disabled:opacity-40"
            >
              {r.secondary}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- the walkthrough ---------- */

export function DemoApp() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]!;

  const [scene, setScene] = useState<Scene>("drafting");
  const [beat, setBeat] = useState(0);
  const [modalOpen, setModalOpen] = useState(true);
  const [choice, setChoice] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);
  const after = useCallback(
    (ms: number, fn: () => void) => {
      const t = window.setTimeout(fn, ms);
      timers.current.push(t);
    },
    [],
  );

  const reset = useCallback(
    (id?: string) => {
      clearTimers();
      if (id) setScenarioId(id);
      setScene("drafting");
      setBeat(0);
      setChoice(null);
      setModalOpen(true);
    },
    [clearTimers],
  );

  // Pressing Next on a narration beat: hide the modal, play the action on the
  // lit page, pause, then re-dim and show the next beat.
  const next = useCallback(() => {
    clearTimers();
    const i = beat;
    setModalOpen(false);
    if (i === 0) {
      after(120, () => setScene("produced"));
      after(1900, () => {
        setBeat(1);
        setModalOpen(true);
      });
    } else if (i === 1) {
      after(120, () => setScene("blocked"));
      after(2000, () => {
        setBeat(2);
        setModalOpen(true);
      });
    } else if (i === 2) {
      // Hand control to the user — the decision buttons go live; no auto-advance.
      after(120, () => setScene("awaiting"));
    }
  }, [beat, after, clearTimers]);

  const decide = useCallback(
    (c: string) => {
      clearTimers();
      setChoice(c);
      setScene("decided");
      after(1700, () => {
        setBeat(3);
        setModalOpen(true);
      });
    },
    [after, clearTimers],
  );

  useEffect(() => () => clearTimers(), [clearTimers]);

  // Enter advances a narration beat (not the finale, not the user-decision beat).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && modalOpen && beat < 3) {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen, beat, next]);

  const ev = useMemo(() => evidenceFor(scenario.fixture, scene), [scenario, scene]);
  const stop = scenario.stops[beat]!;
  const isFinale = beat === 3;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <style>{`
        @keyframes mc-halo {
          0%,100% { box-shadow: 0 0 0 1px rgba(74,127,181,.55), 0 0 36px 2px rgba(74,127,181,.30) }
          50%     { box-shadow: 0 0 0 1px rgba(74,127,181,.80), 0 0 58px 8px rgba(74,127,181,.48) }
        }
        @media (prefers-reduced-motion: reduce) { .mc-halo { animation: none !important } }
      `}</style>

      {/* Banner + scenario tabs */}
      <div className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-[11px]">
          <span className="inline-flex items-center gap-1.5 font-medium uppercase tracking-[0.1em] text-verified">
            <span className="h-1.5 w-1.5 rounded-full bg-verified" aria-hidden /> Live demo
          </span>
          <span className="text-stone-500">A real MakerChecker run, replayed in the product — no backend connected.</span>
          <a href="/" className="ml-auto font-medium text-ink underline underline-offset-2 hover:text-stone-600">
            makerchecker.ai
          </a>
          <a href={BOOK_DEMO} className="rounded border border-ink bg-ink px-2.5 py-1 font-medium text-white hover:bg-stone-800">
            Book a demo
          </a>
        </div>
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-5 pb-2.5">
          <span className="mr-1 font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">Scenario</span>
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => reset(s.id)}
              className={`rounded border px-3 py-1 text-xs font-medium ${
                s.id === scenarioId ? "border-ink bg-ink text-white" : "border-line bg-white text-stone-600 hover:border-stone-400"
              }`}
            >
              {s.tab}
              <span className="ml-1.5 font-normal text-[10px] opacity-70">{s.domain}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Stage */}
      <div className="mx-auto max-w-5xl px-5 py-8">
        <header className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-semibold tracking-tight text-ink">{scenario.fixture.scenes.completed.run.flow}</h1>
          <StatusPill status={ev.status} />
          <span className="font-mono text-[10px] text-stone-400">governed by MakerChecker</span>
        </header>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_330px]">
          <section aria-label="Agent output">
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.1em] text-stone-400">What the agent produced</h2>
            <ReportDoc sc={scenario} scene={scene} choice={choice} onDecide={decide} />
          </section>

          <aside aria-label="Audit evidence">
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.1em] text-stone-400">Audit trail</h2>
            <ChainBadge verify={ev.verify} />
            <div className="mt-4">
              <AuditTrail events={ev.events} />
            </div>
          </aside>
        </div>
      </div>

      {/* Dim + modal */}
      {modalOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-ink/75 backdrop-blur-sm transition-opacity" aria-hidden />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-5" role="dialog" aria-modal="true">
            <div className="mc-halo w-full max-w-lg rounded-2xl bg-paper p-7" style={{ animation: "mc-halo 2.6s ease-in-out infinite" }}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em]" style={{ color: ACCENT }}>
                  {scenario.tab}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-400">
                  · step {Math.min(beat + 1, 4)} of 4
                </span>
              </div>
              <h3 className="mt-3 font-display text-2xl font-light leading-snug text-ink">{stop.title}</h3>
              <p className="mt-3 font-sans text-[14px] leading-relaxed text-stone-600">{stop.body}</p>

              {isFinale ? (
                <div className="mt-7 flex flex-wrap gap-2.5">
                  <a href={BOOK_DEMO} className="rounded border border-ink bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-stone-800">
                    Book a demo
                  </a>
                  <a href="/concepts/" className="rounded border border-ink px-4 py-2 text-sm font-medium text-ink hover:bg-stone-50">
                    How it works
                  </a>
                  <button
                    type="button"
                    onClick={() => reset()}
                    className="rounded border border-line px-4 py-2 text-sm font-medium text-stone-600 hover:border-stone-400"
                  >
                    Replay
                  </button>
                </div>
              ) : (
                <div className="mt-7 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={next}
                    className="rounded px-4 py-2 text-sm font-medium text-white"
                    style={{ background: ACCENT }}
                  >
                    {stop.cta ?? "Next"} →
                  </button>
                  {beat === 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        clearTimers();
                        setScene("decided");
                        setChoice(scenario.report.primary);
                        setModalOpen(false);
                      }}
                      className="text-xs text-stone-400 underline underline-offset-2 hover:text-stone-600"
                    >
                      Skip the walkthrough
                    </button>
                  )}
                </div>
              )}

              {/* Finale: jump to another scenario */}
              {isFinale && (
                <div className="mt-6 border-t border-line pt-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-stone-400">Try another</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {SCENARIOS.filter((s) => s.id !== scenarioId).map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => reset(s.id)}
                        className="rounded border border-line px-3 py-1 text-xs font-medium text-stone-600 hover:border-stone-400"
                      >
                        {s.tab}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
