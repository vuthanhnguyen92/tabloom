import { describe, expect, it } from "vitest";
import * as workspaceMerge from "../shared/workspace-merge";

type ConvertTobyExport = (
  value: unknown,
  options: {
    userId: string;
    spaceName: string;
    now: string;
    createId: () => string;
  },
) => {
  snapshot: {
    spaces: Array<{ id: string; name: string; user_id: string }>;
    collections: Array<{ id: string; name: string; position: number }>;
    links: Array<{ id: string; collection_id: string; url: string; title: string; description: string; position: number }>;
  };
  summary: {
    sourceCollections: number;
    importedCollections: number;
    sourceCards: number;
    importedLinks: number;
    duplicateCards: number;
    skippedUnsupportedLinks: number;
  };
};

const convertTobyExport = (workspaceMerge as typeof workspaceMerge & {
  convertTobyExport?: ConvertTobyExport;
}).convertTobyExport;

const source = {
  version: 3,
  lists: [
    {
      title: " Notes ",
      cards: [
        { title: "Original title", customTitle: "Custom title", customDescription: "Useful details", url: "https://EXAMPLE.com:443/docs" },
        { title: "Unsupported", customTitle: "", customDescription: "", url: "chrome://settings" },
      ],
    },
    {
      title: "notes",
      cards: [
        { title: "Duplicate", customTitle: "", customDescription: "", url: "https://example.com/docs" },
        { title: "Second", customTitle: "", customDescription: "", url: "https://example.com/second" },
      ],
    },
    {
      title: "Other",
      cards: [
        { title: "Same URL elsewhere", customTitle: "", customDescription: "", url: "https://example.com/docs" },
      ],
    },
  ],
};

describe("Toby import conversion", () => {
  it("is available as part of the workspace merge boundary", () => {
    expect(convertTobyExport).toBeTypeOf("function");
  });

  it("merges same-named lists and deduplicates URLs only within that collection", () => {
    if (!convertTobyExport) throw new Error("Toby converter is unavailable");
    let nextId = 0;
    const result = convertTobyExport(source, {
      userId: "user-1",
      spaceName: "My Space",
      now: "2026-08-30T00:00:00.000Z",
      createId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    });

    expect(result.summary).toEqual({
      sourceCollections: 3,
      importedCollections: 2,
      sourceCards: 5,
      importedLinks: 3,
      duplicateCards: 1,
      skippedUnsupportedLinks: 1,
    });
    expect(result.snapshot.spaces).toMatchObject([{ name: "My Space", user_id: "user-1" }]);
    expect(result.snapshot.collections.map((collection) => [collection.name, collection.position])).toEqual([
      ["Notes", 0],
      ["Other", 1],
    ]);

    const notes = result.snapshot.collections[0];
    const other = result.snapshot.collections[1];
    expect(result.snapshot.links.filter((link) => link.collection_id === notes.id)).toMatchObject([
      { title: "Custom title", description: "Useful details", position: 0, url: "https://EXAMPLE.com:443/docs" },
      { title: "Second", description: "", position: 1, url: "https://example.com/second" },
    ]);
    expect(result.snapshot.links.filter((link) => link.collection_id === other.id)).toMatchObject([
      { title: "Same URL elsewhere", position: 0, url: "https://example.com/docs" },
    ]);
  });

  it("assigns a unique Tabloom id to every imported record", () => {
    if (!convertTobyExport) throw new Error("Toby converter is unavailable");
    let nextId = 0;
    const result = convertTobyExport(source, {
      userId: "user-1",
      spaceName: "My Space",
      now: "2026-08-30T00:00:00.000Z",
      createId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    });
    const ids = [
      ...result.snapshot.spaces.map((record) => record.id),
      ...result.snapshot.collections.map((record) => record.id),
      ...result.snapshot.links.map((record) => record.id),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });
});
