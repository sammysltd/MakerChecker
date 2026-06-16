import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BarsChart, Chart, type ChartSpec, LineChart, Prose, WaterfallChart } from "./charts";

describe("charts", () => {
  it("BarsChart draws a bar per item, a threshold line, and flags items", () => {
    const { container } = render(
      <BarsChart
        chart={{
          kind: "bars",
          items: [
            { label: "Escalated", value: 2, flag: true },
            { label: "Cleared", value: 3 },
          ],
          threshold: 4,
          thresholdLabel: "limit",
          caption: "by outcome",
        }}
      />,
    );
    expect(container.querySelectorAll("rect")).toHaveLength(2);
    // threshold dashed line present
    expect(container.querySelector("line")).not.toBeNull();
    // flagged bar uses the blocked red
    const flagged = [...container.querySelectorAll("rect")].some((r) => r.getAttribute("fill") === "#b91c1c");
    expect(flagged).toBe(true);
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe("by outcome");
  });

  it("WaterfallChart renders gross, deduction, and a Net bar", () => {
    const { container } = render(
      <WaterfallChart
        chart={{
          kind: "waterfall",
          items: [
            { label: "Gross", value: 3000 },
            { label: "Deductions", value: -1400 },
          ],
          unit: "",
          caption: "bridge",
        }}
      />,
    );
    // gross + deduction + appended Net = 3 bars
    expect(container.querySelectorAll("rect")).toHaveLength(3);
    expect(container.textContent).toContain("Net");
  });

  it("LineChart shades the excursion area when points breach the limit", () => {
    const { container } = render(
      <LineChart chart={{ kind: "line", points: [2, 4, 9, 5], limit: 8, unit: "C", caption: "temp" }} />,
    );
    // line path + area path = 2 paths; breach dots in red
    expect(container.querySelectorAll("path").length).toBeGreaterThanOrEqual(2);
    const red = [...container.querySelectorAll("circle")].some((c) => c.getAttribute("fill") === "#b91c1c");
    expect(red).toBe(true);
  });

  it("LineChart omits the area when nothing breaches the limit", () => {
    const { container } = render(
      <LineChart chart={{ kind: "line", points: [1, 2, 3], limit: 8, unit: "C", caption: "calm" }} />,
    );
    // only the line path (no shaded area path)
    expect(container.querySelectorAll("path")).toHaveLength(1);
  });

  it("Chart dispatches by kind and shows the caption", () => {
    const charts: ChartSpec[] = [
      { kind: "bars", items: [{ label: "a", value: 1 }], caption: "C-bars" },
      { kind: "waterfall", items: [{ label: "g", value: 10 }], unit: "", caption: "C-water" },
      { kind: "line", points: [1, 2], limit: 3, unit: "x", caption: "C-line" },
    ];
    for (const chart of charts) {
      const { container } = render(<Chart chart={chart} />);
      expect(container.querySelector("figcaption")?.textContent).toBe(chart.caption);
      expect(container.querySelector("svg")).not.toBeNull();
    }
  });

  it("Prose links footnote markers and keeps plain text", () => {
    const { container } = render(<Prose text="net margin is impossible [2] for this market" />);
    const link = container.querySelector('a[href="#fn-2"]');
    expect(link?.textContent).toBe("[2]");
    expect(container.textContent).toContain("net margin is impossible");
  });
});
