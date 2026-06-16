import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SequentialInvokerExecutor } from "../skills/sequential-executor.js";
import {
  accrualDraft,
  caseIntake,
  complaintIngest,
  csvIngest,
  dispositionAct,
  erpExtract,
  excursionIngest,
  gtnWaterfall,
  mdrDraft,
  narrativeDraft,
  quarantine,
  reportabilityTriage,
  reportGen,
  seriousnessTriage,
  stabilityAssess,
  txnMatch,
} from "./skills.js";

const sig = () => new AbortController().signal;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-demo-"));
  writeFileSync(
    join(dir, "bank_statement.csv"),
    "txn_id,date,description,amount\nT-1,2026-06-10,ALPHA,100.00\nT-2,2026-06-10,BETA,-50.00\nT-3,2026-06-10\n",
  );
  writeFileSync(
    join(dir, "ledger.csv"),
    "entry_id,txn_ref,date,description,amount\nL-1,T-1,2026-06-10,Alpha,100.00\nL-2,T-2,2026-06-10,Beta,-50.00\nL-9,T-99,2026-06-10,Orphan,7.00\n",
  );
  // The healthcare ingest skills resolve their fixtures as SIBLINGS of
  // DEMO_DATA_DIR — mirror the examples/ directory layout inside the temp dir.
  mkdirSync(join(dir, "demo-data"));
  mkdirSync(join(dir, "mdr-reportability-triage"));
  writeFileSync(
    join(dir, "mdr-reportability-triage", "complaints.csv"),
    "complaint_id,device,event_type,patient_harm,recurrence_risk,description,received_date\n" +
      "C-1,PumpX,death,death,low,fatal event,2026-06-01\n" +
      "C-2,VentY,malfunction,none,high,alarm failed,2026-06-02\n" +
      "C-3,MeterZ,user_error,none,low,wrong strips,2026-06-03\n",
  );
  mkdirSync(join(dir, "pv-icsr-processing"));
  writeFileSync(
    join(dir, "pv-icsr-processing", "icsr_cases.csv"),
    "case_id,drug,event,seriousness,expectedness,country,received_date\n" +
      "P-1,DrugA,Hepatic failure,serious,unexpected,US,2026-06-01\n" +
      "P-2,DrugB,Headache,non-serious,expected,GB,2026-06-02\n",
  );
  mkdirSync(join(dir, "gross-to-net-margin"));
  writeFileSync(
    join(dir, "gross-to-net-margin", "erp_pricing.csv"),
    "market,sku,product,list_price,statutory_rebate_pct,austerity_discount_pct,clawback_pct,units\n" +
      "US,ONC-200,Oncozar,100.00,0.10,0.00,0.00,10\n" +
      "DE,PUMP-MX,Pump,200.00,0.05,0.90,0.30,5\n",
  );
  mkdirSync(join(dir, "cold-chain-disposition"));
  // A SINGLE incident row, the product's validated limits, and the datalogger
  // temperature time-series — mirroring the new examples/ fixture layout.
  writeFileSync(
    join(dir, "cold-chain-disposition", "excursions.csv"),
    "lot_id,product,shipment,units,value_usd\n" +
      "LOT-5002,VaxFlu Quad vaccine,VAX-2026-114,9800,235200.00\n",
  );
  writeFileSync(
    join(dir, "cold-chain-disposition", "stability_limits.csv"),
    "product,max_temp_c,max_excursion_minutes\nVaxFlu Quad vaccine,8,120\n",
  );
  writeFileSync(
    join(dir, "cold-chain-disposition", "readings.csv"),
    "minute,temp_c\n" +
      "0,4\n30,4\n60,5\n90,6\n120,9\n150,12\n180,15\n210,14\n240,11\n270,9\n300,7\n330,6\n360,5\n",
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("csvIngest", () => {
  it("throws without paths and without DEMO_DATA_DIR", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    delete process.env.DEMO_DATA_DIR;
    try {
      await expect(csvIngest({}, sig())).rejects.toThrow(/statementPath/);
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
    }
  });

  it("falls back to DEMO_DATA_DIR when paths are omitted", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    process.env.DEMO_DATA_DIR = dir;
    try {
      const out = (await csvIngest({}, sig())) as { statement: unknown[]; ledger: unknown[] };
      expect(out.statement).toHaveLength(3);
      expect(out.ledger).toHaveLength(3);
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
      else delete process.env.DEMO_DATA_DIR;
    }
  });

  it("tolerates short rows (missing cells become empty)", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    process.env.DEMO_DATA_DIR = dir;
    try {
      const out = (await csvIngest(
        { statementPath: join(dir, "bank_statement.csv"), ledgerPath: join(dir, "ledger.csv") },
        sig(),
      )) as { statement: Array<{ txn_id: string; description: string }> };
      const short = out.statement.find((r) => r.txn_id === "T-3")!;
      expect(short.description).toBe("");
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
      else delete process.env.DEMO_DATA_DIR;
    }
  });

  it("rejects a caller path that escapes the demo data tree", async () => {
    // The confinement root is the PARENT of DEMO_DATA_DIR (where the sibling
    // sample data lives). Point DEMO_DATA_DIR at a sub-directory so escapes are
    // unambiguous, then attack with an absolute path and a relative traversal.
    const saved = process.env.DEMO_DATA_DIR;
    process.env.DEMO_DATA_DIR = join(dir, "demo-data");
    try {
      // Absolute path outside the tree.
      await expect(
        csvIngest({ statementPath: "/etc/passwd", ledgerPath: "/etc/passwd" }, sig()),
      ).rejects.toThrow(/escapes the demo data directory/);
      // Relative traversal that climbs past the confinement root: the exact
      // shape that would exfiltrate the audit signing key (instance_key.pem).
      await expect(
        csvIngest(
          {
            statementPath: "../../instance_key.pem",
            ledgerPath: "../../instance_key.pem",
          },
          sig(),
        ),
      ).rejects.toThrow(/escapes the demo data directory/);
      // The legit in-root default still works (statement.csv/ledger.csv are
      // siblings of DEMO_DATA_DIR, i.e. inside the confinement root).
      const out = (await csvIngest(
        {
          statementPath: join(dir, "bank_statement.csv"),
          ledgerPath: join(dir, "ledger.csv"),
        },
        sig(),
      )) as { statement: unknown[]; ledger: unknown[] };
      expect(out.statement).toHaveLength(3);
      expect(out.ledger).toHaveLength(3);
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
      else delete process.env.DEMO_DATA_DIR;
    }
  });

  it("rejects any read when DEMO_DATA_DIR is unset", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    delete process.env.DEMO_DATA_DIR;
    try {
      await expect(
        csvIngest(
          {
            statementPath: join(dir, "bank_statement.csv"),
            ledgerPath: join(dir, "ledger.csv"),
          },
          sig(),
        ),
      ).rejects.toThrow(/bundled sample data/);
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
    }
  });
});

