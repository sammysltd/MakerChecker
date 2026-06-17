import { describe, expect, it } from "vitest";

import { assertAuthBindSafe } from "./bind-guard.js";

describe("assertAuthBindSafe", () => {
  it("throws when auth is disabled on a reachable bind", () => {
    expect(() => assertAuthBindSafe("0.0.0.0", true)).toThrow(/reachable/);
    expect(() => assertAuthBindSafe("192.168.1.10", true)).toThrow(/reachable/);
    expect(() => assertAuthBindSafe("", true)).toThrow(/reachable/);
    expect(() => assertAuthBindSafe("::", true)).toThrow(/reachable/);
  });

  it("permits auth disabled on a loopback bind", () => {
    expect(() => assertAuthBindSafe("127.0.0.1", true)).not.toThrow();
    expect(() => assertAuthBindSafe("::1", true)).not.toThrow();
    expect(() => assertAuthBindSafe("localhost", true)).not.toThrow();
    expect(() => assertAuthBindSafe("LOCALHOST", true)).not.toThrow();
  });

  it("permits any host when auth is enabled", () => {
    expect(() => assertAuthBindSafe("0.0.0.0", false)).not.toThrow();
    expect(() => assertAuthBindSafe("127.0.0.1", false)).not.toThrow();
    expect(() => assertAuthBindSafe("", false)).not.toThrow();
  });
});
