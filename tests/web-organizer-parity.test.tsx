import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { WorkspaceClient } from "../app/app/WorkspaceClient";
import { createDemoSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository } from "../shared/repository";

beforeEach(() => localStorage.clear());

function expectNativeClick(element: Element, modifiers: MouseEventInit = {}) {
  let prevented = true;
  const observe = (event: MouseEvent) => { prevented = event.defaultPrevented; event.preventDefault(); };
  document.addEventListener("click", observe, { once: true });
  fireEvent(element, new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers }));
  expect(prevented).toBe(false);
}

function renderWorkspace() {
  const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
  render(<WorkspaceClient repository={repository} mode="demo" />);
  return repository;
}

describe("web shared organizer parity", () => {
  it("renders the shared organizer with search and no browser-only controls", async () => {
    renderWorkspace();
    expect(await screen.findByTestId("shared-workspace-organizer")).toBeVisible();
    expect(screen.getByRole("button", { name: "Search all links" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Current tabs" })).toBeNull();
    expect(screen.queryByRole("button", { name: /sync bookmarks|close tabs|group tabs/i })).toBeNull();
  });

  it("preserves native current-page anchors and modifier clicks for cards and search", async () => {
    renderWorkspace();
    const card = (await screen.findByText("Product roadmap")).closest("a")!;
    expect(card).toHaveAttribute("href", "https://linear.app/roadmap");
    expect(card).not.toHaveAttribute("target");
    for (const modifiers of [{}, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
      expectNativeClick(card, modifiers);
    }
    await userEvent.click(screen.getByRole("button", { name: "Search all links" }));
    await userEvent.type(screen.getByRole("searchbox"), "roadmap");
    const result = within(screen.getByRole("dialog")).getByRole("link", { name: /^Product roadmap/ });
    expect(result).not.toHaveAttribute("target");
    expectNativeClick(result, { ctrlKey: true });
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("waits for the snapshot then renders the remembered space and collapse state without a default-space flash", async () => {
    localStorage.setItem("tabloom:selected-space:demo", "space-research");
    localStorage.setItem("tabloom:collapsed-collections:demo", JSON.stringify(["collection-learn"]));
    const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
    const snapshot = await repository.load();
    snapshot.collections.find((collection) => collection.id === "collection-learn")!.space_id = "space-research";
    let resolve!: (value: typeof snapshot) => void;
    vi.spyOn(repository, "load").mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<WorkspaceClient repository={repository} mode="demo" />);
    expect(screen.queryByText("Product roadmap")).toBeNull();
    expect(screen.queryByTestId("shared-workspace-organizer")).toBeNull();
    await act(async () => resolve(snapshot));
    expect(await screen.findByRole("heading", { name: "Research" })).toBeVisible();
    expect(screen.queryByText("Product roadmap")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand Learn" })).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem("tabloom:selected-space:demo")).toBe("space-research");
  });

  it("shows an optimistic edit then rolls back a rejected web write", async () => {
    const repository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
    let reject!: (error: Error) => void;
    vi.spyOn(repository, "updateLink").mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    render(<WorkspaceClient repository={repository} mode="synced" />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit Product roadmap" }));
    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Edited roadmap");
    await userEvent.click(screen.getByRole("button", { name: "Save link" }));
    expect(await screen.findByText("Edited roadmap")).toBeVisible();
    await act(async () => reject(new Error("private backend detail")));
    expect(await screen.findByText("Product roadmap")).toBeVisible();
    expect(screen.queryByText("Edited roadmap")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Changes could not be saved");
    expect(screen.queryByText(/private backend detail/)).toBeNull();
  });

  it("uses one dialog owner and persists collection and rail collapse", async () => {
    renderWorkspace();
    await userEvent.click(await screen.findByRole("button", { name: "New collection" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Collapse Plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    await waitFor(() => expect(localStorage.getItem("tabloom:collapsed-collections:demo")).toBe('["collection-plan"]'));
    expect(localStorage.getItem("tabloom:sidebar-collapsed")).toBe("false");
  });

  it("positions the web account dropdown over content without reserving organizer space", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync("app/globals.css", "utf8").replaceAll(/^@import .*;$/gm, "");
    document.head.appendChild(style);
    try {
      renderWorkspace();
      await userEvent.click(await screen.findByLabelText("Account"));
      const menu = screen.getByRole("link", { name: "Home" }).parentElement!;
      expect(getComputedStyle(menu).position).toBe("absolute");
      await userEvent.keyboard("{Escape}");
      expect(screen.getByLabelText("Account").closest("details")).not.toHaveAttribute("open");
      expect(screen.getByLabelText("Account")).toHaveFocus();
    } finally { style.remove(); }
  });

  it("keeps shared dialog geometry when web styles are loaded", async () => {
    const style = document.createElement("style");
    style.textContent = readFileSync("shared/organizer/organizer.css", "utf8") + readFileSync("app/globals.css", "utf8").replaceAll(/^@import .*;$/gm, "");
    document.head.appendChild(style);
    try {
      render(<WorkspaceClient repository={new MemoryWorkspaceRepository("demo-user", createDemoSnapshot())} mode="demo" sharing={{ availability: "sign-in-required", repository: null, siteUrl: "https://tabloom.nickvu.dev", onRequestSignIn: vi.fn() }} />);
      await userEvent.click(await screen.findByRole("button", { name: "Share Plan" }));
      expect(getComputedStyle(screen.getByRole("dialog")).borderRadius).toBe("16px");
      expect(getComputedStyle(screen.getByRole("dialog")).fontFamily).toContain("Poppins");
      await userEvent.keyboard("{Escape}");
      await userEvent.click(screen.getByRole("button", { name: "New collection" }));
      expect(getComputedStyle(screen.getByRole("button", { name: "Close dialog" })).width).toBe("34px");
      expect(getComputedStyle(screen.getByRole("dialog")).fontFamily).toContain("Poppins");
      await userEvent.keyboard("{Escape}");
      await userEvent.click(screen.getByRole("button", { name: "Search all links" }));
      const footer = screen.getByRole("dialog").querySelector("footer")!;
      expect(getComputedStyle(footer).marginLeft).not.toBe("auto");
      expect(getComputedStyle(screen.getByRole("dialog")).fontFamily).toContain("Poppins");
    } finally { style.remove(); }
  });
});
