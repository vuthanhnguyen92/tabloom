import { describe, expect, it } from "vitest";
import type {
  Collection,
  SavedLink,
  Space,
  WorkspaceSnapshot,
} from "../shared/domain";
import {
  isEffectivelyEmptyLocalWorkspace,
  isEmptyCloudWorkspace,
  normalizeWorkspaceName,
  planWorkspaceMerge,
} from "../shared/workspace-merge";

const createdAt = "2026-08-29T00:00:00.000Z";

function space(overrides: Partial<Space> = {}): Space {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    user_id: "local-user",
    name: "My Space",
    color: "#7357e6",
    position: 0,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

function collection(overrides: Partial<Collection> = {}): Collection {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    user_id: "local-user",
    space_id: "10000000-0000-4000-8000-000000000001",
    name: "My Collection",
    position: 0,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

function link(overrides: Partial<SavedLink> = {}): SavedLink {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    user_id: "local-user",
    collection_id: "20000000-0000-4000-8000-000000000001",
    url: "https://example.com/",
    title: "Example",
    description: "Local description",
    favicon_url: "https://example.com/favicon.ico",
    position: 0,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

function snapshot(
  spaces: Space[] = [],
  collections: Collection[] = [],
  links: SavedLink[] = [],
): WorkspaceSnapshot {
  return { spaces, collections, links };
}

describe("normalizeWorkspaceName", () => {
  it("normalizes Unicode, whitespace, and case", () => {
    expect(normalizeWorkspaceName("  CAFE\u0301   PLANS  ")).toBe("café plans");
  });
});

describe("workspace emptiness", () => {
  it("treats an unchanged default local workspace as effectively empty", () => {
    expect(
      isEffectivelyEmptyLocalWorkspace(snapshot([space()], [collection()], [])),
    ).toBe(true);
  });

  it("treats renamed or populated local workspaces as meaningful", () => {
    expect(
      isEffectivelyEmptyLocalWorkspace(
        snapshot([space({ name: "Research" })], [collection()], []),
      ),
    ).toBe(false);
    expect(
      isEffectivelyEmptyLocalWorkspace(
        snapshot([space()], [collection()], [link()]),
      ),
    ).toBe(false);
  });

  it("requires every cloud array to be empty", () => {
    expect(isEmptyCloudWorkspace(snapshot())).toBe(true);
    expect(isEmptyCloudWorkspace(snapshot([space()], [], []))).toBe(false);
  });
});

describe("planWorkspaceMerge", () => {
  it("matches spaces and collections by normalized name and links by UUID first", () => {
    const local = snapshot(
      [space({ name: " Café   Plans " })],
      [collection({ name: "Reading List" })],
      [link({ title: "Local title" })],
    );
    const cloud = snapshot(
      [
        space({
          id: "10000000-0000-4000-8000-000000000002",
          user_id: "cloud-user",
          name: "CAFÉ PLANS",
        }),
      ],
      [
        collection({
          id: "20000000-0000-4000-8000-000000000002",
          user_id: "cloud-user",
          space_id: "10000000-0000-4000-8000-000000000002",
          name: " reading   list ",
        }),
      ],
      [
        link({
          user_id: "cloud-user",
          collection_id: "20000000-0000-4000-8000-000000000002",
          url: "https://different.example/",
          title: "Cloud title",
        }),
      ],
    );

    const plan = planWorkspaceMerge(local, cloud, 7);

    expect(plan.expectedRevision).toBe(7);
    expect(plan.summary).toMatchObject({
      matchedSpaces: 1,
      matchedCollections: 1,
      matchedLinksById: 1,
      matchedLinksByUrl: 0,
    });
    expect(plan.merged.links).toHaveLength(1);
    expect(plan.merged.links[0].title).toBe("Cloud title");
  });

  it("uses normalized URL fallback only inside the matched collection", () => {
    const cloudSpace = space({ user_id: "cloud-user" });
    const cloudCollection = collection({ user_id: "cloud-user" });
    const cloudLink = link({
      id: "30000000-0000-4000-8000-000000000002",
      user_id: "cloud-user",
      url: "https://example.com",
      title: "Cloud title",
    });
    const local = snapshot([space()], [collection()], [link()]);

    const plan = planWorkspaceMerge(
      local,
      snapshot([cloudSpace], [cloudCollection], [cloudLink]),
      2,
    );

    expect(plan.summary.matchedLinksByUrl).toBe(1);
    expect(plan.merged.links).toHaveLength(1);
    expect(plan.identityMap.links[link().id]).toBe(cloudLink.id);
  });

  it("keeps the same URL when it belongs to different collections", () => {
    const secondCollection = collection({
      id: "20000000-0000-4000-8000-000000000002",
      name: "Later",
      position: 1,
    });
    const local = snapshot(
      [space()],
      [collection(), secondCollection],
      [
        link(),
        link({
          id: "30000000-0000-4000-8000-000000000002",
          collection_id: secondCollection.id,
        }),
      ],
    );

    const plan = planWorkspaceMerge(local, snapshot(), 0);

    expect(plan.merged.links).toHaveLength(2);
    expect(plan.summary.addedLinks).toBe(2);
  });

  it("fills only empty cloud metadata from local values", () => {
    const cloudLink = link({
      user_id: "cloud-user",
      title: "Cloud title",
      description: "",
      favicon_url: null,
      position: 4,
    });

    const plan = planWorkspaceMerge(
      snapshot([space()], [collection()], [link()]),
      snapshot(
        [space({ user_id: "cloud-user" })],
        [collection({ user_id: "cloud-user" })],
        [cloudLink],
      ),
      4,
    );

    expect(plan.merged.links[0]).toMatchObject({
      title: "Cloud title",
      description: "Local description",
      favicon_url: "https://example.com/favicon.ico",
      position: 4,
    });
  });

  it("preserves cloud order and appends local-only rows in stable order", () => {
    const localEarly = collection({
      id: "20000000-0000-4000-8000-000000000003",
      name: "Early",
      position: 1,
    });
    const localLate = collection({
      id: "20000000-0000-4000-8000-000000000004",
      name: "Late",
      position: 9,
    });
    const cloudOnly = collection({
      id: "20000000-0000-4000-8000-000000000005",
      user_id: "cloud-user",
      name: "Cloud",
      position: 3,
    });

    const plan = planWorkspaceMerge(
      snapshot([space()], [localLate, localEarly], []),
      snapshot([space({ user_id: "cloud-user" })], [cloudOnly], []),
      1,
    );

    expect(plan.merged.collections.map((item) => item.name)).toEqual([
      "Cloud",
      "Early",
      "Late",
    ]);
    expect(plan.merged.collections.map((item) => item.position)).toEqual([3, 4, 5]);
  });

  it("remaps a colliding local UUID instead of merging unrelated rows", () => {
    const cloudSpace = space({
      user_id: "cloud-user",
      name: "Cloud Space",
    });
    const localSpace = space({ name: "Local Space" });

    const plan = planWorkspaceMerge(
      snapshot([localSpace], [], []),
      snapshot([cloudSpace], [], []),
      1,
    );

    expect(plan.merged.spaces).toHaveLength(2);
    expect(plan.summary.remappedIds).toBe(1);
    expect(plan.identityMap.spaces[localSpace.id]).not.toBe(localSpace.id);
    expect(plan.identityMap.spaces[localSpace.id]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("skips unsupported links without rejecting valid rows", () => {
    const plan = planWorkspaceMerge(
      snapshot(
        [space()],
        [collection()],
        [
          link(),
          link({
            id: "30000000-0000-4000-8000-000000000002",
            url: "chrome://settings",
          }),
        ],
      ),
      snapshot(),
      0,
    );

    expect(plan.merged.links).toHaveLength(1);
    expect(plan.summary.skippedUnsupportedLinks).toBe(1);
  });
});
