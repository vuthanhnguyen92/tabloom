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

  it("shows the real workspace model in the hero", () => {
    render(<Home />);

    const preview = screen.getByLabelText("Tabloom workspace preview");
    expect(within(preview).getByText("My Space")).toBeInTheDocument();
    expect(within(preview).getByText("Launch planning")).toBeInTheDocument();
    expect(within(preview).getByText("Current tabs")).toBeInTheDocument();
    expect(within(preview).getByText("Sprint notes")).toBeInTheDocument();
  });

  it("renders capture, organize, and search as one ordered workflow", () => {
    render(<Home />);

    const steps = Array.from(
      document.querySelectorAll("#features article[data-step]"),
    );
    expect(steps.map((step) => step.getAttribute("data-step"))).toEqual([
      "capture",
      "organize",
      "search",
    ]);
    expect(screen.getAllByText("Save all as collection").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Open all").length).toBeGreaterThan(0);
    expect(screen.getByText("My Space · Launch planning")).toBeInTheDocument();
  });

  it("describes local-first use, optional sync, supported browsers, and MCP", () => {
    render(<Home />);

    expect(
      screen.getByText(/your spaces stay useful on this device before you sign in/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/sign in when you want cross-device sync/i),
    ).toBeInTheDocument();
    for (const browser of [
      "Chrome",
      "Arc",
      "Dia",
      "Firefox",
      "Safari on macOS",
    ]) {
      expect(screen.getByText(browser)).toBeInTheDocument();
    }
    expect(screen.queryByText(/iphone|ipad/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /connect with mcp/i }),
    ).toHaveAttribute("href", "/mcp");
  });

  it("does not advertise retired product behavior", () => {
    render(<Home />);

    expect(
      screen.queryByText(/save selected|save & close|demo workspace/i),
    ).not.toBeInTheDocument();
  });
});
