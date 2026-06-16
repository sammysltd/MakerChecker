import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { JsonBlock } from "./JsonBlock";

describe("JsonBlock", () => {
  it("renders a collapsed details with pretty JSON", () => {
    const { container } = render(<JsonBlock label="Input" value={{ a: 1 }} />);
    expect(screen.getByText("Input")).toBeDefined();
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe('{\n  "a": 1\n}');
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  it("opens by default when asked", () => {
    const { container } = render(<JsonBlock label="Error" value="bad" defaultOpen />);
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("uses the error tone", () => {
    const { container } = render(
      <JsonBlock label="Error" value={{ message: "x" }} tone="error" />,
    );
    expect(container.querySelector("summary")?.className).toContain("text-blocked");
    expect(container.querySelector("pre")?.className).toContain("bg-red-50");
  });
});
