import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { Json, LocalSkillFn } from "../engine/executor.js";

/**
 * Confines a demo-skill file read to the bundled demo data tree. Demo skills
 * accept a caller-controlled path (statementPath, alertsPath, ...) so an
 * untrusted flow run input could otherwise read any file the server can reach
 * (e.g. the audit signing key). The allowed root is the PARENT of
 * DEMO_DATA_DIR: skills read sibling example directories via
 * join(dataDir, "..", ...), so all legitimate reads resolve within that parent.
 *
 * If DEMO_DATA_DIR is unset there is no demo data tree to read, so any read is
 * rejected: the demo skills only ever read the bundled sample data.
 */
function assertWithinDemoRoot(p: string): string {
  const dataDir = process.env.DEMO_DATA_DIR;
  if (!dataDir) {
    throw new Error("demo skills read only bundled sample data; set DEMO_DATA_DIR");
  }
  const root = resolve(dataDir, "..");
  const full = resolve(root, p);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error("demo data path escapes the demo data directory");
  }
  return full;
}

interface StatementRow {
  txn_id: string;
  date: string;
  description: string;
  amount: number;
}

interface LedgerRow {
  entry_id: string;
  txn_ref: string;
  date: string;
  description: string;
  amount: number;
}

function parseCsv(text: string): Record<string, string>[] {
  const [header, ...lines] = text.trim().split("\n");
  const cols = header!.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

/** Reads the bank statement and ledger CSVs from disk. */
export const csvIngest: LocalSkillFn = async (input) => {
  // DEMO_DATA_DIR lets the seeded flow run with an empty trigger body
  // (docker compose sets it to the bundled examples directory).
  const dataDir = process.env.DEMO_DATA_DIR;
  const statementPath = String(
    input.statementPath ?? (dataDir ? join(dataDir, "bank_statement.csv") : ""),
  );
  const ledgerPath = String(input.ledgerPath ?? (dataDir ? join(dataDir, "ledger.csv") : ""));
  if (!statementPath || !ledgerPath) {
    throw new Error("csv-ingest requires statementPath and ledgerPath (or DEMO_DATA_DIR)");
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is caller-controlled but confined to the bundled demo data tree by assertWithinDemoRoot (path-traversal guard).
  const statement = parseCsv(await readFile(assertWithinDemoRoot(statementPath), "utf8")).map(
    (r) => ({
      txn_id: r.txn_id!,
      date: r.date!,
      description: r.description!,
      amount: Number(r.amount),
    }),
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is caller-controlled but confined to the bundled demo data tree by assertWithinDemoRoot (path-traversal guard).
  const ledger = parseCsv(await readFile(assertWithinDemoRoot(ledgerPath), "utf8")).map((r) => ({
    entry_id: r.entry_id!,
    txn_ref: r.txn_ref!,
    date: r.date!,
    description: r.description!,
    amount: Number(r.amount),
  }));
  return { statement, ledger } as unknown as Json;
};

/** Matches statement transactions against ledger entries; flags exceptions. */
export const txnMatch: LocalSkillFn = async (input) => {
  const statement = (input.statement ?? []) as StatementRow[];
  const ledger = (input.ledger ?? []) as LedgerRow[];
  const ledgerByRef = new Map(ledger.map((l) => [l.txn_ref, l]));
  const matchedStatementIds = new Set<string>();

  const matched: Json[] = [];
  const exceptions: Json[] = [];

  for (const txn of statement) {
    const entry = ledgerByRef.get(txn.txn_id);
    if (!entry) {
      exceptions.push({
        type: "missing_in_ledger",
        txnId: txn.txn_id,
        description: txn.description,
        amount: txn.amount,
        detail: "statement transaction has no ledger entry",
      });
      continue;
    }
    matchedStatementIds.add(txn.txn_id);
    if (entry.amount !== txn.amount) {
      exceptions.push({
        type: "amount_mismatch",
        txnId: txn.txn_id,
        description: txn.description,
        statementAmount: txn.amount,
        ledgerAmount: entry.amount,
        difference: Number((txn.amount - entry.amount).toFixed(2)),
        detail: `statement ${txn.amount} != ledger ${entry.amount}`,
      });
    } else {
      matched.push({ txnId: txn.txn_id, amount: txn.amount });
    }
  }
  for (const entry of ledger) {
    if (!matchedStatementIds.has(entry.txn_ref)) {
      exceptions.push({
        type: "missing_in_statement",
        txnRef: entry.txn_ref,
        entryId: entry.entry_id,
        amount: entry.amount,
        detail: "ledger entry has no statement transaction",
      });
    }
  }

  return {
    matchedCount: matched.length,
    exceptionCount: exceptions.length,
    matched,
    exceptions,
  };
};

/** Renders the post-approval reconciliation summary. */
export const reportGen: LocalSkillFn = async (input) => {
  const matchedCount = Number(input.matchedCount ?? 0);
  const exceptions = (input.exceptions ?? []) as Json[];
  const lines = [
    `Daily Cash Reconciliation — ${new Date().toISOString().slice(0, 10)}`,
    `Matched transactions: ${matchedCount}`,
    `Exceptions: ${exceptions.length}`,
    ...exceptions.map(
      (e, i) => `  ${i + 1}. [${String(e.type)}] ${String(e.detail)}`,
    ),
    exceptions.length
      ? "Exception list reviewed and approved at the human gate."
      : "Clean reconciliation; no exceptions.",
  ];
  const report = lines.join("\n");
  return {
    report,
    matchedCount,
    exceptionCount: exceptions.length,
    exceptions,
    // Notification-ready fields so notify@1 can run directly downstream.
    channel: "#recon",
    message: `Daily cash reconciliation complete: ${matchedCount} matched, ${exceptions.length} exception(s) reviewed and approved.`,
  };
};

/** Used by the seeded self-approval demo flow (blocked by SoD). */
export const approveRecon: LocalSkillFn = async (input) => ({
  approved: true,
  ...input,
});

interface AlertRow {
  alert_id: string;
  customer: string;
  type: string;
  amount: number;
  risk_score: number;
}

/** Reads the day's AML alerts CSV from disk. */
export const alertIngest: LocalSkillFn = async (input) => {
  // Mirrors csv-ingest: an explicit path wins; under docker compose the AML
  // fixture is a sibling of DEMO_DATA_DIR inside the bundled examples dir.
  const dataDir = process.env.DEMO_DATA_DIR;
  const alertsPath = String(
    input.alertsPath ?? (dataDir ? join(dataDir, "..", "aml-alert-triage", "alerts.csv") : ""),
  );
  if (!alertsPath) {
    throw new Error("alert-ingest requires alertsPath (or DEMO_DATA_DIR)");
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is caller-controlled but confined to the bundled demo data tree by assertWithinDemoRoot (path-traversal guard).
  const alerts = parseCsv(await readFile(assertWithinDemoRoot(alertsPath), "utf8")).map((r) => ({
    alert_id: r.alert_id!,
    customer: r.customer!,
    type: r.type!,
    amount: Number(r.amount),
    risk_score: Number(r.risk_score),
  }));
  return { alerts };
};

/** Rule-based triage: risk_score >= 80 or a sanctions near-match escalates. */
export const alertTriage: LocalSkillFn = async (input) => {
  const alerts = (input.alerts ?? []) as AlertRow[];
  const escalations: Json[] = [];
  const cleared: Json[] = [];

  for (const alert of alerts) {
    const reasons: string[] = [];
    if (alert.type === "sanctions_near_match") {
      reasons.push("sanctions near-match requires officer disposition");
    }
    if (alert.risk_score >= 80) {
      reasons.push(`risk score ${alert.risk_score} >= 80`);
    }
    if (reasons.length > 0) {
      escalations.push({
        alertId: alert.alert_id,
        customer: alert.customer,
        type: alert.type,
        amount: alert.amount,
        riskScore: alert.risk_score,
        rationale: reasons.join("; "),
      });
    } else {
      cleared.push({
        alertId: alert.alert_id,
        rationale: `risk score ${alert.risk_score} below 80 and no mandatory-escalation type`,
      });
    }
  }

  return {
    alertCount: alerts.length,
    escalatedCount: escalations.length,
    escalations,
    cleared,
  };
};

/** Drafts a SAR narrative per escalated alert (runs only after the gate). */
export const sarDraft: LocalSkillFn = async (input) => {
  const escalations = (input.escalations ?? []) as Array<{
    alertId: string;
    customer: string;
    type: string;
    amount: number;
    riskScore: number;
    rationale: string;
  }>;
  const narratives = escalations.map((e) => ({
    alertId: e.alertId,
    customer: e.customer,
    narrative:
      `SAR draft for ${e.alertId} (${e.customer}): ${e.type} alert, amount ` +
      `${e.amount.toFixed(2)}, risk score ${e.riskScore}. Escalation rationale: ` +
      `${e.rationale}. Disposition approved at the SAR filing decision gate.`,
  }));
  return {
    sarCount: narratives.length,
    narratives,
    // Notification-ready fields so notify@1 can run directly downstream.
    channel: "#aml",
    message: `AML alert triage complete: ${narratives.length} SAR narrative(s) drafted for officer-approved escalations.`,
  };
};

interface ComplaintRow {
  complaint_id: string;
  device: string;
  event_type: string;
  patient_harm: string;
  recurrence_risk: string;
  description: string;
  received_date: string;
}

/** Reads the day's device-complaint queue CSV from disk. */
export const complaintIngest: LocalSkillFn = async (input) => {
  // Mirrors alert-ingest: an explicit path wins; under docker compose the MDR
  // fixture is a sibling of DEMO_DATA_DIR inside the bundled examples dir.
  const dataDir = process.env.DEMO_DATA_DIR;
  const complaintsPath = String(
    input.complaintsPath ??
      (dataDir ? join(dataDir, "..", "mdr-reportability-triage", "complaints.csv") : ""),
  );
  if (!complaintsPath) {
    throw new Error("complaint-ingest requires complaintsPath (or DEMO_DATA_DIR)");
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is caller-controlled but confined to the bundled demo data tree by assertWithinDemoRoot (path-traversal guard).
  const complaints = parseCsv(await readFile(assertWithinDemoRoot(complaintsPath), "utf8")).map(
    (r) => ({
      complaint_id: r.complaint_id!,
      device: r.device!,
      event_type: r.event_type!,
      patient_harm: r.patient_harm!,
      recurrence_risk: r.recurrence_risk!,
      description: r.description!,
      received_date: r.received_date!,
    }),
  );
  return { complaints };
};

/**
 * Rule-based reportability triage: death or serious injury escalates onto the
 * 30-day MDR clock (21 CFR 803.50); a malfunction with high recurrence risk
 * escalates as malfunction-reportable. The agent only PROPOSES — the
 * reportability determination belongs to the regulatory officer at the gate.
 */
export const reportabilityTriage: LocalSkillFn = async (input) => {
  const complaints = (input.complaints ?? []) as ComplaintRow[];
  const escalations: Json[] = [];
  const cleared: Json[] = [];

  for (const c of complaints) {
    const base = {
      complaintId: c.complaint_id,
      device: c.device,
      eventType: c.event_type,
      patientHarm: c.patient_harm,
      recurrenceRisk: c.recurrence_risk,
      receivedDate: c.received_date,
    };
    if (c.event_type === "death" || c.event_type === "serious_injury") {
      escalations.push({
        ...base,
        clock: "30-day MDR (21 CFR 803.50)",
        rationale:
          `${c.event_type === "death" ? "death" : "serious injury"} ` +
          `(patient harm: ${c.patient_harm}) — reportable event; the 30-calendar-day ` +
          `MDR clock under 21 CFR 803.50 runs from awareness (${c.received_date})`,
      });
    } else if (c.event_type === "malfunction" && c.recurrence_risk === "high") {
      escalations.push({
        ...base,
        clock: "30-day malfunction MDR (21 CFR 803.50)",
        rationale:
          "malfunction with high recurrence risk — would be likely to cause or " +
          "contribute to a death or serious injury if it recurred; malfunction " +
          `reportable under 21 CFR 803.50 from awareness (${c.received_date})`,
      });
    } else {
      cleared.push({
        complaintId: c.complaint_id,
        rationale:
          `event type "${c.event_type}" with patient harm "${c.patient_harm}" — ` +
          "not MDR-reportable; designated-unit review recorded",
      });
    }
  }

  return {
    complaintCount: complaints.length,
    escalatedCount: escalations.length,
    escalations,
    cleared,
  };
};

/** Drafts an MDR report skeleton per escalated complaint (post-gate only). */
export const mdrDraft: LocalSkillFn = async (input) => {
  const escalations = (input.escalations ?? []) as Array<{
    complaintId: string;
    device: string;
    eventType: string;
    clock: string;
    rationale: string;
  }>;
  const drafts = escalations.map((e) => ({
    complaintId: e.complaintId,
    device: e.device,
    draft:
      `MDR draft for ${e.complaintId} (${e.device}): ${e.eventType}. Escalation ` +
      `rationale: ${e.rationale}. Clock: ${e.clock}. Reportability decided by the ` +
      "regulatory officer at the reportability_decision gate.",
  }));
  return {
    mdrCount: drafts.length,
    drafts,
    // Notification-ready fields so notify@1 can run directly downstream.
    channel: "#mdr",
    message: `MDR reportability triage complete: ${drafts.length} MDR draft(s) prepared for officer-decided reportable complaints.`,
  };
};

interface IcsrRow {
  case_id: string;
  drug: string;
  event: string;
  seriousness: string;
  expectedness: string;
  country: string;
  received_date: string;
}

/** Reads the day's ICSR adverse-event case queue CSV from disk. */
export const caseIntake: LocalSkillFn = async (input) => {
  // Mirrors alert-ingest: an explicit path wins; under docker compose the PV
  // fixture is a sibling of DEMO_DATA_DIR inside the bundled examples dir.
  const dataDir = process.env.DEMO_DATA_DIR;
  const casesPath = String(
    input.casesPath ?? (dataDir ? join(dataDir, "..", "pv-icsr-processing", "icsr_cases.csv") : ""),
  );
  if (!casesPath) {
    throw new Error("case-intake requires casesPath (or DEMO_DATA_DIR)");
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is caller-controlled but confined to the bundled demo data tree by assertWithinDemoRoot (path-traversal guard).
  const cases = parseCsv(await readFile(assertWithinDemoRoot(casesPath), "utf8")).map((r) => ({
    case_id: r.case_id!,
    drug: r.drug!,
    event: r.event!,
    seriousness: r.seriousness!,
    expectedness: r.expectedness!,
    country: r.country!,
    received_date: r.received_date!,
  }));
  return { cases };
};

/**
 * Rule-based seriousness/expectedness triage: serious AND unexpected goes onto
 * the 15-day expedited clock (21 CFR 314.80) regardless of source country;
 * everything else routes to periodic reporting. The agent only PROPOSES — the
 * medical reviewer confirms seriousness and expectedness at the gate.
 */
export const seriousnessTriage: LocalSkillFn = async (input) => {
  const cases = (input.cases ?? []) as IcsrRow[];
  const expedited: Json[] = [];
  const periodic: Json[] = [];

  for (const c of cases) {
    if (c.seriousness === "serious" && c.expectedness === "unexpected") {
      expedited.push({
        caseId: c.case_id,
        drug: c.drug,
        event: c.event,
        seriousness: c.seriousness,
        expectedness: c.expectedness,
        country: c.country,
        receivedDate: c.received_date,
        clock: "15-day expedited (21 CFR 314.80)",
        rationale:
          `serious and unexpected — 15-day expedited report ("Alert report") under ` +
          `21 CFR 314.80, regardless of source (received from ${c.country} on ` +
          `${c.received_date})`,
      });
    } else {
      periodic.push({
        caseId: c.case_id,
        rationale:
          `seriousness "${c.seriousness}", expectedness "${c.expectedness}" — does ` +
          "not meet the serious-and-unexpected test of 21 CFR 314.80; route to " +
          "periodic reporting",
      });
    }
  }

  return {
    caseCount: cases.length,
    expeditedCount: expedited.length,
    expedited,
    periodic,
  };
};

/** Drafts an ICSR narrative per expedited case (runs only after the gate). */
export const narrativeDraft: LocalSkillFn = async (input) => {
  const expedited = (input.expedited ?? []) as Array<{
    caseId: string;
    drug: string;
    event: string;
    country: string;
    clock: string;
    rationale: string;
  }>;
  const narratives = expedited.map((c) => ({
    caseId: c.caseId,
    drug: c.drug,
    narrative:
      `ICSR narrative for ${c.caseId} (${c.drug}): ${c.event}, source ${c.country}. ` +
      `Triage rationale: ${c.rationale}. Clock: ${c.clock}. Seriousness and ` +
      "expectedness confirmed by the medical reviewer at the medical_review gate; " +
      "transmit in E2B(R3) format.",
  }));
  return {
    icsrCount: narratives.length,
    narratives,
    // Notification-ready fields so notify@1 can run directly downstream.
    channel: "#pv",
    message: `ICSR processing complete: ${narratives.length} expedited narrative(s) drafted for medical-reviewer-confirmed cases.`,
  };
};

interface ErpPricingRow {
  market: string;
  sku: string;
  product: string;
  list_price: number;
  statutory_rebate_pct: number;
  austerity_discount_pct: number;
  clawback_pct: number;
  units: number;
}

/** Reads the day's ERP pricing export CSV from disk. */
export const erpExtract: LocalSkillFn = async (input) => {
  // Mirrors alert-ingest: an explicit path wins; under docker compose the
  // gross-to-net fixture is a sibling of DEMO_DATA_DIR in the examples dir.
  const dataDir = process.env.DEMO_DATA_DIR;
  const pricingPath = String(
    input.pricingPath ??
      (dataDir ? join(dataDir, "..", "gross-to-net-margin", "erp_pricing.csv") : ""),
  );
  if (!pricingPath) {
    throw new Error("erp-extract requires pricingPath (or DEMO_DATA_DIR)");
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is caller-controlled but confined to the bundled demo data tree by assertWithinDemoRoot (path-traversal guard).
  const rows = parseCsv(await readFile(assertWithinDemoRoot(pricingPath), "utf8")).map((r) => ({
    market: r.market!,
    sku: r.sku!,
    product: r.product!,
    list_price: Number(r.list_price),
    statutory_rebate_pct: Number(r.statutory_rebate_pct),
    austerity_discount_pct: Number(r.austerity_discount_pct),
    clawback_pct: Number(r.clawback_pct),
    units: Number(r.units),
  }));
  return { rows };
};

const round2 = (n: number): number => Number(n.toFixed(2));
const round4 = (n: number): number => Number(n.toFixed(4));

/**
 * Builds the gross-to-net waterfall per ERP row: net price after the
 * statutory rebate, austerity discount, and clawback cascade, plus the net
 * margin versus list. Aggregates a per-market summary and a single
 * consolidated comparable view (units-weighted average net margin). FLAGS any
 * row whose total deduction reaches or exceeds 100% of list — or whose net is
 * non-positive — as a data_integrity_exception with a rationale: an impossible
 * net is precisely the wrong number the org would otherwise post to the
 * financials. The agent only ASSEMBLES — the controller certifies at the gate.
 */
export const gtnWaterfall: LocalSkillFn = async (input) => {
  const rows = (input.rows ?? []) as ErpPricingRow[];
  const clean: Json[] = [];
  const exceptions: Json[] = [];
  const byMarket = new Map<
    string,
    { market: string; skuCount: number; grossRevenue: number; netRevenue: number }
  >();

  for (const r of rows) {
    const totalDeductionPct = round4(
      r.statutory_rebate_pct + r.austerity_discount_pct + r.clawback_pct,
    );
    const net = round2(r.list_price * (1 - totalDeductionPct));

    if (totalDeductionPct >= 1.0 || net <= 0) {
      exceptions.push({
        market: r.market,
        sku: r.sku,
        product: r.product,
        listPrice: r.list_price,
        statutoryRebatePct: r.statutory_rebate_pct,
        austerityDiscountPct: r.austerity_discount_pct,
        clawbackPct: r.clawback_pct,
        totalDeductionPct,
        netPrice: net,
        type: "data_integrity_exception",
        rationale:
          `total deductions ${(totalDeductionPct * 100).toFixed(1)}% of list ` +
          `(statutory ${(r.statutory_rebate_pct * 100).toFixed(1)}% + austerity ` +
          `${(r.austerity_discount_pct * 100).toFixed(1)}% + clawback ` +
          `${(r.clawback_pct * 100).toFixed(1)}%) yield an impossible net of ` +
          `${net.toFixed(2)} for ${r.market}/${r.sku} — exceeds 100% of list, a ` +
          "likely double-counted austerity discount; excluded from the comparable " +
          "view pending source correction",
      });
      continue;
    }

    // A clean row has net > 0, which implies list_price > 0 — division is safe.
    const netMarginPct = round4(net / r.list_price);
    const grossRevenue = round2(r.list_price * r.units);
    const netRevenue = round2(net * r.units);
    clean.push({
      market: r.market,
      sku: r.sku,
      product: r.product,
      listPrice: r.list_price,
      statutoryRebatePct: r.statutory_rebate_pct,
      austerityDiscountPct: r.austerity_discount_pct,
      clawbackPct: r.clawback_pct,
      totalDeductionPct,
      netPrice: net,
      netMarginPct,
      units: r.units,
      grossRevenue,
      netRevenue,
    });

    const m = byMarket.get(r.market) ?? {
      market: r.market,
      skuCount: 0,
      grossRevenue: 0,
      netRevenue: 0,
    };
    m.skuCount += 1;
    m.grossRevenue = round2(m.grossRevenue + grossRevenue);
    m.netRevenue = round2(m.netRevenue + netRevenue);
    byMarket.set(r.market, m);
  }

  const perMarket = [...byMarket.values()]
    .sort((a, b) => a.market.localeCompare(b.market))
    .map((m) => ({
      ...m,
      // Units-weighted net margin makes markets comparable despite different
      // list prices and a different deduction cascade in each.
      netMarginPct: round4(m.grossRevenue === 0 ? 0 : m.netRevenue / m.grossRevenue),
    }));

  const grossRevenue = round2(perMarket.reduce((s, m) => s + m.grossRevenue, 0));
  const netRevenue = round2(perMarket.reduce((s, m) => s + m.netRevenue, 0));
  const consolidated = {
    markets: perMarket.length,
    cleanSkuCount: clean.length,
    grossRevenue,
    netRevenue,
    netMarginPct: round4(grossRevenue === 0 ? 0 : netRevenue / grossRevenue),
  };

  return {
    rowCount: rows.length,
    cleanCount: clean.length,
    exceptionCount: exceptions.length,
    rows: clean,
    exceptions,
    perMarket,
    consolidated,
  };
};

/** Drafts the rebate-accrual summary for the certified figures (post-gate). */
export const accrualDraft: LocalSkillFn = async (input) => {
  const perMarket = (input.perMarket ?? []) as Array<{
    market: string;
    grossRevenue: number;
    netRevenue: number;
  }>;
  const consolidated = (input.consolidated ?? {}) as {
    grossRevenue?: number;
    netRevenue?: number;
    netMarginPct?: number;
  };
  const accruals = perMarket.map((m) => ({
    market: m.market,
    // The rebate accrual is the gross-to-net bridge: what must be set aside
    // because list revenue will never be collected.
    rebateAccrual: round2(m.grossRevenue - m.netRevenue),
    grossRevenue: m.grossRevenue,
    netRevenue: m.netRevenue,
  }));
  const totalAccrual = round2(accruals.reduce((s, a) => s + a.rebateAccrual, 0));
  return {
    accrualCount: accruals.length,
    accruals,
    totalAccrual,
    consolidated,
    // Notification-ready fields so notify@1 can run directly downstream.
    channel: "#finance",
    message:
      `Gross-to-net margin certified: consolidated net margin ` +
      `${((consolidated.netMarginPct ?? 0) * 100).toFixed(1)}%, total rebate accrual ` +
      `${totalAccrual.toFixed(2)} across ${accruals.length} market(s).`,
  };
};

interface ExcursionRow {
  lot_id: string;
  product: string;
  shipment: string;
  units: number;
  value_usd: number;
}

interface StabilityLimitRow {
  product: string;
  max_temp_c: number;
  max_excursion_minutes: number;
}

interface JoinedLot extends ExcursionRow {
  limit_c: number | null;
  max_excursion_minutes: number | null;
}

/**
 * Reads the single cold-chain incident row, the validated stability limits, and
 * the datalogger temperature time-series. The incident is joined to the limits
 * for its product; a product with no validated stability profile cannot be
 * assessed against a known ceiling, so limitC/maxExcursionMinutes are carried as
 * null and assessed as borderline downstream (fail safe: unknown stability is
 * never silently releasable).
 */
export const excursionIngest: LocalSkillFn = async (input) => {
  // Mirrors alert-ingest: an explicit path wins; under docker compose the
  // cold-chain fixtures are siblings of DEMO_DATA_DIR in the examples dir.
  const dataDir = process.env.DEMO_DATA_DIR;
  const excursionsPath = String(
    input.excursionsPath ??
      (dataDir ? join(dataDir, "..", "cold-chain-disposition", "excursions.csv") : ""),
  );
  const limitsPath = String(
    input.limitsPath ??
      (dataDir ? join(dataDir, "..", "cold-chain-disposition", "stability_limits.csv") : ""),
  );
  const readingsPath = String(
    input.readingsPath ??
      (dataDir ? join(dataDir, "..", "cold-chain-disposition", "readings.csv") : ""),
  );
  if (!excursionsPath || !limitsPath || !readingsPath) {
    throw new Error(
      "excursion-ingest requires excursionsPath, limitsPath and readingsPath (or DEMO_DATA_DIR)",
    );
  }

  // A single incident row: the affected lot, its product, shipment, and value.
  const excursions: ExcursionRow[] = parseCsv(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is caller-controlled but confined to the bundled demo data tree by assertWithinDemoRoot (path-traversal guard).
    await readFile(assertWithinDemoRoot(excursionsPath), "utf8"),
  ).map((r) => ({
    lot_id: r.lot_id!,
    product: r.product!,
    shipment: r.shipment!,
    units: Number(r.units),
    value_usd: Number(r.value_usd),
  }));
  const limits: StabilityLimitRow[] = parseCsv(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is caller-controlled but confined to the bundled demo data tree by assertWithinDemoRoot (path-traversal guard).
    await readFile(assertWithinDemoRoot(limitsPath), "utf8"),
  ).map((r) => ({
    product: r.product!,
    max_temp_c: Number(r.max_temp_c),
    max_excursion_minutes: Number(r.max_excursion_minutes),
  }));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is caller-controlled but confined to the bundled demo data tree by assertWithinDemoRoot (path-traversal guard).
  const readingRows = parseCsv(await readFile(assertWithinDemoRoot(readingsPath), "utf8")).map(
    (r) => ({
      minute: Number(r.minute),
      tempC: Number(r.temp_c),
    }),
  );

  const incidentRow = excursions[0];
  const limit = incidentRow
    ? limits.find((l) => l.product === incidentRow.product)
    : undefined;

  const joined: JoinedLot = {
    lot_id: incidentRow?.lot_id ?? "",
    product: incidentRow?.product ?? "",
    shipment: incidentRow?.shipment ?? "",
    units: incidentRow?.units ?? 0,
    value_usd: incidentRow?.value_usd ?? 0,
    // A null limit means "no validated profile" — propagated, never defaulted.
    limit_c: limit ? limit.max_temp_c : null,
    max_excursion_minutes: limit ? limit.max_excursion_minutes : null,
  };

  const intervalMinutes =
    readingRows.length >= 2 ? readingRows[1]!.minute - readingRows[0]!.minute : 30;

  return {
    incident: {
      lot: joined.lot_id,
      product: joined.product,
      shipment: joined.shipment,
      units: joined.units,
      valueUsd: joined.value_usd,
    },
    limitC: joined.limit_c,
    maxExcursionMinutes: joined.max_excursion_minutes,
    intervalMinutes,
    readings: readingRows,
  };
};

interface IncidentIn {
  lot?: string;
  product?: string;
  shipment?: string;
  units?: number;
  valueUsd?: number;
}

interface ReadingIn {
  minute: number;
  tempC: number;
}

/**
 * Single-incident stability assessment versus the validated limits.
 *
 *  - beyond / destroy: the datalogger peak exceeds the labelled limit AND the
 *    cumulative time at or above the limit exceeds the validated excursion
 *    allowance — the lot is out of specification.
 *  - within / release: the peak never reaches the labelled limit.
 *  - borderline / escalate: over the limit but inside the validated allowance,
 *    or a product with no validated stability profile (fail safe) — the
 *    human-judgment moment for QA.
 *
 * The agent only RECOMMENDS and builds the incident report. The release-or-
 * destroy decision is a one-way door owned by QA at the disposition_decision
 * gate (21 CFR 211.22). quarantine@1 adds held/heldUnits/holdList afterwards.
 */
export const stabilityAssess: LocalSkillFn = async (input) => {
  const incident = (input.incident ?? {}) as IncidentIn;
  const readings = (input.readings ?? []) as ReadingIn[];
  const limitCRaw = input.limitC;
  const maxExcursionMinutesRaw = input.maxExcursionMinutes;
  const intervalMinutes = Number(input.intervalMinutes ?? 30);

  const hasLimit =
    typeof limitCRaw === "number" &&
    Number.isFinite(limitCRaw) &&
    typeof maxExcursionMinutesRaw === "number" &&
    Number.isFinite(maxExcursionMinutesRaw);
  const limitC = hasLimit ? (limitCRaw as number) : null;
  const maxExcursionMinutes = hasLimit ? (maxExcursionMinutesRaw as number) : null;

  const peakTempC = readings.reduce((max, r) => (r.tempC > max ? r.tempC : max), 0);
  // Time over limit = number of readings at or above the limit * interval. With
  // no validated limit there is nothing to count against, so it is 0.
  const readingsOverLimit =
    limitC === null ? 0 : readings.filter((r) => r.tempC >= limitC).length;
  const minutesOverLimit = readingsOverLimit * intervalMinutes;

  // Classify per the contract.
  let classification: "within" | "beyond" | "borderline";
  let recommendedDisposition: "release" | "destroy" | "escalate";
  if (limitC === null || maxExcursionMinutes === null) {
    classification = "borderline";
    recommendedDisposition = "escalate";
  } else if (peakTempC <= limitC) {
    classification = "within";
    recommendedDisposition = "release";
  } else if (peakTempC > limitC && minutesOverLimit > maxExcursionMinutes) {
    classification = "beyond";
    recommendedDisposition = "destroy";
  } else {
    classification = "borderline";
    recommendedDisposition = "escalate";
  }

  const report = buildIncidentReport({
    incident,
    limitC,
    maxExcursionMinutes,
    peakTempC,
    minutesOverLimit,
    classification,
    recommendedDisposition,
  });

  return {
    incident,
    limitC,
    maxExcursionMinutes,
    intervalMinutes,
    readings,
    peakTempC,
    minutesOverLimit,
    classification,
    recommendedDisposition,
    holdList: incident.lot ? [incident.lot] : [],
    report,
  };
};

const REPORT_REF = "CCIR-2026-0613";

/**
 * Builds the Cold-Chain Incident Report dynamically from the assessed numbers:
 * three body paragraphs (para1 cites [1], para2 cites [2] and [3], para3 carries
 * the 21 CFR 211.22 one-way-door sentence with no citation) and three footnotes.
 * The recommendation clause adapts to the classification.
 */
function buildIncidentReport(args: {
  incident: IncidentIn;
  limitC: number | null;
  maxExcursionMinutes: number | null;
  peakTempC: number;
  minutesOverLimit: number;
  classification: "within" | "beyond" | "borderline";
  recommendedDisposition: "release" | "destroy" | "escalate";
}): Json {
  const { incident, limitC, maxExcursionMinutes, peakTempC, minutesOverLimit, classification } =
    args;
  const product = incident.product ?? "the product";
  const lot = incident.lot ?? "the lot";
  const shipment = incident.shipment ?? "the shipment";
  const units = Number(incident.units ?? 0);
  const unitsStr = units.toLocaleString("en-US");
  const peakStr = peakTempC.toFixed(1);
  const limitStr = limitC === null ? "the labelled" : `the labelled ${limitC} °C`;

  const para1 =
    `A temperature excursion was detected on shipment ${shipment} carrying ${product} ` +
    `(lot ${lot}, ${unitsStr} units). The datalogger recorded a peak of ${peakStr} °C ` +
    `against ${limitStr} limit, with temperature above the limit for ${minutesOverLimit} ` +
    `minutes [1].`;

  // The recommendation clause adapts to the classification.
  let para2: string;
  if (classification === "beyond") {
    para2 =
      `Against the validated stability profile, cumulative time above the limit ` +
      `(${minutesOverLimit} minutes) exceeds the validated ${maxExcursionMinutes}-minute ` +
      `excursion allowance, which bears directly on potency [2]. The lot is beyond ` +
      `validated stability and is recommended for destruction [3].`;
  } else if (classification === "within") {
    para2 =
      `Against the validated stability profile, the peak of ${peakStr} °C stayed within ` +
      `the validated limit and cumulative time above the limit (${minutesOverLimit} minutes) ` +
      `is within the validated ${maxExcursionMinutes}-minute excursion allowance, which bears ` +
      `directly on potency [2]. The lot is within validated stability and is recommended for ` +
      `release [3].`;
  } else {
    const allowanceClause =
      maxExcursionMinutes === null
        ? `no validated excursion allowance exists for this product`
        : `cumulative time above the limit (${minutesOverLimit} minutes) is within the ` +
          `validated ${maxExcursionMinutes}-minute excursion allowance`;
    para2 =
      `Against the validated stability profile, ${allowanceClause}, which bears directly on ` +
      `potency [2]. The lot is at the boundary of validated stability and is recommended for ` +
      `escalation to the quality unit [3].`;
  }

  const para3 =
    "Quarantine has been placed on the lot. Disposition is a one-way door and must be " +
    "decided by the independent quality unit (21 CFR 211.22) — it is not the agent's to make.";

  return {
    title: "Cold-Chain Incident Report",
    ref: REPORT_REF,
    body: [para1, para2, para3],
    footnotes: [
      "Datalogger trace DL-114-2026.csv",
      `Stability Study SR-2024-118 — ${product}`,
      "SOP QA-014 — Excursion Disposition",
    ],
  };
}

/**
 * LOW-risk: marks the incident lot held. Holding is the SAFE direction — the
 * agent may quarantine without a gate, because a held lot is neither released
 * nor destroyed; the costly, irreversible decision is still owned by QA. The
 * asymmetry in one skill: the agent is free to move toward safety. The output
 * is the full contract object, with held/heldUnits/holdList added.
 */
export const quarantine: LocalSkillFn = async (input) => {
  const incident = (input.incident ?? {}) as IncidentIn;
  return {
    ...input,
    held: true,
    heldUnits: incident.units ?? 0,
    holdList: incident.lot ? [incident.lot] : [],
  };
};

/**
 * HIGH-risk: executes the one-way disposition for the single incident — RELEASE
 * a within-spec lot, DESTROY a beyond-spec lot, or leave a borderline lot held
 * for QA judgment — following the recommendation carried out of stability-
 * assess. Because this skill is risk_tier 'high', the flow grammar structurally
 * forces an approval gate before the step that uses it.
 */
export const dispositionAct: LocalSkillFn = async (input) => {
  const incident = (input.incident ?? {}) as IncidentIn;
  const recommendedDisposition = String(input.recommendedDisposition ?? "escalate");

  const lotEntry = {
    lotId: incident.lot ?? "",
    units: Number(incident.units ?? 0),
    valueUsd: Number(incident.valueUsd ?? 0),
  };

  const released: Json[] = [];
  const destroyed: Json[] = [];
  const heldForJudgment: Json[] = [];
  if (recommendedDisposition === "release") {
    released.push(lotEntry);
  } else if (recommendedDisposition === "destroy") {
    destroyed.push(lotEntry);
  } else {
    heldForJudgment.push(lotEntry);
  }

  const releasedValue = round2(released.reduce((s, r) => s + (Number(r.valueUsd) || 0), 0));
  const destroyedValue = round2(destroyed.reduce((s, r) => s + (Number(r.valueUsd) || 0), 0));

  return {
    releasedCount: released.length,
    destroyedCount: destroyed.length,
    heldForJudgmentCount: heldForJudgment.length,
    releasedValue,
    destroyedValue,
    released,
    destroyed,
    heldForJudgment,
    // Notification-ready fields so notify@1 can run directly downstream.
    channel: "#cold-chain",
    message:
      `Cold-chain disposition executed at QA decision: ${released.length} lot(s) released ` +
      `(${releasedValue.toFixed(2)}), ${destroyed.length} destroyed ` +
      `(${destroyedValue.toFixed(2)}), ${heldForJudgment.length} held for QA judgment.`,
  };
};

export function demoLocalRegistry(): Map<string, LocalSkillFn> {
  return new Map<string, LocalSkillFn>([
    ["csv-ingest@1", csvIngest],
    ["txn-match@1", txnMatch],
    ["report-gen@1", reportGen],
    ["approve-recon@1", approveRecon],
    ["alert-ingest@1", alertIngest],
    ["alert-triage@1", alertTriage],
    ["sar-draft@1", sarDraft],
    ["complaint-ingest@1", complaintIngest],
    ["reportability-triage@1", reportabilityTriage],
    ["mdr-draft@1", mdrDraft],
    ["case-intake@1", caseIntake],
    ["seriousness-triage@1", seriousnessTriage],
    ["narrative-draft@1", narrativeDraft],
    ["erp-extract@1", erpExtract],
    ["gtn-waterfall@1", gtnWaterfall],
    ["accrual-draft@1", accrualDraft],
    ["excursion-ingest@1", excursionIngest],
    ["stability-assess@1", stabilityAssess],
    ["quarantine@1", quarantine],
    ["disposition-act@1", dispositionAct],
  ]);
}
