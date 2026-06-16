import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { auditEvents, sodAuditEvent } from "../../test/fixtures";
import type { AuditEvent } from "../lib/api";
import { AuditTrail } from "./AuditTrail";

describe("AuditTrail", () => {
  it("shows an empty note without events", () => {
    render(<AuditTrail events={[]} />);
    expect(screen.getByText("No audit events yet.")).toBeDefined();
  });

  it("renders events in seq order with type, actor and truncated hash", () => {
    render(<AuditTrail events={auditEvents} />);
    expect(screen.getByText("run.created")).toBeDefined();
    expect(screen.getByText("approval.decided")).toBeDefined();
    expect(screen.getByText("ops@bank.example")).toBeDefined();
    expect(screen.getByText(/#10/)).toBeDefined();
  });

  it("styles user, agent and system actors distinctly", () => {
    render(<AuditTrail events={auditEvents} />);
    expect(screen.getByText("ops@bank.example").className).toContain("bg-ink");
    expect(screen.getByText("recon-preparer").className).toContain("border-stone-400");
    expect(screen.getByText("engine").className).toContain("bg-stone-200");
  });

  it("shows model and token usage prominently for llm.call", () => {
    render(<AuditTrail events={auditEvents} />);
    expect(screen.getByText("claude-opus-4-8")).toBeDefined();
    expect(screen.getByText("2,300 in / 412 out tokens")).toBeDefined();
  });

  it("falls back to a generic model label when llm.call payload lacks one", () => {
    const event: AuditEvent = {
      ...auditEvents[1]!,
      payload: { usage: null },
    };
    render(<AuditTrail events={[event]} />);
    expect(screen.getByText("model")).toBeDefined();
  });

  it("renders an SoD violation as a red blocking entry with the reason", () => {
    render(<AuditTrail events={[sodAuditEvent]} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Blocked — segregation of duties");
    expect(alert.textContent).toContain('role "recon-approver-role" conflicts');
    expect(alert.className).toContain("border-blocked");
    expect(alert.className).toContain("bg-red-50");
  });

  it("renders enforcement.blocked with a fallback reason", () => {
    const event: AuditEvent = {
      ...sodAuditEvent,
      event_type: "enforcement.blocked",
      payload: { code: "skill_not_granted" },
    };
    render(<AuditTrail events={[event]} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Blocked — enforcement");
    expect(alert.textContent).toContain("policy violation");
  });

  it("offers an expandable payload only when non-empty", () => {
    const { container } = render(<AuditTrail events={auditEvents} />);
    // run.created has {} payload -> no details; llm.call and approval.decided have payloads.
    expect(container.querySelectorAll("details").length).toBe(2);
  });
});
