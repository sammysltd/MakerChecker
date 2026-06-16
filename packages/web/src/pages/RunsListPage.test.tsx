import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { flows, runDetail, runSummary, RUN_ID } from "../../test/fixtures";
import { renderApp } from "../../test/render";
import * as api from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    listRuns: vi.fn(),
    listFlows: vi.fn(),
    triggerFlow: vi.fn(),
    getRun: vi.fn(),
    verifyAudit: vi.fn(),
  };
});

const mocked = {
  listRuns: vi.mocked(api.listRuns),
  listFlows: vi.mocked(api.listFlows),
  triggerFlow: vi.mocked(api.triggerFlow),
  getRun: vi.mocked(api.getRun),
  verifyAudit: vi.mocked(api.verifyAudit),
};

describe("RunsListPage", () => {
  it("renders run rows with flow, version, status and duration", async () => {
    mocked.listRuns.mockResolvedValue({
      runs: [runSummary, { ...runSummary, id: "r2", status: "waiting_approval" }],
    });
    mocked.listFlows.mockResolvedValue({ flows });
    renderApp("/");

    expect(await screen.findAllByText("daily-cash-reconciliation")).toHaveLength(2);
    expect(screen.getByText("completed")).toBeDefined();
    expect(screen.getByText("waiting approval")).toBeDefined();
    expect(screen.getAllByText("v1")).toHaveLength(2);
    expect(screen.getAllByText("8.4s")).toHaveLength(2);
  });

  it("shows trigger buttons only for published flows", async () => {
    mocked.listRuns.mockResolvedValue({ runs: [] });
    mocked.listFlows.mockResolvedValue({ flows });
    renderApp("/");

    expect(
      await screen.findByRole("button", { name: "Trigger daily-cash-reconciliation" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Trigger draft-flow" })).toBeNull();
    expect(screen.getByText("No runs yet — trigger a flow above.")).toBeDefined();
  });

  it("triggers a flow and navigates to the new run", async () => {
    mocked.listRuns.mockResolvedValue({ runs: [] });
    mocked.listFlows.mockResolvedValue({ flows });
    mocked.triggerFlow.mockResolvedValue({ runId: RUN_ID });
    mocked.getRun.mockResolvedValue(runDetail);
    mocked.verifyAudit.mockResolvedValue({ ok: true, count: 12, headHash: "ab" });
    const { router } = renderApp("/");

    const button = await screen.findByRole("button", {
      name: "Trigger daily-cash-reconciliation",
    });
    await userEvent.click(button);

    expect(mocked.triggerFlow).toHaveBeenCalledWith("daily-cash-reconciliation");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/runs/${RUN_ID}`),
    );
  });

  it("navigates to the run viewer when a row is clicked", async () => {
    mocked.listRuns.mockResolvedValue({ runs: [runSummary] });
    mocked.listFlows.mockResolvedValue({ flows });
    mocked.getRun.mockResolvedValue(runDetail);
    mocked.verifyAudit.mockResolvedValue({ ok: true, count: 12, headHash: "ab" });
    const { router } = renderApp("/");

    await userEvent.click(await screen.findByText("completed"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/runs/${RUN_ID}`),
    );
  });

  it("surfaces trigger failures", async () => {
    mocked.listRuns.mockResolvedValue({ runs: [] });
    mocked.listFlows.mockResolvedValue({ flows });
    mocked.triggerFlow.mockRejectedValue(new api.ApiError(404, "no published flow"));
    renderApp("/");

    await userEvent.click(
      await screen.findByRole("button", { name: "Trigger daily-cash-reconciliation" }),
    );
    expect(await screen.findByText(/no published flow/)).toBeDefined();
  });

  it("shows an error note when runs fail to load", async () => {
    mocked.listRuns.mockRejectedValue(new Error("network down"));
    mocked.listFlows.mockResolvedValue({ flows: [] });
    renderApp("/");

    expect(await screen.findByText(/network down/)).toBeDefined();
  });
});
