import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pendingApprovals, pendingMultiApprovals, runDetail, RUN_ID } from "../../test/fixtures";
import { renderApp } from "../../test/render";
import * as api from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    listApprovals: vi.fn(),
    decideApproval: vi.fn(),
    getRun: vi.fn(),
    verifyAudit: vi.fn(),
  };
});

const mocked = {
  listApprovals: vi.mocked(api.listApprovals),
  decideApproval: vi.mocked(api.decideApproval),
  getRun: vi.mocked(api.getRun),
  verifyAudit: vi.mocked(api.verifyAudit),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getRun.mockResolvedValue(runDetail);
  mocked.verifyAudit.mockResolvedValue({ ok: true, count: 12, headHash: "ab" });
});

describe("ApprovalsPage", () => {
  it("shows the empty state", async () => {
    mocked.listApprovals.mockResolvedValue({ approvals: [] });
    renderApp("/approvals");
    expect(await screen.findByText("No pending approvals.")).toBeDefined();
  });

  it("lists pending gates with flow, step and age, linking to the run", async () => {
    mocked.listApprovals.mockResolvedValue({ approvals: pendingApprovals });
    renderApp("/approvals");

    expect(await screen.findByText("daily-cash-reconciliation")).toBeDefined();
    expect(screen.getByText("exception_review")).toBeDefined();
    expect(screen.getByText(/requested/)).toBeDefined();
    const link = screen.getByRole("link", { name: "View run" });
    expect(link.getAttribute("href")).toBe(`/runs/${RUN_ID}`);
  });

  it("shows quorum progress on n-of-m gates and hides it on single-approval ones", async () => {
    mocked.listApprovals.mockResolvedValue({
      approvals: [...pendingApprovals, ...pendingMultiApprovals],
    });
    renderApp("/approvals");

    expect(await screen.findByText("high-value-payment")).toBeDefined();
    expect(screen.getByText("1 of 2 approvals")).toBeDefined();
    // The single-approval gate shows no quorum chrome.
    expect(screen.queryByText("0 of 1 approvals")).toBeNull();
  });

  it("approves without a reason and navigates to the run", async () => {
    mocked.listApprovals.mockResolvedValue({ approvals: pendingApprovals });
    mocked.decideApproval.mockResolvedValue({ ok: true });
    const { router } = renderApp("/approvals");

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));

    expect(mocked.decideApproval).toHaveBeenCalledWith("ap-pending-1", "approved", undefined);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/runs/${RUN_ID}`),
    );
  });

  it("approves with a reason when one is typed", async () => {
    mocked.listApprovals.mockResolvedValue({ approvals: pendingApprovals });
    mocked.decideApproval.mockResolvedValue({ ok: true });
    renderApp("/approvals");

    await userEvent.type(
      await screen.findByLabelText("Reason for exception_review"),
      "Exceptions explained",
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(mocked.decideApproval).toHaveBeenCalledWith(
      "ap-pending-1",
      "approved",
      "Exceptions explained",
    );
  });

  it("refuses to reject without a reason", async () => {
    mocked.listApprovals.mockResolvedValue({ approvals: pendingApprovals });
    renderApp("/approvals");

    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));

    expect(screen.getByText("A reason is required to reject.")).toBeDefined();
    expect(mocked.decideApproval).not.toHaveBeenCalled();
  });

  it("rejects with a reason and navigates to the run", async () => {
    mocked.listApprovals.mockResolvedValue({ approvals: pendingApprovals });
    mocked.decideApproval.mockResolvedValue({ ok: true });
    const { router } = renderApp("/approvals");

    await userEvent.type(
      await screen.findByLabelText("Reason for exception_review"),
      "Numbers do not reconcile",
    );
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(mocked.decideApproval).toHaveBeenCalledWith(
      "ap-pending-1",
      "rejected",
      "Numbers do not reconcile",
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/runs/${RUN_ID}`),
    );
  });

  it("surfaces decision failures (e.g. already decided)", async () => {
    mocked.listApprovals.mockResolvedValue({ approvals: pendingApprovals });
    mocked.decideApproval.mockRejectedValue(new api.ApiError(409, "already decided"));
    renderApp("/approvals");

    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Decision failed/)).toBeDefined();
  });

  it("shows an error note when the inbox fails to load", async () => {
    mocked.listApprovals.mockRejectedValue(new Error("api down"));
    renderApp("/approvals");
    expect(await screen.findByText(/api down/)).toBeDefined();
  });
});
