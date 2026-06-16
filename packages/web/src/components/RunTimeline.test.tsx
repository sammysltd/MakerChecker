import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { multiApproval, runDetail } from "../../test/fixtures";
import * as api from "../lib/api";
import type { RunApproval, StepRun } from "../lib/api";
import { RunTimeline } from "./RunTimeline";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, decideApproval: vi.fn() };
});

// RunTimeline's pending gate renders ApprovalDecision (react-query); wrap renders.
const render = (ui: ReactElement) =>
  rtlRender(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

const definition = runDetail.run.definition;

describe("RunTimeline with run data", () => {
  it("renders every definition step in order with agent names and skills", () => {
    render(
      <RunTimeline
        definition={definition}
        steps={runDetail.steps}
        approvals={runDetail.approvals}
      />,
    );
    expect(screen.getByText("recon-preparer")).toBeDefined();
    expect(screen.getByText("recon-reporter")).toBeDefined();
    expect(screen.getByText("csv-ingest@1")).toBeDefined();
    expect(screen.getByText("txn-match@1")).toBeDefined();
    expect(screen.getByText("notify@1")).toBeDefined();
    expect(screen.getAllByText("completed").length).toBe(2);
  });

  it("shows the gate decision with decider and the reason VERBATIM", () => {
    render(
      <RunTimeline
        definition={definition}
        steps={runDetail.steps}
        approvals={runDetail.approvals}
      />,
    );
    expect(screen.getByText("Review the exception list")).toBeDefined();
    expect(screen.getAllByText("ops@bank.example").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "“Both exceptions explained: Globex invoice typo, ref 88231 under investigation”",
      ),
    ).toBeDefined();
  });

  it("shows step input and output JSON", () => {
    const { container } = render(
      <RunTimeline
        definition={definition}
        steps={runDetail.steps}
        approvals={runDetail.approvals}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain('"matchedCount": 10');
    expect(text).toContain('"delivered": true');
  });

  it("lets a reviewer approve directly from the run-view gate", async () => {
    vi.mocked(api.decideApproval).mockResolvedValue({ ok: true });
    const pending: RunApproval = {
      ...runDetail.approvals[0]!,
      status: "pending",
      decided_at: null,
      decided_by: null,
      reason: null,
    };
    render(<RunTimeline definition={definition} steps={runDetail.steps} approvals={[pending]} />);
    await userEvent.type(screen.getByLabelText("Reason for exception_review"), "Looks good");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(api.decideApproval).toHaveBeenCalledWith(pending.id, "approved", "Looks good");
  });

  it("styles a rejected gate red and shows the rejection reason", () => {
    const rejected: RunApproval = {
      ...runDetail.approvals[0]!,
      status: "rejected",
      reason: "Numbers do not reconcile, resubmit",
    };
    const { container } = render(
      <RunTimeline definition={definition} steps={runDetail.steps} approvals={[rejected]} />,
    );
    const quote = container.querySelector("blockquote");
    expect(quote?.textContent).toContain("Numbers do not reconcile, resubmit");
    expect(quote?.className).toContain("border-blocked");
  });

  it("shows a pending gate as awaiting decision", () => {
    const pending: RunApproval = {
      ...runDetail.approvals[0]!,
      status: "pending",
      decided_at: null,
      decided_by: null,
      reason: null,
    };
    render(<RunTimeline definition={definition} steps={[]} approvals={[pending]} />);
    expect(screen.getByText(/Awaiting human decision/)).toBeDefined();
  });

  it("renders an approved gate without a reason as decision only", () => {
    const noReason: RunApproval = { ...runDetail.approvals[0]!, reason: null };
    const { container } = render(
      <RunTimeline definition={definition} steps={runDetail.steps} approvals={[noReason]} />,
    );
    expect(container.querySelector("blockquote")).toBeNull();
  });

  it("counts retry attempts and surfaces the error payload", () => {
    const failed: StepRun = {
      ...runDetail.steps[0]!,
      id: "s1b",
      attempt: 2,
      status: "failed",
      error: { message: "timeout contacting ledger" },
    };
    const { container } = render(
      <RunTimeline
        definition={definition}
        steps={[runDetail.steps[0]!, failed]}
        approvals={[]}
      />,
    );
    expect(screen.getByText("attempt ×2")).toBeDefined();
    expect(container.textContent).toContain("timeout contacting ledger");
  });
});

describe("RunTimeline n-of-m gates", () => {
  it("shows quorum progress and one line per recorded decision", () => {
    render(
      <RunTimeline definition={definition} steps={runDetail.steps} approvals={[multiApproval]} />,
    );
    expect(screen.getByText("Approvals: 1 of 2")).toBeDefined();
    expect(screen.getByText("alice@bank.example")).toBeDefined();
    expect(screen.getByText("approved")).toBeDefined();
    expect(screen.getByText(/first sign-off/)).toBeDefined();
  });

  it("styles rejecting deciders red and tolerates anonymous, reasonless lines", () => {
    const rejected: RunApproval = {
      ...multiApproval,
      status: "rejected",
      decisions: [
        ...multiApproval.decisions,
        {
          id: "ad-m2",
          decision: "rejected",
          reason: null,
          created_at: "2026-06-12T08:00:05.000Z",
          decided_by: null,
        },
      ],
    };
    const { container } = render(
      <RunTimeline definition={definition} steps={runDetail.steps} approvals={[rejected]} />,
    );
    expect(screen.getByText("unknown")).toBeDefined();
    const decisionList = container.querySelector("ul");
    expect(decisionList?.textContent).toContain("rejected");
    expect(decisionList?.querySelector(".text-blocked")).not.toBeNull();
    // The n-of-m decision list replaces the single-approval blockquote block.
    expect(container.querySelector("blockquote")).toBeNull();
  });

  it("shows the quorum with no decisions yet", () => {
    render(
      <RunTimeline
        definition={definition}
        steps={[]}
        approvals={[{ ...multiApproval, decisions: [] }]}
      />,
    );
    expect(screen.getByText("Approvals: 0 of 2")).toBeDefined();
  });
});

describe("RunTimeline static (flow visualizer) mode", () => {
  it("renders the definition alone with not-started markers", () => {
    render(<RunTimeline definition={definition} />);
    expect(screen.getAllByText("not started").length).toBe(2);
    expect(screen.getByText("not reached")).toBeDefined();
    expect(
      screen.getByText("Ingest the CSVs, match transactions, produce the exception list."),
    ).toBeDefined();
  });
});
