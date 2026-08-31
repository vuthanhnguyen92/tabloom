import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

const extensionCss = readFileSync("extension/style.css", "utf8");

describe("extension cross-browser visual baseline", () => {
  beforeEach(() => {
    const style = document.createElement("style");
    style.textContent = extensionCss;
    document.head.appendChild(style);
  });

  it("removes native control appearance while preserving shared control geometry", () => {
    render(<div className="ext-header-tools">
      <button className="account-trigger">Account</button>
      <label><input aria-label="Search" type="search" /></label>
      <select aria-label="Collection"><option>Inbox</option></select>
      <textarea aria-label="Description" />
    </div>);

    const controls = [
      screen.getByRole("button", { name: "Account" }),
      screen.getByRole("searchbox", { name: "Search" }),
      screen.getByRole("combobox", { name: "Collection" }),
      screen.getByRole("textbox", { name: "Description" }),
    ];

    for (const control of controls) {
      const style = getComputedStyle(control);
      expect(style.appearance).toBe("none");
      expect(style.fontFamily).toContain("Poppins");
      expect(style.margin).toBe("0px");
    }
    expect(getComputedStyle(screen.getByRole("button", { name: "Account" })).height).toBe("var(--control-height)");
    expect(getComputedStyle(screen.getByRole("searchbox", { name: "Search" }).parentElement!)).toHaveProperty("height", "var(--control-height)");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--control-height").trim()).toBe("42px");
  });

  it("publishes one shared palette and scrollbar contract", () => {
    const rootStyle = getComputedStyle(document.documentElement);

    expect(rootStyle.getPropertyValue("--surface-page").trim()).toBe("#f6f3ee");
    expect(rootStyle.getPropertyValue("--surface-panel").trim()).toBe("#ffffff");
    expect(rootStyle.getPropertyValue("--text-primary").trim()).toBe("#25233a");
    expect(rootStyle.getPropertyValue("--border-default").trim()).toBe("#e3ded7");
    expect(rootStyle.scrollbarWidth).toBe("thin");
  });

  it("keeps the workspace, sidebar, and current-tabs pane independently scrollable", () => {
    render(<main className="ext-shell">
      <aside className="ext-sidebar collapsed" />
      <section className="ext-main" />
      <aside className="current-tabs-sheet" />
    </main>);

    const shell = document.querySelector<HTMLElement>(".ext-shell")!;
    const sidebar = document.querySelector<HTMLElement>(".ext-sidebar")!;
    const workspace = document.querySelector<HTMLElement>(".ext-main")!;
    expect(getComputedStyle(shell).height).toBe(`${window.innerHeight}px`);
    expect(getComputedStyle(shell).overflow).toBe("hidden");
    expect(getComputedStyle(sidebar).overflowY).toBe("auto");
    expect(getComputedStyle(workspace).overflowY).toBe("auto");
  });

  it("uses a single deliberate control at the top of the collapsed icon rail", () => {
    render(<aside className="ext-sidebar collapsed">
      <div className="sidebar-top"><button aria-label="Expand sidebar" className="sidebar-toggle">Expand</button></div>
      <div className="space-list"><div className="space-row active"><button className="space-select"><i>M</i></button></div></div>
    </aside>);

    const top = document.querySelector<HTMLElement>(".sidebar-top")!;
    const toggle = screen.getByRole("button", { name: "Expand sidebar" });
    const spaceIcon = document.querySelector<HTMLElement>(".space-select i")!;
    expect(getComputedStyle(top).flexDirection).toBe("row");
    expect(getComputedStyle(top).borderBottomWidth).toBe("1px");
    expect(getComputedStyle(toggle).width).toBe("38px");
    expect(getComputedStyle(toggle).height).toBe("38px");
    expect(getComputedStyle(spaceIcon).width).toBe("34px");
    expect(getComputedStyle(spaceIcon).height).toBe("34px");
  });

  it("presents global search as a full-screen layer with a larger search control", () => {
    render(<>
      <button className="global-search-trigger">Search</button>
      <section className="global-search-overlay">
        <button aria-label="Close search backdrop" className="global-search-backdrop" />
        <div className="global-search-shell"><header><input aria-label="Global search" /></header></div>
      </section>
    </>);

    const trigger = screen.getByRole("button", { name: "Search" });
    const overlay = document.querySelector<HTMLElement>(".global-search-overlay")!;
    const backdrop = screen.getByRole("button", { name: "Close search backdrop" });
    const input = screen.getByRole("textbox", { name: "Global search" });
    expect(getComputedStyle(trigger).height).toBe("var(--control-height)");
    expect(getComputedStyle(overlay).position).toBe("fixed");
    expect(getComputedStyle(overlay).inset).toBe("0px");
    expect(getComputedStyle(backdrop).backdropFilter).toContain("blur(8px)");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--search-backdrop").trim()).toBe("rgba(246,243,238,.82)");
    expect(getComputedStyle(input).fontSize).toBe("24px");
  });

  it("uses labeled, theme-safe sync colors and a 36px manual target", () => {
    render(<div className="account-sync-status sync-state-synced">
      <span><strong>Synced</strong><small>Synced just now</small></span>
      <button aria-label="Sync now">Refresh</button>
    </div>);
    const status = screen.getByText("Synced").closest(".account-sync-status")!;
    const subtitle = screen.getByText("Synced just now");
    const button = screen.getByRole("button", { name: "Sync now" });
    expect(getComputedStyle(status).getPropertyValue("--sync-state-color").trim()).toBe("#36b37e");
    expect(getComputedStyle(subtitle).color).toBe("var(--sync-state-color)");
    expect(getComputedStyle(button).width).toBe("36px");
    expect(getComputedStyle(button).height).toBe("36px");
  });
});
