import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OutputView } from "./OutputView";

describe("OutputView", () => {
  it("renders a recognised output as a titled report with a chart and raw output", () => {
    const { container } = render(
      <OutputView
        output={{
          matchedCount: 10,
          exceptionCount: 1,
          exceptions: [{ type: "amount_mismatch", txnId: "T-1009", detail: "statement != ledger" }],
          report: "Daily Cash Reconciliation\nMatched: 10", // a section item with title only (no detail)
        }}
      />,
    );
    expect(screen.getByText("Cash reconciliation")).toBeDefined();
    expect(container.querySelector("svg")).not.toBeNull(); // the chart
    expect(screen.getByText("Raw output")).toBeDefined(); // collapsed full payload
    expect(container.textContent).toContain("statement != ledger");
    // the raw JSON is still present in the DOM (collapsed)
    expect(container.textContent).toContain('"matchedCount": 10');
  });

  it("renders a cold-chain incident as a footnoted report with a line chart", () => {
    const { container } = render(
      <OutputView
        output={{
          incident: { lot: "LOT-5002", product: "VaxFlu Quad vaccine", shipment: "VAX-2026-114", units: 9800, valueUsd: 235200 },
          limitC: 8,
          maxExcursionMinutes: 120,
          intervalMinutes: 30,
          readings: [
            { minute: 0, tempC: 4 },
            { minute: 120, tempC: 9 },
            { minute: 180, tempC: 15 },
            { minute: 360, tempC: 5 },
          ],
          peakTempC: 15,
          minutesOverLimit: 180,
          classification: "beyond",
          recommendedDisposition: "destroy",
          held: true,
          heldUnits: 9800,
          holdList: ["LOT-5002"],
          report: {
            title: "Cold-Chain Incident Report",
            ref: "CCIR-2026-0613",
            body: [
              "A temperature excursion was detected on shipment VAX-2026-114 [1].",
              "Cumulative time above the limit exceeds the allowance [2]. Recommended for destruction [3].",
              "Disposition is a one-way door (21 CFR 211.22) — not the agent's to make.",
            ],
            footnotes: [
              "Datalogger trace DL-114-2026.csv",
              "Stability Study SR-2024-118 — VaxFlu Quad vaccine",
              "SOP QA-014 — Excursion Disposition",
            ],
          },
        }}
      />,
    );
    // report title renders in the header (with its reference)
    expect(screen.getByRole("heading").textContent).toContain("Cold-Chain Incident Report · CCIR-2026-0613");
    // the line chart is an svg
    expect(container.querySelector("svg")).not.toBeNull();
    // footnote link [1] resolves to an element with id="fn-1"
    expect(container.querySelector('a[href="#fn-1"]')).not.toBeNull();
    expect(container.querySelector("#fn-1")).not.toBeNull();
    // the raw payload is still present (collapsed)
    expect(screen.getByText("Raw output")).toBeDefined();
    expect(container.textContent).toContain('"classification": "beyond"');
  });

  it("tones bad sections with the blocked border", () => {
    const { container } = render(
      <OutputView
        output={{
          matchedCount: 8,
          exceptionCount: 1,
          exceptions: [{ type: "amount_mismatch", txnId: "T-1009", detail: "statement != ledger" }],
        }}
      />,
    );
    expect(screen.getByText("Cash reconciliation")).toBeDefined();
    expect(container.querySelector(".border-blocked")).not.toBeNull();
  });

  it("renders a report without a chart when the adapter provides none", () => {
    const { container } = render(
      <OutputView output={{ narratives: [{ caseId: "C-1", narrative: "draft" }] }} />,
    );
    expect(screen.getByText("Drafted reports")).toBeDefined();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("falls back to a JSON block for unrecognised output", () => {
    const { container } = render(<OutputView output={{ foo: 1, bar: "baz" }} />);
    expect(screen.queryByText("Cash reconciliation")).toBeNull();
    expect(screen.getByText("Output")).toBeDefined(); // default JsonBlock label
    expect(container.textContent).toContain('"foo": 1');
  });

  it("uses a custom label for the JSON fallback", () => {
    render(<OutputView output={"just a string"} label="Result" />);
    expect(screen.getByText("Result")).toBeDefined();
  });
});
