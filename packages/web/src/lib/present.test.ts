import { describe, expect, it } from "vitest";

import { presentOutput } from "./present";

/** Outputs mirror the real shapes emitted by packages/server/src/demo/skills.ts. */

describe("presentOutput — cold-chain incident", () => {
  const output = {
    incident: { lot: "LOT-5002", product: "VaxFlu Quad vaccine", shipment: "VAX-2026-114", units: 9800, valueUsd: 235200 },
    limitC: 8,
    maxExcursionMinutes: 120,
    intervalMinutes: 30,
    readings: [
      { minute: 0, tempC: 4 },
      { minute: 30, tempC: 4 },
      { minute: 60, tempC: 5 },
      { minute: 90, tempC: 6 },
      { minute: 120, tempC: 9 },
      { minute: 150, tempC: 12 },
      { minute: 180, tempC: 15 },
      { minute: 210, tempC: 14 },
      { minute: 240, tempC: 11 },
      { minute: 270, tempC: 9 },
      { minute: 300, tempC: 7 },
      { minute: 330, tempC: 6 },
      { minute: 360, tempC: 5 },
    ],
    peakTempC: 15,
    minutesOverLimit: 180,
    classification: "beyond",
    recommendedDisposition: "destroy",
    held: true,
    heldUnits: 9800,
    holdList: ["LOT-5002"],
    report: {
      title: "Cold-Chain Incident Report",
      ref: "CCIR-2026-0613",
      body: [
        "A temperature excursion was detected on shipment VAX-2026-114 carrying VaxFlu Quad vaccine (lot LOT-5002, 9,800 units). The datalogger recorded a peak of 15.0 °C against the labelled 8 °C limit, with temperature above the limit for 180 minutes [1].",
        "Against the validated stability profile, cumulative time above the limit (180 minutes) exceeds the validated 120-minute excursion allowance, which bears directly on potency [2]. The lot is beyond validated stability and is recommended for destruction [3].",
        "Quarantine has been placed on the lot. Disposition is a one-way door and must be decided by the independent quality unit (21 CFR 211.22) — it is not the agent's to make.",
      ],
      footnotes: [
        "Datalogger trace DL-114-2026.csv",
        "Stability Study SR-2024-118 — VaxFlu Quad vaccine",
        "SOP QA-014 — Excursion Disposition",
      ],
    },
  };

  it("titles the incident report with its reference", () => {
    const p = presentOutput(output)!;
    expect(p.title).toContain("Cold-Chain Incident Report");
    expect(p.title).toContain("CCIR-2026-0613");
  });

  it("renders a temperature line chart against the limit", () => {
    const p = presentOutput(output)!;
    expect(p.chart?.kind).toBe("line");
    if (p.chart?.kind !== "line") throw new Error("expected line");
    expect(p.chart.points).toHaveLength(13);
    expect(p.chart.limit).toBe(8);
  });

  it("surfaces peak temperature and time-over-limit stats", () => {
    const p = presentOutput(output)!;
    const stats = Object.fromEntries(p.stats.map((s) => [s.label, s.value]));
    expect(stats["Peak temperature"]).toBe("15 °C");
    expect(stats["Time over limit"]).toBe("180 min");
    expect(p.stats.find((s) => s.label === "Peak temperature")?.tone).toBe("bad");
    expect(p.stats.find((s) => s.label === "Time over limit")?.tone).toBe("bad");
  });

  it("carries the report body and footnotes through", () => {
    const p = presentOutput(output)!;
    expect(p.body).toHaveLength(3);
    expect(p.footnotes).toHaveLength(3);
  });
});