describe("txnMatch", () => {
  it("flags ledger entries missing from the statement, and defaults empty inputs", async () => {
    const out = (await txnMatch(
      {
        statement: [{ txn_id: "T-1", date: "d", description: "x", amount: 100 }],
        ledger: [
          { entry_id: "L-1", txn_ref: "T-1", date: "d", description: "x", amount: 100 },
          { entry_id: "L-9", txn_ref: "T-99", date: "d", description: "orphan", amount: 7 },
        ],
      },
      sig(),
    )) as { exceptions: Array<{ type: string }>; matchedCount: number };
    expect(out.matchedCount).toBe(1);
    expect(out.exceptions).toEqual([
      expect.objectContaining({ type: "missing_in_statement", entryId: "L-9" }),
    ]);

    const empty = (await txnMatch({}, sig())) as { matchedCount: number; exceptionCount: number };
    expect(empty).toMatchObject({ matchedCount: 0, exceptionCount: 0 });
  });
});

describe("reportGen", () => {
  it("renders a clean reconciliation when there are no exceptions", async () => {
    const out = (await reportGen({ matchedCount: 12, exceptions: [] }, sig())) as {
      report: string;
      message: string;
    };
    expect(out.report).toContain("Clean reconciliation; no exceptions.");
    expect(out.message).toContain("12 matched, 0 exception(s)");
  });

  it("defaults missing fields to zero/empty", async () => {
    const out = (await reportGen({}, sig())) as { report: string };
    expect(out.report).toContain("Matched transactions: 0");
  });
});

describe("complaintIngest", () => {
  it("throws without a path and without DEMO_DATA_DIR", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    delete process.env.DEMO_DATA_DIR;
    try {
      await expect(complaintIngest({}, sig())).rejects.toThrow(/complaintsPath/);
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
    }
  });

  it("resolves the fixture as a sibling of DEMO_DATA_DIR", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    process.env.DEMO_DATA_DIR = join(dir, "demo-data");
    try {
      const out = (await complaintIngest({}, sig())) as {
        complaints: Array<{ complaint_id: string; event_type: string }>;
      };
      expect(out.complaints).toHaveLength(3);
      expect(out.complaints[0]).toMatchObject({ complaint_id: "C-1", event_type: "death" });
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
      else delete process.env.DEMO_DATA_DIR;
    }
  });
});

