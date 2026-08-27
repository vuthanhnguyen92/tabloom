import { describe, expect, it } from "vitest";
import {
  createDemoSnapshot,
  filterWorkspace,
  isSaveableUrl,
  normalizePositions,
} from "../shared/domain";
import * as domain from "../shared/domain";

describe("isSaveableUrl", () => {
  it.each(["https://example.com", "http://localhost:3000/path"])("accepts %s", (url) => {
    expect(isSaveableUrl(url)).toBe(true);
  });

  it.each(["chrome://settings", "file:///tmp/a", "javascript:alert(1)", "not a url"])("rejects %s", (url) => {
    expect(isSaveableUrl(url)).toBe(false);
  });
});

describe("duplicate URL matching", () => {
  it("normalizes host casing, default ports, and a trailing root slash", () => {
    const normalize = (domain as typeof domain & { normalizeUrlForDuplicate?: (url: string) => string | null }).normalizeUrlForDuplicate;
    expect(normalize).toBeTypeOf("function");
    expect(normalize!("https://EXAMPLE.com:443")).toBe("https://example.com/");
    expect(normalize!("https://example.com/")).toBe("https://example.com/");
  });

  it("preserves meaningful queries and fragments", () => {
    const normalize = (domain as typeof domain & { normalizeUrlForDuplicate?: (url: string) => string | null }).normalizeUrlForDuplicate;
    expect(normalize).toBeTypeOf("function");
    expect(normalize!("https://example.com/page?view=one#top")).not.toBe(normalize!("https://example.com/page?view=two#top"));
    expect(normalize!("https://example.com/page#top")).not.toBe(normalize!("https://example.com/page#details"));
  });

  it("finds duplicates only inside the target collection", () => {
    const findDuplicate = (domain as typeof domain & { findDuplicateLink?: (links: ReturnType<typeof createDemoSnapshot>["links"], collectionId: string, url: string, excludeId?: string) => { id: string } | undefined }).findDuplicateLink;
    expect(findDuplicate).toBeTypeOf("function");
    const snapshot = createDemoSnapshot();
    const product = snapshot.links.find((link) => link.title === "Product roadmap")!;
    expect(findDuplicate!(snapshot.links, product.collection_id, "https://LINEAR.app:443/roadmap")?.id).toBe(product.id);
    expect(findDuplicate!(snapshot.links, "collection-design", product.url)).toBeUndefined();
    expect(findDuplicate!(snapshot.links, product.collection_id, product.url, product.id)).toBeUndefined();
  });
});

describe("filterWorkspace", () => {
  it("searches link metadata and its parent collection and space", () => {
    const snapshot = createDemoSnapshot("user-1");
    expect(filterWorkspace(snapshot, "figma").links.map((link) => link.title)).toContain("Brand system");
    expect(filterWorkspace(snapshot, "launch").links.length).toBeGreaterThan(2);
    expect(filterWorkspace(snapshot, "missing").links).toEqual([]);
  });
});

describe("normalizePositions", () => {
  it("returns dense ordered copies without mutating input", () => {
    const input = [{ id: "b", position: 8 }, { id: "a", position: 2 }];
    expect(normalizePositions(input)).toEqual([{ id: "a", position: 0 }, { id: "b", position: 1 }]);
    expect(input[0].position).toBe(8);
  });
});
