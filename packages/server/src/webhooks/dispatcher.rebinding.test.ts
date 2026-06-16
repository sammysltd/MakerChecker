import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level node:dns mock so we can make a public-LOOKING webhook hostname
// "resolve" to a chosen address. Isolated in its own file so the global module
// mock does not leak into the real webhook integration suite. The connect-time
// pin (undici Agent connect hook) re-checks each resolved address; with the
// allow-flag OFF, a resolved private/loopback address must be REFUSED at connect
// even though the static assertSafeHttpUrl check (which only sees the hostname)
// passed. This is the DNS-rebinding defence for the FULLY PINNED webhook path.
let nextLookup: { addresses?: Array<{ address: string; family: number }>; error?: Error } = {};

vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    lookup: (
      hostname: string,
      opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, addresses: unknown) => void,
    ): void => {
      // Real IP literals (e.g. 127.0.0.1) never reach here — the guard
      // short-circuits literals. Only the fake public hostname is intercepted;
      // anything else falls through to the real resolver.
      if (hostname === "rebind.victim.test") {
        if (nextLookup.error) cb(nextLookup.error as NodeJS.ErrnoException, []);
        else cb(null, nextLookup.addresses ?? []);
        return;
      }
      (actual.lookup as unknown as (h: string, o: unknown, c: unknown) => void)(hostname, opts, cb);
    },
  };
});

const { deliverWithRetryForTest, webhookFailureCount } = await import("./dispatcher.js");

// ---------------------------------------------------------------------------
// Webhook DNS-rebinding defence (issue #7): the pinned fetch must refuse a
// webhook whose hostname resolves to a private/loopback/link-local IP, counting
// it as a failed delivery and never POSTing.
// ---------------------------------------------------------------------------
let server: Server;
let serverPort: number;
let hits = 0;

const PREV_ALLOW = process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = 0;
});

afterEach(() => {
  if (PREV_ALLOW === undefined) delete process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;
  else process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = PREV_ALLOW;
});

describe("webhook connect-time pin (DNS rebinding)", () => {
  it("REFUSES a webhook host that resolves to loopback (flag off) — no POST, counted as failure", async () => {
    // Static guard sees only the public hostname and passes it; the connect hook
    // then resolves it to our loopback server and must refuse the connection.
    delete process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;
    nextLookup = { addresses: [{ address: "127.0.0.1", family: 4 }] };
    const before = webhookFailureCount();
    await deliverWithRetryForTest(
      { url: `http://rebind.victim.test:${serverPort}/hook`, secret: "s" },
      "x.test",
      "{}",
      [1, 1],
    );
    expect(hits).toBe(0); // the loopback server was never reached
    expect(webhookFailureCount()).toBe(before + 1);
  });

  it("ADVERSARIAL: refuses a webhook host that resolves to the cloud-metadata IP", async () => {
    delete process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS;
    nextLookup = { addresses: [{ address: "169.254.169.254", family: 4 }] };
    const before = webhookFailureCount();
    await deliverWithRetryForTest(
      { url: "http://rebind.victim.test/hook", secret: "s" },
      "x.test",
      "{}",
      [1, 1],
    );
    expect(webhookFailureCount()).toBe(before + 1);
  });

  it("DELIVERS to the same loopback target when the resolver is allowed (flag on, pin proceeds)", async () => {
    // With the opt-in flag ON, the pinned connect hook permits the loopback
    // address and pins to it — so the delivery actually lands on our server.
    process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS = "1";
    nextLookup = { addresses: [{ address: "127.0.0.1", family: 4 }] };
    await deliverWithRetryForTest(
      { url: `http://rebind.victim.test:${serverPort}/hook`, secret: "s" },
      "x.test",
      "{}",
      [1, 1],
    );
    expect(hits).toBe(1);
  });
});