describe("reportabilityTriage", () => {
  const complaint = (over: Record<string, string>) => ({
    complaint_id: "C-0",
    device: "DevX",
    event_type: "user_error",
    patient_harm: "none",
    recurrence_risk: "low",
    description: "d",
    received_date: "2026-06-01",
    ...over,
  });

  it("escalates deaths and serious injuries onto the 30-day MDR clock", async () => {
    const out = (await reportabilityTriage(
      {
        complaints: [
          complaint({ complaint_id: "C-1", event_type: "death", patient_harm: "death" }),
          complaint({
            complaint_id: "C-2",
            event_type: "serious_injury",
            patient_harm: "hospitalized",
          }),
        ],
      },
      sig(),
    )) as { escalations: Array<{ complaintId: string; clock: string; rationale: string }> };
    expect(out.escalations).toHaveLength(2);
    for (const e of out.escalations) {
      expect(e.clock).toBe("30-day MDR (21 CFR 803.50)");
      expect(e.rationale).toContain("30-calendar-day");
    }
    expect(out.escalations[0]!.rationale).toContain("death");
  });

  it("escalates a malfunction only when it is likely to recur", async () => {
    const out = (await reportabilityTriage(
      {
        complaints: [
          complaint({ complaint_id: "C-1", event_type: "malfunction", recurrence_risk: "high" }),
          complaint({ complaint_id: "C-2", event_type: "malfunction", recurrence_risk: "low" }),
        ],
      },
      sig(),
    )) as {
      escalations: Array<{ complaintId: string; clock: string; rationale: string }>;
      cleared: Array<{ complaintId: string; rationale: string }>;
    };
    expect(out.escalations).toEqual([
      expect.objectContaining({
        complaintId: "C-1",
        clock: "30-day malfunction MDR (21 CFR 803.50)",
      }),
    ]);
    expect(out.escalations[0]!.rationale).toContain("if it recurred");
    expect(out.cleared).toEqual([expect.objectContaining({ complaintId: "C-2" })]);
    expect(out.cleared[0]!.rationale).toContain("not MDR-reportable");
  });

  it("defaults empty input to an empty queue", async () => {
    expect(await reportabilityTriage({}, sig())).toMatchObject({
      complaintCount: 0,
      escalatedCount: 0,
    });
  });
});

describe("mdrDraft", () => {
  it("drafts one notification-ready skeleton per escalation", async () => {
    const out = (await mdrDraft(
      {
        escalations: [
          {
            complaintId: "C-1",
            device: "PumpX",
            eventType: "serious_injury",
            clock: "30-day MDR (21 CFR 803.50)",
            rationale: "r",
          },
        ],
      },
      sig(),
    )) as { mdrCount: number; drafts: Array<{ draft: string }>; channel: string };
    expect(out.mdrCount).toBe(1);
    expect(out.drafts[0]!.draft).toContain("C-1");
    expect(out.drafts[0]!.draft).toContain("30-day MDR");
    expect(out.channel).toBe("#mdr");
  });

  it("defaults missing escalations to zero drafts", async () => {
    expect(await mdrDraft({}, sig())).toMatchObject({ mdrCount: 0 });
  });
});

describe("caseIntake", () => {
  it("throws without a path and without DEMO_DATA_DIR", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    delete process.env.DEMO_DATA_DIR;
    try {
      await expect(caseIntake({}, sig())).rejects.toThrow(/casesPath/);
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
    }
  });

  it("resolves the fixture as a sibling of DEMO_DATA_DIR", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    process.env.DEMO_DATA_DIR = join(dir, "demo-data");
    try {
      const out = (await caseIntake({}, sig())) as {
        cases: Array<{ case_id: string; seriousness: string; expectedness: string }>;
      };
      expect(out.cases).toHaveLength(2);
      expect(out.cases[0]).toMatchObject({
        case_id: "P-1",
        seriousness: "serious",
        expectedness: "unexpected",
      });
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
      else delete process.env.DEMO_DATA_DIR;
    }
  });
});

describe("seriousnessTriage", () => {
  const icsr = (over: Record<string, string>) => ({
    case_id: "P-0",
    drug: "DrugX",
    event: "Event",
    seriousness: "non-serious",
    expectedness: "expected",
    country: "US",
    received_date: "2026-06-01",
    ...over,
  });

  it("only serious AND unexpected goes onto the 15-day expedited clock", async () => {
    const out = (await seriousnessTriage(
      {
        cases: [
          icsr({ case_id: "P-1", seriousness: "serious", expectedness: "unexpected", country: "DE" }),
          icsr({ case_id: "P-2", seriousness: "serious", expectedness: "expected" }),
          icsr({ case_id: "P-3", seriousness: "non-serious", expectedness: "unexpected" }),
        ],
      },
      sig(),
    )) as {
      expedited: Array<{ caseId: string; clock: string; rationale: string }>;
      periodic: Array<{ caseId: string; rationale: string }>;
    };
    expect(out.expedited).toEqual([
      expect.objectContaining({ caseId: "P-1", clock: "15-day expedited (21 CFR 314.80)" }),
    ]);
    // The expedited clock is source-independent: P-1 is foreign-sourced.
    expect(out.expedited[0]!.rationale).toContain("regardless of source (received from DE");
    expect(out.periodic.map((c) => c.caseId)).toEqual(["P-2", "P-3"]);
    for (const c of out.periodic) {
      expect(c.rationale).toContain("serious-and-unexpected test");
    }
  });

  it("defaults empty input to an empty queue", async () => {
    expect(await seriousnessTriage({}, sig())).toMatchObject({
      caseCount: 0,
      expeditedCount: 0,
    });
  });
});

