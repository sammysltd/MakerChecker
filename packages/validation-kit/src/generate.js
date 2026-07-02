/**
 * Generates a Computer System Validation (CSV) result set by re-deriving each
 * IQ/OQ/PQ test case's evidence deterministically from a signed audit bundle,
 * and builds the Requirements Traceability Matrix (URS -> FS -> test -> result).
 *
 * Reuses the proof verifier (chain integrity) and the obligations predicate
 * engine (evidence evaluation). No LLM, no network, no producer access.
 */

import { verifyBundle, nodeCrypto } from "../../proof-verifier/src/index.js";
import { indexEvents, evalPredicate } from "../../obligations/src/predicates.js";

export const RESULT = { PASS: "PASS", FAIL: "FAIL", NOT_APPLICABLE: "NOT_APPLICABLE" };

/**
 * Waivers are the only path past an unexercised requirement, and each one must
 * name a protocol URS and carry a written reason — recorded in the report as a
 * deviation. Anything malformed throws: qualification is fail-closed.
 */
function normalizeWaivers(waivers, protocol) {
  if (waivers == null) return [];
  if (!Array.isArray(waivers)) throw new Error("opts.waivers must be an array of { urs, reason }");
  const known = new Set(protocol.urs.map((u) => u.id));
  return waivers.map((w) => {
    const urs = typeof w?.urs === "string" ? w.urs.trim() : "";
    const reason = typeof w?.reason === "string" ? w.reason.trim() : "";
    if (!urs || !reason) throw new Error(`waiver ${JSON.stringify(w)} must carry both a urs id and a written reason`);
    if (!known.has(urs)) throw new Error(`waiver names unknown requirement "${urs}"; protocol defines: ${[...known].join(", ")}`);
    return { urs, reason };
  });
}

export async function generateValidation(bundle, protocol, opts = {}) {
  const waivers = normalizeWaivers(opts.waivers, protocol);
  const waiverByUrs = new Map(waivers.map((w) => [w.urs, w]));
  const chain = await verifyBundle(bundle, nodeCrypto, opts);
  const idx = indexEvents(Array.isArray(bundle?.events) ? bundle.events : []);
  const ctx = { chainVerified: chain.ok };

  const tests = protocol.tests.map((t) => {
    let applicable = true;
    if (t.applicableWhen && t.applicableWhen !== "always") {
      applicable = evalPredicate(idx, t.applicableWhen, ctx).met;
    }
    if (!applicable) {
      return { id: t.id, stage: t.stage, title: t.title, procedure: t.procedure, expected: t.expected, fs: t.fs, result: RESULT.NOT_APPLICABLE, citedSeqs: [] };
    }
    const r = evalPredicate(idx, t.evidence, ctx);
    return { id: t.id, stage: t.stage, title: t.title, procedure: t.procedure, expected: t.expected, fs: t.fs, result: r.met ? RESULT.PASS : RESULT.FAIL, citedSeqs: r.seqs };
  });

  const testById = Object.fromEntries(tests.map((t) => [t.id, t]));
  const fsById = Object.fromEntries(protocol.fs.map((f) => [f.id, f]));
  const ursById = Object.fromEntries(protocol.urs.map((u) => [u.id, u]));

  // Requirements Traceability Matrix: each URS -> the FS that implement it ->
  // the tests that exercise those FS -> coverage verdict.
  const rtm = protocol.urs.map((u) => {
    const fsItems = protocol.fs.filter((f) => f.urs.includes(u.id));
    const testItems = tests.filter((t) => t.fs.some((fid) => fsById[fid]?.urs.includes(u.id)));
    const executed = testItems.filter((t) => t.result !== RESULT.NOT_APPLICABLE);
    const covered = executed.length > 0 && executed.every((t) => t.result === RESULT.PASS);
    const untested = executed.length === 0;
    // A waiver only excuses a requirement the run never exercised; it can never
    // rescue a requirement whose tests executed and failed.
    const waiver = untested ? waiverByUrs.get(u.id) ?? null : null;
    return {
      urs: u.id,
      ursText: u.text,
      risk: u.risk,
      fs: fsItems.map((f) => f.id),
      tests: testItems.map((t) => ({ id: t.id, result: t.result })),
      covered,
      untested,
      waived: waiver != null,
      waiverReason: waiver ? waiver.reason : null,
    };
  });

  const stages = { IQ: [], OQ: [], PQ: [] };
  for (const t of tests) (stages[t.stage] ??= []).push(t);

  const summary = { total: tests.length, PASS: 0, FAIL: 0, NOT_APPLICABLE: 0 };
  for (const t of tests) summary[t.result] += 1;
  const requirementsCovered = rtm.filter((r) => r.covered).length;
  const requirementsWaived = rtm.filter((r) => r.waived).length;

  // Fail-closed: a requirement the run never exercised does NOT qualify unless
  // it was explicitly waived (a recorded deviation with a written reason).
  const qualified = chain.ok && summary.FAIL === 0 && rtm.every((r) => r.covered || (r.untested && r.waived));

  return {
    protocol: { id: protocol.id, title: protocol.title, version: protocol.version },
    chain: { verified: chain.ok, ...(chain.ok ? { count: chain.count, headHash: chain.headHash, keyFingerprint: chain.keyFingerprint } : { reason: chain.reason }) },
    reliable: chain.ok,
    qualified,
    stages,
    tests,
    rtm,
    waivers: waivers.map((w) => ({ ...w, applied: rtm.some((r) => r.urs === w.urs && r.waived) })),
    summary: { ...summary, requirementsCovered, requirementsWaived, requirementsTotal: protocol.urs.length },
    meta: { ursById, fsById, testById },
  };
}
