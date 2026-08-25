import { useState, type DragEvent } from "react";
import type { Collection, SavedLink } from "../shared/domain";
import { hostnameFor } from "../shared/domain";
import type { WorkspaceRepository } from "../shared/repository";
import type { CaptureTab } from "./chrome-api";
import { BROWSER_TAB_MIME } from "./CurrentTabsSheet";

export type CollectionRowsProps = {
  collections: Collection[];
  links: SavedLink[];
  repository: WorkspaceRepository;
  onReload: () => Promise<void>;
  openLink?: (url: string) => void;
  onBrowserTabDrop?: (tab: CaptureTab, collectionId: string) => void;
};

type DraggedItem = { kind: "collection" | "link"; id: string } | null;

export function CollectionRows({ collections, links, repository, onReload, openLink = (url) => chrome.tabs.create({ url }), onBrowserTabDrop }: CollectionRowsProps) {
  const [dragged, setDragged] = useState<DraggedItem>(null);
  const orderedCollections = [...collections].sort((a, b) => a.position - b.position);

  async function moveCollection(targetId: string) {
    if (dragged?.kind !== "collection" || dragged.id === targetId) return;
    const orderedIds = orderedCollections.map((item) => item.id);
    const from = orderedIds.indexOf(dragged.id);
    const target = orderedIds.indexOf(targetId);
    if (from < 0 || target < 0) return;
    orderedIds.splice(from, 1);
    orderedIds.splice(orderedIds.indexOf(targetId), 0, dragged.id);
    setDragged(null);
    await repository.reorderCollections(orderedCollections[0].space_id, orderedIds);
    await onReload();
  }

  async function moveLink(collectionId: string, targetLinkId?: string) {
    if (dragged?.kind !== "link") return;
    const orderedIds = links
      .filter((item) => item.collection_id === collectionId && item.id !== dragged.id)
      .sort((a, b) => a.position - b.position)
      .map((item) => item.id);
    const targetIndex = targetLinkId ? orderedIds.indexOf(targetLinkId) : orderedIds.length;
    orderedIds.splice(targetIndex < 0 ? orderedIds.length : targetIndex, 0, dragged.id);
    setDragged(null);
    await repository.reorderLinks(collectionId, orderedIds);
    await onReload();
  }

  function allowDrop(event: DragEvent) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function acceptBrowserTab(event: DragEvent, collectionId: string) {
    if (typeof event.dataTransfer?.getData !== "function") return false;
    const payload = event.dataTransfer.getData(BROWSER_TAB_MIME);
    if (!payload || !onBrowserTabDrop) return false;
    try { onBrowserTabDrop(JSON.parse(payload) as CaptureTab, collectionId); return true; }
    catch { return false; }
  }

  return <div className="ext-columns">
    {orderedCollections.map((collection) => {
      const collectionLinks = links.filter((link) => link.collection_id === collection.id).sort((a, b) => a.position - b.position);
      return <article
        aria-label={`${collection.name} collection`}
        draggable
        key={collection.id}
        onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setDragged({ kind: "collection", id: collection.id }); }}
        onDragOver={allowDrop}
        onDrop={(event) => { event.preventDefault(); if (acceptBrowserTab(event, collection.id)) return; if (dragged?.kind === "collection") void moveCollection(collection.id); else void moveLink(collection.id); }}
        role="group"
      >
        <div className="ext-col-head"><b>{collection.name}</b><span>{collectionLinks.length} links</span></div>
        <div className="ext-link-grid">
          {collectionLinks.map((link) => <a
            aria-label={`${link.title} · ${hostnameFor(link.url)}`}
            draggable
            href={link.url}
            key={link.id}
            onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; setDragged({ kind: "link", id: link.id }); }}
            onDragOver={allowDrop}
            onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (!acceptBrowserTab(event, collection.id)) void moveLink(collection.id, link.id); }}
          ><i>{link.title[0]?.toUpperCase()}</i><span><b>{link.title}</b><small>{hostnameFor(link.url)}</small></span></a>)}
        </div>
        <button className="open-links" onClick={() => collectionLinks.forEach((link) => openLink(link.url))}>Open all</button>
      </article>;
    })}
  </div>;
}
