import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

import { isBlockedIpv4, isBlockedIpv6 } from "./invoker.js";

// ---------------------------------------------------------------------------
// Connect-time IP pinning against DNS rebinding for OUTBOUND HTTP.
//
// assertSafeHttpUrl (invoker.ts) rejects URLs whose host is a LITERAL
// private/loopback/link-local IP or a known internal hostname. It cannot, by
// itself, defeat DNS rebinding: a hostname that passes the static check but
// *resolves* to a private address at connect time would otherwise slip through
// (a public-looking name with a 169.254.169.254 A-record, say).
//
// This module closes that hole by resolving the host and re-checking EVERY
// resolved address with the exact same ruleset the static guard uses
// (isBlockedIpv4 / isBlockedIpv6 — one source of truth, imported, not copied).
//
// Two controls are provided; every outbound path uses the pinning fetch, and the
// MCP path layers the host check in front of it for defence in depth:
//
//  - createPinnedFetch(): a `fetch` backed by an undici Agent whose `connect`
//    lookup hook resolves the host, rejects if ANY address is blocked, and then
//    PINS the connection to exactly the validated address list. undici connects
//    to the addresses we returned, so there is no second, unchecked resolution
//    between our check and the TCP connect — the TOCTOU window is closed. This is
//    the control on every outbound path: the HTTP skill fetch, the outbound
//    webhook fetch, and the MCP StreamableHTTPClientTransport (which accepts our
//    fetch and so connects through the same pinned dispatcher).
//
//  - assertHostResolvesPublic(): an up-front resolve-then-check run before the
//    MCP transport is built, so an internal target is rejected before any
//    connection is attempted. The pinned fetch is what closes the TOCTOU window;
//    this check is a fast, early gate in front of it.
//
// The MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS=1 opt-in (the same flag the static
// guard honours) disables the private-IP rejection so localhost dev/test works.
// ---------------------------------------------------------------------------

/** Raised when a resolved address (or the resolution itself) is rejected. */
export class SsrfBlockedError extends Error {
  override name = "SsrfBlockedError";
}

/** Shape of the dns.lookup callback (all:true) — overridable in tests. */
export type AllAddresses = Array<{ address: string; family: number }>;
export type ResolveAllFn = (hostname: string) => Promise<AllAddresses>;

/**
 * True when private/loopback/link-local addresses are explicitly permitted
 * (dev/test). Mirrors assertSafeHttpUrl's opt-in so the two guards never
 * disagree about whether localhost is allowed. Resolved per call so tests can
 * toggle it without a module reload.
 */
export function allowPrivateHosts(): boolean {
  return process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS === "1";
}

/**
 * Classify a single resolved address with the SAME ruleset the static URL guard
 * applies to literal IPs. An unrecognized / unparseable address is treated as
 * blocked (fail-closed). family is the DNS family hint (4/6); we additionally
 * sniff via isIP so a v4 address surfacing in a v6 lookup is still judged as v4.
 */
export function isBlockedResolvedAddress(address: string, family?: number): boolean {
  const detected = isIP(address);
  const v = detected !== 0 ? detected : family;
  if (v === 4) return isBlockedIpv4(address);
  if (v === 6) return isBlockedIpv6(address);
  // Neither a clean v4 nor v6 literal: we cannot prove it is safe — block it.
  return true;
}

/**
 * Resolve `hostname` to all addresses and assert NONE is private/loopback/
 * link-local. Returns the validated address list (so a pinning caller can hand
 * the exact set to the connector). Throws SsrfBlockedError if resolution yields
 * no usable address or if ANY address is blocked.
 *
 * Honours allowPrivateHosts(): when set, the per-address check is skipped
 * (dev/test calling localhost), but the addresses are still returned so pinning
 * callers continue to pin to the resolved set.
 *
 * An IP-literal host short-circuits DNS: assertSafeHttpUrl already classified it
 * statically, but we re-check it here too (defense in depth, and so the pinned
 * connector still has a concrete address to pin to).
 */
