# Good first issues

Scoped starter tasks for new contributors. Each has clear context and a
testable definition of done. Claim one by opening an issue referencing it.

1. **API-key management endpoints.** Keys are only created by the seed or
   `generateApiKey`. Add `POST /api/api-keys` (returns plaintext once),
   `GET /api/api-keys`, `POST /api/api-keys/:id/revoke`, all audited.
   Done when: covered by integration tests including revoked-key 401.

2. **Run list pagination.** `GET /api/runs` caps at 50 with no paging. Add
   `limit`/`before` cursor params. Done when: stable ordering proven by test.

3. **OpenAPI response schemas.** Routes declare operationIds but not response
   bodies. Add TypeBox response schemas to the run/approval routes. Done
   when: `/api/openapi.json` documents response shapes and CI stays green.

4. **`audit export --since <seq>` flag.** Incremental exports for large
   chains. Done when: a bundle exported from a mid-chain seq verifies with
   its manifest, which records that the first event's `prev_hash` links to the
   event immediately before the export window.

5. **pg-boss ExecutionBackend.** A second `ExecutionBackend` implementation
   proving the seam. Done when: the engine integration suite passes against
   it behind an env switch.

6. **Web accessibility pass.** Keyboard navigation and ARIA labels for the
   approvals inbox and run viewer (decision buttons, expandable JSON).
   Done when: testing-library queries by role cover the interactions.

7. **Helm chart.** `deploy/helm` with server + Postgres (or external DB
   values). Done when: `helm template` renders and a kind-cluster smoke test
   documents the steps.

8. **Devcontainer.** `.devcontainer` with Node 22 + Postgres 17 service so
   `pnpm run ci` passes out of the box. Done when: documented in
   CONTRIBUTING and verified in Codespaces.

9. **SoD constraint scopes.** `sod_constraints.scope` only supports
   `flow_run`. Add a `flow` scope (conflicting roles may never appear in
   the same flow definition, checked at publish). Done when: publish-time
   rejection is tested.

10. **Per-API-key rate limiting on approval decisions.** A global per-IP
    limiter already guards `/api` (`@fastify/rate-limit`, 100 req/min). Add a
    tighter *per-key* token bucket specifically on
    `POST /api/approvals/:id/decision` so a single credential cannot brute-force
    decisions behind a shared IP. Done when: 429 behavior is tested and the
    per-key limit is configurable.