describe("narrativeDraft", () => {
  it("drafts one E2B(R3)-bound narrative per expedited case", async () => {
    const out = (await narrativeDraft(
      {
        expedited: [
          {
            caseId: "P-1",
            drug: "DrugA",
            event: "Hepatic failure",
            country: "US",
            clock: "15-day expedited (21 CFR 314.80)",
            rationale: "r",
          },
        ],
      },
      sig(),
    )) as { icsrCount: number; narratives: Array<{ narrative: string }>; channel: string };
    expect(out.icsrCount).toBe(1);
    expect(out.narratives[0]!.narrative).toContain("P-1");
    expect(out.narratives[0]!.narrative).toContain("E2B(R3)");
    expect(out.channel).toBe("#pv");
  });

  it("defaults missing cases to zero narratives", async () => {
    expect(await narrativeDraft({}, sig())).toMatchObject({ icsrCount: 0 });
  });
});

describe("erpExtract", () => {
  it("throws without a path and without DEMO_DATA_DIR", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    delete process.env.DEMO_DATA_DIR;
    try {
      await expect(erpExtract({}, sig())).rejects.toThrow(/pricingPath/);
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
    }
  });

  it("resolves the fixture as a sibling of DEMO_DATA_DIR", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    process.env.DEMO_DATA_DIR = join(dir, "demo-data");
    try {
      const out = (await erpExtract({}, sig())) as {
        rows: Array<{ market: string; sku: string; list_price: number }>;
      };
      expect(out.rows).toHaveLength(2);
      expect(out.rows[0]).toMatchObject({ market: "US", sku: "ONC-200", list_price: 100 });
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
      else delete process.env.DEMO_DATA_DIR;
    }
  });

  it("reads an explicitly supplied path", async () => {
    // The path lives under dir; DEMO_DATA_DIR's parent (dir) is the read root.
    const saved = process.env.DEMO_DATA_DIR;
    process.env.DEMO_DATA_DIR = join(dir, "demo-data");
    try {
      const out = (await erpExtract(
        { pricingPath: join(dir, "gross-to-net-margin", "erp_pricing.csv") },
        sig(),
      )) as { rows: Array<{ sku: string; austerity_discount_pct: number }> };
      expect(out.rows.map((r) => r.sku)).toEqual(["ONC-200", "PUMP-MX"]);
      expect(out.rows[1]!.austerity_discount_pct).toBe(0.9);
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
      else delete process.env.DEMO_DATA_DIR;
    }
  });
});

