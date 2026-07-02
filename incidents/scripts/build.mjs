/**
 * Regenerates the Agent Incident Database derived artifacts from the entry
 * sources in incidents/entries/*.json:
 *   - incidents/index.json            machine-readable registry
 *   - incidents/README.md             human index with the full table
 *   - incidents/entries/<id>.md       one citable page per incident
 *
 * The JSON entry files are the source of truth; never hand-edit the .md or
 * index.json. Run: node incidents/scripts/build.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES_DIR = join(ROOT, "entries");

const CONTROL_LABEL = {
  skill_not_granted: "Deny-by-default (skill_not_granted)",
  sod_violation: "Segregation of duties (sod_violation)",
  high_risk_requires_gate: "High-risk approval gate (high_risk_requires_gate)",
  limit_violation: "Fail-closed limits (limit_violation)",
  approval_gate: "Named approval gate",
};

const CATEGORY_LABEL = {
  "data-loss": "Data loss",
  "unauthorized-financial-action": "Unauthorized financial action",
  fabrication: "Fabrication",
  "data-exfiltration": "Data exfiltration",
  "wrongful-automated-decision": "Wrongful automated decision",
  "runaway-execution": "Runaway execution",
  "binding-commitment": "Binding commitment",
};

function loadEntries() {
  const files = readdirSync(ENTRIES_DIR).filter((f) => f.endsWith(".json"));
  const entries = files.map((f) => JSON.parse(readFileSync(join(ENTRIES_DIR, f), "utf8")));
  // Stable order: newest year first, then by id.
  entries.sort((a, b) => (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
  return entries;
}

function entryMarkdown(e) {
  const controls = e.controlsThatBlock.map((c) => `- ${CONTROL_LABEL[c] ?? c}`).join("\n");
  const sources = e.sources.length
    ? e.sources.map((s) => `- [${s.title}](${s.url})`).join("\n")
    : "_None recorded._";
  return `# ${e.id} — ${e.title}

> ${e.oneLineSummary}

| | |
|---|---|
| **Incident ID** | \`${e.id}\` |
| **Date** | ${e.incidentDateText} |
| **Category** | ${CATEGORY_LABEL[e.category] ?? e.category} |
| **Severity** | ${e.severity} |
| **Reproducible** | ${e.reproducible ? `yes — [\`${e.reproPath}\`](../../${e.reproPath})` : "no"} |

## What happened

${e.whatHappened}

## The consequential action

${e.agentAction}

## Irreversible effect

${e.irreversibleEffect}

## Why governance would have caught it

${e.rootCause}

## How MakerChecker blocks it

${e.makercheckerRefusal}

**Controls that would have blocked or contained this:**

${controls}

## Sources

${sources}

---

_Part of the [Agent Incident Database](../README.md). Cite as \`${e.id}\`. Corrections and new incidents: see [CONTRIBUTING](../CONTRIBUTING.md)._
`;
}

function indexJson(entries) {
  return {
    schema: "https://makerchecker.ai/incidents/schema.json",
    updatedFields: ["id", "title", "incidentDateText", "category", "severity", "controlsThatBlock", "reproPath"],
    count: entries.length,
    entries: entries.map((e) => ({
      id: e.id,
      slug: e.slug,
      title: e.title,
      date: e.incidentDateText,
      year: e.incidentYear,
      category: e.category,
      severity: e.severity,
      oneLineSummary: e.oneLineSummary,
      controlsThatBlock: e.controlsThatBlock,
      reproducible: e.reproducible,
      reproPath: e.reproPath,
      page: `entries/${e.id}.md`,
      sources: e.sources,
    })),
  };
}

function readmeMarkdown(entries) {
  // Pre-LLM / non-agent cases kept as precedents: same failure mode, older or
  // non-AI system. Labeled so the catalogue's scope is honest.
  const PRECEDENTS = new Set([
    "AID-2012-0001", // Knight Capital
    "AID-2013-0001", // Everbright
    "AID-2015-0001", // Robodebt
    "AID-2022-0003", // Citigroup fat-finger
  ]);
  const rows = entries
    .map(
      (e) =>
        `| [\`${e.id}\`](entries/${e.id}.md) | ${e.incidentDateText} | ${e.title.replace(/\|/g, "\\|")}${PRECEDENTS.has(e.id) ? " _(precedent)_" : ""} | ${CATEGORY_LABEL[e.category] ?? e.category} | ${e.severity} |`,
    )
    .join("\n");

  const byControl = {};
  for (const e of entries) for (const c of e.controlsThatBlock) byControl[c] = (byControl[c] ?? 0) + 1;
  const controlRows = Object.entries(byControl)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `| ${CONTROL_LABEL[c] ?? c} | ${n} |`)
    .join("\n");

  return `# Agent Incident Database (AID)

A citable, CVE-style catalog of real-world incidents where an AI agent or
automated system took a **consequential action that a maker-checker control
would have blocked or contained**. Every entry has a stable id, structured
fields, primary sources, and — where available — a runnable MakerChecker
reproduction that demonstrates the block.

This is a public reference. Cite an incident by its id (e.g. \`AID-2023-0002\`).
The id namespace and the citation graph are the point: the markdown is easy to
copy, the canonical reference is not.

- **Machine-readable registry:** [index.json](index.json)
- **Entry schema:** [schema.json](schema.json)
- **Add or correct an incident:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **${entries.length} incidents** currently catalogued, all reproducible.

## Scope

This catalogue covers incidents where an automated system took a consequential
action a human should have owned and could not take back. The core is AI-agent
failures. A few older cases, for example Knight Capital in 2012 and Robodebt in
2015, are included as precedents and marked \`_(precedent)_\` in the table below,
because the failure mode is the same even though the system was not an LLM agent.
Where an incident was a researcher proof-of-concept that was fixed before real
harm, the entry says so. Where a human, not the agent, took the final action, the
entry says that too.

## Incidents

| ID | Date | Incident | Category | Severity |
|---|---|---|---|---|
${rows}

## Controls that would have blocked these

Every incident maps to one or more structural controls. Across the catalogue:

| Control | Incidents it would have blocked |
|---|---|
${controlRows}

The recurring lesson: in nearly every case the model was free to *propose*, but
nothing structural stopped it from *committing* the irreversible action. That
gap — not the model's mistake — is the incident.

## Accuracy, disclaimer, and corrections

Entries describe publicly reported incidents, summarized from the sources cited
in each entry. Summaries may contain errors, and claims drawn from pending
litigation are labeled as allegations rather than established fact. If you spot
an error, email [hello@makerchecker.ai](mailto:hello@makerchecker.ai) or open a
PR (see [CONTRIBUTING.md](CONTRIBUTING.md)). Confirmed factual errors are
corrected within 14 days of report.

---

_Maintained by [MakerChecker](https://makerchecker.ai). Entries are derived from
the JSON sources in [\`entries/\`](entries); regenerate with
\`node incidents/scripts/build.mjs\`._
`;
}

function main() {
  const entries = loadEntries();
  for (const e of entries) {
    writeFileSync(join(ENTRIES_DIR, `${e.id}.md`), entryMarkdown(e));
  }
  writeFileSync(join(ROOT, "index.json"), JSON.stringify(indexJson(entries), null, 2) + "\n");
  writeFileSync(join(ROOT, "README.md"), readmeMarkdown(entries));
  process.stdout.write(`built ${entries.length} incident pages + index.json + README.md\n`);
}

main();
