import { isIP } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Ajv, type ValidateFunction } from "ajv";
import type { Pool } from "pg";

import type { LocalSkillFn } from "../engine/executor.js";
import { parseSkillRef } from "../engine/enforcement.js";
import {
  assertHostResolvesPublic,
  createPinnedFetch,
  SsrfBlockedError,
} from "./ssrf-guard.js";

export type Json = Record<string, unknown>;

/**
 * Minimal fetch shape used by the HTTP skill path. The production default is the
 * connect-time-pinned undici fetch (createPinnedFetch); tests may inject a mock.
 * Kept structural so both the global fetch and undici's fetch satisfy it.
 */
export type SkillHttpFetch = (
  url: string,
  init: {
    method: string;
    signal: AbortSignal;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

// ---------------------------------------------------------------------------
// Hardening: skill implementations are DB-stored, attacker-influenced data.
// The invoker spawns processes (MCP stdio) and makes outbound HTTP requests
// from those rows, so every untrusted field is validated fail-closed before
// it reaches a transport. Deny by default: anything not explicitly permitted
// is rejected with SkillInvocationError("input_invalid", ...).
// ---------------------------------------------------------------------------

/**
 * Shell interpreters that can execute arbitrary code from a string argument.
 * Spawning any of these from a registry row is an RCE primitive, so they are
 * rejected outright regardless of their args.
 */
const FORBIDDEN_STDIO_COMMANDS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "ash",
  "fish",
  "busybox",
  "env",
  "xargs",
  "eval",
  "exec",
  "command",
  "nohup",
  "setsid",
  "perl",
  "ruby",
  "php",
  "lua",
  "awk",
  "gawk",
  // node, nodejs, python* are NOT forbidden here: they are the standard launchers
  // for MCP stdio servers (e.g. `node server.mjs`). They are CODE_RUNTIMES, so
  // assertSafeStdioSpawn additionally forbids passing them ANY flag (a script
  // path only) — closing -e/-c and `python -m timeit` style module RCE.
  "deno",
  "bun",
  "pwsh",
  "powershell",
  "cmd",
  // Package-fetching launchers: they download and execute arbitrary remote
  // packages from an attacker-supplied name/URL (a supply-chain RCE primitive),
  // with no eval flag for the matcher to catch (`npx pkg`, `uvx --from url x`).
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "bunx",
  "uv",
  "uvx",
  "pip",
  "pip3",
  "pipx",
  "poetry",
]);

/**
 * Characters that confer shell-metacharacter / argument-injection power, plus
 * all whitespace (\s) and control characters (\x00-\x1f, \x7f). Presence of any
 * of these in a command, path segment, or arg means we refuse to spawn.
 */
