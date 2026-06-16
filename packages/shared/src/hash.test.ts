import { describe, expect, it } from "vitest";

import { hashAuditEvent, sha256Hex, type HashableAuditEvent } from "./hash.js";

describe("sha256Hex", () => {
  it("matches the NIST test vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes UTF-8 bytes, not UTF-16", () => {
    // "€" is 3 bytes in UTF-8 (e2 82 ac); a UTF-16 hash would differ.
    expect(sha256Hex("€")).toBe(
      "c4cc90ed3d26f12d4b08a75140970a7904035c31cbb4515a83f19b9003c00d1d",
    );
  });
});

describe("hashAuditEvent", () => {
  const base: HashableAuditEvent = {
    id: "5c19984e-71f0-4f0e-9a4c-2a2d6f7d2a10",
    occurredAt: "2026-06-11T12:00:00.000Z",
    actor: { type: "agent", id: "recon-preparer" },
    eventType: "run.step.completed",
    entityType: "step_run",
    entityId: "11111111-1111-1111-1111-111111111111",
    runId: "22222222-2222-2222-2222-222222222222",
    payload: { output: { matched: 41, exceptions: 2 } },
    prevHash: "0".repeat(64),
  };

  it("is deterministic", () => {
    expect(hashAuditEvent(base)).toBe(hashAuditEvent({ ...base }));
  });

  it("is independent of property insertion order (canonicalization)", () => {
    const reordered = JSON.parse(JSON.stringify(base)) as HashableAuditEvent;
    reordered.payload = { output: { exceptions: 2, matched: 41 } };
    expect(hashAuditEvent(reordered)).toBe(hashAuditEvent(base));
  });

  it("changes when any hashed field changes (tamper detection)", () => {
    const original = hashAuditEvent(base);
    const tampered: Array<Partial<HashableAuditEvent>> = [
      { payload: { output: { matched: 41, exceptions: 1 } } },
      { eventType: "run.step.failed" },
      { actor: { type: "agent", id: "recon-reporter" } },
      { occurredAt: "2026-06-11T12:00:00.001Z" },
      { prevHash: "1".repeat(64) },
      { runId: null },
    ];
    for (const change of tampered) {
      expect(hashAuditEvent({ ...base, ...change })).not.toBe(original);
    }
  });

  it("chains: an event's hash feeds the next event's prevHash", () => {
    const first = hashAuditEvent(base);
    const second = hashAuditEvent({ ...base, id: "different-id", prevHash: first });
    const tamperedFirst = hashAuditEvent({
      ...base,
      payload: { output: { matched: 40, exceptions: 2 } },
    });
    // Recomputing the chain after tampering with event 1 cannot reproduce event 2's hash.
    expect(hashAuditEvent({ ...base, id: "different-id", prevHash: tamperedFirst })).not.toBe(
      second,
    );
  });
});
