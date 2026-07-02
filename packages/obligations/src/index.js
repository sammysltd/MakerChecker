/**
 * @makerchecker/obligations — deterministic mapping of a signed audit bundle to
 * named regulatory obligation profiles (21 CFR Part 11, EU Annex 11, GAMP 5,
 * HIPAA 164.312). Public API.
 */

export { checkObligations, STATUS } from "./checker.js";
export { indexEvents, evalPredicate } from "./predicates.js";
