/**
 * Deterministic obligations checker.
 *
 * Given a signed audit bundle and a control-mapping profile, it:
 *   1. verifies the bundle (so evidence rests on an intact chain), then
 *   2. evaluates each clause's evidence predicate against the events, emitting
 *      MET / NOT_EVIDENCED / NOT_APPLICABLE with the citing seq numbers.
 *
 * No network, no LLM, no producer access. If the chain does not verify, the
 * report says so and its findings must not be relied upon.
 */

import { verifyBundle, nodeCrypto } from "../../proof-verifier/src/index.js";

import { indexEvents, evalPredicate } from "./predicates.js";

export const STATUS = {
  MET: "MET",
  NOT_EVIDENCED: "NOT_EVIDENCED",
  NOT_APPLICABLE: "NOT_APPLICABLE",
};

export async function checkObligations(bundle, profile, opts = {}) {
  const chain = await verifyBundle(bundle, nodeCrypto, opts);
  const idx = indexEvents(Array.isArray(bundle?.events) ? bundle.events : []);
  const ctx = { chainVerified: chain.ok };

  const clauses = profile.clauses.map((c) => {
    let applicable = true;
    if (c.applicableWhen && c.applicableWhen !== "always") {
      applicable = evalPredicate(idx, c.applicableWhen, ctx).met;
    }
    if (!applicable) {
      return { id: c.id, title: c.title, requirement: c.requirement, status: STATUS.NOT_APPLICABLE, citedSeqs: [], note: c.note, partial: c.partial === true };
    }
    const r = evalPredicate(idx, c.evidence, ctx);
    return {
      id: c.id,
      title: c.title,
      requirement: c.requirement,
      status: r.met ? STATUS.MET : STATUS.NOT_EVIDENCED,
      citedSeqs: r.seqs,
      note: c.note,
      partial: c.partial === true,
    };
  });

  const summary = { MET: 0, NOT_EVIDENCED: 0, NOT_APPLICABLE: 0 };
  for (const c of clauses) summary[c.status] += 1;

  return {
    profile: { id: profile.id, framework: profile.framework, version: profile.version },
    chain: { verified: chain.ok, ...(chain.ok ? { count: chain.count, headHash: chain.headHash, keyFingerprint: chain.keyFingerprint } : { reason: chain.reason }) },
    reliable: chain.ok,
    clauses,
    summary,
  };
}
