import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level mock of node:dns so we can drive what an MCP host "resolves" to.
// This lives in its own test file because the mock is global to the module
// graph; keeping it isolated avoids polluting the other invoker suites. The mock
// returns whatever `nextLookup` is set to for each test.
let nextLookup: { addresses?: Array<{ address: string; family: number }>; error?: Error } = {
  addresses: [{ address: "93.184.216.34", family: 4 }],
};

vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    lookup: (
      _hostname: string,
      _opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, addresses: unknown) => void,
    ): void => {
      if (nextLookup.error) cb(nextLookup.error as NodeJS.ErrnoException, []);
      else cb(null, nextLookup.addresses ?? []);
    },
  };
});

const { SkillInvoker } = await import("./invoker.js");
type SkillRow = import("./invoker.js").SkillRow;

// ---------------------------------------------------------------------------
// MCP StreamableHTTP transport: SSRF / DNS-rebinding protection (issue #7).
//
// The MCP http transport connects through the same connect-time-pinned fetch as
// the HTTP skill and webhook paths, and the invoker also validates the host up
// front (assertHostResolvesPublic) before the transport is built. These tests
// prove that wiring: a public-looking hostname whose A-record is a private or
// metadata IP is refused as input_invalid before any connection is made.
// ---------------------------------------------------------------------------
function makeSkill(implementation: Record<string, unknown>): SkillRow {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    name: "evil-mcp",
    version: 1,
    description: "",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    implementation,
    risk_tier: "low",
  };
}

function makeInvoker(skill: SkillRow): InstanceType<typeof SkillInvoker> {
  const pool = {
    query: vi.fn(async () => ({ rows: [skill] })),
  } as unknown as ConstructorParameters<typeof SkillInvoker>[0];
  return new SkillInvoker(pool);
}

const PREV_ALLOW = process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;

describe("MCP http transport SSRF / rebinding check", () => {
  beforeEach(() => {
    delete process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;
  });
  afterEach(() => {
    if (PREV_ALLOW === undefined) delete process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;
    else process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = PREV_ALLOW;
    nextLookup = { addresses: [{ address: "93.184.216.34", family: 4 }] };
  });

  it("rejects a public-looking MCP host that RESOLVES to a private IP", async () => {
    nextLookup = { addresses: [{ address: "10.0.0.5", family: 4 }] };
    const invoker = makeInvoker(
      makeSkill({
        type: "mcp",
        transport: "http",
        url: "https://internal-via-dns.example.com/mcp",
        tool: "x",
      }),
    );
    await expect(
      invoker.invoke("evil-mcp@1", {}, new AbortController().signal),
    ).rejects.toMatchObject({ name: "SkillInvocationError", code: "input_invalid" });
    await invoker.close();
  });

  it("ADVERSARIAL: rejects an MCP host resolving to the cloud-metadata IP", async () => {
    nextLookup = { addresses: [{ address: "169.254.169.254", family: 4 }] };
    const invoker = makeInvoker(
      makeSkill({
        type: "mcp",
        transport: "http",
        url: "https://metadata-proxy.attacker.test/mcp",
        tool: "x",
      }),
    );
    await expect(
      invoker.invoke("evil-mcp@1", {}, new AbortController().signal),
    ).rejects.toMatchObject({ name: "SkillInvocationError", code: "input_invalid" });
    await invoker.close();
  });

  it("ADVERSARIAL: rejects when ANY of multiple A-records is private", async () => {
    nextLookup = {
      addresses: [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    };
    const invoker = makeInvoker(
      makeSkill({
        type: "mcp",
        transport: "http",
        url: "https://mixed.example.com/mcp",
        tool: "x",
      }),
    );
    await expect(
      invoker.invoke("evil-mcp@1", {}, new AbortController().signal),
    ).rejects.toMatchObject({ name: "SkillInvocationError", code: "input_invalid" });
    await invoker.close();
  });
});
