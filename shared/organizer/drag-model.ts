import type { Collection, SavedLink } from "../domain";
import type { BrowserTabSummary } from "./capabilities";

export type OrganizerDragState =
  | { kind: "collection"; id: string; overIndex: number }
  | { kind: "saved-link"; id: string; sourceCollectionId: string; targetCollectionId: string; overIndex: number }
  | { kind: "browser-tab"; tab: BrowserTabSummary; targetCollectionId?: string; overIndex?: number }
  | { kind: "browser-bookmark"; link: SavedLink; targetCollectionId?: string; overIndex?: number }
  | null;

/** Index is measured in the destination after removing the dragged entity. */
function previewOrder<T extends { id: string; position: number }>(items: readonly T[], id: string, index: number): T[] {
  const ordered = [...items].sort((a, b) => a.position - b.position);
  const source = ordered.find((item) => item.id === id);
  if (!source) return ordered;
  const remaining = ordered.filter((item) => item.id !== id);
  remaining.splice(Math.max(0, Math.min(remaining.length, Number.isFinite(index) ? Math.trunc(index) : remaining.length)), 0, source);
  return remaining.map((item, position) => ({ ...item, position }));
}

export function previewLinkDrop(links: readonly SavedLink[], id: string, index: number): SavedLink[] {
  return previewOrder(links, id, index);
}

export function previewCollectionDrop(collections: readonly Collection[], id: string, index: number): Collection[] {
  return previewOrder(collections, id, index);
}

export function previewLinkTransfer(links: readonly SavedLink[], id: string, collectionId: string, index: number): SavedLink[] {
  const source = links.find((link) => link.id === id);
  if (!source) return [...links];
  const destination = links.filter((link) => link.collection_id === collectionId && link.id !== id);
  const moved = previewLinkDrop([...destination, { ...source, collection_id: collectionId }], id, index);
  const origin = links.filter((link) => link.collection_id === source.collection_id && link.id !== id)
    .sort((a, b) => a.position - b.position).map((link, position) => ({ ...link, position }));
  return [...links.filter((link) => link.collection_id !== collectionId && link.collection_id !== source.collection_id),
    ...(source.collection_id === collectionId ? [] : origin), ...moved];
}
