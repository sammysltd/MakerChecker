import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { skillDetail, skills } from "../../test/fixtures";
import { renderApp } from "../../test/render";
import * as api from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    listSkills: vi.fn(),
    getSkill: vi.fn(),
  };
});

const mocked = {
  listSkills: vi.mocked(api.listSkills),
  getSkill: vi.mocked(api.getSkill),
};

describe("SkillsPage", () => {
  it("lists skills as name@version with risk tier and status", async () => {
    mocked.listSkills.mockResolvedValue({ skills });
    renderApp("/skills");

    const link = await screen.findByRole("link", { name: "csv-ingest@1" });
    expect(link.getAttribute("href")).toBe("/skills/sk1");
    expect(screen.getByText("approve-recon@2")).toBeDefined();
    expect(screen.getByText("low risk")).toBeDefined();
    expect(screen.getByText("high risk")).toBeDefined();
    expect(screen.getByText("published")).toBeDefined();
    expect(screen.getByText("deprecated")).toBeDefined();
  });

  it("shows an error note on failure", async () => {
    mocked.listSkills.mockRejectedValue(new Error("registry down"));
    renderApp("/skills");
    expect(await screen.findByText(/registry down/)).toBeDefined();
  });
});

describe("SkillDetailPage", () => {
  it("shows the skill header and grant history with active and revoked rows", async () => {
    mocked.getSkill.mockResolvedValue(skillDetail);
    renderApp("/skills/sk1");

    expect(await screen.findByRole("heading", { name: "csv-ingest@1" })).toBeDefined();
    expect(screen.getByText("recon-preparer-role")).toBeDefined();
    expect(screen.getByText("recon-reporter-role")).toBeDefined();
    expect(screen.getByText("active")).toBeDefined();
    expect(screen.getAllByText(/by admin@makerchecker.local/).length).toBe(2);
    expect(mocked.getSkill).toHaveBeenCalledWith("sk1");
  });

  it("renders the never-granted empty state", async () => {
    mocked.getSkill.mockResolvedValue({ ...skillDetail, grantHistory: [] });
    renderApp("/skills/sk1");
    expect(await screen.findByText("Never granted to any role.")).toBeDefined();
  });

  it("shows an error note on failure", async () => {
    mocked.getSkill.mockRejectedValue(new Error("skill missing"));
    renderApp("/skills/sk1");
    expect(await screen.findByText(/skill missing/)).toBeDefined();
  });
});
