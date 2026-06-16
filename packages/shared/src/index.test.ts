import { describe, expect, it } from "vitest";

import * as shared from "./index.js";

describe("public API surface", () => {
  it("exposes the documented exports", () => {
    expect(shared.canonicalJson({ a: 1 })).toBe('{"a":1}');
    expect(typeof shared.sha256Hex("x")).toBe("string");
    expect(typeof shared.hashAuditEvent).toBe("function");
    expect(shared.CanonicalizationError).toBeDefined();
  });

  it("pins the audit schema version", () => {
    expect(shared.SCHEMA_VERSION).toBe(1);
  });
});
