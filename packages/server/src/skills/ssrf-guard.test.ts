import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allowPrivateHosts,
  assertHostResolvesPublic,
  createPinnedFetch,
  isBlockedResolvedAddress,
  resolveAndCheckHost,
  SsrfBlockedError,
  type AllAddresses,
  type ResolveAllFn,
} from "./ssrf-guard.js";

// ---------------------------------------------------------------------------
// Connect-time IP pinning against DNS rebinding (issue #7).
//
// Threat model: a skill/webhook host that PASSES the static assertSafeHttpUrl
// check (public-looking hostname) but RESOLVES to a private/loopback/link-local
// address at connect time. The guard must resolve the host, re-check every
// resolved address with the same ruleset used for literal IPs, and reject if
// ANY address is blocked — honouring the MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS
// dev/test opt-in.
//
// These are pure-logic tests driven by an INJECTED resolver (no real DNS), so
// they are deterministic and exercise the exact bytes an attacker would return.
// ---------------------------------------------------------------------------

/** A resolver that always returns the given addresses (family inferred). */
function fixedResolver(addrs: AllAddresses): ResolveAllFn {
  return async () => addrs;
}

const PREV_ALLOW = process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;

afterEach(() => {
  if (PREV_ALLOW === undefined) delete process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;
  else process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = PREV_ALLOW;
  vi.restoreAllMocks();
});

function ensureFlagOff(): void {
  delete process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;
}