export async function resolveAndCheckHost(
  rawHostname: string,
  resolveAll: ResolveAllFn = defaultResolveAll,
): Promise<AllAddresses> {
  // URL.hostname keeps brackets on an IPv6 literal ("[::1]"); strip them so the
  // host classifies as an IP. (undici's connect hook passes the bare form, but
  // the MCP up-front check feeds us url.hostname directly, so normalize here.)
  let hostname = rawHostname;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  const literal = isIP(hostname);
  if (literal !== 0) {
    if (!allowPrivateHosts() && isBlockedResolvedAddress(hostname, literal)) {
      throw new SsrfBlockedError(
        `host "${hostname}" is a blocked (private/loopback/link-local) address`,
      );
    }
    return [{ address: hostname, family: literal }];
  }

  const addresses = await resolveAll(hostname);
  if (addresses.length === 0) {
    throw new SsrfBlockedError(`host "${hostname}" did not resolve to any address`);
  }
  if (!allowPrivateHosts()) {
    for (const { address, family } of addresses) {
      if (isBlockedResolvedAddress(address, family)) {
        throw new SsrfBlockedError(
          `host "${hostname}" resolves to a blocked ` +
            `(private/loopback/link-local) address ${address}`,
        );
      }
    }
  }
  return addresses;
}

/** Default resolver: dns.lookup(hostname, { all: true }) promisified. */
function defaultResolveAll(hostname: string): Promise<AllAddresses> {
  return new Promise((resolve, reject) => {
    // family: 0 -> return both A and AAAA records, so we re-check every address
    // the connector could otherwise pick.
    dnsLookup(hostname, { all: true, family: 0 }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

/**
 * Build a `fetch` whose connections are PINNED to addresses validated against
 * the SSRF ruleset. The undici Agent's `connect.lookup` hook is the only
 * resolution point: it resolves once, rejects any blocked address, and returns
 * the validated set to undici, which then connects to exactly those addresses.
 * Because there is no second resolution between our check and the TCP connect,
 * the DNS-rebinding TOCTOU window is closed for every request made through it.
 *
 * `resolveAll` is injectable so tests can drive the hook with a mocked resolver
 * (a private IP -> the connection is refused; a public IP -> it proceeds).
 *
 * Returns both the fetch fn and the Agent so the caller can close() it.
 */
export function createPinnedFetch(resolveAll: ResolveAllFn = defaultResolveAll): {
  fetch: typeof undiciFetch;
  agent: Agent;
} {
  const agent = new Agent({
    connect: {
      // undici/node net LookupFunction signature. opts is dns.LookupOptions
      // (we ignore the requested family and always return ALL addresses so a
      // blocked AAAA cannot hide behind an allowed A or vice versa).
      lookup: (
        hostname: string,
        _opts: unknown,
        cb: (
          err: NodeJS.ErrnoException | null,
          address: string | AllAddresses,
          family?: number,
        ) => void,
      ): void => {
        resolveAndCheckHost(hostname, resolveAll).then(
          (addresses) => {
            // Hand back the validated, pinned address list. undici connects to
            // these — not to a fresh, unchecked resolution.
            cb(null, addresses);
          },
          (err: unknown) => {
            // Surface as a connection error; fetch rejects with this as `cause`.
            cb(toErrno(err), "", 0);
          },
        );
      },
    },
  });

  const pinnedFetch = ((input: Parameters<typeof undiciFetch>[0], init?: RequestInit) =>
    undiciFetch(input, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher: agent })) as typeof undiciFetch;

  return { fetch: pinnedFetch, agent };
}

/** Coerce an unknown rejection into the ErrnoException undici's lookup expects. */
function toErrno(err: unknown): NodeJS.ErrnoException {
  if (err instanceof Error) return err as NodeJS.ErrnoException;
  return new Error(String(err)) as NodeJS.ErrnoException;
}

/**
 * Up-front resolve-then-check run before the MCP transport is built, so an
 * internal target is rejected before any connection is attempted. Throws
 * SsrfBlockedError if the host resolves to a blocked address. The MCP transport
 * itself connects through createPinnedFetch(), which pins the socket to the
 * validated address and closes the rebinding window; this check is a fast early
 * gate in front of that pinned connection.
 */
export async function assertHostResolvesPublic(
  hostname: string,
  resolveAll: ResolveAllFn = defaultResolveAll,
): Promise<void> {
  await resolveAndCheckHost(hostname, resolveAll);
}
