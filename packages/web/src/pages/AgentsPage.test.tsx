import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { agentDetail, agents } from "../../test/fixtures";
import { renderApp } from "../../test/render";
import * as api from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    listAgents: vi.fn(),
    getAgent: vi.fn(),
  };
});

const mocked = {
  listAgents: vi.mocked(api.listAgents),
  getAgent: vi.mocked(api.getAgent),
};

describe("AgentsPage", () => {
  it("lists agents with role and status, linking to detail", async () => {
    mocked.listAgents.mockResolvedValue({ agents });
    renderApp("/agents");

    const link = await screen.findByRole("link", { name: "recon-preparer" });
    expect(link.getAttribute("href")).toBe("/agents/ag1");
    expect(screen.getByText("recon-preparer-role")).toBeDefined();
    expect(screen.getByText("active")).toBeDefined();
  });

  it("shows an error note on failure", async () => {
    mocked.listAgents.mockRejectedValue(new Error("nope"));
    renderApp("/agents");
    expect(await screen.findByText(/nope/)).toBeDefined();
  });
});

describe("AgentDetailPage", () => {
  it("shows role, granted skills with risk tier, and recent runs", async () => {
    mocked.getAgent.mockResolvedValue(agentDetail);
    renderApp("/agents/ag1");

    expect(await screen.findByRole("heading", { name: "recon-preparer" })).toBeDefined();
    expect(screen.getByText("Prepares reconciliations")).toBeDefined();
    expect(screen.getByText("recon-preparer-role")).toBeDefined();
    expect(screen.getByText("csv-ingest@1")).toBeDefined();
    expect(screen.getByText("low risk")).toBeDefined();
    // Recent run row links to the run viewer.
    const runLink = screen.getByRole("link", { name: "11111111" });
    expect(runLink.getAttribute("href")).toContain("/runs/");
    expect(mocked.getAgent).toHaveBeenCalledWith("ag1");
  });

  it("renders deny-by-default empties without skills or runs", async () => {
    mocked.getAgent.mockResolvedValue({ ...agentDetail, skills: [], recentRuns: [] });
    renderApp("/agents/ag1");

    expect(await screen.findByText("No skills granted — deny by default.")).toBeDefined();
    expect(screen.getByText("No runs yet.")).toBeDefined();
  });

  it("shows an error note on failure", async () => {
    mocked.getAgent.mockRejectedValue(new Error("agent missing"));
    renderApp("/agents/ag1");
    expect(await screen.findByText(/agent missing/)).toBeDefined();
  });
});
