# @makerchecker/validation-kit

**The GxP validation package, generated from proof.** Turn a signed audit bundle
into a Computer System Validation (IQ/OQ/PQ) report and a Requirements
Traceability Matrix — deterministically, with every result re-derived from
recorded events and cited to the audit `seq` it rests on.

This is the artifact a regulated QA function (pharma, CRO, medtech) needs to
deploy an AI agent under **21 CFR Part 11 / EU Annex 11 / GAMP 5**: not a claim
that the controls work, but executable evidence that they did, on a chain anyone
can re-verify.

## Why it matters

Every incumbent in regulated AI stalls at "suggest-only" because they cannot
*prove*, in a validatable form, that the human gate fired and the agent stayed
in role. This kit produces that proof as the document QA actually signs.

## Use

```bash
mc-validate list-protocols
mc-validate run --bundle run-evidence.json --protocol agent-governance-baseline --out validation-report.md
# pin the key, or emit machine-readable results:
mc-validate run --bundle run-evidence.json --protocol agent-governance-baseline --key instance-pubkey.pem --json
```

Exit code `0` only if the system **qualified**: the chain verified, every
executed test passed, and every user requirement was exercised and covered —
or explicitly waived. Exit code `1` for anything else: a failed test, an
uncovered requirement, a requirement the bundle never exercised
(**fail-closed** — "not exercised" is a gap, not a pass), or a chain that did
not verify.

A requirement your evidence never exercised (e.g. `URS-004` fail-closed limits,
when the run never hit a limit) makes the report **NOT QUALIFIED**. Either
capture challenge-run evidence — drive an over-limit request so the refusal is
recorded — and re-run, or record an explicit deviation:

```bash
mc-validate run --bundle run-evidence.json --protocol agent-governance-baseline \
  --waive URS-004 --reason "Fail-closed limits challenge scheduled for OQ round 2 (CAPA-114)" \
  --out validation-report.md
```

Every `--waive` requires a written `--reason`; the waiver is printed verbatim in
the report's **Deviations** section for the named reviewers to accept or reject.
A waiver never rescues a requirement whose tests executed and failed.

## What it produces

- **IQ** — installation: the instance is initialised and the audit chain is rooted and verifies.
- **OQ** — operational: each control fires (deny-by-default, high-risk gate, segregation of duties, fail-closed limits).
- **PQ** — performance: a representative governed run completes end-to-end with a signed decision.
- **Requirements Traceability Matrix** — URS → FS → test → result, with a coverage verdict per requirement.
- **Deviations** — any waived (unexercised) requirement, with its recorded reason.
- **Qualification statement** and an **approval block** for the operator's named reviewers (maker-checker applies to the validation itself: author ≠ approver).

A tampered or incomplete bundle cannot qualify, and neither can a run that
never exercised a requirement — the report says **NOT QUALIFIED** and states
why, unless the gap is an explicitly recorded deviation.

## Protocols

A protocol is a JSON file in [`protocols/`](./protocols) that traces user
requirements (URS) through functional specs (FS) to IQ/OQ/PQ test cases, each
with an `evidence` predicate over the audit events. The bundled
[`agent-governance-baseline`](./protocols/agent-governance-baseline.json) covers
the core governance requirements; add a protocol per use case (PV ICSR, MDR,
oncology access) with a pull request — one protocol, many runs.

## How it works

1. The bundle is **verified first** (`@makerchecker/proof-verifier`); results
   only count on an intact chain.
2. Each test case's `evidence` predicate is evaluated against the events (the
   same deterministic engine as `@makerchecker/obligations`).
3. The Requirements Traceability Matrix is computed from URS → FS → test links.

No LLM, no network, no producer access.

## Library

```js
import { generateValidation, renderReport } from "@makerchecker/validation-kit";
const result = await generateValidation(bundle, protocol, {
  expectedPublicKeyPem,
  waivers: [{ urs: "URS-004", reason: "Limits challenge scheduled for OQ round 2 (CAPA-114)" }],
});
const markdown = renderReport(result);
```

## Test

```bash
npm test   # fail-closed: an unexercised requirement does NOT qualify; a waiver
           # records a deviation; a challenge run covering every URS qualifies;
           # a tampered bundle never qualifies
```

## License

Apache-2.0.