describe("gtnWaterfall", () => {
  const row = (over: Partial<Record<string, number | string>>) => ({
    market: "US",
    sku: "SKU-0",
    product: "Product",
    list_price: 100,
    statutory_rebate_pct: 0.1,
    austerity_discount_pct: 0,
    clawback_pct: 0,
    units: 10,
    ...over,
  });

  it("computes net price and units-weighted margins per market and consolidated", async () => {
    const out = (await gtnWaterfall(
      {
        rows: [
          row({ market: "US", sku: "A", list_price: 100, statutory_rebate_pct: 0.1, units: 10 }),
          row({
            market: "DE",
            sku: "B",
            list_price: 200,
            statutory_rebate_pct: 0.1,
            austerity_discount_pct: 0.1,
            units: 5,
          }),
        ],
      },
      sig(),
    )) as {
      cleanCount: number;
      exceptionCount: number;
      rows: Array<{ sku: string; netPrice: number; netMarginPct: number; netRevenue: number }>;
      perMarket: Array<{ market: string; netMarginPct: number; netRevenue: number }>;
      consolidated: { markets: number; netMarginPct: number; grossRevenue: number; netRevenue: number };
    };
    expect(out.cleanCount).toBe(2);
    expect(out.exceptionCount).toBe(0);
    // US: list 100, 10% off => net 90, margin 0.9.
    const us = out.rows.find((r) => r.sku === "A")!;
    expect(us.netPrice).toBe(90);
    expect(us.netMarginPct).toBe(0.9);
    // DE: list 200, 20% off => net 160, margin 0.8.
    const de = out.rows.find((r) => r.sku === "B")!;
    expect(de.netPrice).toBe(160);
    expect(de.netMarginPct).toBe(0.8);
    // Per-market summaries sorted by market.
    expect(out.perMarket.map((m) => m.market)).toEqual(["DE", "US"]);
    // Consolidated: gross 100*10 + 200*5 = 2000; net 90*10 + 160*5 = 1700.
    expect(out.consolidated).toMatchObject({
      markets: 2,
      grossRevenue: 2000,
      netRevenue: 1700,
      netMarginPct: 0.85,
    });
  });

  it("FLAGS a row whose total deduction reaches 100% of list as a data-integrity exception", async () => {
    const out = (await gtnWaterfall(
      {
        rows: [
          row({ sku: "OK", statutory_rebate_pct: 0.1 }),
          // Double-counted austerity discount: deductions exceed 100% => net negative.
          row({
            market: "DE",
            sku: "BAD",
            list_price: 200,
            statutory_rebate_pct: 0.05,
            austerity_discount_pct: 0.9,
            clawback_pct: 0.3,
            units: 5,
          }),
        ],
      },
      sig(),
    )) as {
      cleanCount: number;
      exceptionCount: number;
      exceptions: Array<{
        sku: string;
        type: string;
        totalDeductionPct: number;
        netPrice: number;
        rationale: string;
      }>;
    };
    expect(out.cleanCount).toBe(1);
    expect(out.exceptionCount).toBe(1);
    const exc = out.exceptions[0]!;
    expect(exc).toMatchObject({ sku: "BAD", type: "data_integrity_exception" });
    expect(exc.totalDeductionPct).toBeCloseTo(1.25, 5);
    expect(exc.netPrice).toBeLessThanOrEqual(0);
    expect(exc.rationale).toContain("exceeds 100% of list");
    expect(exc.rationale).toContain("austerity");
  });

  it("flags a row whose total deduction equals exactly 100% (net zero)", async () => {
    const out = (await gtnWaterfall(
      { rows: [row({ sku: "ZERO", statutory_rebate_pct: 0.6, austerity_discount_pct: 0.4 })] },
      sig(),
    )) as { exceptionCount: number; exceptions: Array<{ netPrice: number }> };
    expect(out.exceptionCount).toBe(1);
    expect(out.exceptions[0]!.netPrice).toBe(0);
  });

  it("defaults empty input to an empty, zero-margin consolidated view", async () => {
    expect(await gtnWaterfall({}, sig())).toMatchObject({
      rowCount: 0,
      cleanCount: 0,
      exceptionCount: 0,
      consolidated: { markets: 0, grossRevenue: 0, netRevenue: 0, netMarginPct: 0 },
    });
  });

  it("flags a zero list price as an exception (impossible non-positive net)", async () => {
    const out = (await gtnWaterfall(
      { rows: [row({ sku: "FREE", list_price: 0, statutory_rebate_pct: 0, units: 3 })] },
      sig(),
    )) as { exceptionCount: number; cleanCount: number; exceptions: Array<{ netPrice: number }> };
    // list 0 => net 0 => non-positive => flagged, never reaching the clean path.
    expect(out.cleanCount).toBe(0);
    expect(out.exceptionCount).toBe(1);
    expect(out.exceptions[0]!.netPrice).toBe(0);
  });

  it("guards against zero-revenue aggregates (no division by zero)", async () => {
    // A clean row with zero units: net margin is real, but revenue aggregates
    // are zero, exercising the per-market and consolidated zero-divisor guards.
    const out = (await gtnWaterfall(
      { rows: [row({ sku: "SAMPLE", list_price: 100, statutory_rebate_pct: 0.1, units: 0 })] },
      sig(),
    )) as {
      cleanCount: number;
      rows: Array<{ netMarginPct: number }>;
      perMarket: Array<{ netMarginPct: number; grossRevenue: number }>;
      consolidated: { netMarginPct: number; grossRevenue: number };
    };
    expect(out.cleanCount).toBe(1);
    // Per-SKU margin is still computed from list (90/100 = 0.9).
    expect(out.rows[0]!.netMarginPct).toBe(0.9);
    // Revenue-weighted aggregates have a zero denominator => guarded to 0.
    expect(out.perMarket[0]!.grossRevenue).toBe(0);
    expect(out.perMarket[0]!.netMarginPct).toBe(0);
    expect(out.consolidated.grossRevenue).toBe(0);
    expect(out.consolidated.netMarginPct).toBe(0);
  });
});