// ---------------------------------------------------------------------------
// allowPrivateHosts: mirrors the static guard's opt-in exactly.
// ---------------------------------------------------------------------------
describe("allowPrivateHosts", () => {
  it("is false unless the env var is exactly '1'", () => {
    ensureFlagOff();
    expect(allowPrivateHosts()).toBe(false);
    process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "0";
    expect(allowPrivateHosts()).toBe(false);
    process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "true";
    expect(allowPrivateHosts()).toBe(false);
    process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "1";
    expect(allowPrivateHosts()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isBlockedResolvedAddress: reuses isBlockedIpv4 / isBlockedIpv6 from invoker.
// ---------------------------------------------------------------------------
describe("isBlockedResolvedAddress (reuses the literal-IP ruleset)", () => {
  it.each([
    ["127.0.0.1", 4],
    ["10.0.0.5", 4],
    ["172.16.0.1", 4],
    ["192.168.1.1", 4],
    ["169.254.169.254", 4], // cloud metadata
    ["100.64.0.1", 4], // CGNAT
    ["0.0.0.0", 4],
  ] as const)("blocks private/loopback/link-local IPv4 %s", (ip, fam) => {
    expect(isBlockedResolvedAddress(ip, fam)).toBe(true);
  });

  it.each([
    ["::1", 6], // loopback
    ["::", 6], // unspecified
    ["fe80::1", 6], // link-local
    ["fc00::1", 6], // unique-local
    ["fd12:3456::1", 6], // unique-local
    ["::ffff:127.0.0.1", 6], // IPv4-mapped loopback
    ["::ffff:169.254.169.254", 6], // IPv4-mapped metadata
    ["::7f00:1", 6], // IPv4-compatible loopback (127.0.0.1 in hex)
    ["::a9fe:a9fe", 6], // IPv4-compatible metadata (169.254.169.254 in hex)
    ["::a00:1", 6], // IPv4-compatible private (10.0.0.1 in hex)
  ] as const)("blocks private/loopback/link-local IPv6 %s", (ip, fam) => {
    expect(isBlockedResolvedAddress(ip, fam)).toBe(true);
  });

  it.each([
    ["8.8.8.8", 4],
    ["172.32.0.1", 4], // just outside the /12 private block
    ["192.169.0.1", 4],
    ["2606:4700:4700::1111", 6],
  ] as const)("allows public address %s", (ip, fam) => {
    expect(isBlockedResolvedAddress(ip, fam)).toBe(false);
  });

  it("sniffs the version from the literal even if the family hint lies", () => {
    // A v4 address mis-tagged family=6 must still be judged as v4 (blocked).
    expect(isBlockedResolvedAddress("127.0.0.1", 6)).toBe(true);
    // A v6 address mis-tagged family=4 must still be judged as v6 (blocked).
    expect(isBlockedResolvedAddress("::1", 4)).toBe(true);
    // Public address with a lying hint is still allowed.
    expect(isBlockedResolvedAddress("8.8.8.8", 6)).toBe(false);
  });

  it("fail-closed: an unparseable / non-IP address is blocked", () => {
    expect(isBlockedResolvedAddress("not-an-ip")).toBe(true);
    expect(isBlockedResolvedAddress("999.999.999.999", 4)).toBe(true);
    expect(isBlockedResolvedAddress("")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveAndCheckHost: the core resolve-then-check helper.
// ---------------------------------------------------------------------------
describe("resolveAndCheckHost (resolve-and-check helper)", () => {
  it("REJECTS a public hostname that resolves to a private IP (the rebinding attack)", async () => {
    ensureFlagOff();
    const resolve = fixedResolver([{ address: "10.0.0.5", family: 4 }]);
    await expect(resolveAndCheckHost("evil.example.com", resolve)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(resolveAndCheckHost("evil.example.com", resolve)).rejects.toThrow(
      /blocked.*10\.0\.0\.5/,
    );
  });

  it("REJECTS the cloud-metadata IP behind a public name", async () => {
    ensureFlagOff();
    const resolve = fixedResolver([{ address: "169.254.169.254", family: 4 }]);
    await expect(resolveAndCheckHost("metadata-proxy.attacker.test", resolve)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("ALLOWS a public hostname that resolves to a public IP", async () => {
    ensureFlagOff();
    const resolve = fixedResolver([{ address: "93.184.216.34", family: 4 }]);
    await expect(resolveAndCheckHost("good.example.com", resolve)).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  it("ADVERSARIAL: rejects when ANY address in a mixed set is private (not just the first)", async () => {
    ensureFlagOff();
    // Attacker returns a public A-record first to look benign, then a private one
    // the connector might otherwise pick. Every address must be checked.
    const resolve = fixedResolver([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(resolveAndCheckHost("mixed.example.com", resolve)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("ADVERSARIAL: rejects a private AAAA hiding behind a public A", async () => {
    ensureFlagOff();
    const resolve = fixedResolver([
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ]);
    await expect(resolveAndCheckHost("dual.example.com", resolve)).rejects.toThrow(/::1/);
  });

  it("rejects a host that resolves to NO addresses (fail-closed)", async () => {
    ensureFlagOff();
    await expect(resolveAndCheckHost("empty.example.com", fixedResolver([]))).rejects.toThrow(
      /did not resolve/,
    );
  });

  it("propagates a resolver error (e.g. NXDOMAIN) rather than allowing connect", async () => {
    ensureFlagOff();
    const boom: ResolveAllFn = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(resolveAndCheckHost("nope.example.com", boom)).rejects.toThrow(/ENOTFOUND/);
  });

  it("short-circuits an IP-literal host without calling the resolver", async () => {
    ensureFlagOff();
    const resolve = vi.fn<ResolveAllFn>();
    // public literal: allowed, resolver untouched
    await expect(resolveAndCheckHost("8.8.8.8", resolve)).resolves.toEqual([
      { address: "8.8.8.8", family: 4 },
    ]);
    // private literal: blocked, resolver untouched
    await expect(resolveAndCheckHost("127.0.0.1", resolve)).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("strips IPv6 brackets from a [literal] host (URL.hostname form)", async () => {
    ensureFlagOff();
    const resolve = vi.fn<ResolveAllFn>();
    await expect(resolveAndCheckHost("[::1]", resolve)).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolveAndCheckHost("[2606:4700:4700::1111]", resolve)).resolves.toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(resolve).not.toHaveBeenCalled();
  });

  describe("MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS=1 opt-in (dev/test)", () => {
    it("allows a private resolved IP and still returns it for pinning", async () => {
      process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "1";
      const resolve = fixedResolver([{ address: "127.0.0.1", family: 4 }]);
      await expect(resolveAndCheckHost("localhost", resolve)).resolves.toEqual([
        { address: "127.0.0.1", family: 4 },
      ]);
    });

    it("allows a private IP literal under the flag", async () => {
      process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "1";
      await expect(resolveAndCheckHost("127.0.0.1")).resolves.toEqual([
        { address: "127.0.0.1", family: 4 },
      ]);
    });

    it("STILL rejects an empty resolution even under the flag (no usable address)", async () => {
      process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "1";
      await expect(resolveAndCheckHost("empty.test", fixedResolver([]))).rejects.toThrow(
        /did not resolve/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// assertHostResolvesPublic: up-front host check run before the MCP transport.
// ---------------------------------------------------------------------------
describe("assertHostResolvesPublic (MCP up-front check)", () => {
  it("throws for a host that resolves to a private IP", async () => {
    ensureFlagOff();
    await expect(
      assertHostResolvesPublic("evil.test", fixedResolver([{ address: "10.1.2.3", family: 4 }])),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("resolves quietly for a public IP", async () => {
    ensureFlagOff();
    await expect(
      assertHostResolvesPublic("good.test", fixedResolver([{ address: "8.8.8.8", family: 4 }])),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createPinnedFetch: the connect-time-pinned fetch. We drive its connect hook
// through the injected resolver and assert the rebinding case is refused at
// connect (the fetch rejects, with our SsrfBlockedError as the cause) while a
// public resolution proceeds to a real socket.
// ---------------------------------------------------------------------------
describe("createPinnedFetch (connect-time pinning)", () => {
  it("REFUSES to connect when the host resolves to a private IP (rebinding blocked at connect)", async () => {
    ensureFlagOff();
    const { fetch, agent } = createPinnedFetch(
      fixedResolver([{ address: "169.254.169.254", family: 4 }]),
    );
    try {
      const err = await fetch("http://rebind.example.com/x").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeTruthy();
      // undici wraps the connector-hook rejection as the fetch failure's cause.
      const cause = (err as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(SsrfBlockedError);
    } finally {
      await agent.close();
    }
  });

  it("ADVERSARIAL: refuses even when a public A is returned alongside a private one", async () => {
    ensureFlagOff();
    const { fetch, agent } = createPinnedFetch(
      fixedResolver([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.9", family: 4 },
      ]),
    );
    try {
      const err = await fetch("http://mixed.example.com/x").then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as { cause?: unknown }).cause).toBeInstanceOf(SsrfBlockedError);
    } finally {
      await agent.close();
    }
  });

  it("PINS to the validated address and connects (public resolution proceeds)", async () => {
    // Stand up a real loopback HTTP server, then make the pinned fetch resolve
    // the (fake) public hostname to that loopback address. With the opt-in flag
    // ON, the loopback address is permitted, and the connect hook must hand that
    // exact address to undici so the connection lands on our server. This proves
    // the happy path connects through the pinned Agent (not just that it rejects).
    process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "1";
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pinned: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    // Resolve any hostname to our loopback server. Pinning means undici connects
    // to exactly this address, regardless of what real DNS would say.
    const { fetch, agent } = createPinnedFetch(
      fixedResolver([{ address: "127.0.0.1", family: 4 }]),
    );
    try {
      const res = await fetch(`http://pinned.example.com:${port}/x`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pinned: true });
    } finally {
      await agent.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("REFUSES that same loopback target when the opt-in flag is OFF", async () => {
    // Symmetric to the previous test: with the flag off, resolving to a loopback
    // address must be refused at the connect hook (no socket to our server).
    ensureFlagOff();
    const { createServer } = await import("node:http");
    let hit = false;
    const server = createServer((_req, res) => {
      hit = true;
      res.writeHead(200).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const { fetch, agent } = createPinnedFetch(
      fixedResolver([{ address: "127.0.0.1", family: 4 }]),
    );
    try {
      const err = await fetch(`http://blocked.example.com:${port}/x`).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as { cause?: unknown }).cause).toBeInstanceOf(SsrfBlockedError);
      expect(hit).toBe(false); // the server was never reached
    } finally {
      await agent.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("propagates a resolver failure as a connect error (fail-closed)", async () => {
    ensureFlagOff();
    const boom: ResolveAllFn = async () => {
      throw new Error("ENOTFOUND boom");
    };
    const { fetch, agent } = createPinnedFetch(boom);
    try {
      const err = await fetch("http://nope.example.com/x").then(
        () => null,
        (e: unknown) => e,
      );
      expect(String((err as { cause?: { message?: string } }).cause?.message)).toContain(
        "ENOTFOUND",
      );
    } finally {
      await agent.close();
    }
  });

  it("coerces a non-Error rejection into an Error for the connect callback", async () => {
    // Defensive: a resolver that rejects with a non-Error value must still
    // surface as a usable connect error (toErrno wraps it), never crash undici.
    ensureFlagOff();
    const weird: ResolveAllFn = () => Promise.reject("string failure");
    const { fetch, agent } = createPinnedFetch(weird);
    try {
      const err = await fetch("http://weird.example.com/x").then(
        () => null,
        (e: unknown) => e,
      );
      expect(String((err as { cause?: { message?: string } }).cause?.message)).toContain(
        "string failure",
      );
    } finally {
      await agent.close();
    }
  });
});
