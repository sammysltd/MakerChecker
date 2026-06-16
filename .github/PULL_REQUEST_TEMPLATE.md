## What and why

Describe the change and the reason for it. Link the issue if one exists.

## Checklist

- [ ] Tests included in this PR (unit + integration where applicable); coverage gates untouched
- [ ] Adversarial tests added for any enforcement or audit code path touched
- [ ] `corepack pnpm run ci` passes locally
- [ ] API route changes: SDK and OpenAPI document updated (`pnpm --filter @makerchecker/server run openapi`)
- [ ] No changes to hashing/canonicalization/bundle formats — or this PR explicitly calls them out as audit-spec changes
- [ ] Conventional commit message(s), imperative, first line < 72 chars

## Notes for reviewers

Anything needing extra attention: migration ordering, locking, invariants, follow-ups.