describe("accrualDraft", () => {
  it("drafts one rebate accrual per market and a notification-ready summary", async () => {
    const out = (await accrualDraft(
      {
        perMarket: [
          { market: "US", grossRevenue: 1000, netRevenue: 900 },
          { market: "DE", grossRevenue: 1000, netRevenue: 800 },
        ],
        consolidated: { grossRevenue: 2000, netRevenue: 1700, netMarginPct: 0.85 },
      },
      sig(),
    )) as {
      accrualCount: number;
      accruals: Array<{ market: string; rebateAccrual: number }>;
      totalAccrual: number;
      channel: string;
      message: string;
    };
    expect(out.accrualCount).toBe(2);
    expect(out.accruals.find((a) => a.market === "US")!.rebateAccrual).toBe(100);
    expect(out.accruals.find((a) => a.market === "DE")!.rebateAccrual).toBe(200);
    expect(out.totalAccrual).toBe(300);
    expect(out.channel).toBe("#finance");
    expect(out.message).toContain("85.0%");
    expect(out.message).toContain("300.00");
  });

  it("defaults missing inputs to zero accruals", async () => {
    const out = (await accrualDraft({}, sig())) as {
      accrualCount: number;
      totalAccrual: number;
      message: string;
    };
    expect(out.accrualCount).toBe(0);
    expect(out.totalAccrual).toBe(0);
    // netMarginPct defaults to 0 when consolidated is absent.
    expect(out.message).toContain("0.0%");
  });
});

describe("excursionIngest", () => {
  it("throws without paths and without DEMO_DATA_DIR", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    delete process.env.DEMO_DATA_DIR;
    try {
      await expect(excursionIngest({}, sig())).rejects.toThrow(
        /excursionsPath, limitsPath and readingsPath/,
      );
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
    }
  });

  it("resolves all three fixtures as siblings of DEMO_DATA_DIR and joins the incident to limits", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    process.env.DEMO_DATA_DIR = join(dir, "demo-data");
    try {
      const out = (await excursionIngest({}, sig())) as {
        incident: { lot: string; product: string; shipment: string; units: number; valueUsd: number };
        limitC: number | null;
        maxExcursionMinutes: number | null;
        intervalMinutes: number;
        readings: Array<{ minute: number; tempC: number }>;
      };
      // The single incident row, joined to the VaxFlu Quad validated limits.
      expect(out.incident).toEqual({
        lot: "LOT-5002",
        product: "VaxFlu Quad vaccine",
        shipment: "VAX-2026-114",
        units: 9800,
        valueUsd: 235200,
      });
      expect(out.limitC).toBe(8);
      expect(out.maxExcursionMinutes).toBe(120);
      // Interval inferred from the first two readings.
      expect(out.intervalMinutes).toBe(30);
      expect(out.readings).toHaveLength(13);
      expect(out.readings[0]).toEqual({ minute: 0, tempC: 4 });
      expect(out.readings[6]).toEqual({ minute: 180, tempC: 15 });
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
      else delete process.env.DEMO_DATA_DIR;
    }
  });

  it("reads explicitly supplied paths and builds the incident, limitC and readings", async () => {
    // The paths live under dir; DEMO_DATA_DIR's parent (dir) is the read root.
    const saved = process.env.DEMO_DATA_DIR;
    process.env.DEMO_DATA_DIR = join(dir, "demo-data");
    try {
      const out = (await excursionIngest(
        {
          excursionsPath: join(dir, "cold-chain-disposition", "excursions.csv"),
          limitsPath: join(dir, "cold-chain-disposition", "stability_limits.csv"),
          readingsPath: join(dir, "cold-chain-disposition", "readings.csv"),
        },
        sig(),
      )) as {
        incident: { lot: string; units: number };
        limitC: number | null;
        maxExcursionMinutes: number | null;
        readings: Array<{ minute: number; tempC: number }>;
      };
      expect(out.incident.lot).toBe("LOT-5002");
      expect(out.incident.units).toBe(9800);
      expect(out.limitC).toBe(8);
      expect(out.maxExcursionMinutes).toBe(120);
      expect(out.readings).toHaveLength(13);
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
      else delete process.env.DEMO_DATA_DIR;
    }
  });

  it("carries null limits for a product with no validated stability profile", async () => {
    const saved = process.env.DEMO_DATA_DIR;
    process.env.DEMO_DATA_DIR = join(dir, "demo-data");
    const orphanLimits = join(dir, "cold-chain-disposition", "stability_limits_orphan.csv");
    writeFileSync(orphanLimits, "product,max_temp_c,max_excursion_minutes\nOtherProduct,5,60\n");
    try {
      const out = (await excursionIngest(
        {
          excursionsPath: join(dir, "cold-chain-disposition", "excursions.csv"),
          // A limits file that omits VaxFlu Quad vaccine: the incident product is unknown.
          limitsPath: orphanLimits,
          readingsPath: join(dir, "cold-chain-disposition", "readings.csv"),
        },
        sig(),
      )) as { limitC: number | null; maxExcursionMinutes: number | null };
      // No validated profile — limits propagate as null, never defaulted.
      expect(out.limitC).toBeNull();
      expect(out.maxExcursionMinutes).toBeNull();
    } finally {
      if (saved !== undefined) process.env.DEMO_DATA_DIR = saved;
      else delete process.env.DEMO_DATA_DIR;
    }
  });
});

