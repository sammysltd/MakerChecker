import { describe, expect, it } from "vitest";

import {
  actorLabel,
  formatAbsolute,
  formatDuration,
  formatJson,
  formatRelative,
  formatTokens,
  isTerminalRunStatus,
  riskTierKind,
  statusKind,
  truncateHash,
} from "./format";

const NOW = Date.parse("2026-06-12T12:00:00.000Z");

describe("formatRelative", () => {
  it("handles null and invalid dates", () => {
    expect(formatRelative(null, NOW)).toBe("—");
    expect(formatRelative("not-a-date", NOW)).toBe("—");
  });

  it("buckets ages", () => {
    expect(formatRelative("2026-06-12T11:59:58.000Z", NOW)).toBe("just now");
    expect(formatRelative("2026-06-12T11:59:30.000Z", NOW)).toBe("30s ago");
    expect(formatRelative("2026-06-12T11:58:00.000Z", NOW)).toBe("2m ago");
    expect(formatRelative("2026-06-12T09:00:00.000Z", NOW)).toBe("3h ago");
    expect(formatRelative("2026-06-07T12:00:00.000Z", NOW)).toBe("5d ago");
  });
});

describe("formatAbsolute", () => {
  it("renders a UTC timestamp", () => {
    expect(formatAbsolute("2026-06-12T09:30:00.000Z")).toBe("2026-06-12 09:30:00 UTC");
  });

  it("handles null and garbage", () => {
    expect(formatAbsolute(null)).toBe("");
    expect(formatAbsolute("garbage")).toBe("");
  });
});

describe("formatDuration", () => {
  it("is em-dash without a start", () => {
    expect(formatDuration(null, null, NOW)).toBe("—");
  });

  it("formats sub-second, seconds, minutes and hours", () => {
    const start = "2026-06-12T11:00:00.000Z";
    expect(formatDuration(start, "2026-06-12T11:00:00.500Z", NOW)).toBe("500ms");
    expect(formatDuration(start, "2026-06-12T11:00:04.200Z", NOW)).toBe("4.2s");
    expect(formatDuration(start, "2026-06-12T11:01:12.000Z", NOW)).toBe("1m 12s");
    expect(formatDuration(start, "2026-06-12T13:05:00.000Z", NOW)).toBe("2h 5m");
  });

  it("runs open intervals against now and clamps negatives", () => {
    expect(formatDuration("2026-06-12T11:59:50.000Z", null, NOW)).toBe("10.0s");
    expect(formatDuration("2026-06-12T12:00:10.000Z", null, NOW)).toBe("0ms");
  });
});

describe("truncateHash", () => {
  it("truncates long hashes with an ellipsis", () => {
    expect(truncateHash("abcdef0123456789abcdef")).toBe("abcdef012345…");
  });

  it("leaves short values and handles null", () => {
    expect(truncateHash("abc")).toBe("abc");
    expect(truncateHash(null)).toBe("—");
  });
});

describe("formatJson", () => {
  it("pretty-prints objects", () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("re-formats JSON strings and passes through non-JSON strings", () => {
    expect(formatJson('{"b":2}')).toBe('{\n  "b": 2\n}');
    expect(formatJson("plain text")).toBe("plain text");
  });

  it("renders null/undefined as null", () => {
    expect(formatJson(null)).toBe("null");
    expect(formatJson(undefined)).toBe("null");
  });
});

describe("actorLabel", () => {
  it("prefers name, then id, then type", () => {
    expect(actorLabel({ type: "user", name: "ops@bank.com", id: "u1" })).toBe("ops@bank.com");
    expect(actorLabel({ type: "agent", id: "ag1" })).toBe("ag1");
    expect(actorLabel({ type: "system" })).toBe("system");
    expect(actorLabel(null)).toBe("unknown");
    expect(actorLabel(undefined)).toBe("unknown");
  });
});

describe("statusKind", () => {
  it("maps every known status to its visual kind", () => {
    for (const s of ["completed", "approved", "published", "active"]) {
      expect(statusKind(s)).toBe("good");
    }
    for (const s of ["running", "pending", "waiting_approval", "queued"]) {
      expect(statusKind(s)).toBe("waiting");
    }
    for (const s of ["failed", "rejected", "blocked", "suspended", "retired", "deprecated"]) {
      expect(statusKind(s)).toBe("bad");
    }
    expect(statusKind("draft")).toBe("neutral");
  });
});

describe("isTerminalRunStatus", () => {
  it("treats completed/failed/cancelled as terminal", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("waiting_approval")).toBe(false);
  });
});

describe("formatTokens", () => {
  it("formats camelCase and snake_case usage", () => {
    expect(formatTokens({ inputTokens: 1234, outputTokens: 567 })).toBe("1,234 in / 567 out");
    expect(formatTokens({ input_tokens: 10, output_tokens: 5 })).toBe("10 in / 5 out");
  });

  it("returns null for malformed usage", () => {
    expect(formatTokens(null)).toBeNull();
    expect(formatTokens("usage")).toBeNull();
    expect(formatTokens({ inputTokens: "x" })).toBeNull();
    expect(formatTokens({ inputTokens: 1 })).toBeNull();
  });
});

describe("riskTierKind", () => {
  it("maps tiers to kinds", () => {
    expect(riskTierKind("high")).toBe("bad");
    expect(riskTierKind("medium")).toBe("waiting");
    expect(riskTierKind("low")).toBe("good");
    expect(riskTierKind("unknown")).toBe("neutral");
  });
});
