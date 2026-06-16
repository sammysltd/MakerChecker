import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Client } from "@makerchecker/sdk";

import { governClaudeTool, GovernanceDeniedError } from "./index.js";

/**
 * Minimal mock of the MakerChecker client's proxy surface. No server is
 * involved: `check` is programmed to allow or deny, and `record` is a spy we
 * assert against. Mirrors the connector-langchain test.
 */
function mockClient(opts: {
  check: () => Awaited<ReturnType<Client["proxy"]["check"]>>;
}): {
  client: Client;
  check: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
} {
  const check = vi.fn(async () => opts.check());
  const record = vi.fn(async () => ({ ok: true }));
  const client = { proxy: { check, record } } as unknown as Client;
  return { client, check, record };
}

const CTX = { sessionId: "ps-1", agentName: "recon-preparer", skillRef: "csv-ingest@1" };
const shape = { n: z.number() };

function okResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

describe("governClaudeTool", () => {
  it("preserves the name, description, and inputSchema on the governed tool", () => {
    const { client } = mockClient({ check: () => ({ allowed: true, checkId: "ck" }) });
    const t = governClaudeTool(client, CTX, "ingest", "ingest the CSVs", shape, async (a) =>
      okResult(String(a.n)),
    );
    expect(t.name).toBe("ingest");
    expect(t.description).toBe("ingest the CSVs");
    expect(t.inputSchema).toBe(shape);
  });

  it("granted: checks, runs the handler, records the output, returns it", async () => {
    const { client, check, record } = mockClient({
      check: () => ({ allowed: true, checkId: "ck-1" }),
    });
    const handler = vi.fn(async (a: { n: number }) => okResult(String(a.n * 2)));
    const t = governClaudeTool(client, CTX, "double", "doubles", shape, handler);

    const out = await t.handler({ n: 21 }, {});
    expect(out).toEqual(okResult("42"));
    expect(check).toHaveBeenCalledWith("ps-1", {
      agentName: "recon-preparer",
      skillRef: "csv-ingest@1",
      input: { n: 21 },
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith("ps-1", { checkId: "ck-1", output: okResult("42") });
  });

  it("denied: throws GovernanceDeniedError and NEVER invokes the handler", async () => {
    const { client, check, record } = mockClient({
      check: () => ({ allowed: false, code: "skill_not_granted", reason: "no grant" }),
    });
    const handler = vi.fn(async () => okResult("must not run"));
    const t = governClaudeTool(client, CTX, "blocked", "b", shape, handler);

    const err = await t.handler({ n: 1 }, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GovernanceDeniedError);
    expect((err as GovernanceDeniedError).code).toBe("skill_not_granted");
    expect((err as GovernanceDeniedError).reason).toBe("no grant");
    expect(handler).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledOnce();
    expect(record).not.toHaveBeenCalled();
  });

  it("handler throw: records the error, then rethrows the original", async () => {
    const { client, record } = mockClient({ check: () => ({ allowed: true, checkId: "ck-9" }) });
    const boom = new Error("downstream exploded");
    const t = governClaudeTool(client, CTX, "fails", "f", shape, async () => {
      throw boom;
    });

    await expect(t.handler({ n: 1 }, {})).rejects.toBe(boom);
    expect(record).toHaveBeenCalledWith("ps-1", {
      checkId: "ck-9",
      error: { message: "downstream exploded" },
    });
  });

  it("non-Error throw values are stringified into the recorded error", async () => {
    const { client, record } = mockClient({ check: () => ({ allowed: true, checkId: "ck-2" }) });
    const t = governClaudeTool(client, CTX, "weird", "throws a string", shape, async () => {
      throw "string failure";
    });

    await expect(t.handler({ n: 1 }, {})).rejects.toBe("string failure");
    expect(record).toHaveBeenCalledWith("ps-1", {
      checkId: "ck-2",
      error: { message: "string failure" },
    });
  });
});