const SHELL_METACHARACTERS = /[\s;&|`$(){}\[\]<>!#"'\\*?~\x00-\x1f\x7f]/;

/** Any control character (NUL, CR, LF, etc.) — used for path/arg sanity. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Long-form interpreter flags that turn an allowed runtime (node/python) into an
 * arbitrary-code executor: inline eval/print, the interactive REPL, and the
 * module preload/loader family (which executes attacker-controlled module code
 * before the entry script). Matched on the flag token only, so `--eval`,
 * `--eval=CODE`, and `--require=/tmp/x.js` are all caught.
 */
const DANGEROUS_LONG_FLAGS = new Set([
  "eval",
  "print",
  "interactive",
  "require",
  "import",
  "loader",
  "experimental-loader",
  "experimental-vm-modules",
  "conditions",
  "module", // `--module` / python `-m <module>` runs a module (e.g. timeit) as code
]);

/**
 * Single-dash flag letters that evaluate inline code, preload a module, or run a
 * module (-e eval, -p print, -c command, -i interactive REPL, -r require, -m
 * module). These glue their value to the letter (`-eCODE`, `-r/tmp/x.js`,
 * `-mtimeit`), so we test the first letter after the dash, not the whole token.
 * `-m` matters because `python -m timeit "<code>"` evaluates argv as code with
 * only the standard library; this catches it even for an interpreter name the
 * CODE_RUNTIMES allowlist does not recognize.
 */
const DANGEROUS_SHORT_FLAG_LETTERS = "epcirm";

/**
 * Code runtimes that turn into arbitrary-code executors via their CLI. They are
 * permitted as MCP launchers ONLY to run a script path — assertSafeStdioSpawn
 * rejects EVERY leading-dash arg for them, because beyond the eval/preload flags
 * a module run like `python -m timeit "<code>"` (or `-m trace`, `-m pdb`)
 * evaluates argv as code using the standard library alone. There is no reliable
 * safe/dangerous flag partition for an interpreter, so we allow none. Launch a
 * module/flag-based server via its console-script or a vetted wrapper instead.
 * (Shells and other interpreters are blocked outright by FORBIDDEN_STDIO_COMMANDS.)
 */
const CODE_RUNTIMES =
  /^(?:node|nodejs|ts-node|tsx|deno|bun|[a-z]*python[0-9.]*|pypy[0-9.]*|jython|graalpy)$/;

/**
 * Optional hard allowlist of spawnable stdio commands, from
 * MAKERCHECKER_STDIO_ALLOWED_COMMANDS (comma-separated full paths and/or bare
 * names). Returns null when unset (deny-lists apply); an empty Set when set but
 * empty (nothing may spawn). Resolved per call so deployments/tests can toggle it.
 */
function stdioCommandAllowlist(): Set<string> | null {
  const raw = process.env.MAKERCHECKER_STDIO_ALLOWED_COMMANDS;
  if (raw === undefined) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * True if a stdio arg is an interpreter flag that grants code execution: the
 * eval/print/interactive and preload/loader families in every spelling — bare
 * (`-e`), glued (`-eCODE`, `-r/tmp/x.js`), `=`-joined (`--eval=CODE`), and the
 * stdin program marker (`-`). This family matcher is applied to EVERY stdio
 * command. Recognized interpreters (CODE_RUNTIMES) are held to a stricter rule
 * in assertSafeStdioSpawn — no leading-dash args at all — because this matcher
 * alone does not catch `-m <module>`/`-s`/etc.
 *
 * Args are spawned array-style (no shell), so spaces/metacharacters in an arg
 * are literal and harmless — a legitimate script path may contain spaces.
 */
export function isDangerousInterpreterFlag(arg: string): boolean {
  if (arg === "-") return true; // reads the program from stdin
  if (arg[0] !== "-") return false;
  if (arg.startsWith("--")) {
    const token = arg.slice(2).split("=", 1)[0]!.toLowerCase();
    return DANGEROUS_LONG_FLAGS.has(token);
  }
  // Single-dash: the dangerous letter may have its value glued on (-eCODE) or be
  // the start of a cluster; either way the first letter decides interpretation.
  const first = arg[1]?.toLowerCase() ?? "";
  return DANGEROUS_SHORT_FLAG_LETTERS.includes(first);
}

/** A bare binary name: alphanumerics, dot, dash, underscore, plus. */
const SAFE_BINARY_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * HTTP request headers a skill row is permitted to set on the outbound fetch.
 * Everything else (Authorization, Cookie, Host, Proxy-*, etc.) is dropped so a
 * malicious skill cannot turn the server into a confused deputy that replays
 * the caller's credentials or rewrites routing.
 */
const ALLOWED_HTTP_HEADERS = new Set(["content-type", "accept", "accept-language"]);

/** Custom-header prefixes a skill may set freely (vendor / experimental). */
const ALLOWED_HEADER_PREFIXES = ["x-"];

/** RFC 7230 token chars for header field names. */
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export class SkillInvocationError extends Error {
  override name = "SkillInvocationError";
  constructor(
    readonly code: "input_invalid" | "output_invalid" | "not_implemented" | "execution_failed",
    message: string,
  ) {
    super(message);
  }
}

export interface SkillRow {
  id: string;
  name: string;
  version: number;
  description: string;
  input_schema: Json;
  output_schema: Json;
  implementation: Json;
  risk_tier: string;
}

export interface InvocationResult {
  skill: SkillRow;
  output: Json;
}

/**
 * Loads skills from the registry, validates input/output against their JSON
 * Schemas, and dispatches to the implementation: local function, HTTP
 * endpoint, or MCP server tool. Enforcement (grants, SoD) happens BEFORE this
 * layer — the invoker assumes authorization is settled.
 */
export class SkillInvoker {
  private readonly ajv = new Ajv({ strict: false });
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly mcpClients = new Map<string, Promise<Client>>();

  // Connect-time-pinned fetch for outbound HTTP skill calls. Its undici Agent
  // resolves the host once, rejects any private/loopback/link-local address, and
  // pins the connection to the validated address — closing the DNS-rebinding
  // TOCTOU window left open by the static assertSafeHttpUrl check. See
  // ssrf-guard.ts. Lazily created so a process that never calls an HTTP skill
  // does not open an Agent.
  private pinned: ReturnType<typeof createPinnedFetch> | undefined;

  /**
   * @param pool         registry/db pool.
   * @param localRegistry in-process local skill implementations.
   * @param httpFetch    OPTIONAL injected fetch for the HTTP skill path, for
   *   tests only. Production leaves it undefined and gets the connect-time-pinned
   *   fetch (createPinnedFetch). Tests inject a mock to assert request shaping
   *   (header stripping, content-type) without real DNS/network. Injecting a
   *   plain fetch does NOT pin — never set it in production.
   */
  constructor(
    private readonly pool: Pool,
    private readonly localRegistry: Map<string, LocalSkillFn> = new Map(),
    private readonly httpFetch?: SkillHttpFetch,
  ) {}

  private pinnedFetch(): SkillHttpFetch {
    if (this.httpFetch) return this.httpFetch;
    this.pinned ??= createPinnedFetch();
    return this.pinned.fetch as unknown as SkillHttpFetch;
  }

  /** The raw connect-time-pinned undici fetch, for the MCP http transport. */
  private mcpFetch(): ReturnType<typeof createPinnedFetch>["fetch"] {
    this.pinned ??= createPinnedFetch();
    return this.pinned.fetch;
  }

  async loadSkill(ref: string): Promise<SkillRow> {
    const { name, version } = parseSkillRef(ref);
    const { rows } = await this.pool.query<SkillRow>(
      `SELECT id, name, version, description, input_schema, output_schema, implementation, risk_tier
         FROM skills WHERE name = $1 AND version = $2`,
      [name, version],
    );
    if (!rows[0]) throw new SkillInvocationError("not_implemented", `skill "${ref}" not found`);
    return rows[0];
  }

  async invoke(ref: string, input: Json, signal: AbortSignal): Promise<InvocationResult> {
    const skill = await this.loadSkill(ref);

    this.validate(`${ref}:input`, skill.input_schema, input, "input_invalid");
    const output = await this.dispatch(ref, skill, input, signal);
    this.validate(`${ref}:output`, skill.output_schema, output, "output_invalid");

    return { skill, output };
  }

  async close(): Promise<void> {
    for (const clientPromise of this.mcpClients.values()) {
      try {
        await (await clientPromise).close();
      } catch {
        /* ignore errors while closing */
      }
    }
    this.mcpClients.clear();
    if (this.pinned) {
      try {
        await this.pinned.agent.close();
      } catch {
        /* ignore errors while closing */
      }
      this.pinned = undefined;
    }
  }

  private validate(
    key: string,
    schema: Json,
    value: Json,
    code: "input_invalid" | "output_invalid",
  ): void {
    let validator = this.validators.get(key);
    if (!validator) {
      validator = this.ajv.compile(schema);
      this.validators.set(key, validator);
    }
    if (!validator(value)) {
      const detail = (validator.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message}`)
        .join("; ");
      throw new SkillInvocationError(code, `${key} failed schema validation: ${detail}`);
    }
  }

  private async dispatch(
    ref: string,
    skill: SkillRow,
    input: Json,
    signal: AbortSignal,
  ): Promise<Json> {
    const impl = skill.implementation;
    try {
      switch (impl.type) {
        case "local": {
          const fn = this.localRegistry.get(ref);
          if (!fn) {
            throw new SkillInvocationError(
              "not_implemented",
              `no local implementation registered for "${ref}"`,
            );
          }
          return await fn(input, signal);
        }
        case "http": {
          const url = assertSafeHttpUrl(impl.url);
          const safeHeaders = sanitizeHttpHeaders(impl.headers);
          // FULLY PINNED path: pinnedFetch resolves the host through the undici
          // Agent's connect hook, rejects any private/loopback/link-local
          // address, and pins the TCP connection to the validated address — so a
          // hostname that rebinds to an internal IP at connect time is refused
          // even though it passed the static assertSafeHttpUrl check.
          let res: Awaited<ReturnType<SkillHttpFetch>>;
          try {
            res = await this.pinnedFetch()(url, {
              method: "POST",
              signal,
              headers: {
                ...safeHeaders,
                // content-type is fixed last: the body is always JSON and a skill
                // row must not be able to lie about it.
                "content-type": "application/json",
              },
              body: JSON.stringify({ input }),
            });
          } catch (err) {
            // A rebinding rejection from the connect hook surfaces as the fetch
            // failure's `cause`. Re-classify it as input_invalid (it is a refusal
            // to talk to a forbidden target, not a runtime failure of a valid one).
            if (isSsrfBlocked(err)) {
              throw new SkillInvocationError(
                "input_invalid",
                `http skill "${ref}": ${(extractSsrfError(err) as Error).message}`,
              );
            }
            throw err;
          }
          if (!res.ok) {
            throw new SkillInvocationError(
              "execution_failed",
              `http skill "${ref}" returned ${res.status}`,
            );
          }
          return (await res.json()) as Json;
        }
        case "mcp": {
          const client = await this.mcpClient(impl);
          const result = await client.callTool({
            name: String(impl.tool),
            arguments: input,
          });
          if (result.isError) {
            const text = Array.isArray(result.content)
              ? result.content
                  .filter((c): c is { type: "text"; text: string } => c.type === "text")
                  .map((c) => c.text)
                  .join("\n")
              : "unknown MCP error";
            throw new SkillInvocationError("execution_failed", `mcp skill "${ref}": ${text}`);
          }
          if (result.structuredContent) return result.structuredContent as Json;
          const text = Array.isArray(result.content)
            ? result.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map((c) => c.text)
                .join("\n")
            : "";
          try {
            return JSON.parse(text) as Json;
          } catch {
            return { text };
          }
        }
        default:
          throw new SkillInvocationError(
            "not_implemented",
            `unknown implementation type "${String(impl.type)}" for "${ref}"`,
          );
      }
    } catch (err) {
      if (err instanceof SkillInvocationError) throw err;
      // The SSRF guard refuses a forbidden target on any outbound path (the
      // pinned fetch on the HTTP/MCP transports, or the MCP up-front host check)
      // by throwing SsrfBlockedError, surfaced directly or as a fetch `cause`.
      // It is a refusal to connect, so classify it input_invalid not failed.
      if (isSsrfBlocked(err)) {
        throw new SkillInvocationError(
          "input_invalid",
          (extractSsrfError(err) as Error).message,
        );
      }
      throw new SkillInvocationError("execution_failed", (err as Error).message);
    }
  }

  /** One lazily-connected client per distinct MCP server config. */
  private mcpClient(impl: Json): Promise<Client> {
    // Validate the transport config BEFORE any caching so a malicious row can
    // never park a rejected/half-open client in the pool (fail-closed) and so
    // the error surfaces synchronously as input_invalid rather than as a cached
    // execution_failed on every later call.
    const transport =
      impl.transport === "stdio"
        ? ({ kind: "stdio" as const, spawn: assertSafeStdioSpawn(impl.command, impl.args) })
        : ({ kind: "http" as const, url: assertSafeHttpUrl(impl.url) });

    const key = JSON.stringify(impl);
    let clientPromise = this.mcpClients.get(key);
    if (!clientPromise) {
      clientPromise = (async () => {
        const client = new Client({ name: "makerchecker", version: "0.0.0" });
        if (transport.kind === "stdio") {
          await client.connect(new StdioClientTransport(transport.spawn));
        } else {
          // MCP-over-HTTP runs through the same connect-time-pinned fetch as the
          // HTTP skill and outbound-webhook paths: the undici Agent resolves the
          // host, validates the address, and pins the socket to that exact IP, so
          // a private/loopback/link-local target or a DNS rebind between resolve
          // and connect is refused at the socket. We also validate the host up
          // front so an obviously-internal target never reaches the transport.
          const mcpUrl = new URL(transport.url);
          await assertHostResolvesPublic(mcpUrl.hostname);
          const t = new StreamableHTTPClientTransport(mcpUrl, {
            fetch: this.mcpFetch(),
            // Cast: the SDK's Transport options are structurally satisfied here;
            // its types are looser than our exactOptionalPropertyTypes config.
          } as ConstructorParameters<typeof StreamableHTTPClientTransport>[1]);
          await client.connect(t as Parameters<Client["connect"]>[0]);
        }
        return client;
      })();
      this.mcpClients.set(key, clientPromise);
    }
    return clientPromise;
  }
}

