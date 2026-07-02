# InjectionGauntlet

**Assume the jailbreak always works. Can the tool call still execute?**

A runnable corpus and harness that makes one point precisely: *structural
enforcement is independent of model gullibility.* The gauntlet assumes the
**worst case** at the model layer — every prompt injection fully subverts the
agent's intent — and then asks the only question that matters: **can the agent
execute its malicious objective?**

```
  Agent fully subverted by injection: 11/11
  Malicious objectives that executed: 0/11
  Blocked: 5 by skill_not_granted, 2 by high_risk_requires_gate, 4 by limit_violation
  Positive controls allowed: 15/15
```

Each payload is distilled from a real incident in the
[Agent Incident Database](../incidents) — EchoLeak, ShadowLeak, CamoLeak, the $1
Tahoe, the Morse-code wallet drain, the Replit and Cursor database wipes, the
DN42 cloud-bill runaway, Knight Capital — plus two synthetic fail-closed probes
(an omitted amount and a negative amount on a limited skill). In every one, the
model was free to be fooled; the structural gate is what stopped the
consequence. The runaway-loop payloads (DN42, Knight) run as actual repeated
small calls — each one individually in-limit, the way those incidents really
unfolded — and are cut off at the policy's invocation cap.

## Run it

```bash
node src/run.mjs                              # the example policy
node src/run.mjs --policy ./my-policy.json    # point it at YOUR policy
node src/run.mjs --json                       # machine-readable
```

Exit code `0` means **no** malicious objective reached a tool AND every
positive control — an ordinary in-policy call — was allowed. Point it at your
own governance policy to see whether your agent's blast radius is actually
closed.

## Why this is honest

This is not a model-jailbreak benchmark and does not claim the model resists
injection — it assumes the opposite. It demonstrates that with deny-by-default
grants, high-risk approval gates, and fail-closed limits, **a fully compromised
agent still cannot act outside what its role was granted.** The model layer is
probabilistic; the enforcement layer is not.

The harness is also not rigged to block everything: the corpus carries positive
controls — at least two in-policy calls per role, including gated skills used
*with* a recorded approval — that must all be ALLOWED for the gauntlet to pass.

The evaluator in [`src/enforce.js`](./src/enforce.js) is a simplified model of
the engine's decision order (deny-by-default grant check → high-risk gate →
fail-closed limits), not the engine itself. The production engine additionally
fails closed on unreadable amounts at the input-parsing layer, counts
invocations from the audit log rather than an in-memory counter, and derives
gate status server-side from flow structure
(`packages/server/src/engine/limits.ts`,
`packages/server/src/engine/enforcement.ts`) — never from anything the agent
asserts. The toy mirrors those semantics where they decide the verdict: a
limited skill with a missing, non-numeric, or negative amount is denied; a
payload claiming `"throughGate": true` is ignored; the invocation counter is
harness state the payload cannot write.

## Contribute a payload

Add an entry to [`corpus.json`](./corpus.json) (ideally linked to an
[AID](../incidents) incident id) and a matching role to a policy. Runaway-loop
payloads take `repeat: N`. Run `npm test` to confirm it is blocked by the
refusal you expect — and that the positive controls still pass.

## License

Apache-2.0.
