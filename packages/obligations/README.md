# @makerchecker/obligations

**Control-mapping as code.** Deterministic, offline mapping of a signed
MakerChecker audit bundle to named regulatory obligations — emitting, per
clause, **MET / NOT_EVIDENCED / NOT_APPLICABLE** with the exact audit
`seq` numbers that satisfy it.

No LLM, no network, no producer access. The mapping is machine-checkable code an
examiner can run against a real run's evidence, not prose in a PDF.

## Profiles

| Profile id | Framework |
|---|---|
| `part-11` | 21 CFR Part 11 — Electronic Records; Electronic Signatures |
| `annex-11` | EU GMP Annex 11 — Computerised Systems |
| `gamp5` | GAMP 5 / ALCOA+ data integrity |
| `hipaa-164-312` | HIPAA Security Rule — Technical Safeguards (45 CFR 164.312) |

Each profile is a JSON file in [`profiles/`](./profiles) binding a clause to the
exact audit event types and refusal codes that evidence it. Profiles are
versioned and PR-able; adding a framework is a pull request.

## Use

```bash
mc-obligations list-profiles
mc-obligations check --bundle run-evidence.json --profile part-11
# pin the instance key, get machine-readable output, or fail on gaps:
mc-obligations check --bundle run-evidence.json --profile annex-11 --key instance-pubkey.pem --json
mc-obligations check --bundle run-evidence.json --profile gamp5 --strict
```

```
EU GMP Annex 11 (Computerised Systems)
Bundle: chain VERIFIED (8 events)

  ✓ 4  MET
      Validation
      note: Partial: tamper-evidence is provided; lifecycle validation (URS/FS/IQ/OQ/PQ) is the operator's process — see the GxP validation kit.
  ✓ 9  MET  (seq 1, 7, 3)
      Audit Trails
      note: Every agent action and governance decision is recorded in the hash-chained log.
  ✓ 12.1  MET  (seq 4)
      Security — access restricted to authorised persons
  ...
  6 met, 0 not-evidenced, 0 not-applicable

  Scope: this profile assesses 5 of 6 mapped clauses in full; 1 is in part the operator's process, not evidenced by this tool.
  Clauses of the framework not mapped in this profile are not assessed here.
```

Clause titles carry the regulation's own words; how MakerChecker evidences the
clause (and any *Partial* caveat about what remains the operator's process) is
in the clause's `note`, printed with every result.

## How it works

1. The bundle is **verified first** (via `@makerchecker/proof-verifier`). If the
   chain does not verify, the report says so and its findings must not be relied
   upon — evidence only counts on an intact chain.
2. Each clause carries an `evidence` predicate over the audit events
   (`eventType`, `payloadMatch`, `payloadHas`, `anyOf`/`allOf`,
   `chainVerified`). A clause is:
   - **MET** when concrete events prove it — their `seq` numbers are cited;
   - **NOT_EVIDENCED** when the activity occurred but the evidence is absent;
   - **NOT_APPLICABLE** when the clause's precondition never arose in this run
     (e.g. a signature clause when no approval was requested).

It is a control-to-clause crosswalk, not a certification: an assessor confirms
the operator's posture against their own validated scope.

## Status meanings, precisely

| Status | Meaning |
|---|---|
| `MET` | Required evidence is present on a verified chain; cited by `seq`. |
| `NOT_EVIDENCED` | The clause applies to this run but its evidence is missing. |
| `NOT_APPLICABLE` | The clause's precondition did not occur in this bundle. |

## Library

```js
import { checkObligations } from "@makerchecker/obligations";
const report = await checkObligations(bundle, profile, { expectedPublicKeyPem });
```

## Test

```bash
npm test   # runs the checker against a real signed bundle and asserts statuses
```

## License

Apache-2.0.
