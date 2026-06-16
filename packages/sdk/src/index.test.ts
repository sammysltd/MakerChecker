import { describe, expect, it, vi } from "vitest";

import { ApiError, createClient, GovernanceDeniedError, governedTool } from "./index.js";

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function lastCall(f: typeof fetch): { url: string; init: RequestInit } {
  const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const [url, init] = calls[calls.length - 1] as [string, RequestInit];
  return { url, init };
}

describe("createClient", () => {
  it("calls /healthz against the base URL", async () => {
    const f = mockFetch(200, { status: "ok", schemaVersion: 1 });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    await expect(client.health()).resolves.toEqual({ status: "ok", schemaVersion: 1 });
    expect(f).toHaveBeenCalledWith("http://api.example/healthz", {
      method: "GET",
      headers: {},
    });
  });

  it("strips trailing slashes from the base URL", async () => {
    const f = mockFetch(200, { status: "ok", schemaVersion: 1 });
    const client = createClient({ baseUrl: "http://api.example///", fetch: f });
    await client.health();
    expect(lastCall(f).url).toBe("http://api.example/healthz");
  });

  it("sends the API key as a bearer token when configured", async () => {
    const f = mockFetch(200, { status: "ok", schemaVersion: 1 });
    const client = createClient({ baseUrl: "http://api.example", apiKey: "mk_test", fetch: f });
    await client.health();
    expect(lastCall(f).init.headers).toEqual({ authorization: "Bearer mk_test" });
  });

  it("falls back to the global fetch when none is provided", async () => {
    const f = mockFetch(200, { status: "ok", schemaVersion: 1 });
    vi.stubGlobal("fetch", f);
    try {
      const client = createClient({ baseUrl: "http://api.example" });
      await expect(client.health()).resolves.toEqual({ status: "ok", schemaVersion: 1 });
      expect(f).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws ApiError with status and body on non-2xx responses", async () => {
    const f = mockFetch(503, { error: "down" });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).body).toContain("down");
  });
});

describe("flows", () => {
  it("triggers a run with input, URL-encoding the flow name", async () => {
    const f = mockFetch(201, { runId: "r-1" });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    await expect(client.flows.trigger("my flow", { a: 1 })).resolves.toEqual({ runId: "r-1" });
    const { url, init } = lastCall(f);
    expect(url).toBe("http://api.example/api/flows/my%20flow/runs");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ input: { a: 1 } });
  });

  it("triggers a run without input using an empty body", async () => {
    const f = mockFetch(201, { runId: "r-2" });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    await client.flows.trigger("recon");
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({});
  });
});

describe("runs", () => {
  it("lists runs", async () => {
    const f = mockFetch(200, { runs: [{ id: "r-1", status: "completed" }] });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    const res = await client.runs.list();
    expect(res.runs[0]!.id).toBe("r-1");
    expect(lastCall(f).url).toBe("http://api.example/api/runs");
  });

  it("gets a run by id", async () => {
    const f = mockFetch(200, { run: { id: "r-1" }, steps: [], approvals: [], auditEvents: [] });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    const res = await client.runs.get("r-1");
    expect(res.run.id).toBe("r-1");
    expect(lastCall(f).url).toBe("http://api.example/api/runs/r-1");
  });
});

describe("approvals", () => {
  it("lists pending approvals", async () => {
    const f = mockFetch(200, { approvals: [{ id: "a-1" }] });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    await client.approvals.list();
    expect(lastCall(f).url).toBe("http://api.example/api/approvals");
  });

  it("decides an approval with a reason", async () => {
    const f = mockFetch(200, { ok: true });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    await client.approvals.decide("a-1", "approved", "looks right");
    const { url, init } = lastCall(f);
    expect(url).toBe("http://api.example/api/approvals/a-1/decision");
    expect(JSON.parse(init.body as string)).toEqual({
      decision: "approved",
      reason: "looks right",
    });
  });

  it("decides an approval without a reason (field omitted)", async () => {
    const f = mockFetch(200, { ok: true });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    await client.approvals.decide("a-1", "rejected");
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({ decision: "rejected" });
  });
});

