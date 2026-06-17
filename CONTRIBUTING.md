# Contributing to MakerChecker

Thanks for contributing. The bar for changes — especially tests — is high.

## Dev setup

- Node 22 (see `.nvmrc`), pnpm via corepack (`corepack enable`). Do not install pnpm globally.
- PostgreSQL 17 **binaries** for the test suite: `brew install postgresql@17` (macOS) or the `postgresql-17` package (Linux). Tests boot a throwaway cluster per run — no running server, no manual database. Alternatively set `TEST_DATABASE_URL` to an existing Postgres, or `PG_BIN` to your binaries directory.

```bash
corepack pnpm install
corepack pnpm run ci     # lint + typecheck + test + build — exactly what CI runs
```

See [docs/quickstart.md](docs/quickstart.md) for running the server and web UI locally.

### Git hooks (secret scanning)

Point git at the repo's hooks directory once after cloning so staged changes are
scanned for secrets before every commit:

```bash
git config core.hooksPath .githooks
```

The pre-commit hook runs `gitleaks protect --staged` against `.gitleaks.toml`.
Install gitleaks (`brew install gitleaks`, or see the [gitleaks
releases](https://github.com/gitleaks/gitleaks#installing)) for local
protection. The hook is optional locally: if gitleaks is not installed it prints
an install hint and lets the commit through. CI runs the same scan and **fails**
on a finding. Known fixtures and placeholders (the
demo password, example `mk_` keys, filler test hashes) are allowlisted in
`.gitleaks.toml`; add real fixtures there rather than bypassing the hook.

## The testing covenant

**Every change lands with its tests in the same commit or PR.** No test-later.

- New features: unit and integration tests alongside the code.
- Bug fixes: start with a failing test that reproduces the bug, then fix it.
- **Enforcement and audit code paths additionally require adversarial tests.** Tamper an audit row, attempt an ungranted skill, violate SoD, replay a job, crash mid-transaction. A guarantee that no test attacks is not a guarantee.
- Integration tests run against real ephemeral Postgres, never a mocked database layer.
- Coverage thresholds (90% lines/functions/branches/statements per package) live in each package's vitest config and are enforced in CI. **Never lower a threshold to make a change pass.** Write the missing tests instead.

## Running tests

```bash
corepack pnpm test                                   # everything
corepack pnpm --filter @makerchecker/server test     # one package
corepack pnpm --filter @makerchecker/server exec vitest run src/audit   # one area, with coverage off
```

Same `--filter` pattern for `@makerchecker/shared`, `@makerchecker/web`, `@makerchecker/sdk`.

## Commits

Conventional commits, imperative mood, first line under 72 characters:

```
feat(server): enforce SoD constraints at invocation time
fix(audit): reject bundles with reordered event hashes
docs: clarify run-bundle linkage semantics
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`. Scope by package or area where it helps.

## Contributor License Agreement

MakerChecker is dual-licensed (open source AGPL-3.0 plus a commercial license — see [LICENSING.md](LICENSING.md)), so the project must hold relicensing rights to merged contributions. Contributors sign a **CLA** granting that right while retaining their own copyright. The CLA process is being finalized; until it is automated, a maintainer will request a signature on your first pull request before merging.

## Pull requests

- Keep PRs focused; one logical change per PR.
- Explain **why**, not just what. Link the issue if one exists.
- `corepack pnpm run ci` must pass locally before you open the PR.
- Changes to API routes must keep `packages/sdk` and the emitted OpenAPI document (`pnpm --filter @makerchecker/server run openapi`) in sync.
- Changes to hashing, canonicalization, or bundle formats are breaking changes to the public [audit spec](docs/audit-spec.md) and need explicit discussion first.
- New dependencies must justify themselves. Boring tech: Postgres + Node.

Looking for somewhere to start? See [docs/good-first-issues.md](docs/good-first-issues.md).
