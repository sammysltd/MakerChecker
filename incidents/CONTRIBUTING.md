# Contributing to the Agent Incident Database

The Agent Incident Database (AID) catalogs real-world incidents where an AI
agent or automated system took a consequential action that a maker-checker
control would have blocked or contained. Contributions — new incidents and
corrections to existing ones — are welcome.

## Inclusion criteria

An incident belongs in the AID if **all** of these hold:

1. **It happened.** A real, documented event with at least one primary source
   (court filing, regulator action, vendor advisory, credible reporting). Not a
   hypothetical or a lab-only demo.
2. **An automated/AI system took a consequential action**, or a human
   rubber-stamped one without the review a control would have forced.
3. **The harm was binding or irreversible** at the moment of action — money
   moved, data was destroyed or exfiltrated, a filing was made, a decision was
   finalized.
4. **A structural control would have blocked or contained it** — deny-by-default
   grants, segregation of duties, a high-risk approval gate, or fail-closed
   limits. State which.

We do not editorialize about the vendor; we describe the failure mode and the
control that addresses it.

## How to add an entry

1. Copy an existing file in [`entries/`](entries) (e.g. `AID-2023-0002.json`) to
   a new id. Ids are `AID-YYYY-NNNN`, where `YYYY` is the incident year and
   `NNNN` is the next free sequence number for that year.
2. Fill in every field. The entry must validate against
   [`schema.json`](schema.json).
3. Regenerate the derived files:

   ```bash
   node incidents/scripts/build.mjs
   ```

   This rewrites `index.json`, `README.md`, and the per-entry `.md` page. Never
   hand-edit those; the JSON is the source of truth.
4. If you can, add a runnable reproduction under [`examples/`](../examples) and
   point `reproPath` at it with `reproducible: true`.

## Corrections

Open a PR editing the entry's JSON and rerun the build, or email
[hello@makerchecker.ai](mailto:hello@makerchecker.ai) with the entry id and the
source that contradicts it. Confirmed factual errors are corrected within 14
days of report. Because this is a citable reference, factual accuracy matters
more than completeness — if a field cannot be supported by a source, leave it
conservative, and label claims from pending litigation as allegations.
