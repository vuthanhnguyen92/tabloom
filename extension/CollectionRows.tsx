import { Trash2, X } from "lucide-react";
import { Fragment, useState, type DragEvent } from "react";
import type { Collection, SavedLink } from "../shared/domain";
import { findDuplicateLink, hostnameFor } from "../shared/domain";
import type { WorkspaceRepository } from "../shared/repository";
import type { CaptureTab } from "./chrome-api";
import { openCollectionTabs } from "./chrome-api";
import { BROWSER_TAB_MIME } from "./CurrentTabsSheet";
import { FaviconTile } from "./FaviconTile";

export type CollectionRowsProps = {
  collections: Collection[];
  links: SavedLink[];
  allLinks?: SavedLink[];
  bookmarkDropCollections?: Collection[];
  browserTabDragSession?: number;
  repository: WorkspaceRepository;
  onReload: () => Promise<void>;
  onOpenCollection?: (collection: Collection, links: SavedLink[]) => void | Promise<void>;
  onBrowserTabDrop?: (tab: CaptureTab, collectionId: string) => void;
  onBookmarkDrop?: (link: SavedLink, collectionId: string) => void | Promise<void>;
  onError?: (message: string) => void;
  onMessage?: (message: string) => void;
  highlightedLinkId?: string;
};

type DraggedItem =
  | { kind: "collection"; id: string }
  | { kind: "saved-link"; id: string }
  | { kind: "browser-bookmark"; link: SavedLink }
  | null;
type LinkDropPreview = { collectionId: string; targetLinkId?: string } | null;
type PendingDuplicateMove = { sourceId: string; collectionId: string; targetLinkId?: string; duplicate: SavedLink } | null;

