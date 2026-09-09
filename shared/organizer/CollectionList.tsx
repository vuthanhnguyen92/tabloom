import { ArrowDown, ArrowUp, ChevronRight, Pencil, Share2, Trash2, X } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { CollectionShareDialog } from "../CollectionShareDialog";
import type { CollectionShareRepository, ShareAvailability } from "../collection-sharing";
import type { Collection, SavedLink } from "../domain";
import { findDuplicateLink, hostnameFor } from "../domain";
import type { WorkspaceRepository } from "../repository";
import type { CollectionCollapsePreference } from "./preferences";
import { CollectionSection } from "./CollectionSection";
import { SavedLinkCard, type OrganizerFaviconResolver } from "./SavedLinkCard";
import { previewCollectionDrop, previewLinkDrop as reorderLinkPreview } from "./drag-model";

const capturedFavicon: OrganizerFaviconResolver = ({ capturedUrl }) => capturedUrl ?? null;

export type CollectionListProps = {
  collections: Collection[];
  links: SavedLink[];
  allLinks?: SavedLink[];
  bookmarkDropCollections?: Collection[];
  externalDrop?: {
    session: number;
    isDrag(event: DragEvent): boolean;
    accept(event: DragEvent, collection: Collection): boolean;
  };
  collapsePreference?: Pick<CollectionCollapsePreference, "reconcile" | "setCollapsed">;
  collapseScope?: string;
  repository: WorkspaceRepository;
  onReload: () => Promise<void>;
  onOpenCollection?: (collection: Collection, links: SavedLink[]) => void | Promise<void>;
  onBookmarkDrop?: (link: SavedLink, collectionId: string) => void | Promise<void>;
  onError?: (message: string) => void;
  onMessage?: (message: string) => void;
  highlightedLinkId?: string;
  resolveFavicon?: OrganizerFaviconResolver;
  share?: {
    availability: ShareAvailability;
    repository: CollectionShareRepository | null;
    siteUrl: string;
    onRequestSignIn: () => void;
    onRequestSyncRetry: () => void;
    onToast: (message: string) => void;
  };
};

type DraggedItem =
  | { kind: "collection"; id: string }
  | { kind: "saved-link"; id: string }
  | { kind: "browser-bookmark"; link: SavedLink }
  | null;
type LinkDropPreview = { collectionId: string; targetLinkId?: string } | null;
type PendingDuplicateMove = { sourceId: string; collectionId: string; targetLinkId?: string; duplicate: SavedLink } | null;
type CollectionDropPreview = { targetId: string; edge: "before" | "after" } | null;
type EditingLink = { original: SavedLink; title: string; description: string; error?: string } | null;
type OptimisticLinkText = { title: string; description: string };
const DELETE_EXIT_MS = 200;
const waitForDeleteExit = () => new Promise<void>((resolve) => setTimeout(resolve,
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : DELETE_EXIT_MS,
));

