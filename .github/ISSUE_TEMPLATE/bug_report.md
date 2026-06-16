---
name: Bug report
about: Something behaves incorrectly
labels: bug
---

**What happened**

A clear description of the bug.

**Expected behaviour**

What should have happened instead.

**Steps to reproduce**

1.
2.
3.

**Environment**

- MakerChecker commit/version:
- Deployment: docker compose / local dev / other
- Node and Postgres versions:
- Executor mode (from boot log): scripted / llm

**Evidence**

Relevant logs, the run's audit events (`GET /runs/:id`), or `audit verify` output. Redact secrets and API keys.

**Severity note**

If this is an enforcement bypass or audit tamper-evidence issue, do not file it here — follow [SECURITY.md](../../SECURITY.md) instead.
