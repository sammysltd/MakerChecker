import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../../test/render";
import * as api from "../lib/api";
import { useApiKey } from "./ApiKeyContext";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    listRuns: vi.fn().mockResolvedValue({ runs: [] }),
    listFlows: vi.fn().mockResolvedValue({ flows: [] }),
  };
});

afterEach(() => {
  localStorage.clear();
});

describe("Layout", () => {
  it("renders the wordmark and all nav links", async () => {
    renderApp("/");

    expect(await screen.findByRole("link", { name: "MakerChecker" })).toBeDefined();
    for (const [label, href] of [
      ["Runs", "/"],
      ["Approvals", "/approvals"],
      ["Agents", "/agents"],
      ["Skills", "/skills"],
      ["Roles", "/roles"],
      ["Flows", "/flows"],
    ] as const) {
      expect(screen.getByRole("link", { name: label }).getAttribute("href")).toBe(href);
    }
  });

  it("hides the API key banner until a 401 happens", async () => {
    renderApp("/");
    await screen.findByRole("link", { name: "MakerChecker" });
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("shows the key banner on 401 and saves the key to localStorage", async () => {
    renderApp("/");
    await screen.findByRole("link", { name: "MakerChecker" });

    act(() => {
      window.dispatchEvent(new Event(api.UNAUTHORIZED_EVENT));
    });

    const input = await screen.findByLabelText("API key");
    await userEvent.type(input, "mk_live_key");
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));

    expect(localStorage.getItem("mc_api_key")).toBe("mk_live_key");
    await waitFor(() => expect(screen.queryByLabelText("API key")).toBeNull());
  });
});

describe("useApiKey", () => {
  it("throws outside the provider", () => {
    function Bare() {
      useApiKey();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/inside ApiKeyProvider/);
  });
});