/**
 * True if `err` is (or wraps, via undici's fetch `cause`) an SsrfBlockedError —
 * i.e. the connect-time guard refused a private/loopback/link-local target.
 * undici surfaces a connector-hook rejection as `TypeError("fetch failed")`
 * with our SsrfBlockedError attached as `.cause`, so we unwrap one level.
 */
function isSsrfBlocked(err: unknown): boolean {
  if (err instanceof SsrfBlockedError) return true;
  const cause = (err as { cause?: unknown })?.cause;
  return cause instanceof SsrfBlockedError;
}

/** Returns the underlying SsrfBlockedError (unwrapping a fetch `cause`). */
function extractSsrfError(err: unknown): SsrfBlockedError {
  if (err instanceof SsrfBlockedError) return err;
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof SsrfBlockedError) return cause;
  // Defensive: isSsrfBlocked gates every call, so this is unreachable.
  return new SsrfBlockedError((err as Error).message);
}

// ---------------------------------------------------------------------------
// Validation helpers (module-level, pure, unit-testable in isolation).
// ---------------------------------------------------------------------------

/**
 * Validate a DB-stored MCP stdio spawn spec before it reaches
 * StdioClientTransport. Returns the narrowed {command, args} on success;
 * throws SkillInvocationError("input_invalid") on any violation.
 *
 * Rules (deny by default):
 *  - command must be a non-empty string.
 *  - command must be either a plain absolute POSIX path OR a bare binary name
 *    matching SAFE_BINARY_NAME — never a relative path, never with metachars.
 *  - the basename of command must not be a known shell/interpreter.
 *  - args (optional) must be an array of non-empty plain strings with no
 *    control characters and no shell metacharacters.
 */