export function CollectionRows({ collections, links, allLinks = links, bookmarkDropCollections = [], browserTabDragSession = 0, repository, onReload, onOpenCollection = async (collection, collectionLinks) => { await openCollectionTabs(collection.name, collectionLinks.map((link) => link.url)); }, onBrowserTabDrop, onBookmarkDrop, onError, onMessage, highlightedLinkId }: CollectionRowsProps) {
  const [dragged, setDragged] = useState<DraggedItem>(null);
  const [linkDropPreview, setLinkDropPreview] = useState<LinkDropPreview>(null);
  const [browserDropTarget, setBrowserDropTarget] = useState<{ collectionId: string; session: number } | null>(null);
  const [pendingDuplicateMove, setPendingDuplicateMove] = useState<PendingDuplicateMove>(null);
  const [pendingDelete, setPendingDelete] = useState<Collection | null>(null);
  const [deleting, setDeleting] = useState(false);
  const orderedCollections = [...collections].sort((a, b) => a.position - b.position);
  const canMutateCollection = (collection: Collection) => collection.origin === "saved" && !collection.read_only;

  function clearDrag() {
    setDragged(null);
    setLinkDropPreview(null);
    setBrowserDropTarget(null);
  }

  async function moveCollection(targetId: string) {
    if (dragged?.kind !== "collection" || dragged.id === targetId) return;
    const targetCollection = orderedCollections.find((item) => item.id === targetId);
    if (!targetCollection || !canMutateCollection(targetCollection)) return clearDrag();
    const orderedIds = orderedCollections.map((item) => item.id);
    const from = orderedIds.indexOf(dragged.id);
    const target = orderedIds.indexOf(targetId);
    if (from < 0 || target < 0) return;
    orderedIds.splice(from, 1);
    orderedIds.splice(orderedIds.indexOf(targetId), 0, dragged.id);
    clearDrag();
    await repository.reorderCollections(orderedCollections[0].space_id, orderedIds);
    await onReload();
  }

  async function persistLinkMove(sourceId: string, collectionId: string, targetLinkId?: string) {
    const orderedIds = allLinks
      .filter((item) => item.origin === "saved" && item.collection_id === collectionId && item.id !== sourceId)
      .sort((a, b) => a.position - b.position)
      .map((item) => item.id);
    const targetIndex = targetLinkId ? orderedIds.indexOf(targetLinkId) : orderedIds.length;
    orderedIds.splice(targetIndex < 0 ? orderedIds.length : targetIndex, 0, sourceId);
    setPendingDuplicateMove(null);
    clearDrag();
    await repository.reorderLinks(collectionId, orderedIds);
    await onReload();
  }

  async function moveLink(collectionId: string, targetLinkId?: string) {
    if (dragged?.kind !== "saved-link") return;
    if (targetLinkId === dragged.id) return clearDrag();
    const source = allLinks.find((link) => link.id === dragged.id);
    const duplicate = source && source.collection_id !== collectionId
      ? findDuplicateLink(allLinks, collectionId, source.url, source.id)
      : undefined;
    if (duplicate) {
      setPendingDuplicateMove({ sourceId: dragged.id, collectionId, targetLinkId, duplicate });
      clearDrag();
      return;
    }
    await persistLinkMove(dragged.id, collectionId, targetLinkId);
  }

  function allowDrop(event: DragEvent) {
    event.preventDefault();
    event.dataTransfer.dropEffect = Array.from(event.dataTransfer.types).includes(BROWSER_TAB_MIME) || dragged?.kind === "browser-bookmark" ? "copy" : "move";
  }

  function isBrowserTabDrag(event: DragEvent) {
    return Array.from(event.dataTransfer.types).includes(BROWSER_TAB_MIME);
  }

  function previewBrowserTabDrop(event: DragEvent, collection: Collection) {
    if (!canMutateCollection(collection) || !browserTabDragSession || !isBrowserTabDrag(event)) return false;
    setBrowserDropTarget({ collectionId: collection.id, session: browserTabDragSession });
    return true;
  }

  function previewLinkDrop(collection: Collection, targetLinkId?: string) {
    if (!canMutateCollection(collection) || (dragged?.kind !== "saved-link" && dragged?.kind !== "browser-bookmark")) return;
    if (dragged.kind === "saved-link" && targetLinkId === dragged.id) return setLinkDropPreview(null);
    setLinkDropPreview({ collectionId: collection.id, targetLinkId });
  }

  function acceptBrowserTab(event: DragEvent, collection: Collection) {
    if (!canMutateCollection(collection)) return false;
    if (typeof event.dataTransfer?.getData !== "function") return false;
    const payload = event.dataTransfer.getData(BROWSER_TAB_MIME);
    if (!payload || !onBrowserTabDrop) return false;
    try { onBrowserTabDrop(JSON.parse(payload) as CaptureTab, collection.id); return true; }
    catch { return false; }
  }

  async function copyBookmark(collection: Collection) {
    if (dragged?.kind !== "browser-bookmark" || !canMutateCollection(collection) || !onBookmarkDrop) return clearDrag();
    const link = dragged.link;
    clearDrag();
    try {
      await onBookmarkDrop(link, collection.id);
      await onReload();
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : "Could not copy this bookmark.");
    }
  }

  async function deleteCollection() {
    if (!pendingDelete || deleting || !canMutateCollection(pendingDelete)) return;
    const deleted = pendingDelete;
    setDeleting(true);
    try {
      await repository.deleteCollection(deleted.id);
      setPendingDelete(null);
      onMessage?.(`${deleted.name} deleted`);
      await onReload();
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : `Could not delete ${deleted.name}.`);
    } finally {
      setDeleting(false);
    }
  }

  const pendingDeleteLinkCount = pendingDelete
    ? allLinks.filter((link) => link.collection_id === pendingDelete.id && link.origin === "saved").length
    : 0;
  const browserTabDragging = browserTabDragSession > 0;
  return <div className={`ext-columns ${dragged?.kind === "saved-link" || dragged?.kind === "browser-bookmark" ? "link-dragging" : ""} ${browserTabDragging ? "browser-tab-dragging" : ""}`}>
    {dragged?.kind === "browser-bookmark" && !!bookmarkDropCollections.length && <aside className="bookmark-copy-tray" aria-label="Saved collection drop targets">
      <p>Copy to a saved collection</p>
      <div>{bookmarkDropCollections.filter(canMutateCollection).sort((left, right) => left.name.localeCompare(right.name)).map((collection) => <div
        aria-label={`${collection.name} copy target`}
        className={linkDropPreview?.collectionId === collection.id ? "bookmark-drop-target" : undefined}
        key={collection.id}
        onDragOver={(event) => { allowDrop(event); previewLinkDrop(collection); }}
        onDrop={(event) => { event.preventDefault(); void copyBookmark(collection); }}
        role="group"
      >{collection.name}</div>)}</div>
    </aside>}
    {orderedCollections.map((collection) => {
      const collectionLinks = links.filter((link) => link.collection_id === collection.id).sort((a, b) => a.position - b.position);
      const showsPreview = linkDropPreview?.collectionId === collection.id;
      const isBrowserDropTarget = browserTabDragging && browserDropTarget?.session === browserTabDragSession && browserDropTarget.collectionId === collection.id;
      const canMutate = canMutateCollection(collection);
      const isBookmarkDropTarget = showsPreview && dragged?.kind === "browser-bookmark";
      return <article
        aria-label={`${collection.name} collection`}
        className={[showsPreview || isBrowserDropTarget ? "drop-target" : "", isBookmarkDropTarget ? "bookmark-drop-target" : "", canMutate ? "" : "read-only"].filter(Boolean).join(" ") || undefined}
        draggable={canMutate}
        key={collection.id}
        onDragStart={(event) => { if (!canMutate) return event.preventDefault(); event.dataTransfer.effectAllowed = "move"; setLinkDropPreview(null); setBrowserDropTarget(null); setDragged({ kind: "collection", id: collection.id }); }}
        onDragEnd={clearDrag}
        onDragOver={(event) => { if (!canMutate) return; allowDrop(event); if (!previewBrowserTabDrop(event, collection)) previewLinkDrop(collection); }}
        onDrop={(event) => { event.preventDefault(); if (!canMutate) return clearDrag(); if (acceptBrowserTab(event, collection)) return; if (dragged?.kind === "collection") void moveCollection(collection.id); else if (dragged?.kind === "browser-bookmark") void copyBookmark(collection); else void moveLink(collection.id); }}
        role="group"
      >
        <div className="ext-col-head"><b>{collection.name}</b><div className="ext-col-meta"><span>{collectionLinks.length} links</span>{canMutate && <button aria-label={`Delete ${collection.name}`} className="collection-delete" draggable={false} title={`Delete ${collection.name}`} onClick={(event) => { event.stopPropagation(); setPendingDelete(collection); }}><Trash2 size={15} /></button>}</div></div>
        <div className="ext-link-grid">
          {collectionLinks.map((link) => <Fragment key={link.id}>
            {showsPreview && linkDropPreview.targetLinkId === link.id && <div aria-hidden="true" className="ext-link-drop-preview"><span>Drop here</span></div>}
            <a
            aria-label={`${link.title} · ${hostnameFor(link.url)}`}
            className={[
              (dragged?.kind === "saved-link" && dragged.id === link.id) || (dragged?.kind === "browser-bookmark" && dragged.link.id === link.id) ? "dragging" : "",
              link.id === highlightedLinkId || link.id === pendingDuplicateMove?.duplicate.id ? "duplicate-highlight" : "",
            ].filter(Boolean).join(" ") || undefined}
            draggable
            href={link.url}
            onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = link.origin === "browser-bookmark" ? "copy" : "move"; setLinkDropPreview(null); setDragged(link.origin === "browser-bookmark" ? { kind: "browser-bookmark", link } : { kind: "saved-link", id: link.id }); }}
            onDragEnd={clearDrag}
            onDragOver={(event) => { event.stopPropagation(); if (!canMutate) return; allowDrop(event); if (!previewBrowserTabDrop(event, collection)) previewLinkDrop(collection, link.id); }}
            onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (!canMutate) return clearDrag(); if (acceptBrowserTab(event, collection)) return; if (dragged?.kind === "browser-bookmark") void copyBookmark(collection); else void moveLink(collection.id, link.id); }}
          ><FaviconTile src={link.favicon_url} title={link.title} /><span><b>{link.title}</b><small>{hostnameFor(link.url)}</small>{link.device_label && <small className="bookmark-device-label">{link.device_label}</small>}</span></a>
          </Fragment>)}
          {showsPreview && !linkDropPreview.targetLinkId && <div aria-hidden="true" className="ext-link-drop-preview"><span>Drop here</span></div>}
        </div>
        <button className="open-links" onClick={() => void onOpenCollection(collection, collectionLinks)}>Open all</button>
      </article>;
    })}
    {pendingDuplicateMove && <div className="drop-confirm-backdrop"><section className="drop-confirm" role="dialog" aria-modal="true" aria-label="Duplicate link"><small>DUPLICATE LINK</small><h2>Already saved in this collection</h2><p>This URL is already represented by <strong>{pendingDuplicateMove.duplicate.title}</strong>. You can cancel or move another copy here.</p><div><button aria-label="Cancel move" onClick={() => setPendingDuplicateMove(null)}>Cancel</button><button className="close-after-save" onClick={() => void persistLinkMove(pendingDuplicateMove.sourceId, pendingDuplicateMove.collectionId, pendingDuplicateMove.targetLinkId)}>Move anyway</button></div></section></div>}
    {pendingDelete && <div className="drop-confirm-backdrop"><section aria-label={`Delete ${pendingDelete.name}`} aria-modal="true" className="drop-confirm" role="dialog">
      <button aria-label="Cancel deleting collection" className="dialog-close" disabled={deleting} onClick={() => setPendingDelete(null)}><X size={18} /></button>
      <small>DELETE COLLECTION</small><h2>Delete “{pendingDelete.name}”?</h2>
      <p>This permanently deletes {pendingDeleteLinkCount} saved link{pendingDeleteLinkCount === 1 ? "" : "s"}. Open browser tabs will not be closed.</p>
      <div><button disabled={deleting} onClick={() => setPendingDelete(null)}>Cancel</button><button className="close-after-save" disabled={deleting} onClick={() => void deleteCollection()}>Delete collection permanently</button></div>
    </section></div>}
  </div>;
}