describe("presentOutput — gross-to-net margin", () => {
  const base = {
    perMarket: [
      { market: "DE", grossRevenue: 1000, netRevenue: 600, netMarginPct: 0.6 },
      { market: "FR", grossRevenue: 2000, netRevenue: 1000, netMarginPct: 0.5 },
    ],
    consolidated: { markets: 2, grossRevenue: 3000, netRevenue: 1600, netMarginPct: 0.5333 },
  };

  it("builds a gross-to-net waterfall and per-market section", () => {
    const p = presentOutput(base)!;
    expect(p.title).toBe("Gross-to-net margin");
    expect(p.chart?.kind).toBe("waterfall");
    if (p.chart?.kind !== "waterfall") throw new Error("expected waterfall");
    expect(p.chart.items[0]).toEqual({ label: "Gross", value: 3000 });
    expect(p.chart.items[1]!.value).toBe(-1400);
    expect(p.sections.find((s) => s.heading === "Per market")?.items).toHaveLength(2);
  });

  it("adds an exceptions section only when there are integrity exceptions", () => {
    expect(presentOutput(base)!.sections.some((s) => s.heading === "Data-integrity exceptions")).toBe(false);
    const withExc = {
      ...base,
      exceptions: [{ market: "IT", sku: "X1", rationale: "deductions exceed 100% of list" }],
    };
    const p = presentOutput(withExc)!;
    const exc = p.sections.find((s) => s.heading === "Data-integrity exceptions")!;
    expect(exc.items[0]).toMatchObject({ title: "IT / X1", tone: "bad" });
    expect(p.stats.find((s) => s.label === "Exceptions")?.tone).toBe("bad");
  });
});

describe("presentOutput — disposition executed", () => {
  it("charts released/destroyed/held and reports values", () => {
    const p = presentOutput({
      released: [{ lotId: "A" }],
      destroyed: [{ lotId: "B" }, { lotId: "C" }],
      heldForJudgment: [{ lotId: "D" }],
      releasedValue: 1000,
      destroyedValue: 8000,
    })!;
    expect(p.title).toBe("Disposition executed");
    expect(p.chart?.kind).toBe("bars");
    const stats = Object.fromEntries(p.stats.map((s) => [s.label, s.value]));
    expect(stats["Destroyed"]).toBe("2");
    expect(stats["Value destroyed"]).toBe("$8,000");
  });
});

describe("presentOutput — triage", () => {
  it("handles AML/MDR escalations vs cleared", () => {
    const p = presentOutput({
      alertCount: 5,
      escalatedCount: 2,
      escalations: [
        { alertId: "AL-1", rationale: "structuring pattern" },
        { alertId: "AL-2", clock: "30-day", rationale: "sanctions near-match" },
      ],
      cleared: [{ alertId: "AL-3" }, { alertId: "AL-4" }, { alertId: "AL-5" }],
    })!;
    expect(p.title).toBe("Alert triage");
    const stats = Object.fromEntries(p.stats.map((s) => [s.label, s.value]));
    expect(stats["Reviewed"]).toBe("5");
    expect(stats["Escalated"]).toBe("2");
    expect(stats["Cleared"]).toBe("3");
    expect(p.sections[0]!.items).toHaveLength(2);
  });

  it("handles PV expedited vs periodic with the case wording", () => {
    const p = presentOutput({
      caseCount: 2,
      expedited: [{ caseId: "C-1", drug: "X", clock: "15-day", rationale: "serious + unexpected" }],
      periodic: [{ caseId: "C-2" }],
    })!;
    expect(p.title).toBe("Adverse-event case triage");
    expect(p.stats.find((s) => s.label === "Expedited")?.value).toBe("1");
    expect(p.stats.find((s) => s.label === "Periodic")?.value).toBe("1");
  });
});