export function assertSafeStdioSpawn(
  rawCommand: unknown,
  rawArgs: unknown,
): { command: string; args: string[] } {
  if (typeof rawCommand !== "string" || rawCommand.length === 0) {
    throw new SkillInvocationError(
      "input_invalid",
      "mcp stdio command must be a non-empty string",
    );
  }
  const command = rawCommand;

  // No NUL / control characters anywhere in the path.
  if (CONTROL_CHARS.test(command)) {
    throw new SkillInvocationError(
      "input_invalid",
      "mcp stdio command contains control characters",
    );
  }

  const isAbsolute = command.startsWith("/");
  if (isAbsolute) {
    // Each path segment must be a safe name; reject "..", empty segments, and
    // any metacharacters. This forbids "/bin/sh -c", "/x/../y", "/x;y", etc.
    const segments = command.slice(1).split("/");
    for (const seg of segments) {
      if (seg.length === 0 || seg === "." || seg === "..") {
        throw new SkillInvocationError(
          "input_invalid",
          `mcp stdio command has an invalid path segment: "${seg}"`,
        );
      }
      if (SHELL_METACHARACTERS.test(seg) || !SAFE_BINARY_NAME.test(seg)) {
        throw new SkillInvocationError(
          "input_invalid",
          `mcp stdio command path segment is not a safe name: "${seg}"`,
        );
      }
    }
  } else {
    // Bare binary name only — no relative paths, no "./x", no metacharacters.
    if (command.includes("/") || SHELL_METACHARACTERS.test(command)) {
      throw new SkillInvocationError(
        "input_invalid",
        "mcp stdio command must be an absolute path or a bare binary name",
      );
    }
    if (!SAFE_BINARY_NAME.test(command)) {
      throw new SkillInvocationError(
        "input_invalid",
        `mcp stdio command is not a safe binary name: "${command}"`,
      );
    }
  }

  // Reject known shell interpreters by basename, regardless of how referenced.
  const basename = command.slice(command.lastIndexOf("/") + 1);
  const interpreter = basename.toLowerCase().replace(/\.exe$/, "");
  if (FORBIDDEN_STDIO_COMMANDS.has(interpreter)) {
    throw new SkillInvocationError(
      "input_invalid",
      `mcp stdio command "${interpreter}" is a forbidden shell/interpreter`,
    );
  }

  // Optional hard allowlist (recommended for production). When
  // MAKERCHECKER_STDIO_ALLOWED_COMMANDS is set, the command must match an entry
  // EXACTLY: a bare-name entry (e.g. "mcp-server-git") matches only a bare
  // command (PATH-resolved), and an absolute-path entry matches only that exact
  // path. We deliberately do NOT match an absolute command by its basename — that
  // would let /tmp/x/mcp-server-git satisfy a "mcp-server-git" entry and spawn an
  // attacker binary from a world-writable dir, defeating the location pinning.
  // The allowlist is the strongest control: set it in production to pin stdio
  // skills to an exact, known set of commands. The deny-list above is the secure
  // default when no allowlist is configured.
  const allow = stdioCommandAllowlist();
  if (allow && !allow.has(command)) {
    throw new SkillInvocationError(
      "input_invalid",
      `mcp stdio command "${command}" is not in MAKERCHECKER_STDIO_ALLOWED_COMMANDS`,
    );
  }

  // args: optional, but if present must be a string[] of non-empty, control-char
  // free values that are not interpreter code-execution flags. (Empty array OK.)
  // Args are passed array-style to spawn (no shell), so spaces and shell
  // metacharacters in an arg are literal and harmless — a legitimate script path
  // may contain spaces (e.g. ".../My Project/.../server.mjs"). The real RCE
  // vector is an interpreter flag/module; we reject all of those (see below).
  const isRuntime = CODE_RUNTIMES.test(interpreter);
  let args: string[] = [];
  if (rawArgs !== undefined && rawArgs !== null) {
    if (!Array.isArray(rawArgs)) {
      throw new SkillInvocationError("input_invalid", "mcp stdio args must be an array");
    }
    args = rawArgs.map((arg, i) => {
      if (typeof arg !== "string" || arg.length === 0) {
        throw new SkillInvocationError(
          "input_invalid",
          `mcp stdio arg[${i}] must be a non-empty string`,
        );
      }
      if (CONTROL_CHARS.test(arg)) {
        throw new SkillInvocationError(
          "input_invalid",
          `mcp stdio arg[${i}] contains control characters`,
        );
      }
      // A recognized interpreter (node/python) is an arbitrary-code executor for
      // ANY flag — not just -e/-r but also `-m timeit "<code>"`, `-s`, etc. — so
      // it may only be given a script path / value, never a leading-dash arg.
      if (isRuntime && arg.startsWith("-")) {
        throw new SkillInvocationError(
          "input_invalid",
          `mcp stdio arg[${i}] "${arg}": an interpreter (${interpreter}) may not be passed flags; ` +
            "launch a script path, console-script, or a vetted wrapper instead",
        );
      }
      // Non-interpreter commands: still reject the inline-eval / preload families.
      if (isDangerousInterpreterFlag(arg)) {
        throw new SkillInvocationError(
          "input_invalid",
          `mcp stdio arg[${i}] "${arg}" is an inline-eval or module-preload flag`,
        );
      }
      return arg;
    });
  }

  return { command, args };
}

