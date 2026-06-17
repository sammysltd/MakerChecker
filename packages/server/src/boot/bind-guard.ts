/** Hosts that bind only the local machine. Everything else is reachable. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** True when binding `host` exposes the server beyond the local machine. */
function isReachableHost(host: string): boolean {
  return !LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** Refuse to start with auth disabled on a reachable bind. Fails closed: an unknown host counts as reachable. */
export function assertAuthBindSafe(host: string, authDisabled: boolean): void {
  if (authDisabled && isReachableHost(host)) {
    throw new Error(
      `refusing to start: MAKERCHECKER_AUTH_DISABLED is on but the server is binding ` +
        `"${host}", which is reachable beyond this machine. Auth-disabled mode is ` +
        `local-only — bind 127.0.0.1 (loopback) or enable authentication.`,
    );
  }
}
