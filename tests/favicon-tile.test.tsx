import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FaviconTile } from "../extension/FaviconTile";

describe("FaviconTile", () => {
  it("shows its monogram immediately while the favicon loads", () => {
    render(<FaviconTile src="https://assets.unique.example/favicon.ico" title="Product" />);

    expect(screen.getByText("P", { exact: true })).toBeInTheDocument();
    expect(document.querySelector("img")).toHaveAttribute("src", "https://assets.unique.example/favicon.ico");
  });

  it("does not request the exact same favicon source again after it fails", () => {
    const first = render(<FaviconTile src="https://failed-once.unique.example/one.ico" title="Failed" />);
    fireEvent.error(first.container.querySelector("img")!);
    first.unmount();

    const second = render(<FaviconTile src="https://failed-once.unique.example/one.ico" title="Failed" />);

    expect(second.container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByText("F", { exact: true })).toBeVisible();
  });

  it("tries a newly discovered favicon even when an older source on the same host failed", () => {
    const first = render(<FaviconTile src="https://retry-source.unique.example/old.ico" title="Before" />);
    fireEvent.error(first.container.querySelector("img")!);
    first.unmount();

    const second = render(<FaviconTile src="https://retry-source.unique.example/current.ico" title="After" />);

    expect(second.container.querySelector("img")).toHaveAttribute("src", "https://retry-source.unique.example/current.ico");
    expect(screen.getByText("A", { exact: true })).toBeVisible();
  });
});
