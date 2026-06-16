import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { runDetail, sodRunDetail, RUN_ID } from "../../test/fixtures";
import { renderApp } from "../../test/render";
import * as api from "../lib/api";
import { runRefetchInterval } from "./RunViewerPage";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    getRun: vi.fn(),
    verifyAudit: vi.fn(),
  };
});

const mockedGetRun = vi.mocked(api.getRun);
const mockedVerify = vi.mocked(api.verifyAudit);

describe("RunViewerPage", () => {
  it("renders header, timeline, gate decision, audit trail and chain badge", async () => {
    mockedGetRun.mockResolvedValue(runDetail);
    mockedVerify.mockResolvedValue({ ok: true, count: 12, headHash: "abcdef0123456789" });
    renderApp(`/runs/${RUN_ID}`);

    expect(
      await screen.findByRole("heading", { name: "daily-cash-reconciliation" }),
    ).toBeDefined();
    expect(screen.getByText("v1")).toBeDefined();
    expect(screen.getByText(/Triggered by/)).toBeDefined();
    // Timeline: agent steps with skill chips.
    expect(screen.getAllByText("recon-preparer").length).toBeGreaterThan(0);
    expect(screen.getByText("csv-ingest@1")).toBeDefined();
    // Gate decision, verbatim reason.
    expect(
      screen.getByText(
        "“Both exceptions explained: Globex invoice typo, ref 88231 under investigation”",
      ),
    ).toBeDefined();
    // Audit trail with llm.call model + tokens.
    expect(await screen.findByText("claude-opus-4-8")).toBeDefined();
    expect(screen.getByText("2,300 in / 412 out tokens")).toBeDefined();
    // Chain badge.
    expect(await screen.findByText("Chain verified ✓ (12 events)")).toBeDefined();
    expect(mockedGetRun).toHaveBeenCalledWith(RUN_ID);
  });

  it("renders the failed run banner and the red SoD audit entry", async () => {
    mockedGetRun.mockResolvedValue(sodRunDetail);
    mockedVerify.mockResolvedValue({ ok: true, count: 5, headHash: "ff00" });
    renderApp("/runs/sod-run-id");

    expect(await screen.findByText("Run failed")).toBeDefined();
    expect(screen.getByText(/enforcement: segregation of duties/)).toBeDefined();
    expect(screen.getByText("Blocked — segregation of duties")).toBeDefined();
    expect(
      screen.getAllByText(/role "recon-approver-role" conflicts with "recon-preparer-role"/)
        .length,
    ).toBeGreaterThan(0);
  });

  it("shows TAMPER DETECTED when chain verification fails", async () => {
    mockedGetRun.mockResolvedValue(runDetail);
    mockedVerify.mockResolvedValue({
      ok: false,
      count: 9,
      failedSeq: "10",
      reason: "hash mismatch (row tampered)",
    });
    renderApp(`/runs/${RUN_ID}`);

    expect(await screen.findByText("Tamper detected")).toBeDefined();
    expect(screen.getByText(/seq 10/)).toBeDefined();
  });

  it("shows an error note when the run cannot be loaded", async () => {
    mockedGetRun.mockRejectedValue(new api.ApiError(404, "run not found"));
    mockedVerify.mockResolvedValue({ ok: true, count: 0, headHash: null });
    renderApp("/runs/missing");

    expect(await screen.findByText(/Failed to load/)).toBeDefined();
    expect(screen.getByText(/run not found/)).toBeDefined();
  });
});

describe("runRefetchInterval", () => {
  it("polls every 2s before data arrives and while non-terminal", () => {
    expect(runRefetchInterval(undefined)).toBe(2000);
    expect(
      runRefetchInterval({ ...runDetail, run: { ...runDetail.run, status: "running" } }),
    ).toBe(2000);
    expect(
      runRefetchInterval({
        ...runDetail,
        run: { ...runDetail.run, status: "waiting_approval" },
      }),
    ).toBe(2000);
  });

  it("stops polling on terminal statuses", () => {
    expect(runRefetchInterval(runDetail)).toBe(false);
    expect(
      runRefetchInterval({ ...runDetail, run: { ...runDetail.run, status: "failed" } }),
    ).toBe(false);
  });
});
