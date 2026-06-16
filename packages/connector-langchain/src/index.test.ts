import { tool } from "@langchain/core/tools";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Client } from "@makerchecker/sdk";

import { governLangChainTool, governToolkit, GovernanceDeniedError } from "./index.js";

/**
 * A minimal mock of the MakerChecker client's proxy surface. No server is
 * involved: `check` is programmed to allow or deny, and `record` is a spy we
 * assert against. Everything else on the client is unused by the connector.
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
  const client = {
    proxy: { check, record },
  } as unknown as Client;
  return { client, check, record };
}

const Schema = z.object({ n: z.number() });

/** A real @langchain/core tool whose handler is a spy. */
function makeTool(handler: (input: { n: number }) => unknown) {
  const fn = vi.fn(handler);
  const t = tool(async (input: { n: number }) => fn(input), {
    name: "double",
    description: "doubles a number",
    schema: Schema,
  });
  return { tool: t, fn };
}

const CTX = { sessionId: "ps-1", agentName: "bot", skillRef: "double@1" };

describe("governLangChainTool", () => {
  it("preserves the name, description, and schema on the wrapper", () => {
    const { tool: underlying } = makeTool((i) => ({ doubled: i.n * 2 }));
    const governed = governLangChainTool(mockClient({ check: () => ({ allowed: true, checkId: "ck" }) }).client, CTX, underlying);

    expect(governed.name).toBe("double");
    expect(governed.description).toBe("doubles a number");
    // The exact same schema object the underlying tool advertises.
    expect(governed.schema).toBe(underlying.schema);
  });

  it("granted: checks, runs the underlying tool, records the output, returns it", async () => {
    const { client, check, record } = mockClient({
      check: () => ({ allowed: true, checkId: "ck-1" }),
    });
    const { tool: underlying, fn } = makeTool((i) => ({ doubled: i.n * 2 }));
    const governed = governLangChainTool(client, CTX, underlying);

    const out = (await governed.invoke({ n: 21 })) as unknown;
    expect(out).toEqual({ doubled: 42 });

    expect(check).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledWith("ps-1", {
      agentName: "bot",
      skillRef: "double@1",
      input: { n: 21 },
    });
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith({ n: 21 });
    expect(record).toHaveBeenCalledWith("ps-1", {
      checkId: "ck-1",
      output: { doubled: 42 },
    });
  });

  it("denied: throws GovernanceDeniedError and NEVER invokes the underlying tool", async () => {
    const { client, check, record } = mockClient({
      check: () => ({ allowed: false, code: "skill_not_granted", reason: "no grant" }),
    });
    const { tool: underlying, fn } = makeTool(() => {
      throw new Error("must not run");
    });
    const governed = governLangChainTool(client, CTX, underlying);

    const err = await governed.invoke({ n: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GovernanceDeniedError);
    expect((err as GovernanceDeniedError).code).toBe("skill_not_granted");
    expect((err as GovernanceDeniedError).reason).toBe("no grant");

    // The whole point: the deny stops execution before the tool body.
    expect(fn).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledOnce();
    // Nothing recorded for a denied call.
    expect(record).not.toHaveBeenCalled();
  });

  it("underlying throw: records the error, then rethrows the original Error", async () => {
    const { client, record } = mockClient({
      check: () => ({ allowed: true, checkId: "ck-9" }),
    });
    const boom = new Error("downstream exploded");
    const { tool: underlying } = makeTool(() => {
      throw boom;
    });
    const governed = governLangChainTool(client, CTX, underlying);

    await expect(governed.invoke({ n: 1 })).rejects.toThrow("downstream exploded");
    expect(record).toHaveBeenCalledWith("ps-1", {
      checkId: "ck-9",
      error: { message: "downstream exploded" },
    });
  });

  it("non-Error throw values are stringified into the recorded error", async () => {
    const { client, record } = mockClient({
      check: () => ({ allowed: true, checkId: "ck-2" }),
    });
    // A DynamicStructuredTool wraps non-Error throws into a ToolException, so
    // drive the wrapper directly with a raw underlying tool whose invoke throws
    // a bare string to exercise the String(err) branch.
    const underlying = {
      name: "weird",
      description: "throws a string",
      schema: Schema,
      invoke: async () => {
        throw "string failure";
      },
    } as unknown as Parameters<typeof governLangChainTool>[2];
    const governed = governLangChainTool(client, CTX, underlying);

    await expect(governed.invoke({ n: 1 })).rejects.toBe("string failure");
    expect(record).toHaveBeenCalledWith("ps-1", {
      checkId: "ck-2",
      error: { message: "string failure" },
    });
  });

  it("undefined output is recorded without an output field", async () => {
    const { client, record } = mockClient({
      check: () => ({ allowed: true, checkId: "ck-3" }),
    });
    const underlying = {
      name: "void",
      description: "returns nothing",
      schema: Schema,
      invoke: async () => undefined,
    } as unknown as Parameters<typeof governLangChainTool>[2];
    const governed = governLangChainTool(client, CTX, underlying);

    await expect(governed.invoke({ n: 1 })).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledWith("ps-1", { checkId: "ck-3" });
  });

  it("omits the input field from check when the input is not a plain object", async () => {
    const { client, check } = mockClient({
      check: () => ({ allowed: true, checkId: "ck-4" }),
    });
    const underlying = {
      name: "scalar",
      description: "takes a scalar",
      schema: z.string(),
      invoke: async () => "ok",
    } as unknown as Parameters<typeof governLangChainTool>[2];
    const governed = governLangChainTool(client, CTX, underlying);

    await governed.invoke("just a string" as never);
    expect(check).toHaveBeenCalledWith("ps-1", {
      agentName: "bot",
      skillRef: "double@1",
    });
  });
});

describe("governToolkit", () => {
  it("maps over tools resolving skillRefs from a record, sharing session and agent", async () => {
    const { client, check } = mockClient({
      check: () => ({ allowed: true, checkId: "ck" }),
    });
    const { tool: a } = makeTool((i) => i.n);
    const b = tool(async () => "ok", {
      name: "greet",
      description: "greets",
      schema: z.object({ name: z.string() }),
    });

    const governed = governToolkit(
      client,
      { sessionId: "ps-9", agentName: "crew" },
      [a, b],
      { double: "double@1", greet: "greet@2" },
    );

    expect(governed.map((t) => t.name)).toEqual(["double", "greet"]);

    await governed[0]!.invoke({ n: 3 });
    expect(check).toHaveBeenLastCalledWith("ps-9", {
      agentName: "crew",
      skillRef: "double@1",
      input: { n: 3 },
    });

    await governed[1]!.invoke({ name: "x" });
    expect(check).toHaveBeenLastCalledWith("ps-9", {
      agentName: "crew",
      skillRef: "greet@2",
      input: { name: "x" },
    });
  });

  it("resolves skillRefs from a function", async () => {
    const { client, check } = mockClient({
      check: () => ({ allowed: true, checkId: "ck" }),
    });
    const { tool: a } = makeTool((i) => i.n);

    const governed = governToolkit(
      client,
      { sessionId: "ps-fn", agentName: "crew" },
      [a],
      (t) => `${t.name}@7`,
    );

    await governed[0]!.invoke({ n: 1 });
    expect(check).toHaveBeenLastCalledWith("ps-fn", {
      agentName: "crew",
      skillRef: "double@7",
      input: { n: 1 },
    });
  });

  it("fails closed: throws for a tool with no mapped skillRef", () => {
    const { client } = mockClient({ check: () => ({ allowed: true, checkId: "ck" }) });
    const { tool: a } = makeTool((i) => i.n);

    expect(() =>
      governToolkit(client, { sessionId: "ps", agentName: "crew" }, [a], {
        somethingElse: "x@1",
      }),
    ).toThrow(/no skillRef mapped for tool "double"/);
  });
});
