# InjectionGauntlet

**"My agent got jailbroken 9 times and stole nothing."**

A runnable corpus and harness that makes one point precisely: *structural
enforcement is independent of model gullibility.* The gauntlet assumes the
**worst case** at the model layer — every prompt injection fully subverts the
agent's intent — and then asks the only question that matters: **can the agent
execute the malicious tool call?**

```
  Agent fully subverted by injection: 9/9
  Tool calls that actually executed:  0/9
  Blocked: 5 by skill_not_granted, 2 by high_risk_requires_gate, 2 by limit_violation
```

Each payload is distilled from a real incident in the
[Agent Incident Database](../incidents) — EchoLeak, ShadowLeak, CamoLeak, the $1
Tahoe, the Morse-code wallet drain, the Replit and Cursor database wipes, the
DN42 cloud-bill runaway, Knight Capital. In every one, the model was free to be
fooled; the structural gate is what stopped the consequence.

## Run it

```bash
node src/run.mjs                              # the example policy
node src/run.mjs --policy ./my-policy.json    # point it at YOUR policy
node src/run.mjs --json                       # machine-readable
```

Exit code `0` means **no** injection reached a tool. Point it at your own
governance policy to see whether your agent's blast radius is actually closed.

## Why this is honest

This is not a model-jailbreak benchmark and does not claim the model resists
injection — it assumes the opposite. It demonstrates that with deny-by-default
grants, high-risk approval gates, and fail-closed limits, **a fully compromised
agent still cannot act outside what its role was granted.** The model layer is
probabilistic; the enforcement layer is not.

The evaluator in [`src/enforce.js`](./src/enforce.js) mirrors MakerChecker's
decision order: deny-by-default grant check → high-risk gate → fail-closed
limits. The same logic runs in the engine; here it is small enough to read in
one sitting.

## Contribute a payload

Add an entry to [`corpus.json`](./corpus.json) (ideally linked to an
[AID](../incidents) incident id) and a matching role to a policy. Run `npm test`
to confirm it is blocked by the refusal you expect.

## License

Apache-2.0.
