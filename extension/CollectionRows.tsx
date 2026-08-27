import { Fragment, useState, type DragEvent } from "react";
import type { Collection, SavedLink } from "../shared/domain";
import { findDuplicateLink, hostnameFor } from "../shared/domain";
import type { WorkspaceRepository } from "../shared/repository";
import type { CaptureTab } from "./chrome-api";
import { BROWSER_TAB_MIME } from "./CurrentTabsSheet";

export type CollectionRowsProps = {
  collections: Collection[];
  links: SavedLink[];
  allLinks?: SavedLink[];
  browserTabDragSession?: number;
  repository: WorkspaceRepository;
  onReload: () => Promise<void>;
  openLink?: (url: string) => void;
  onBrowserTabDrop?: (tab: CaptureTab, collectionId: string) => void;
  highlightedLinkId?: string;
};

type DraggedItem = { kind: "collection" | "link"; id: string } | null;
type LinkDropPreview = { collectionId: string; targetLinkId?: string } | null;
type PendingDuplicateMove = { sourceId: string; collectionId: string; targetLinkId?: string; duplicate: SavedLink } | null;

export function CollectionRows({ collections, links, allLinks = links, browserTabDragSession = 0, repository, onReload, openLink = (url) => chrome.tabs.create({ url }), onBrowserTabDrop, highlightedLinkId }: CollectionRowsProps) {
  const [dragged, setDragged] = useState<DraggedItem>(null);
  const [linkDropPreview, setLinkDropPreview] = useState<LinkDropPreview>(null);
  const [browserDropTarget, setBrowserDropTarget] = useState<{ collectionId: string; session: number } | null>(null);
  const [pendingDuplicateMove, setPendingDuplicateMove] = useState<PendingDuplicateMove>(null);
  const orderedCollections = [...collections].sort((a, b) => a.position - b.position);

  function clearDrag() {
    setDragged(null);
    setLinkDropPreview(null);
    setBrowserDropTarget(null);
  }

  async function moveCollection(targetId: string) {
    if (dragged?.kind !== "collection" || dragged.id === targetId) return;
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
      .filter((item) => item.collection_id === collectionId && item.id !== sourceId)
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
    if (dragged?.kind !== "link") return;
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
    event.dataTransfer.dropEffect = Array.from(event.dataTransfer.types).includes(BROWSER_TAB_MIME) ? "copy" : "move";
  }

  function isBrowserTabDrag(event: DragEvent) {
    return Array.from(event.dataTransfer.types).includes(BROWSER_TAB_MIME);
  }

  function previewBrowserTabDrop(event: DragEvent, collectionId: string) {
    if (!browserTabDragSession || !isBrowserTabDrag(event)) return false;
    setBrowserDropTarget({ collectionId, session: browserTabDragSession });
    return true;
  }

  function previewLinkDrop(collectionId: string, targetLinkId?: string) {
    if (dragged?.kind !== "link") return;
    if (targetLinkId === dragged.id) return setLinkDropPreview(null);
    setLinkDropPreview({ collectionId, targetLinkId });
  }

  function acceptBrowserTab(event: DragEvent, collectionId: string) {
    if (typeof event.dataTransfer?.getData !== "function") return false;
    const payload = event.dataTransfer.getData(BROWSER_TAB_MIME);
    if (!payload || !onBrowserTabDrop) return false;
    try { onBrowserTabDrop(JSON.parse(payload) as CaptureTab, collectionId); return true; }
    catch { return false; }
  }

  const browserTabDragging = browserTabDragSession > 0;
  return <div className={`ext-columns ${dragged?.kind === "link" ? "link-dragging" : ""} ${browserTabDragging ? "browser-tab-dragging" : ""}`}>
    {orderedCollections.map((collection) => {
      const collectionLinks = links.filter((link) => link.collection_id === collection.id).sort((a, b) => a.position - b.position);
      const showsPreview = linkDropPreview?.collectionId === collection.id;
      const isBrowserDropTarget = browserTabDragging && browserDropTarget?.session === browserTabDragSession && browserDropTarget.collectionId === collection.id;
      return <article
        aria-label={`${collection.name} collection`}
        className={showsPreview || isBrowserDropTarget ? "drop-target" : undefined}
        draggable
        key={collection.id}
        onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setLinkDropPreview(null); setBrowserDropTarget(null); setDragged({ kind: "collection", id: collection.id }); }}
        onDragEnd={clearDrag}
        onDragOver={(event) => { allowDrop(event); if (!previewBrowserTabDrop(event, collection.id)) previewLinkDrop(collection.id); }}
        onDrop={(event) => { event.preventDefault(); if (acceptBrowserTab(event, collection.id)) return; if (dragged?.kind === "collection") void moveCollection(collection.id); else void moveLink(collection.id); }}
        role="group"
      >
        <div className="ext-col-head"><b>{collection.name}</b><span>{collectionLinks.length} links</span></div>
        <div className="ext-link-grid">
          {collectionLinks.map((link) => <Fragment key={link.id}>
            {showsPreview && linkDropPreview.targetLinkId === link.id && <div aria-hidden="true" className="ext-link-drop-preview"><span>Drop here</span></div>}
            <a
            aria-label={`${link.title} · ${hostnameFor(link.url)}`}
            className={[
              dragged?.kind === "link" && dragged.id === link.id ? "dragging" : "",
              link.id === highlightedLinkId || link.id === pendingDuplicateMove?.duplicate.id ? "duplicate-highlight" : "",
            ].filter(Boolean).join(" ") || undefined}
            draggable
            href={link.url}
            onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; setLinkDropPreview(null); setDragged({ kind: "link", id: link.id }); }}
            onDragEnd={clearDrag}
            onDragOver={(event) => { event.stopPropagation(); allowDrop(event); if (!previewBrowserTabDrop(event, collection.id)) previewLinkDrop(collection.id, link.id); }}
            onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (!acceptBrowserTab(event, collection.id)) void moveLink(collection.id, link.id); }}
          ><i>{link.title[0]?.toUpperCase()}</i><span><b>{link.title}</b><small>{hostnameFor(link.url)}</small></span></a>
          </Fragment>)}
          {showsPreview && !linkDropPreview.targetLinkId && <div aria-hidden="true" className="ext-link-drop-preview"><span>Drop here</span></div>}
        </div>
        <button className="open-links" onClick={() => collectionLinks.forEach((link) => openLink(link.url))}>Open all</button>
      </article>;
    })}
    {pendingDuplicateMove && <div className="drop-confirm-backdrop"><section className="drop-confirm" role="dialog" aria-modal="true" aria-label="Duplicate link"><small>DUPLICATE LINK</small><h2>Already saved in this collection</h2><p>This URL is already represented by <strong>{pendingDuplicateMove.duplicate.title}</strong>. You can cancel or move another copy here.</p><div><button aria-label="Cancel move" onClick={() => setPendingDuplicateMove(null)}>Cancel</button><button className="close-after-save" onClick={() => void persistLinkMove(pendingDuplicateMove.sourceId, pendingDuplicateMove.collectionId, pendingDuplicateMove.targetLinkId)}>Move anyway</button></div></section></div>}
  </div>;
}
