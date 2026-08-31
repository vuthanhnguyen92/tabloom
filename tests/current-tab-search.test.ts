import { describe, expect, it } from "vitest";
import type { BrowserTab } from "../shared/capture";
import { currentTabCandidates, searchCurrentTabs } from "../extension/current-tab-search";

const tabs: BrowserTab[] = [
  { id: 1, title: "Tabloom", url: "chrome-extension://tabloom/index.html", active: true, index: 0 },
  { id: 2, title: "React docs", url: "https://react.dev/learn", active: false, index: 1, favIconUrl: "https://react.dev/favicon.ico" },
  { id: 3, title: "Example dashboard", url: "http://example.com/dashboard", active: false, index: 2 },
  { id: 4, title: "Settings", url: "chrome://settings", active: false, index: 3 },
  { id: 5, title: "Firefox config", url: "about:config", active: false, index: 4 },
  { title: "Missing ID", url: "https://missing.example", active: false, index: 5 },
];

describe("current-tab search", () => {
  it("keeps inactive HTTP tabs with numeric IDs and excludes internal tabs", () => {
    expect(currentTabCandidates(tabs)).toEqual([
      { kind: "current-tab", tab: tabs[1] },
      { kind: "current-tab", tab: tabs[2] },
    ]);
  });

  it("matches titles and URLs without case sensitivity", () => {
    expect(searchCurrentTabs(tabs, "REACT").map(({ tab }) => tab.id)).toEqual([2]);
    expect(searchCurrentTabs(tabs, "dashboard").map(({ tab }) => tab.id)).toEqual([3]);
  });

  it("returns no visible results for an empty query", () => {
    expect(searchCurrentTabs(tabs, "   ")).toEqual([]);
  });
});
