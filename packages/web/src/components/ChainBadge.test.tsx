import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChainBadge } from "./ChainBadge";

describe("ChainBadge", () => {
  it("shows a pending state while verification loads", () => {
    render(<ChainBadge verify={undefined} />);
    expect(screen.getByText("Verifying audit chain…")).toBeDefined();
  });

  it("shows the verified state with event count and truncated head hash", () => {
    render(
      <ChainBadge
        verify={{ ok: true, count: 1234, headHash: "abcdef0123456789deadbeef" }}
      />,
    );
    expect(screen.getByText("Chain verified ✓ (1,234 events)")).toBeDefined();
    const hash = screen.getByText("abcdef012345…");
    expect(hash.className).toContain("font-mono");
    expect(hash.getAttribute("title")).toBe("abcdef0123456789deadbeef");
  });

  it("handles a verified empty chain with a null head hash", () => {
    render(<ChainBadge verify={{ ok: true, count: 0, headHash: null }} />);
    expect(screen.getByText("Chain verified ✓ (0 events)")).toBeDefined();
    expect(screen.getByText("—")).toBeDefined();
  });

  it("screams TAMPER DETECTED when verification fails", () => {
    render(
      <ChainBadge
        verify={{ ok: false, count: 17, failedSeq: "18", reason: "hash mismatch (row tampered)" }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Tamper detected");
    expect(alert.textContent).toContain("seq 18");
    expect(alert.textContent).toContain("hash mismatch (row tampered)");
    expect(alert.className).toContain("border-blocked");
  });
});
