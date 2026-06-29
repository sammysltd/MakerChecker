/**
 * A tiny, deterministic predicate evaluator over a bundle's audit events.
 * No LLM, no heuristics: a clause is MET only when concrete events prove it,
 * and the matching events' seq numbers are returned as citations.
 *
 * Predicate forms (all JSON):
 *   { eventType: "approval.decided" }                          >=1 such event
 *   { eventType: "enforcement.blocked",
 *     payloadMatch: { code: "skill_not_granted" } }            >=1 matching payload
 *   { eventType: "...", minCount: 2 }                          at least N
 *   { anyOf: [ <pred>, ... ] }                                 any child MET
 *   { allOf: [ <pred>, ... ] }                                 all children MET
 *   { chainVerified: true }                                    bundle passed verification
 */

export function indexEvents(events) {
  const byType = new Map();
  for (const e of events) {
    if (!byType.has(e.event_type)) byType.set(e.event_type, []);
    byType.get(e.event_type).push(e);
  }
  return { byType, all: events };
}

const dedupe = (xs) => [...new Set(xs)];

function matchLeaf(idx, pred) {
  const list = idx.byType.get(pred.eventType) ?? [];
  if (!pred.payloadMatch) return list;
  return list.filter((e) => {
    const p = e.payload ?? {};
    return Object.entries(pred.payloadMatch).every(([k, v]) => p[k] === v);
  });
}

export function evalPredicate(idx, pred, ctx) {
  if (!pred || typeof pred !== "object") return { met: false, seqs: [] };

  if (pred.allOf) {
    const parts = pred.allOf.map((p) => evalPredicate(idx, p, ctx));
    return { met: parts.every((r) => r.met), seqs: dedupe(parts.flatMap((r) => r.seqs)) };
  }
  if (pred.anyOf) {
    const parts = pred.anyOf.map((p) => evalPredicate(idx, p, ctx));
    return { met: parts.some((r) => r.met), seqs: dedupe(parts.filter((r) => r.met).flatMap((r) => r.seqs)) };
  }
  if (pred.chainVerified) {
    return { met: ctx.chainVerified === true, seqs: [] };
  }
  const matched = matchLeaf(idx, pred);
  const min = pred.minCount ?? 1;
  return { met: matched.length >= min, seqs: matched.map((e) => e.seq) };
}