describe("stabilityAssess", () => {
  // The seeded VaxFlu Quad series: peak 15°C, 6 readings >= 8°C => 180 min over.
  const SEEDED = {
    incident: {
      lot: "LOT-5002",
      product: "VaxFlu Quad vaccine",
      shipment: "VAX-2026-114",
      units: 9800,
      valueUsd: 235200,
    },
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
  };

  it("classifies the seeded series as beyond / destroy and builds the incident report", async () => {
    const out = (await stabilityAssess(SEEDED, sig())) as {
      peakTempC: number;
      minutesOverLimit: number;
      classification: string;
      recommendedDisposition: string;
      holdList: string[];
      report: { title: string; ref: string; body: string[]; footnotes: string[] };
    };
    expect(out.peakTempC).toBe(15);
    // 6 readings at or above 8°C * 30-min interval = 180 minutes over limit.
    expect(out.minutesOverLimit).toBe(180);
    expect(out.classification).toBe("beyond");
    expect(out.recommendedDisposition).toBe("destroy");
    expect(out.holdList).toEqual(["LOT-5002"]);

    expect(out.report.title).toBe("Cold-Chain Incident Report");
    expect(out.report.ref).toBe("CCIR-2026-0613");
    // Exactly three body paragraphs and three footnotes, built dynamically.
    expect(out.report.body).toHaveLength(3);
    expect(out.report.footnotes).toHaveLength(3);
    // [1] in para 1, [2] and [3] in para 2, no citation in para 3.
    expect(out.report.body[0]).toContain("[1]");
    expect(out.report.body[0]).toContain("peak of 15.0 °C against the labelled 8 °C limit");
    expect(out.report.body[0]).toContain("180 minutes");
    expect(out.report.body[1]).toContain("[2]");
    expect(out.report.body[1]).toContain("[3]");
    expect(out.report.body[1]).toContain("180 minutes");
    expect(out.report.body[1]).toContain("120-minute");
    expect(out.report.body[1]).toContain("recommended for destruction");
    expect(out.report.body[2]).not.toContain("[");
    expect(out.report.body[2]).toContain("21 CFR 211.22");
    expect(out.report.footnotes[1]).toContain("VaxFlu Quad vaccine");
  });

  it("classifies within / release when the peak never reaches the limit", async () => {
    const out = (await stabilityAssess(
      {
        ...SEEDED,
        // A clean trace: every reading below the 8°C limit.
        readings: [
          { minute: 0, tempC: 4 },
          { minute: 30, tempC: 5 },
          { minute: 60, tempC: 7 },
          { minute: 90, tempC: 6 },
        ],
      },
      sig(),
    )) as {
      peakTempC: number;
      minutesOverLimit: number;
      classification: string;
      recommendedDisposition: string;
      report: { body: string[] };
    };
    expect(out.peakTempC).toBe(7);
    expect(out.minutesOverLimit).toBe(0);
    expect(out.classification).toBe("within");
    expect(out.recommendedDisposition).toBe("release");
    expect(out.report.body[1]).toContain("recommended for release");
  });

  it("classifies borderline / escalate when over the limit but within the allowance", async () => {
    const out = (await stabilityAssess(
      {
        ...SEEDED,
        // Peak 9°C > 8°C limit, but only 2 readings >= 8 => 60 min < 120 allowance.
        readings: [
          { minute: 0, tempC: 4 },
          { minute: 30, tempC: 9 },
          { minute: 60, tempC: 8 },
          { minute: 90, tempC: 5 },
        ],
      },
      sig(),
    )) as {
      peakTempC: number;
      minutesOverLimit: number;
      classification: string;
      recommendedDisposition: string;
      report: { body: string[] };
    };
    expect(out.peakTempC).toBe(9);
    expect(out.minutesOverLimit).toBe(60);
    expect(out.classification).toBe("borderline");
    expect(out.recommendedDisposition).toBe("escalate");
    expect(out.report.body[1]).toContain("escalation to the quality unit");
  });

  it("treats a null limit as borderline / escalate (fail safe)", async () => {
    const out = (await stabilityAssess(
      { ...SEEDED, limitC: null, maxExcursionMinutes: null },
      sig(),
    )) as {
      peakTempC: number;
      minutesOverLimit: number;
      classification: string;
      recommendedDisposition: string;
      report: { body: string[] };
    };
    // No limit to count against — nothing is over.
    expect(out.minutesOverLimit).toBe(0);
    expect(out.classification).toBe("borderline");
    expect(out.recommendedDisposition).toBe("escalate");
    // The report still has three paragraphs and three footnotes.
    expect(out.report.body).toHaveLength(3);
  });

  it("defaults empty input gracefully (no readings => peak 0)", async () => {
    const out = (await stabilityAssess({}, sig())) as {
      peakTempC: number;
      minutesOverLimit: number;
      classification: string;
      holdList: string[];
      report: { body: string[]; footnotes: string[] };
    };
    expect(out.peakTempC).toBe(0);
    expect(out.minutesOverLimit).toBe(0);
    // No limit known => fail-safe borderline.
    expect(out.classification).toBe("borderline");
    expect(out.holdList).toEqual([]);
    expect(out.report.body).toHaveLength(3);
    expect(out.report.footnotes).toHaveLength(3);
  });
});