/**
 * Parse and validate a DB-stored URL before any outbound request. Returns the
 * normalized href on success; throws SkillInvocationError("input_invalid") for
 * anything but an http(s) URL to a non-private, non-loopback, non-link-local
 * host. Literal-IP hosts in those ranges are rejected.
 *
 * This is the first layer: a static, fail-closed check on the literal host. It
 * cannot, by itself, defeat DNS rebinding (a hostname that passes here but
 * resolves to a private address at connect time); connect-time IP pinning in
 * skills/ssrf-guard.ts re-checks every resolved address and closes that window.
 */
export function assertSafeHttpUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new SkillInvocationError("input_invalid", "http url must be a non-empty string");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SkillInvocationError("input_invalid", `http url is not a valid URL: "${rawUrl}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SkillInvocationError(
      "input_invalid",
      `http url scheme "${url.protocol}" is not allowed (only http/https)`,
    );
  }
  // Reject embedded credentials — they smuggle auth and confuse host parsing.
  if (url.username !== "" || url.password !== "") {
    throw new SkillInvocationError("input_invalid", "http url must not contain credentials");
  }

  // url.hostname keeps the surrounding brackets on IPv6 literals (e.g. "[::1]")
  // — strip them so the host can be classified as an IP.
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host.length === 0) {
    throw new SkillInvocationError("input_invalid", "http url has no host");
  }
  // Private/loopback/link-local hosts are blocked by default (SSRF defence). A
  // dev/test deployment that genuinely calls a localhost skill opts in
  // explicitly via MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS=1; production never sets it.
  if (isBlockedHost(host) && process.env.MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS !== "1") {
    throw new SkillInvocationError(
      "input_invalid",
      `http url host "${host}" resolves to a blocked (private/loopback/link-local) address`,
    );
  }
  return url.href;
}

/** Well-known internal / loopback hostnames that must never be reached. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
]);

/**
 * True if `host` is a literal IP in a private/loopback/link-local range, or a
 * well-known internal hostname. Lower-cased input expected.
 */
export function isBlockedHost(host: string): boolean {
  // Strip an IPv6 zone id (e.g. fe80::1%eth0) before classification.
  let bareHost = host.includes("%") ? host.slice(0, host.indexOf("%")) : host;
  // Strip a trailing dot: "metadata.google.internal." and "localhost." are the
  // same FQDN to the resolver but would otherwise slip past the blocklist. (IP
  // literals are already canonicalized without the dot by the URL parser.)
  if (bareHost.endsWith(".")) bareHost = bareHost.slice(0, -1);

  if (BLOCKED_HOSTNAMES.has(bareHost)) return true;
  // Any *.localhost is loopback by convention (RFC 6761).
  if (bareHost === "localhost" || bareHost.endsWith(".localhost")) return true;

  const ipVersion = isIP(bareHost);
  if (ipVersion === 4) return isBlockedIpv4(bareHost);
  if (ipVersion === 6) return isBlockedIpv6(bareHost);

  // Non-literal hostname that isn't on the blocklist: allowed (DNS-rebinding
  // is a documented follow-up, not silently permitted as "safe").
  return false;
}

/**
 * IPv4 private / loopback / link-local / unspecified / metadata ranges.
 * Exported so the connect-time DNS-rebinding guard (see ssrf-guard.ts) can
 * re-classify each resolved address with the SAME ruleset the static URL guard
 * uses — there must be exactly one definition of "blocked IPv4".
 */
export function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Not a clean dotted-quad — treat as blocked (fail-closed).
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 (unspecified / "this host")
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/**
 * IPv6 loopback / unspecified / link-local / unique-local + IPv4-mapped.
 * Exported for the same reason as isBlockedIpv4: the connect-time guard reuses
 * it verbatim so a resolved IPv6 address is judged identically to a literal one.
 */
export function isBlockedIpv6(ip: string): boolean {
  // Drop zone id (already stripped by caller; defensive here too).
  let addr = ip.includes("%") ? ip.slice(0, ip.indexOf("%")) : ip;
  addr = addr.toLowerCase();

  if (addr === "::1") return true; // loopback
  if (addr === "::") return true; // unspecified

  // IPv4-mapped / IPv4-compatible written in dotted form
  // (e.g. ::ffff:127.0.0.1): classify by the embedded IPv4.
  const dotted = addr.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) return isBlockedIpv4(dotted[1]);

  // IPv4-mapped (::ffff:...) and IPv4-compatible (::...) addresses written in
  // hex form. The WHATWG URL parser canonicalizes the dotted tail to hex, so
  // ::ffff:127.0.0.1 -> ::ffff:7f00:1 and ::127.0.0.1 -> ::7f00:1. Decode the
  // trailing two hextets back into an IPv4 address and classify by it, so a
  // private/loopback/metadata target cannot slip through either v6 encoding.
  const hexMapped = addr.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped?.[1] && hexMapped[2]) {
    const hi = Number.parseInt(hexMapped[1], 16);
    const lo = Number.parseInt(hexMapped[2], 16);
    const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    return isBlockedIpv4(v4);
  }

  const firstHextet = addr.split(":")[0] ?? "";
  // Link-local fe80::/10 (fe80–febf).
  if (/^fe[89ab][0-9a-f]?$/.test(firstHextet)) return true;
  // Unique-local fc00::/7 (fc00–fdff).
  if (/^f[cd][0-9a-f]{0,2}$/.test(firstHextet)) return true;

  return false;
}

/**
 * Restrict skill-supplied HTTP headers to a safe allowlist. Returns a new
 * lower-cased header map containing only permitted headers; silently drops the
 * rest (confused-deputy headers like Authorization/Cookie/Host must never be
 * forwarded). Header names/values with CRLF or control chars are rejected
 * outright (header-injection / request-splitting) rather than dropped, because
 * their presence signals an attack on the request framing itself.
 */
export function sanitizeHttpHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SkillInvocationError("input_invalid", "http headers must be an object");
  }

  for (const [rawName, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const name = rawName.toLowerCase();

    // Reject malformed/injecting names (CRLF, controls, non-token chars).
    if (!HEADER_NAME_TOKEN.test(name)) {
      throw new SkillInvocationError(
        "input_invalid",
        `http header name "${rawName}" is not a valid token`,
      );
    }

    if (typeof rawValue !== "string") {
      throw new SkillInvocationError(
        "input_invalid",
        `http header "${name}" value must be a string`,
      );
    }
    // Reject CR/LF/NUL/control chars in values (request splitting).
    if (CONTROL_CHARS.test(rawValue)) {
      throw new SkillInvocationError(
        "input_invalid",
        `http header "${name}" value contains control characters`,
      );
    }

    const permitted =
      ALLOWED_HTTP_HEADERS.has(name) || ALLOWED_HEADER_PREFIXES.some((p) => name.startsWith(p));
    if (!permitted) {
      // Confused-deputy / sensitive header: drop silently, deny-by-default.
      continue;
    }
    out[name] = rawValue;
  }
  return out;
}
