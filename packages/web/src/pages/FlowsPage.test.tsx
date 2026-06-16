import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { flowDetail, flows } from "../../test/fixtures";
import { renderApp } from "../../test/render";
import * as api from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    listFlows: vi.fn(),
    getFlow: vi.fn(),
  };
});

const mocked = {
  listFlows: vi.mocked(api.listFlows),
  getFlow: vi.mocked(api.getFlow),
};

describe("FlowsPage", () => {
  it("lists flows with latest version and status", async () => {
    mocked.listFlows.mockResolvedValue({ flows });
    renderApp("/flows");

    const link = await screen.findByRole("link", { name: "daily-cash-reconciliation" });
    expect(link.getAttribute("href")).toBe("/flows/daily-cash-reconciliation");
    expect(screen.getByText("v1")).toBeDefined();
    expect(screen.getByText("published")).toBeDefined();
    // The version-less flow renders em-dashes.
    expect(screen.getByRole("link", { name: "draft-flow" })).toBeDefined();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows an error note on failure", async () => {
    mocked.listFlows.mockRejectedValue(new Error("flows down"));
    renderApp("/flows");
    expect(await screen.findByText(/flows down/)).toBeDefined();
  });
});

describe("FlowDetailPage", () => {
  it("renders the latest definition as a static timeline plus version history", async () => {
    mocked.getFlow.mockResolvedValue(flowDetail);
    renderApp("/flows/daily-cash-reconciliation");

    expect(
      await screen.findByRole("heading", { name: "daily-cash-reconciliation" }),
    ).toBeDefined();
    // Static visualizer: definition steps with not-started markers.
    expect(screen.getByText("recon-preparer")).toBeDefined();
    expect(screen.getByText("Review the exception list")).toBeDefined();
    expect(screen.getAllByText("not started").length).toBe(2);
    // Version history lists both versions.
    expect(screen.getByText("Version history")).toBeDefined();
    expect(screen.getAllByText("v2").length).toBeGreaterThan(0);
    expect(screen.getByText("v1")).toBeDefined();
    expect(mocked.getFlow).toHaveBeenCalledWith("daily-cash-reconciliation");
  });

  it("handles a flow with no versions", async () => {
    mocked.getFlow.mockResolvedValue({ flow: flowDetail.flow, versions: [] });
    renderApp("/flows/daily-cash-reconciliation");
    expect(await screen.findByText("No versions published.")).toBeDefined();
  });

  it("shows an error note on failure", async () => {
    mocked.getFlow.mockRejectedValue(new Error("flow missing"));
    renderApp("/flows/daily-cash-reconciliation");
    expect(await screen.findByText(/flow missing/)).toBeDefined();
  });
});
