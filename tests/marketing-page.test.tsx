import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "../app/page";

describe("Tabloom landing page", () => {
  it("leads with the browser workspace workflow", () => {
    render(<Home />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Make every new tab your workspace.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/drag a live tab into the right context/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/spaces for projects\. collections for context/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/search everything without leaving the new tab/i),
    ).toBeInTheDocument();
  });

  it("presents optional sync and MCP after the core workflow", () => {
    render(<Home />);

    expect(
      within(document.querySelector("#local-first")!).getByText(
        /useful before you sign in/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(document.querySelector("#mcp")!).getByRole("link", {
        name: /connect with mcp/i,
      }),
    ).toHaveAttribute("href", "/mcp");
  });

  it("does not advertise retired product behavior", () => {
    render(<Home />);

    expect(
      screen.queryByText(/save selected|save & close|demo workspace/i),
    ).not.toBeInTheDocument();
  });
});