describe("agents", () => {
  it("lists, creates, gets, and sets status", async () => {
    const f = mockFetch(200, {
      agents: [],
      agent: { id: "ag-1" },
      skills: [],
      recentRuns: [],
    });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });

    await client.agents.list();
    expect(lastCall(f).url).toBe("http://api.example/api/agents");

    await client.agents.create({ name: "bot", roleName: "ops" });
    expect(lastCall(f).url).toBe("http://api.example/api/agents");
    expect(lastCall(f).init.method).toBe("POST");
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({
      name: "bot",
      roleName: "ops",
    });

    await client.agents.get("ag-1");
    expect(lastCall(f).url).toBe("http://api.example/api/agents/ag-1");

    await client.agents.setStatus("ag-1", "suspended");
    expect(lastCall(f).url).toBe("http://api.example/api/agents/ag-1/status");
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({ status: "suspended" });
  });
});

describe("roles", () => {
  it("lists and creates roles", async () => {
    const f = mockFetch(200, { roles: [], role: { id: "ro-1" } });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });

    await client.roles.list();
    expect(lastCall(f).url).toBe("http://api.example/api/roles");

    await client.roles.create({ name: "ops", description: "d" });
    expect(lastCall(f).init.method).toBe("POST");
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({
      name: "ops",
      description: "d",
    });
  });
});

describe("skills", () => {
  it("lists, publishes, and deprecates skills", async () => {
    const f = mockFetch(200, { skills: [], skill: { id: "sk-1" } });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });

    await client.skills.list();
    expect(lastCall(f).url).toBe("http://api.example/api/skills");

    await client.skills.publish({
      name: "csv-ingest",
      version: 2,
      description: "d",
      inputSchema: {},
      outputSchema: {},
      implementation: { type: "local" },
      riskTier: "low",
    });
    expect(lastCall(f).url).toBe("http://api.example/api/skills");
    expect(lastCall(f).init.method).toBe("POST");

    await client.skills.deprecate("sk-1");
    expect(lastCall(f).url).toBe("http://api.example/api/skills/sk-1/deprecate");
  });
});

describe("grants", () => {
  it("creates and revokes grants", async () => {
    const f = mockFetch(200, { grant: { id: "g-1" } });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });

    await client.grants.create({ roleId: "ro-1", skillId: "sk-1" });
    expect(lastCall(f).url).toBe("http://api.example/api/grants");
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({
      roleId: "ro-1",
      skillId: "sk-1",
    });

    await client.grants.revoke("g-1");
    expect(lastCall(f).url).toBe("http://api.example/api/grants/g-1/revoke");
  });
});

describe("audit", () => {
  it("verifies the chain", async () => {
    const f = mockFetch(200, { ok: true, count: 12, headHash: "abc" });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    await expect(client.audit.verify()).resolves.toEqual({ ok: true, count: 12, headHash: "abc" });
    expect(lastCall(f).url).toBe("http://api.example/api/audit/verify");
  });
});

describe("proxy", () => {
  it("opens a session, omitting externalRef when not given", async () => {
    const f = mockFetch(201, { session: { id: "ps-1", status: "open" } });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });

    await client.proxy.openSession({ label: "langgraph-run" });
    expect(lastCall(f).url).toBe("http://api.example/api/proxy/sessions");
    expect(lastCall(f).init.method).toBe("POST");
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({ label: "langgraph-run" });

    await client.proxy.openSession({ label: "crew", externalRef: "thread-42" });
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({
      label: "crew",
      externalRef: "thread-42",
    });
  });

  it("checks with and without input", async () => {
    const f = mockFetch(200, { allowed: true, checkId: "ck-1" });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });

    const res = await client.proxy.check("ps-1", {
      agentName: "bot",
      skillRef: "csv-ingest@1",
      input: { path: "/tmp/x.csv" },
    });
    expect(res).toEqual({ allowed: true, checkId: "ck-1" });
    expect(lastCall(f).url).toBe("http://api.example/api/proxy/sessions/ps-1/check");
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({
      agentName: "bot",
      skillRef: "csv-ingest@1",
      input: { path: "/tmp/x.csv" },
    });

    await client.proxy.check("ps-1", { agentName: "bot", skillRef: "csv-ingest@1" });
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({
      agentName: "bot",
      skillRef: "csv-ingest@1",
    });
  });

  it("records results and errors, omitting absent fields", async () => {
    const f = mockFetch(200, { ok: true });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });

    await client.proxy.record("ps-1", { checkId: "ck-1", output: { rows: 3 } });
    expect(lastCall(f).url).toBe("http://api.example/api/proxy/sessions/ps-1/record");
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({
      checkId: "ck-1",
      output: { rows: 3 },
    });

    await client.proxy.record("ps-1", { checkId: "ck-2", error: { message: "boom" } });
    expect(JSON.parse(lastCall(f).init.body as string)).toEqual({
      checkId: "ck-2",
      error: { message: "boom" },
    });
  });

  it("closes and gets a session", async () => {
    const f = mockFetch(200, {
      session: { id: "ps-1", status: "closed" },
      actions: [],
      auditEvents: [],
    });
    const client = createClient({ baseUrl: "http://api.example", fetch: f });

    await client.proxy.closeSession("ps-1");
    expect(lastCall(f).url).toBe("http://api.example/api/proxy/sessions/ps-1/close");
    expect(lastCall(f).init.method).toBe("POST");

    const detail = await client.proxy.getSession("ps-1");
    expect(lastCall(f).url).toBe("http://api.example/api/proxy/sessions/ps-1");
    expect(detail.actions).toEqual([]);
  });
});

