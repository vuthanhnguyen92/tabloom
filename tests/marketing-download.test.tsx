import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BrowserDownloadButton } from "../app/BrowserDownloadButton";
import Home from "../app/page";

function identifyBrowser(userAgent: string, platform = "MacIntel") {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
}

describe("marketing extension download", () => {
  it("uses extension downloads as the landing page's primary calls to action", async () => {
    identifyBrowser("Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36");
    render(<Home />);

    expect(screen.queryByRole("link", { name: /open workspace/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /start organizing/i })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("link", { name: /download for chromium/i })).toHaveLength(3));
    expect(screen.getByRole("link", { name: /web workspace/i })).toHaveAttribute("href", "/app");
  });

  it.each([
    ["Chromium", "Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36", "/downloads/tabloom-chromium.zip"],
    ["Firefox", "Mozilla/5.0 Firefox/147.0", "/downloads/tabloom-firefox.zip"],
    ["Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.4 Safari/605.1.15", "/downloads/tabloom-safari.zip"],
  ])("downloads the %s package for the current browser", async (browserName, userAgent, href) => {
    identifyBrowser(userAgent);
    render(<BrowserDownloadButton className="button" />);

    await waitFor(() => expect(screen.getByRole("link", { name: `Download for ${browserName}` })).toHaveAttribute("href", href));
  });

  it("offers a browser chooser when the current browser is unknown", async () => {
    identifyBrowser("UnknownBrowser/1.0", "Unknown");
    render(<BrowserDownloadButton className="button" />);

    const chooser = await screen.findByRole("button", { name: "Choose browser download" });
    await userEvent.click(chooser);
    expect(screen.getByRole("link", { name: "Chromium package" })).toHaveAttribute("href", "/downloads/tabloom-chromium.zip");
    expect(screen.getByRole("link", { name: "Firefox package" })).toHaveAttribute("href", "/downloads/tabloom-firefox.zip");
    expect(screen.getByRole("link", { name: "Safari package" })).toHaveAttribute("href", "/downloads/tabloom-safari.zip");
  });
});
