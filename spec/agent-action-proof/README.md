# Agent Action Proof Receipt (AAPR)

An open, vendor-neutral standard for **proving that an AI agent's actions were
governed and recorded** — verifiable offline, in any language, by anyone, with
no access to the system that produced the proof.

- **The spec:** [agent-action-proof-v1.md](agent-action-proof-v1.md)
- **Reference verifier (CLI + browser + library):** [`@makerchecker/proof-verifier`](../../packages/proof-verifier)
- **Conformance corpus:** [`packages/proof-verifier/vectors`](../../packages/proof-verifier/vectors)

## The idea

An audit record is only worth something if a third party can check it without
trusting whoever produced it. That requires three things: the format is open,
verification is reproducible from the spec alone, and enough producers share the
shape that a verifier — and an auditor's expectation — is portable.

AAPR is that shared shape. MakerChecker is *a* reference producer; the format
belongs to everyone. If your system emits a conforming receipt and passes the
conformance vectors, it is "Agent-Proof compatible, v1" — and every adopter,
including a fork, reinforces the same standard rather than competing with it.

## What a receipt proves

- **Integrity** — not one byte of a recorded action has changed (hash chain).
- **Completeness** — for a full bundle, nothing was removed, inserted, or
  reordered (genesis-rooted linkage).
- **Origin** — the bundle was signed by the instance's key (Ed25519), and key
  pinning proves *which* key.
- **Offline** — all of the above with no network and no producer access.

## Status

Draft version 1. Comments, weaknesses, and proposed changes:
[SECURITY.md](../../SECURITY.md) and the issue tracker.
