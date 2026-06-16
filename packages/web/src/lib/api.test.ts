import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  decideApproval,
  getAgent,
  getApiKey,
  getFlow,
  getRole,
  getRun,
  getSkill,
  isApprovalGate,
  listAgents,
  listApprovals,
  listFlows,
  listRoles,
  listRuns,
  listSkills,
  setApiKey,
  triggerFlow,
  UNAUTHORIZED_EVENT,
  verifyAudit,
} from "./api";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function lastCall(fn: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const [url, init] = fn.mock.calls[fn.mock.calls.length - 1] as [string, RequestInit];
  return { url, init };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("API key storage", () => {
  it("round-trips through localStorage", () => {
    expect(getApiKey()).toBeNull();
    setApiKey("mk_test");
    expect(getApiKey()).toBe("mk_test");
    setApiKey(null);
    expect(getApiKey()).toBeNull();
  });

  it("trims keys and treats blank as removal", () => {
    setApiKey("  mk_padded  ");
    expect(getApiKey()).toBe("mk_padded");
    setApiKey("   ");
    expect(getApiKey()).toBeNull();
  });
});

describe("request behaviour", () => {
  it("attaches the bearer header when a key is stored", async () => {
    setApiKey("mk_secret");
    const fn = mockFetch(200, { runs: [] });
    await listRuns();
    expect(lastCall(fn).init.headers).toEqual({ authorization: "Bearer mk_secret" });
  });

  it("sends no auth header without a key", async () => {
    const fn = mockFetch(200, { runs: [] });
    await listRuns();
    expect(lastCall(fn).init.headers).toEqual({});
  });

  it("dispatches the unauthorized event on 401 and throws ApiError", async () => {
    mockFetch(401, { error: "missing API key" });
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);
    const err = await listRuns().catch((e: unknown) => e);
    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  it("throws ApiError with status and body on non-2xx", async () => {
    mockFetch(404, { error: "run not found" });
    const err = await getRun("nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).body).toContain("run not found");
    expect((err as ApiError).message).toContain("404");
  });
});

describe("endpoints", () => {
  it("lists runs", async () => {
    const fn = mockFetch(200, { runs: [{ id: "r1" }] });
    const res = await listRuns();
    expect(res.runs[0]!.id).toBe("r1");
    expect(lastCall(fn).url).toBe("/api/runs");
  });

  it("gets a run, URL-encoding the id", async () => {
    const fn = mockFetch(200, { run: { id: "r 1" }, steps: [], approvals: [], auditEvents: [] });
    await getRun("r 1");
    expect(lastCall(fn).url).toBe("/api/runs/r%201");
  });

  it("triggers a flow with empty body by default", async () => {
    const fn = mockFetch(201, { runId: "r2" });
    const res = await triggerFlow("daily-cash-reconciliation");
    expect(res.runId).toBe("r2");
    const { url, init } = lastCall(fn);
    expect(url).toBe("/api/flows/daily-cash-reconciliation/runs");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("triggers a flow with input when provided", async () => {
    const fn = mockFetch(201, { runId: "r3" });
    await triggerFlow("recon", { a: 1 });
    expect(JSON.parse(lastCall(fn).init.body as string)).toEqual({ input: { a: 1 } });
  });

  it("lists pending approvals", async () => {
    const fn = mockFetch(200, { approvals: [] });
    await listApprovals();
    expect(lastCall(fn).url).toBe("/api/approvals");
  });

  it("decides an approval with a reason", async () => {
    const fn = mockFetch(200, { ok: true });
    await decideApproval("a1", "rejected", "numbers do not reconcile");
    const { url, init } = lastCall(fn);
    expect(url).toBe("/api/approvals/a1/decision");
    expect(JSON.parse(init.body as string)).toEqual({
      decision: "rejected",
      reason: "numbers do not reconcile",
    });
  });

  it("decides an approval without a reason", async () => {
    const fn = mockFetch(200, { ok: true });
    await decideApproval("a1", "approved");
    expect(JSON.parse(lastCall(fn).init.body as string)).toEqual({ decision: "approved" });
  });

  it("verifies the audit chain", async () => {
    const fn = mockFetch(200, { ok: true, count: 42, headHash: "abc" });
    const res = await verifyAudit();
    expect(res).toEqual({ ok: true, count: 42, headHash: "abc" });
    expect(lastCall(fn).url).toBe("/api/audit/verify");
  });

  it("lists and gets agents", async () => {
    const fn = mockFetch(200, { agents: [] });
    await listAgents();
    expect(lastCall(fn).url).toBe("/api/agents");
    mockFetch(200, { agent: { id: "ag1" }, skills: [], recentRuns: [] });
    const detail = await getAgent("ag1");
    expect(detail.agent.id).toBe("ag1");
  });

  it("lists and gets skills", async () => {
    const fn = mockFetch(200, { skills: [] });
    await listSkills();
    expect(lastCall(fn).url).toBe("/api/skills");
    const fn2 = mockFetch(200, { skill: { id: "s1" }, grantHistory: [] });
    await getSkill("s1");
    expect(lastCall(fn2).url).toBe("/api/skills/s1");
  });

  it("lists and gets roles", async () => {
    const fn = mockFetch(200, { roles: [] });
    await listRoles();
    expect(lastCall(fn).url).toBe("/api/roles");
    const fn2 = mockFetch(200, { role: { id: "ro1" }, grants: [], sodConstraints: [] });
    await getRole("ro1");
    expect(lastCall(fn2).url).toBe("/api/roles/ro1");
  });

  it("lists and gets flows", async () => {
    const fn = mockFetch(200, { flows: [] });
    await listFlows();
    expect(lastCall(fn).url).toBe("/api/flows");
    const fn2 = mockFetch(200, { flow: { id: "f1" }, versions: [] });
    await getFlow("daily-cash-reconciliation");
    expect(lastCall(fn2).url).toBe("/api/flows/daily-cash-reconciliation");
  });
});

describe("isApprovalGate", () => {
  it("discriminates gate steps from agent steps", () => {
    expect(isApprovalGate({ key: "g", type: "approval_gate", title: "Review" })).toBe(true);
    expect(isApprovalGate({ key: "a", agent: "bot", skills: ["x@1"] })).toBe(false);
  });
});
