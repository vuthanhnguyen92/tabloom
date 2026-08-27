export type WorkspaceOrigin = "saved" | "browser-bookmark";

export type WorkspaceRecordMeta = {
  origin: WorkspaceOrigin;
  read_only: boolean;
};

export type Space = WorkspaceRecordMeta & {
  id: string;
  user_id: string;
  name: string;
  color: string;
  position: number;
  created_at: string;
  updated_at: string;
};

export type Collection = WorkspaceRecordMeta & {
  id: string;
  user_id: string;
  space_id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
};

export type SavedLink = WorkspaceRecordMeta & {
  id: string;
  user_id: string;
  collection_id: string;
  url: string;
  title: string;
  description: string;
  favicon_url: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  device_label?: string | null;
};

export type WorkspaceSnapshot = {
  spaces: Space[];
  collections: Collection[];
  links: SavedLink[];
};

export type CaptureResult = { saved: number; skipped: number; closed: number };
export type Positioned = { id: string; position: number };

export function isSaveableUrl(value?: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeUrlForDuplicate(value?: string | null): string | null {
  if (!isSaveableUrl(value)) return null;
  return new URL(value!).href;
}

export function findDuplicateLink(
  links: SavedLink[],
  collectionId: string,
  url: string,
  excludeId?: string,
): SavedLink | undefined {
  const normalized = normalizeUrlForDuplicate(url);
  if (!normalized) return undefined;
  return links.find((link) => (
    link.collection_id === collectionId
    && link.id !== excludeId
    && normalizeUrlForDuplicate(link.url) === normalized
  ));
}

export function hostnameFor(value: string): string {
  try { return new URL(value).hostname.replace(/^www\./, ""); }
  catch { return value; }
}

export function normalizePositions<T extends Positioned>(items: T[]): T[] {
  return [...items]
    .sort((a, b) => a.position - b.position)
    .map((item, position) => ({ ...item, position }));
}

export function filterWorkspace(snapshot: WorkspaceSnapshot, rawQuery: string): WorkspaceSnapshot {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return snapshot;
  const collectionById = new Map(snapshot.collections.map((item) => [item.id, item]));
  const spaceById = new Map(snapshot.spaces.map((item) => [item.id, item]));
  const links = snapshot.links.filter((link) => {
    const collection = collectionById.get(link.collection_id);
    const space = collection ? spaceById.get(collection.space_id) : undefined;
    return [link.title, link.url, link.description, link.device_label, collection?.name, space?.name]
      .some((value) => value?.toLocaleLowerCase().includes(query));
  });
  const collectionIds = new Set(links.map((link) => link.collection_id));
  const collections = snapshot.collections.filter((item) => collectionIds.has(item.id));
  const spaceIds = new Set(collections.map((item) => item.space_id));
  return { spaces: snapshot.spaces.filter((item) => spaceIds.has(item.id)), collections, links };
}

const now = "2026-08-19T00:00:00.000Z";
export function createDemoSnapshot(userId = "demo-user"): WorkspaceSnapshot {
  const spaces: Space[] = [
    { id: "space-launch", user_id: userId, name: "Product launch", color: "#f56f72", position: 0, created_at: now, updated_at: now, origin: "saved", read_only: false },
    { id: "space-research", user_id: userId, name: "Research", color: "#7157d9", position: 1, created_at: now, updated_at: now, origin: "saved", read_only: false },
    { id: "space-personal", user_id: userId, name: "Personal", color: "#2bb8a8", position: 2, created_at: now, updated_at: now, origin: "saved", read_only: false },
  ];
  const collections: Collection[] = [
    { id: "collection-plan", user_id: userId, space_id: "space-launch", name: "Plan", position: 0, created_at: now, updated_at: now, origin: "saved", read_only: false },
    { id: "collection-design", user_id: userId, space_id: "space-launch", name: "Design", position: 1, created_at: now, updated_at: now, origin: "saved", read_only: false },
    { id: "collection-learn", user_id: userId, space_id: "space-launch", name: "Learn", position: 2, created_at: now, updated_at: now, origin: "saved", read_only: false },
  ];
  const seeds = [
    ["Product roadmap", "https://linear.app/roadmap", "collection-plan"],
    ["Customer brief", "https://notion.so/customer-brief", "collection-plan"],
    ["Launch checklist", "https://docs.google.com/checklist", "collection-plan"],
    ["Brand system", "https://figma.com/brand-system", "collection-design"],
    ["Homepage explorations", "https://figma.com/homepage", "collection-design"],
    ["Prototype", "https://figma.com/prototype", "collection-design"],
    ["Interview notes", "https://notion.so/interviews", "collection-learn"],
    ["Market research", "https://docs.google.com/research", "collection-learn"],
  ] as const;
  const links: SavedLink[] = seeds.map(([title, url, collection_id], position) => ({
    id: `link-${position}`, user_id: userId, collection_id, url, title,
    description: title === "Brand system" ? "Figma assets for launch" : "",
    favicon_url: null, position, created_at: now, updated_at: now,
    origin: "saved", read_only: false, device_label: null,
  }));
  return { spaces, collections, links };
}
