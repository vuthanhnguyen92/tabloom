import type { Collection, SavedLink, Space, WorkspaceSnapshot } from "./domain";
import { isSaveableUrl, normalizeUrlForDuplicate } from "./domain";

type TobyCard = {
  title?: unknown;
  customTitle?: unknown;
  customDescription?: unknown;
  url?: unknown;
};

type TobyList = {
  title?: unknown;
  cards?: unknown;
};

export type TobyImportOptions = {
  userId: string;
  spaceName: string;
  now?: string;
  createId?: () => string;
};

export type TobyImportSummary = {
  sourceCollections: number;
  importedCollections: number;
  sourceCards: number;
  importedLinks: number;
  duplicateCards: number;
  skippedUnsupportedLinks: number;
};

export type TobyImportResult = {
  snapshot: WorkspaceSnapshot;
  summary: TobyImportSummary;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function titleFor(card: TobyCard, url: string): string {
  const explicit = text(card.customTitle) || text(card.title);
  if (explicit) return explicit;
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function uniqueId(createId: () => string, used: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = createId();
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error("Could not create a unique Tabloom record id.");
}

export function convertTobyExport(
  value: unknown,
  options: TobyImportOptions,
): TobyImportResult {
  if (!record(value) || value.version !== 3 || !Array.isArray(value.lists)) {
    throw new Error("This is not a supported Toby version 3 export.");
  }

  const now = options.now ?? new Date().toISOString();
  const createId = options.createId ?? (() => crypto.randomUUID());
  const usedIds = new Set<string>();
  const spaceId = uniqueId(createId, usedIds);
  const space: Space = {
    id: spaceId,
    user_id: options.userId,
    name: text(options.spaceName) || "My Space",
    color: "#7157d9",
    position: 0,
    created_at: now,
    updated_at: now,
    origin: "saved",
    read_only: false,
  };

  const collections: Collection[] = [];
  const links: SavedLink[] = [];
  const collectionByName = new Map<string, Collection>();
  const seenUrls = new Map<string, Set<string>>();
  const summary: TobyImportSummary = {
    sourceCollections: value.lists.length,
    importedCollections: 0,
    sourceCards: 0,
    importedLinks: 0,
    duplicateCards: 0,
    skippedUnsupportedLinks: 0,
  };

  for (const entry of value.lists) {
    if (!record(entry)) continue;
    const list = entry as TobyList;
    const displayName = text(list.title) || "Untitled Collection";
    const normalizedName = displayName.normalize("NFC").toLowerCase();
    let collection = collectionByName.get(normalizedName);
    if (!collection) {
      collection = {
        id: uniqueId(createId, usedIds),
        user_id: options.userId,
        space_id: spaceId,
        name: displayName,
        position: collections.length,
        created_at: now,
        updated_at: now,
        origin: "saved",
        read_only: false,
      };
      collectionByName.set(normalizedName, collection);
      seenUrls.set(collection.id, new Set());
      collections.push(collection);
    }

    const cards = Array.isArray(list.cards) ? list.cards : [];
    summary.sourceCards += cards.length;
    for (const entryCard of cards) {
      if (!record(entryCard)) {
        summary.skippedUnsupportedLinks += 1;
        continue;
      }
      const card = entryCard as TobyCard;
      const url = text(card.url);
      if (!isSaveableUrl(url)) {
        summary.skippedUnsupportedLinks += 1;
        continue;
      }
      const normalizedUrl = normalizeUrlForDuplicate(url)!;
      const collectionUrls = seenUrls.get(collection.id)!;
      if (collectionUrls.has(normalizedUrl)) {
        summary.duplicateCards += 1;
        continue;
      }
      collectionUrls.add(normalizedUrl);
      const position = links.filter(
        (link) => link.collection_id === collection!.id,
      ).length;
      links.push({
        id: uniqueId(createId, usedIds),
        user_id: options.userId,
        collection_id: collection.id,
        url,
        title: titleFor(card, url),
        description: text(card.customDescription),
        favicon_url: null,
        position,
        created_at: now,
        updated_at: now,
        device_label: null,
        origin: "saved",
        read_only: false,
      });
    }
  }

  summary.importedCollections = collections.length;
  summary.importedLinks = links.length;
  return { snapshot: { spaces: [space], collections, links }, summary };
}
