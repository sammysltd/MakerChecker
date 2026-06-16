import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { roleDetail, roles } from "../../test/fixtures";
import { renderApp } from "../../test/render";
import * as api from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    listRoles: vi.fn(),
    getRole: vi.fn(),
  };
});

const mocked = {
  listRoles: vi.mocked(api.listRoles),
  getRole: vi.mocked(api.getRole),
};

describe("RolesPage", () => {
  it("lists roles with active grant counts", async () => {
    mocked.listRoles.mockResolvedValue({ roles });
    renderApp("/roles");

    const link = await screen.findByRole("link", { name: "recon-preparer-role" });
    expect(link.getAttribute("href")).toBe("/roles/ro1");
    expect(screen.getByText("2")).toBeDefined();
  });

  it("defaults a missing grant count to 0", async () => {
    const bare = { ...roles[0]! };
    delete (bare as Partial<typeof bare>).active_grant_count;
    mocked.listRoles.mockResolvedValue({ roles: [bare] });
    renderApp("/roles");
    expect(await screen.findByText("0")).toBeDefined();
  });

  it("shows an error note on failure", async () => {
    mocked.listRoles.mockRejectedValue(new Error("roles down"));
    renderApp("/roles");
    expect(await screen.findByText(/roles down/)).toBeDefined();
  });
});

describe("RoleDetailPage", () => {
  it("shows grants (active + revoked) and SoD constraints", async () => {
    mocked.getRole.mockResolvedValue(roleDetail);
    renderApp("/roles/ro1");

    expect(
      await screen.findByRole("heading", { name: "recon-preparer-role" }),
    ).toBeDefined();
    expect(screen.getByText("csv-ingest@1")).toBeDefined();
    expect(screen.getByText("txn-match@1")).toBeDefined();
    expect(screen.getAllByText(/revoked/).length).toBeGreaterThan(0);
    // Active SoD constraint, red; revoked one marked.
    expect(
      screen.getByText("recon-preparer-role × recon-approver-role"),
    ).toBeDefined();
    expect(screen.getByText(/recon-preparer-role × recon-reporter-role/)).toBeDefined();
    expect(screen.getByText("maker-checker: the preparer may not also approve")).toBeDefined();
    expect(mocked.getRole).toHaveBeenCalledWith("ro1");
  });

  it("renders empty grants and constraints", async () => {
    mocked.getRole.mockResolvedValue({ ...roleDetail, grants: [], sodConstraints: [] });
    renderApp("/roles/ro1");

    expect(await screen.findByText("No skills granted — deny by default.")).toBeDefined();
    expect(screen.getByText("No SoD constraints involve this role.")).toBeDefined();
  });

  it("shows an error note on failure", async () => {
    mocked.getRole.mockRejectedValue(new Error("role missing"));
    renderApp("/roles/ro1");
    expect(await screen.findByText(/role missing/)).toBeDefined();
  });
});
