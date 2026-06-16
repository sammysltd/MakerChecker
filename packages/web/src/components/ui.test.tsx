import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  EmptyNote,
  ErrorNote,
  Loading,
  PageTitle,
  RelTime,
  RiskBadge,
  SkillChip,
  StatusPill,
} from "./ui";

describe("StatusPill", () => {
  const matrix: Array<[string, string]> = [
    ["completed", "text-verified"],
    ["approved", "text-verified"],
    ["waiting_approval", "text-waiting"],
    ["running", "text-waiting"],
    ["failed", "text-blocked"],
    ["rejected", "text-blocked"],
    ["draft", "text-stone-500"],
  ];

  it.each(matrix)("renders %s with the right tone", (status, cls) => {
    render(<StatusPill status={status} />);
    const label = status.replace(/_/g, " ");
    const el = screen.getByText(label);
    expect(el.className).toContain(cls);
  });

  it("replaces underscores in the label", () => {
    render(<StatusPill status="waiting_approval" />);
    expect(screen.getByText("waiting approval")).toBeDefined();
  });
});

describe("RiskBadge", () => {
  it.each([
    ["high", "text-blocked"],
    ["medium", "text-waiting"],
    ["low", "text-verified"],
  ])("renders %s risk", (tier, cls) => {
    render(<RiskBadge tier={tier} />);
    const el = screen.getByText(`${tier} risk`);
    expect(el.className).toContain(cls);
  });
});

describe("SkillChip", () => {
  it("renders the skill ref in monospace", () => {
    render(<SkillChip skillRef="csv-ingest@1" />);
    const el = screen.getByText("csv-ingest@1");
    expect(el.className).toContain("font-mono");
  });
});

describe("RelTime", () => {
  it("shows the relative age with the absolute time on hover", () => {
    render(<RelTime iso={new Date(Date.now() - 120_000).toISOString()} />);
    const el = screen.getByText("2m ago");
    expect(el.getAttribute("title")).toContain("UTC");
  });

  it("renders an em-dash for null", () => {
    render(<RelTime iso={null} />);
    expect(screen.getByText("—")).toBeDefined();
  });
});

describe("notes", () => {
  it("Loading names the resource", () => {
    render(<Loading what="runs" />);
    expect(screen.getByText("Loading runs…")).toBeDefined();
  });

  it("ErrorNote shows Error messages", () => {
    render(<ErrorNote error={new Error("boom")} />);
    expect(screen.getByRole("alert").textContent).toContain("boom");
  });

  it("ErrorNote stringifies non-Error values", () => {
    render(<ErrorNote error="plain failure" />);
    expect(screen.getByRole("alert").textContent).toContain("plain failure");
  });

  it("EmptyNote and PageTitle render children", () => {
    render(
      <div>
        <PageTitle>Runs</PageTitle>
        <EmptyNote>Nothing here</EmptyNote>
      </div>,
    );
    expect(screen.getByRole("heading", { name: "Runs" })).toBeDefined();
    expect(screen.getByText("Nothing here")).toBeDefined();
  });
});