describe("governedTool", () => {
  function sequencedFetch(responses: Array<{ status: number; body: unknown }>) {
    let i = 0;
    return vi.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  it("happy path: checks, runs the tool, records the output, returns it", async () => {
    const f = sequencedFetch([
      { status: 200, body: { allowed: true, checkId: "ck-1" } },
      { status: 200, body: { ok: true } },
    ]);
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    const fn = vi.fn(async (input: { n: number }) => ({ doubled: input.n * 2 }));

    const tool = governedTool(client, "ps-1", "bot", "double@1", fn);
    await expect(tool({ n: 21 })).resolves.toEqual({ doubled: 42 });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ n: 21 });
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toBe("http://api.example/api/proxy/sessions/ps-1/check");
    expect(JSON.parse((calls[0]![1] as RequestInit).body as string)).toEqual({
      agentName: "bot",
      skillRef: "double@1",
      input: { n: 21 },
    });
    expect(calls[1]![0]).toBe("http://api.example/api/proxy/sessions/ps-1/record");
    expect(JSON.parse((calls[1]![1] as RequestInit).body as string)).toEqual({
      checkId: "ck-1",
      output: { doubled: 42 },
    });
  });

  it("denial: throws GovernanceDeniedError and never runs the tool", async () => {
    const f = sequencedFetch([
      {
        status: 200,
        body: { allowed: false, code: "skill_not_granted", reason: "no grant" },
      },
    ]);
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    const fn = vi.fn();

    const tool = governedTool(client, "ps-1", "bot", "forbidden@1", fn);
    const err = await tool({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GovernanceDeniedError);
    expect((err as GovernanceDeniedError).code).toBe("skill_not_granted");
    expect((err as GovernanceDeniedError).reason).toBe("no grant");
    expect((err as GovernanceDeniedError).message).toContain("skill_not_granted");

    expect(fn).not.toHaveBeenCalled();
    // Only the check call went out — nothing was recorded for a denied tool.
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("tool throw: records the error, then rethrows the original", async () => {
    const f = sequencedFetch([
      { status: 200, body: { allowed: true, checkId: "ck-9" } },
      { status: 200, body: { ok: true } },
    ]);
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    const tool = governedTool(client, "ps-1", "bot", "flaky@1", async () => {
      throw new Error("downstream exploded");
    });

    await expect(tool({})).rejects.toThrow("downstream exploded");
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toBe("http://api.example/api/proxy/sessions/ps-1/record");
    expect(JSON.parse((calls[1]![1] as RequestInit).body as string)).toEqual({
      checkId: "ck-9",
      error: { message: "downstream exploded" },
    });
  });

  it("non-Error throw values are stringified into the recorded error", async () => {
    const f = sequencedFetch([
      { status: 200, body: { allowed: true, checkId: "ck-2" } },
      { status: 200, body: { ok: true } },
    ]);
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    const tool = governedTool(client, "ps-1", "bot", "weird@1", () => {
      throw "string failure";
    });

    await expect(tool({})).rejects.toBe("string failure");
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.parse((calls[1]![1] as RequestInit).body as string)).toEqual({
      checkId: "ck-2",
      error: { message: "string failure" },
    });
  });

  it("undefined tool output records without an output field", async () => {
    const f = sequencedFetch([
      { status: 200, body: { allowed: true, checkId: "ck-3" } },
      { status: 200, body: { ok: true } },
    ]);
    const client = createClient({ baseUrl: "http://api.example", fetch: f });
    const tool = governedTool(client, "ps-1", "bot", "void@1", async () => undefined);

    await expect(tool({})).resolves.toBeUndefined();
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.parse((calls[1]![1] as RequestInit).body as string)).toEqual({
      checkId: "ck-3",
    });
  });
});
