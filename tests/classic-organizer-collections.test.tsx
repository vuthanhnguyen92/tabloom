import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../shared/domain";
import { CollectionSection } from "../shared/organizer/CollectionSection";
import { SavedLinkCard } from "../shared/organizer/SavedLinkCard";

const snapshot = createDemoSnapshot();
const collection = snapshot.collections[0];
const link = snapshot.links.find((item) => item.collection_id === collection.id)!;

describe("classic collection presentation hooks", () => {
  it("marks collection rows and saved-link cards without changing their actions", () => {
    render(<CollectionSection
      collection={collection}
      links={[link]}
      writable
    >
      <SavedLinkCard
        actions={{ onDelete: vi.fn(), onEdit: vi.fn() }}
        favicon={null}
        link={link}
        onDragStart={vi.fn()}
        writable
      />
    </CollectionSection>);

    expect(screen.getByRole("group", { name: "Plan collection" })).toHaveClass("classic-collection-row");
    expect(screen.getByRole("group", { name: "Plan collection" }).querySelector(".ext-col-head")).toHaveClass("classic-collection-header");
    expect(screen.getByRole("link", { name: /Product roadmap/ }).parentElement).toHaveClass("classic-link-card");
    expect(screen.getByRole("button", { name: "Drag Product roadmap" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit Product roadmap" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete Product roadmap" })).toBeVisible();
  });
});
