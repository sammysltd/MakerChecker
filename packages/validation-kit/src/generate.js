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

export async function generateValidation(bundle, protocol, opts = {}) {
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
    return {
      urs: u.id,
      ursText: u.text,
      risk: u.risk,
      fs: fsItems.map((f) => f.id),
      tests: testItems.map((t) => ({ id: t.id, result: t.result })),
      covered,
      untested: executed.length === 0,
    };
  });

  const stages = { IQ: [], OQ: [], PQ: [] };
  for (const t of tests) (stages[t.stage] ??= []).push(t);

  const summary = { total: tests.length, PASS: 0, FAIL: 0, NOT_APPLICABLE: 0 };
  for (const t of tests) summary[t.result] += 1;
  const requirementsCovered = rtm.filter((r) => r.covered).length;

  const qualified = chain.ok && summary.FAIL === 0 && rtm.every((r) => r.covered || r.untested);

  return {
    protocol: { id: protocol.id, title: protocol.title, version: protocol.version },
    chain: { verified: chain.ok, ...(chain.ok ? { count: chain.count, headHash: chain.headHash, keyFingerprint: chain.keyFingerprint } : { reason: chain.reason }) },
    reliable: chain.ok,
    qualified,
    stages,
    tests,
    rtm,
    summary: { ...summary, requirementsCovered, requirementsTotal: protocol.urs.length },
    meta: { ursById, fsById, testById },
  };
}