export function CollectionList({ collections, links, allLinks = links, bookmarkDropCollections = [], externalDrop, collapsePreference, collapseScope = "local", repository, onReload, onOpenCollection, onBookmarkDrop, onError, onMessage, highlightedLinkId, resolveFavicon = capturedFavicon, share }: CollectionListProps) {
  const browserTabDragSession = externalDrop?.session ?? 0;
  const listRef = useRef<HTMLDivElement>(null);
  const layoutPositions = useRef(new Map<string, { left: number; top: number }>());
  useLayoutEffect(() => {
    const next = new Map<string, { left: number; top: number }>();
    const animations: Animation[] = [];
    const reduceMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    listRef.current?.querySelectorAll<HTMLElement>("[data-organizer-layout-id]").forEach((node) => {
      const id = node.dataset.organizerLayoutId!;
      const bounds = node.getBoundingClientRect();
      next.set(id, { left: bounds.left, top: bounds.top });
      const previous = layoutPositions.current.get(id);
      if (!previous || reduceMotion || node.classList.contains("drag-preview-source")) return;
      const x = previous.left - bounds.left;
      const y = previous.top - bounds.top;
      if ((x || y) && node.animate) animations.push(node.animate([
        { transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0px, 0px)" },
      ], { duration: 200, easing: "ease-out" }));
    });
    layoutPositions.current = next;
    return () => animations.forEach((animation) => animation.cancel());
  });
  const [dragged, setDragged] = useState<DraggedItem>(null);
  const [linkDropPreview, setLinkDropPreview] = useState<LinkDropPreview>(null);
  const [collectionDropPreview, setCollectionDropPreview] = useState<CollectionDropPreview>(null);
  const [browserDropTarget, setBrowserDropTarget] = useState<{ collectionId: string; session: number } | null>(null);
  const [pendingDuplicateMove, setPendingDuplicateMove] = useState<PendingDuplicateMove>(null);
  const [pendingDelete, setPendingDelete] = useState<Collection | null>(null);
  const [pendingDeleteLink, setPendingDeleteLink] = useState<SavedLink | null>(null);
  const [editingLink, setEditingLink] = useState<EditingLink>(null);
  const [removingCollectionId, setRemovingCollectionId] = useState<string | null>(null);
  const [removingLinkId, setRemovingLinkId] = useState<string | null>(null);
  const [editingCollection, setEditingCollection] = useState<{ id: string; originalName: string; value: string; error?: string } | null>(null);
  const [sharingCollection, setSharingCollection] = useState<Collection | null>(null);
  const [optimisticCollectionNames, setOptimisticCollectionNames] = useState<Record<string, string>>({});
  const [optimisticLinkText, setOptimisticLinkText] = useState<Record<string, OptimisticLinkText>>({});
  const collectionNameInputRef = useRef<HTMLInputElement>(null);
  const linkTitleInputRef = useRef<HTMLInputElement>(null);
  const [collapsedState, setCollapsedState] = useState<{ scope: string; ids: Set<string>; ready: boolean }>(() => ({ scope: collapseScope, ids: new Set(), ready: !collapsePreference }));
  const [deleting, setDeleting] = useState(false);
  const orderedCollections = [...collections].sort((a, b) => a.position - b.position);
  const canMutateCollection = (collection: Collection) => collection.origin === "saved" && !collection.read_only;
  const collectionIdsKey = orderedCollections.map((collection) => collection.id).join("\0");
  const editingCollectionId = editingCollection?.id;
  const editingLinkId = editingLink?.original.id;

  useEffect(() => {
    if (!editingCollectionId) return;
    collectionNameInputRef.current?.focus();
    collectionNameInputRef.current?.select();
  }, [editingCollectionId]);

  useEffect(() => {
    if (!editingLinkId) return;
    linkTitleInputRef.current?.focus();
    linkTitleInputRef.current?.select();
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setEditingLink(null);
      }
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [editingLinkId]);

  useEffect(() => {
    let active = true;
    if (collapsePreference) {
      void collapsePreference.reconcile(collapseScope, collectionIdsKey ? collectionIdsKey.split("\0") : []).then((collapsed) => {
        if (active) setCollapsedState({ scope: collapseScope, ids: collapsed, ready: true });
      }).catch(() => {
        if (active) {
          setCollapsedState({ scope: collapseScope, ids: new Set(), ready: true });
          onError?.("Could not restore collapsed collections.");
        }
      });
    }
    return () => { active = false; };
  }, [collapsePreference, collapseScope, collectionIdsKey, onError]);

  function toggleCollection(collectionId: string) {
    setCollapsedState((current) => {
      const next = new Set(current.scope === collapseScope ? current.ids : []);
      const collapsed = !next.has(collectionId);
      if (collapsed) next.add(collectionId);
      else next.delete(collectionId);
      void collapsePreference?.setCollapsed(collapseScope, collectionId, collapsed).catch(() => onError?.("Could not remember this collection state."));
      return { scope: collapseScope, ids: next, ready: true };
    });
  }

  function clearDrag() {
    setDragged(null);
    setLinkDropPreview(null);
    setCollectionDropPreview(null);
    setBrowserDropTarget(null);
  }

  function startRenamingCollection(collection: Collection, displayName: string) {
    if (!canMutateCollection(collection)) return;
    clearDrag();
    setEditingCollection({ id: collection.id, originalName: displayName, value: displayName });
  }

  function cancelRenamingCollection() {
    setEditingCollection(null);
  }

  function startEditingLink(link: SavedLink) {
    if (link.origin !== "saved" || link.read_only) return;
    clearDrag();
    const optimistic = optimisticLinkText[link.id];
    setEditingLink({
      original: link,
      title: optimistic?.title ?? link.title,
      description: optimistic?.description ?? link.description,
    });
  }

  async function saveLinkText() {
    if (!editingLink) return;
    const current = editingLink;
    const title = current.title.trim();
    const description = current.description.trim();
    if (!title) {
      setEditingLink({ ...current, error: "Title is required" });
      return;
    }
    setOptimisticLinkText((values) => ({ ...values, [current.original.id]: { title, description } }));
    setEditingLink(null);
    try {
      await repository.updateLink(current.original.id, { title, description });
      await onReload();
      setOptimisticLinkText((values) => {
        const next = { ...values };
        delete next[current.original.id];
        return next;
      });
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : `Could not update ${current.original.title}.`);
    }
  }

  async function saveCollectionName(collection: Collection) {
    if (editingCollection?.id !== collection.id) return;
    const name = editingCollection.value.trim();
    if (!name) {
      setEditingCollection((current) => current?.id === collection.id ? { ...current, error: "Collection name is required" } : current);
      return;
    }
    if (name === editingCollection.originalName) {
      setEditingCollection(null);
      return;
    }
    setOptimisticCollectionNames((current) => ({ ...current, [collection.id]: name }));
    setEditingCollection(null);
    try {
      await repository.updateCollection(collection.id, { name });
      await onReload();
      setOptimisticCollectionNames((current) => {
        const next = { ...current };
        delete next[collection.id];
        return next;
      });
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : `Could not rename ${editingCollection.originalName}.`);
    }
  }

  function collectionOrderForPreview(targetId: string, edge: "before" | "after") {
    if (dragged?.kind !== "collection") return orderedCollections;
    const source = orderedCollections.find((item) => item.id === dragged.id);
    const target = orderedCollections.find((item) => item.id === targetId);
    if (!source || !target || source.id === target.id) return orderedCollections;
    const preview = orderedCollections.filter((item) => item.id !== source.id);
    const targetIndex = preview.findIndex((item) => item.id === target.id);
    return previewCollectionDrop(orderedCollections, source.id, targetIndex + (edge === "after" ? 1 : 0));
  }

  function previewCollectionMove(event: DragEvent, targetId: string) {
    if (dragged?.kind !== "collection" || dragged.id === targetId) return setCollectionDropPreview(null);
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = bounds.height > 0 && event.clientY >= bounds.top + bounds.height / 2 ? "after" : "before";
    setCollectionDropPreview({ targetId, edge });
  }

  async function moveCollection(targetId: string) {
    if (dragged?.kind !== "collection" || dragged.id === targetId) return;
    const targetCollection = orderedCollections.find((item) => item.id === targetId);
    if (!targetCollection || !canMutateCollection(targetCollection)) return clearDrag();
    const preview = collectionDropPreview ?? { targetId, edge: "before" as const };
    const orderedIds = collectionOrderForPreview(preview.targetId, preview.edge).map((item) => item.id);
    clearDrag();
    await repository.reorderCollections(orderedCollections[0].space_id, orderedIds);
    await onReload();
  }

  async function moveCollectionByStep(collectionId: string, direction: -1 | 1) {
    const index = orderedCollections.findIndex((collection) => collection.id === collectionId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= orderedCollections.length) return;
    const target = orderedCollections[targetIndex];
    if (!canMutateCollection(orderedCollections[index]) || !canMutateCollection(target)) return;
    const orderedIds = orderedCollections.map((collection) => collection.id);
    [orderedIds[index], orderedIds[targetIndex]] = [orderedIds[targetIndex], orderedIds[index]];
    try {
      await repository.reorderCollections(orderedCollections[index].space_id, orderedIds);
      await onReload();
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : "Could not move this collection.");
    }
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
    await requestLinkMove(dragged.id, collectionId, targetLinkId);
  }

  async function moveLinkByStep(link: SavedLink, direction: -1 | 1) {
    const ordered = allLinks.filter((item) => item.collection_id === link.collection_id).sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((item) => item.id === link.id);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= ordered.length) return;
    const preview = reorderLinkPreview(ordered, link.id, destination);
    await requestLinkMove(link.id, link.collection_id, preview[destination + 1]?.id);
  }

  async function requestLinkMove(sourceId: string, collectionId: string, targetLinkId?: string) {
    if (targetLinkId === sourceId) return clearDrag();
    const source = allLinks.find((link) => link.id === sourceId);
    const destination = collections.find((item) => item.id === collectionId);
    if (!source || source.origin !== "saved" || source.read_only || !destination || !canMutateCollection(destination)) return clearDrag();
    const duplicate = source && source.collection_id !== collectionId
      ? findDuplicateLink(allLinks, collectionId, source.url, source.id)
      : undefined;
    if (duplicate) {
      setPendingDuplicateMove({ sourceId, collectionId, targetLinkId, duplicate });
      clearDrag();
      return;
    }
    try { await persistLinkMove(sourceId, collectionId, targetLinkId); }
    catch (reason) { onError?.(reason instanceof Error ? reason.message : "Could not move this link."); }
  }

  function allowDrop(event: DragEvent) {
    event.preventDefault();
    event.dataTransfer.dropEffect = externalDrop?.isDrag(event) || dragged?.kind === "browser-bookmark" ? "copy" : "move";
  }

  function isBrowserTabDrag(event: DragEvent) {
    return externalDrop?.isDrag(event) ?? false;
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
    const accepted = externalDrop?.accept(event, collection) ?? false;
    if (accepted) clearDrag();
    return accepted;
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
    setPendingDelete(null);
    setRemovingCollectionId(deleted.id);
    try {
      await Promise.all([repository.deleteCollection(deleted.id), waitForDeleteExit()]);
      onMessage?.(`${deleted.name} deleted`);
      await onReload();
      setRemovingCollectionId(null);
    } catch (reason) {
      setRemovingCollectionId(null);
      setPendingDelete(deleted);
      onError?.(reason instanceof Error ? reason.message : `Could not delete ${deleted.name}.`);
    } finally {
      setDeleting(false);
    }
  }

  async function deleteSavedLink() {
    if (!pendingDeleteLink || deleting || pendingDeleteLink.origin !== "saved") return;
    const deleted = pendingDeleteLink;
    setDeleting(true);
    setPendingDeleteLink(null);
    setRemovingLinkId(deleted.id);
    try {
      await Promise.all([repository.deleteLink(deleted.id), waitForDeleteExit()]);
      onMessage?.(`${deleted.title} deleted`);
      await onReload();
      setRemovingLinkId(null);
    } catch (reason) {
      setRemovingLinkId(null);
      setPendingDeleteLink(deleted);
      onError?.(reason instanceof Error ? reason.message : `Could not delete ${deleted.title}.`);
    } finally {
      setDeleting(false);
    }
  }

  const pendingDeleteLinkCount = pendingDelete
    ? allLinks.filter((link) => link.collection_id === pendingDelete.id && link.origin === "saved").length
    : 0;
  const browserTabDragging = browserTabDragSession > 0;
  const displayedCollections = dragged?.kind === "collection" && collectionDropPreview
    ? collectionOrderForPreview(collectionDropPreview.targetId, collectionDropPreview.edge)
    : orderedCollections;
  const collapseStateReady = !collapsePreference || (collapsedState.ready && collapsedState.scope === collapseScope);
  if (!collapseStateReady) return <div aria-label="Restoring collection layout" className="ext-columns collection-layout-loading" role="status" />;
  return <div ref={listRef} className={`ext-columns ${dragged?.kind === "saved-link" || dragged?.kind === "browser-bookmark" ? "link-dragging" : ""} ${dragged?.kind === "collection" ? "collection-reordering" : ""} ${browserTabDragging ? "browser-tab-dragging" : ""}`}>
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
    {displayedCollections.map((collection) => {
      const collectionLinks = links.filter((link) => link.collection_id === collection.id).sort((a, b) => a.position - b.position);
      const showsPreview = linkDropPreview?.collectionId === collection.id;
      const isBrowserDropTarget = browserTabDragging && browserDropTarget?.session === browserTabDragSession && browserDropTarget.collectionId === collection.id;
      const canMutate = canMutateCollection(collection);
      const isBookmarkDropTarget = showsPreview && dragged?.kind === "browser-bookmark";
      const isRemovingCollection = removingCollectionId === collection.id;
      const displayName = optimisticCollectionNames[collection.id] ?? collection.name;
      const displayCollection = displayName === collection.name ? collection : { ...collection, name: displayName };
      const isEditingCollection = editingCollection?.id === collection.id;
      const isCollapsed = collapsedState.scope === collapseScope && collapsedState.ids.has(collection.id);
      const isDraggedCollection = dragged?.kind === "collection" && dragged.id === collection.id;
      const canonicalIndex = orderedCollections.findIndex((item) => item.id === collection.id);
      const canMoveUp = canMutate && canonicalIndex > 0 && canMutateCollection(orderedCollections[canonicalIndex - 1]);
      const canMoveDown = canMutate && canonicalIndex < orderedCollections.length - 1 && canMutateCollection(orderedCollections[canonicalIndex + 1]);
      return <Fragment key={collection.id}>
      {isDraggedCollection && collectionDropPreview && <div aria-hidden="true" className="collection-drop-preview"><span>Drop collection here</span></div>}
      <CollectionSection collection={displayCollection} links={collectionLinks} writable={canMutate} collapsed={isCollapsed} onOpenCollection={onOpenCollection}
        aria-label={`${displayName} collection`}
        aria-busy={isRemovingCollection || undefined}
        className={[showsPreview || isBrowserDropTarget ? "drop-target" : "", isBookmarkDropTarget ? "bookmark-drop-target" : "", canMutate ? "" : "read-only", isDraggedCollection ? "collection-dragging" : "", isCollapsed ? "is-collapsed" : "", isRemovingCollection ? "is-removing" : ""].filter(Boolean).join(" ") || undefined}
        draggable={canMutate && !isRemovingCollection && !isEditingCollection}
        key={collection.id}
        onDragStart={(event) => { if (!canMutate || isRemovingCollection || isEditingCollection) return event.preventDefault(); event.dataTransfer.effectAllowed = "move"; setLinkDropPreview(null); setBrowserDropTarget(null); setDragged({ kind: "collection", id: collection.id }); }}
        onDragEnd={clearDrag}
        onDragOver={(event) => { if (!canMutate) return; allowDrop(event); if (dragged?.kind === "collection") return previewCollectionMove(event, collection.id); if (!previewBrowserTabDrop(event, collection)) previewLinkDrop(collection); }}
        onDrop={(event) => { event.preventDefault(); if (!canMutate) return clearDrag(); if (acceptBrowserTab(event, collection)) return; if (dragged?.kind === "collection") void moveCollection(collection.id); else if (dragged?.kind === "browser-bookmark") void copyBookmark(collection); else void moveLink(collection.id); }}
        header={<div className="ext-col-head"><div className="collection-title-group"><button aria-controls={`collection-body-${collection.id}`} aria-expanded={!isCollapsed} aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${displayName}`} className="collection-collapse-toggle" draggable={false} onClick={(event) => { event.stopPropagation(); toggleCollection(collection.id); }}><ChevronRight aria-hidden="true" size={17} /></button>{isEditingCollection ? <div className="collection-name-editor"><input
          aria-invalid={Boolean(editingCollection.error)}
          aria-label={`Collection name for ${editingCollection.originalName}`}
          draggable={false}
          onBlur={() => void saveCollectionName(collection)}
          onChange={(event) => setEditingCollection((current) => current?.id === collection.id ? { ...current, value: event.target.value, error: undefined } : current)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); cancelRenamingCollection(); }
            if (event.key === "Enter") { event.preventDefault(); void saveCollectionName(collection); }
          }}
          ref={collectionNameInputRef}
          value={editingCollection.value}
        />{editingCollection.error && <small role="alert">{editingCollection.error}</small>}</div> : canMutate ? <button aria-label={`Rename ${displayName}`} className="collection-name-edit" draggable={false} title={`Rename ${displayName}`} onClick={(event) => { event.stopPropagation(); startRenamingCollection(collection, displayName); }}><b>{displayName}</b><Pencil aria-hidden="true" size={13} /></button> : <b className="collection-name-readonly">{displayName}</b>}</div><div className="ext-col-meta">
          {canMutate && !isEditingCollection && <div className="collection-reorder-actions"><button aria-label={`Move ${displayName} up`} disabled={!canMoveUp} draggable={false} onClick={(event) => { event.stopPropagation(); void moveCollectionByStep(collection.id, -1); }}><ArrowUp size={14} /></button><button aria-label={`Move ${displayName} down`} disabled={!canMoveDown} draggable={false} onClick={(event) => { event.stopPropagation(); void moveCollectionByStep(collection.id, 1); }}><ArrowDown size={14} /></button></div>}
          {canMutate && !isEditingCollection && share && <button aria-label={`Share ${displayName}`} className="collection-share" draggable={false} title={`Share ${displayName}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); clearDrag(); setSharingCollection(displayCollection); }}><Share2 size={15} /></button>}
          <span>{collectionLinks.length} links</span>
          {canMutate && !isEditingCollection && <button aria-label={`Delete ${displayName}`} className="collection-delete" draggable={false} title={`Delete ${displayName}`} onClick={(event) => { event.stopPropagation(); setPendingDelete(displayCollection); }}><Trash2 size={15} /></button>}
        </div></div>}
      >
          {collectionLinks.map((link) => {
            const isRemovingLink = removingLinkId === link.id;
            const optimisticText = optimisticLinkText[link.id];
            const displayLink = optimisticText ? { ...link, ...optimisticText } : link;
            const canonicalLinks = allLinks.filter((item) => item.collection_id === collection.id).sort((a, b) => a.position - b.position);
            const linkIndex = canonicalLinks.findIndex((item) => item.id === link.id);
            const isDragged = (dragged?.kind === "saved-link" && dragged.id === link.id) || (dragged?.kind === "browser-bookmark" && dragged.link.id === link.id);
            return <Fragment key={link.id}>
            {showsPreview && linkDropPreview.targetLinkId === link.id && <div aria-hidden="true" className="ext-link-drop-preview"><span>Drop here</span></div>}
            <SavedLinkCard link={displayLink} writable={canMutate} removing={isRemovingLink}
              dragging={isDragged} previewSource={isDragged && !!linkDropPreview && dragged?.kind === "saved-link"}
              copyable={link.origin === "browser-bookmark" && !!onBookmarkDrop}
              highlighted={link.id === highlightedLinkId || link.id === pendingDuplicateMove?.duplicate.id}
              favicon={resolveFavicon({ pageUrl: displayLink.url, capturedUrl: displayLink.favicon_url, size: 32 })}
              moveDestinations={orderedCollections}
              actions={{
                onEdit: () => startEditingLink(displayLink),
                onDelete: () => setPendingDeleteLink(displayLink),
                onMoveEarlier: linkIndex > 0 ? () => void moveLinkByStep(link, -1) : undefined,
                onMoveLater: linkIndex < canonicalLinks.length - 1 ? () => void moveLinkByStep(link, 1) : undefined,
                onMoveToCollection: orderedCollections.some((item) => canMutateCollection(item) && item.id !== collection.id) ? (id) => void requestLinkMove(link.id, id) : undefined,
              }}
              onDragStart={(event) => { event.stopPropagation(); if (isRemovingLink) return event.preventDefault(); event.dataTransfer.effectAllowed = link.origin === "browser-bookmark" ? "copy" : "move"; setLinkDropPreview(null); setDragged(link.origin === "browser-bookmark" ? { kind: "browser-bookmark", link } : { kind: "saved-link", id: link.id }); }}
              onDragEnd={clearDrag}
              onDragOver={(event) => { event.stopPropagation(); if (!canMutate) return; allowDrop(event); if (!previewBrowserTabDrop(event, collection)) previewLinkDrop(collection, link.id); }}
              onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (!canMutate) return clearDrag(); if (acceptBrowserTab(event, collection)) return; if (dragged?.kind === "browser-bookmark") void copyBookmark(collection); else void moveLink(collection.id, link.id); }}
            />
          </Fragment>; })}
          {showsPreview && !linkDropPreview.targetLinkId && <div aria-hidden="true" className="ext-link-drop-preview"><span>Drop here</span></div>}
      </CollectionSection>
      </Fragment>;
    })}
    {pendingDuplicateMove && <div className="drop-confirm-backdrop"><section className="drop-confirm" role="dialog" aria-modal="true" aria-label="Duplicate link"><small>DUPLICATE LINK</small><h2>Already saved in this collection</h2><p>This URL is already represented by <strong>{pendingDuplicateMove.duplicate.title}</strong>. You can cancel or move another copy here.</p><div><button aria-label="Cancel move" onClick={() => setPendingDuplicateMove(null)}>Cancel</button><button className="close-after-save" onClick={() => void persistLinkMove(pendingDuplicateMove.sourceId, pendingDuplicateMove.collectionId, pendingDuplicateMove.targetLinkId)}>Move anyway</button></div></section></div>}
    {pendingDelete && <div className="drop-confirm-backdrop"><section aria-label={`Delete ${pendingDelete.name}`} aria-modal="true" className="drop-confirm" role="dialog">
      <button aria-label="Cancel deleting collection" className="dialog-close" disabled={deleting} onClick={() => setPendingDelete(null)}><X size={18} /></button>
      <small>DELETE COLLECTION</small><h2>Delete “{pendingDelete.name}”?</h2>
      <p>This permanently deletes {pendingDeleteLinkCount} saved link{pendingDeleteLinkCount === 1 ? "" : "s"}. Open browser tabs will not be closed.</p>
      <div><button disabled={deleting} onClick={() => setPendingDelete(null)}>Cancel</button><button className="close-after-save" disabled={deleting} onClick={() => void deleteCollection()}>Delete collection permanently</button></div>
    </section></div>}
    {pendingDeleteLink && <div className="drop-confirm-backdrop"><section aria-label={`Delete ${pendingDeleteLink.title} link`} aria-modal="true" className="drop-confirm" role="dialog">
      <button aria-label="Cancel deleting link" className="dialog-close" disabled={deleting} onClick={() => setPendingDeleteLink(null)}><X size={18} /></button>
      <small>DELETE SAVED LINK</small><h2>Delete “{pendingDeleteLink.title}”?</h2>
      <p>The saved link will be permanently removed from this collection. The open browser tab, if any, will not be closed.</p>
      <div><button disabled={deleting} onClick={() => setPendingDeleteLink(null)}>Cancel</button><button className="close-after-save" disabled={deleting} onClick={() => void deleteSavedLink()}>Delete link permanently</button></div>
    </section></div>}
    {editingLink && <div className="drop-confirm-backdrop"><section aria-label={`Edit ${editingLink.original.title}`} aria-modal="true" className="drop-confirm link-editor-modal" role="dialog">
      <button aria-label="Cancel editing link" className="dialog-close" onClick={() => setEditingLink(null)}><X size={18} /></button>
      <small>EDIT SAVED LINK</small><h2>Edit card details</h2>
      <form onSubmit={(event) => { event.preventDefault(); void saveLinkText(); }}>
        <label>Title<input aria-invalid={Boolean(editingLink.error)} aria-label="Title" onChange={(event) => setEditingLink((current) => current ? { ...current, title: event.target.value, error: undefined } : current)} ref={linkTitleInputRef} value={editingLink.title} /></label>
        {editingLink.error && <small role="alert">{editingLink.error}</small>}
        <label>Subtitle<input aria-label="Subtitle" onChange={(event) => setEditingLink((current) => current ? { ...current, description: event.target.value } : current)} placeholder={hostnameFor(editingLink.original.url)} value={editingLink.description} /></label>
        <div><button type="button" onClick={() => setEditingLink(null)}>Cancel</button><button className="close-after-save" type="submit">Save changes</button></div>
      </form>
    </section></div>}
    {sharingCollection && share && <CollectionShareDialog
      availability={share.availability}
      collection={sharingCollection}
      onClose={() => setSharingCollection(null)}
      onRequestSignIn={share.onRequestSignIn}
      onRequestSyncRetry={share.onRequestSyncRetry}
      onToast={share.onToast}
      repository={share.repository}
      siteUrl={share.siteUrl}
    />}
  </div>;
}