describe("presentOutput — drafts and reconciliation", () => {
  it("lists drafted narratives", () => {
    const p = presentOutput({
      sarCount: 1,
      narratives: [{ alertId: "AL-1", narrative: "SAR draft text" }],
    })!;
    expect(p.title).toBe("Drafted reports");
    expect(p.chart).toBeUndefined();
    expect(p.sections[0]!.items[0]!.detail).toContain("SAR draft text");
  });

  it("renders reconciliation with exceptions and the report text", () => {
    const p = presentOutput({
      matchedCount: 10,
      exceptionCount: 2,
      exceptions: [
        { type: "amount_mismatch", txnId: "T-1009", detail: "statement -7800 != ledger -7080" },
        { type: "missing_in_ledger", txnId: "T-1012", detail: "no ledger entry" },
      ],
      report: "Daily Cash Reconciliation\nMatched: 10",
    })!;
    expect(p.title).toBe("Cash reconciliation");
    expect(p.chart?.kind).toBe("bars");
    expect(p.sections.find((s) => s.heading === "Exceptions")?.items).toHaveLength(2);
    expect(p.sections.find((s) => s.heading === "Report")).toBeDefined();
  });

  it("renders a clean reconciliation with no exceptions section", () => {
    const p = presentOutput({ matchedCount: 12, exceptionCount: 0, exceptions: [] })!;
    expect(p.sections.some((s) => s.heading === "Exceptions")).toBe(false);
    expect(p.stats.find((s) => s.label === "Exceptions")?.tone).toBe("good");
  });
});

describe("presentOutput — notification and fallbacks", () => {
  it("renders a notification ack", () => {
    const p = presentOutput({ delivered: true, channel: "#recon", message: "done" })!;
    expect(p.title).toBe("Notification");
    expect(p.stats[0]).toMatchObject({ label: "Channel", value: "#recon" });
  });

  it("returns null for unrecognised shapes so the caller shows raw JSON", () => {
    expect(presentOutput({ foo: 1, bar: "baz" })).toBeNull();
    expect(presentOutput({ readings: [{ minute: 0, tempC: 4 }] })).toBeNull(); // no report
    expect(presentOutput({ report: { title: "x" } })).toBeNull(); // no readings
    expect(presentOutput({ delivered: true, channel: "#x" })).toBeNull(); // no message
  });

  it("returns null for non-object inputs", () => {
    expect(presentOutput(null)).toBeNull();
    expect(presentOutput("string")).toBeNull();
    expect(presentOutput([1, 2, 3])).toBeNull();
    expect(presentOutput(42)).toBeNull();
  });
});

describe("presentOutput — defensive field handling", () => {
  it("labels triage items by whichever identity field is present", () => {
    const p = presentOutput({
      escalatedCount: 2,
      escalations: [
        { customer: "ACME Corp", rationale: "structuring" }, // identified by customer
        { device: "Infusion Pump X", clock: "30-day", rationale: "death" }, // by device
      ],
    })!;
    const titles = p.sections[0]!.items.map((i) => i.title);
    expect(titles).toContain("ACME Corp");
    expect(titles).toContain("Infusion Pump X");
  });

  it("tolerates a draft with a non-string id and missing narrative text", () => {
    const p = presentOutput({ drafts: [{ complaintId: 4021, draft: null }] })!;
    expect(p.title).toBe("Drafted reports");
    expect(p.sections[0]!.items[0]!.title).toBe("4021");
    expect(p.sections[0]!.items[0]!.detail).toBe("");
  });

  it("gives an unknown cold-chain classification a neutral tone", () => {
    const p = presentOutput({
      incident: { lot: "LOT-Z", product: "x", shipment: "S-1", units: 100, valueUsd: 0 },
      limitC: 8,
      maxExcursionMinutes: 120,
      intervalMinutes: 30,
      readings: [{ minute: 0, tempC: 5 }],
      peakTempC: 5,
      minutesOverLimit: 0,
      classification: "unknown",
      recommendedDisposition: "hold",
      report: { title: "Cold-Chain Incident Report", ref: "", body: [], footnotes: [] },
    })!;
    expect(p.stats.find((s) => s.label === "Classification")?.tone).toBe("neutral");
    expect(p.stats.find((s) => s.label === "Peak temperature")?.tone).toBe("neutral");
    expect(p.title).toBe("Cold-Chain Incident Report"); // ref omitted when empty
  });
});