describe("quarantine", () => {
  it("forwards the assessment and marks the incident held (the safe direction)", async () => {
    const assessment = {
      incident: { lot: "LOT-5002", product: "VaxFlu Quad vaccine", units: 9800, valueUsd: 235200 },
      limitC: 8,
      classification: "beyond",
      recommendedDisposition: "destroy",
      report: { title: "Cold-Chain Incident Report" },
    };
    const out = (await quarantine(assessment, sig())) as {
      held: boolean;
      heldUnits: number;
      holdList: string[];
      classification: string;
      recommendedDisposition: string;
      report: { title: string };
    };
    expect(out.held).toBe(true);
    expect(out.heldUnits).toBe(9800);
    expect(out.holdList).toEqual(["LOT-5002"]);
    // The full assessment is carried forward to the gated disposition step.
    expect(out.classification).toBe("beyond");
    expect(out.recommendedDisposition).toBe("destroy");
    expect(out.report.title).toBe("Cold-Chain Incident Report");
  });

  it("defaults empty input to nothing held", async () => {
    expect(await quarantine({}, sig())).toMatchObject({
      held: true,
      heldUnits: 0,
      holdList: [],
    });
  });
});

describe("dispositionAct", () => {
  it("destroys the single incident lot when the recommendation is destroy", async () => {
    const out = (await dispositionAct(
      {
        incident: { lot: "LOT-5002", units: 9800, valueUsd: 235200 },
        recommendedDisposition: "destroy",
      },
      sig(),
    )) as {
      releasedCount: number;
      destroyedCount: number;
      heldForJudgmentCount: number;
      releasedValue: number;
      destroyedValue: number;
      destroyed: Array<{ lotId: string; units: number; valueUsd: number }>;
      channel: string;
      message: string;
    };
    expect(out.releasedCount).toBe(0);
    expect(out.destroyedCount).toBe(1);
    expect(out.heldForJudgmentCount).toBe(0);
    expect(out.destroyedValue).toBe(235200);
    expect(out.destroyed[0]).toEqual({ lotId: "LOT-5002", units: 9800, valueUsd: 235200 });
    expect(out.channel).toBe("#cold-chain");
    expect(out.message).toContain("1 destroyed");
  });

  it("releases the single incident lot when the recommendation is release", async () => {
    const out = (await dispositionAct(
      {
        incident: { lot: "LOT-5002", units: 9800, valueUsd: 235200 },
        recommendedDisposition: "release",
      },
      sig(),
    )) as {
      releasedCount: number;
      destroyedCount: number;
      releasedValue: number;
      released: Array<{ lotId: string }>;
      message: string;
    };
    expect(out.releasedCount).toBe(1);
    expect(out.destroyedCount).toBe(0);
    expect(out.releasedValue).toBe(235200);
    expect(out.released[0]!.lotId).toBe("LOT-5002");
    expect(out.message).toContain("1 lot(s) released");
  });

  it("holds the incident for judgment on an escalate recommendation (default)", async () => {
    const out = (await dispositionAct(
      { incident: { lot: "LOT-5002", units: 9800, valueUsd: 235200 } },
      sig(),
    )) as {
      releasedCount: number;
      destroyedCount: number;
      heldForJudgmentCount: number;
      heldForJudgment: Array<{ lotId: string }>;
    };
    expect(out.releasedCount).toBe(0);
    expect(out.destroyedCount).toBe(0);
    expect(out.heldForJudgmentCount).toBe(1);
    expect(out.heldForJudgment[0]!.lotId).toBe("LOT-5002");
  });

  it("defaults missing incident to a zero-value held disposition", async () => {
    expect(await dispositionAct({}, sig())).toMatchObject({
      releasedCount: 0,
      destroyedCount: 0,
      heldForJudgmentCount: 1,
    });
  });
});

describe("SequentialInvokerExecutor", () => {
  it("refuses to start on an already-aborted signal", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const executor = new SequentialInvokerExecutor(
      {
        invoke: async () => ({ skill: {} as never, output: {} }),
      } as never,
      // The abort check fires before any limit lookup ever touches the pool.
      {} as never,
    );
    await expect(
      executor.execute({
        step: { key: "s", agent: "a", skills: ["x@1"] },
        input: {},
        signal: aborted.signal,
        meta: {
          runId: "r",
          stepRunId: "s",
          agentId: "a",
          agentName: "a",
          roleId: "r",
          modelConfig: {},
        },
      }),
    ).rejects.toThrow(/aborted/);
  });
});
