import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedCollectionUnavailable, SharedCollectionView } from "../app/s/[token]/SharedCollectionView";

const links = [
  { id: "one", title: "Linear roadmap", description: "Release plan", url: "https://linear.app/roadmap", favicon_url: null, position: 0 },
  { id: "two", title: "Reference", description: "", url: "https://example.com/reference", favicon_url: "https://example.com/favicon.ico", position: 1 },
];

afterEach(() => vi.restoreAllMocks());

describe("SharedCollectionView", () => {
  it("renders an anonymous read-only collection with safe card links", () => {
    render(<SharedCollectionView token={"a".repeat(43)} snapshot={{ name: "Launch plan", links }} />);

    expect(screen.getByLabelText("Tabloom").closest("a")).toHaveClass("shared-collection-brand");
    expect(screen.queryByText("Shared collection")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Launch plan" })).toHaveClass("shared-collection-title");
    expect(screen.getByText("2 links")).toBeVisible();
    expect(screen.getByText("Release plan")).toBeVisible();
    expect(screen.getByText("example.com")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open all" })).toHaveClass("shared-open-all-button");
    expect(screen.getByRole("link", { name: /Linear roadmap/ })).toHaveAttribute("href", "https://linear.app/roadmap");
    expect(screen.getByRole("link", { name: /Linear roadmap/ })).toHaveAttribute("rel", "noreferrer noopener");
    expect(document.body).not.toHaveTextContent(/owner|space|device|sync/i);
  });

  it("exposes an ordered, anonymous machine-readable collection", () => {
    render(<SharedCollectionView token={"a".repeat(43)} snapshot={{ name: "Launch plan", links }} />);

    expect(screen.getByRole("list", { name: "Launch plan" })).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    const script = document.querySelector<HTMLScriptElement>('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const structuredData = JSON.parse(script!.textContent!);
    expect(structuredData).toEqual({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "Launch plan",
      description: "Launch plan — 2 links shared with Tabloom.",
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: 2,
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            item: { "@type": "WebPage", name: "Linear roadmap", description: "Release plan", url: "https://linear.app/roadmap" },
          },
          {
            "@type": "ListItem",
            position: 2,
            item: { "@type": "WebPage", name: "Reference", url: "https://example.com/reference" },
          },
        ],
      },
    });
    expect(script!.textContent).not.toMatch(/owner|user|account|space|device/i);
  });

  it("renders a useful empty collection", () => {
    render(<SharedCollectionView token={"a".repeat(43)} snapshot={{ name: "Reading list", links: [] }} />);
    expect(screen.getByText("Nothing saved here yet")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open all" })).not.toBeInTheDocument();
  });

  it("opens a small collection in its canonical order", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<SharedCollectionView token={"a".repeat(43)} snapshot={{ name: "Launch plan", links }} />);

    await userEvent.click(screen.getByRole("button", { name: "Open all" }));

    expect(open.mock.calls.map(([url]) => url)).toEqual(links.map((link) => link.url));
    expect(open).toHaveBeenCalledWith(links[0].url, "_blank", "noopener,noreferrer");
  });

  it("confirms unusually large collections and supports cancellation", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const manyLinks = Array.from({ length: 11 }, (_, index) => ({ ...links[0], id: `link-${index}`, title: `Link ${index}`, url: `https://example.com/${index}`, position: index }));
    render(<SharedCollectionView token={"a".repeat(43)} snapshot={{ name: "Big list", links: manyLinks }} />);

    await userEvent.click(screen.getByRole("button", { name: "Open all" }));
    expect(screen.getByRole("dialog", { name: "Open 11 tabs?" })).toBeVisible();
    expect(open).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Open 11 tabs?" })).not.toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it("reports blocked popups instead of silently claiming success", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    render(<SharedCollectionView token={"a".repeat(43)} snapshot={{ name: "Launch plan", links }} />);
    await userEvent.click(screen.getByRole("button", { name: "Open all" }));
    expect(screen.getByRole("status")).toHaveTextContent("browser blocked 2 tabs");
  });

  it("uses token-free temporary copy for remote failures", () => {
    render(<SharedCollectionUnavailable temporary />);
    expect(screen.getByRole("heading", { name: "This shared collection is temporarily unavailable" })).toBeVisible();
    expect(document.body).not.toHaveTextContent(/expired|replaced|turned off/i);
  });
});
