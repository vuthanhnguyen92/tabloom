import { ArrowDown, ArrowUp, ChevronRight, GripVertical, Pencil, Plus, Share2, Trash2 } from "lucide-react";
import { Fragment, useEffect, useState, type DragEvent, type ReactNode } from "react";
import { CollectionShareDialog } from "../CollectionShareDialog";
import { TabloomMark } from "../TabloomMark";
import type { Collection } from "../domain";
import { CollectionLayout, type CollectionListProps } from "./CollectionList";
import { CollectionSection } from "./CollectionSection";
import { GlobalSearch } from "./GlobalSearch";
import { SavedLinkCard, type OrganizerFaviconResolver } from "./SavedLinkCard";
import { SpaceRail } from "./SpaceRail";
import { ToastRegion } from "./ToastRegion";
import { TrashDialog } from "./TrashDialog";
import { WorkspaceDialogs } from "./WorkspaceDialogs";
import { WorkspaceHeader, type OrganizerStatus } from "./WorkspaceHeader";
import { WorkspaceShell } from "./WorkspaceShell";
import { previewCollectionDrop, previewLinkTransfer } from "./drag-model";
import { isWritable } from "./mutation-policy";
import { useWorkspaceController, type WorkspaceController, type WorkspaceControllerOptions } from "./useWorkspaceController";

export type WorkspaceOrganizerProps = WorkspaceControllerOptions & {
  accountControls?: ReactNode;
  currentTabs?: ReactNode;
  headerActions?: ReactNode;
  mainContentBefore?: ReactNode;
  railBeforeSpaces?: ReactNode;
  status?: OrganizerStatus;
  share?: CollectionListProps["share"];
  externalDrop?: CollectionListProps["externalDrop"];
  onBookmarkDrop?: CollectionListProps["onBookmarkDrop"];
  resolveFavicon?: OrganizerFaviconResolver;
  savedLinkNewTab?: boolean;
  highlightedLinkId?: string;
  trashInAccount?: boolean;
};

export function WorkspaceOrganizer(props: WorkspaceOrganizerProps) {
  const controller = useWorkspaceController(props);
  return <WorkspaceOrganizerView {...props} controller={controller} />;
}

/** Compositions that also coordinate platform sync may retain and supply the controller. */
export function WorkspaceOrganizerView({ controller: c, accountControls, currentTabs, headerActions, railBeforeSpaces, status, ...props }: WorkspaceOrganizerProps & { controller: WorkspaceController }) {
  if (!c.ready) return <>
    <WorkspaceShell ready={false} rail={null}>{null}</WorkspaceShell>
    {c.bootError && <p role="alert">Workspace could not be loaded. Please reload and try again.</p>}
  </>;
  const active = c.activeSpace;
  return <div data-testid="shared-workspace-organizer">
    <WorkspaceShell rail={<SpaceRail spaces={[...c.snapshot.spaces].sort((a, b) => a.position - b.position)} activeSpaceId={c.selectedSpaceId} collapsed={c.railCollapsed} onCollapsedChange={c.setRailCollapsed} onSelect={c.selectSpace} isPending={(space) => c.isPending(space.id)}
      brand={<TabloomMark />} beforeSpaces={railBeforeSpaces}
      actions={<button aria-label="New space" onClick={() => c.openDialog({ type: "create-space" })}><Plus size={16} /></button>}
      spaceActions={(space) => isWritable(space) && !c.isPending(space.id) ? <div className="space-row-actions">
        <button aria-label={`Edit ${space.name}`} onClick={() => c.openDialog({ type: "edit-space", space })}><Pencil size={14} /></button>
        {props.trashRepository && <button aria-label={`Delete ${space.name}`} onClick={() => { void c.requestDelete("space", space.id); }}><Trash2 size={14} /></button>}
      </div> : null}
    />} sidePanel={currentTabs} header={<WorkspaceHeader title={active?.name ?? "Your workspace"} status={status} onOpenTrash={props.trashRepository && !props.trashInAccount ? () => c.setTrashOpen(true) : undefined} actions={<>
      {active && isWritable(active) && !c.isPending(active.id) && <button className="organizer-new-collection" onClick={() => c.openDialog({ type: "create-collection", spaceId: active.id })}><Plus size={15} />New collection</button>}
      <GlobalSearch snapshot={c.snapshot} capabilities={props.capabilities} open={c.searchOpen} onOpenChange={c.setSearchOpen} savedLinkNewTab={props.savedLinkNewTab} resolveFavicon={props.resolveFavicon} onError={(message) => c.notify(message, "error")} />
      {headerActions}{accountControls}
    </>} />}>
      {props.mainContentBefore}
      <ControllerCollections {...props} controller={c} />
      {!active && <p>Create a space to start organizing your links.</p>}
    </WorkspaceShell>
    <WorkspaceDialogs dialog={c.dialog} onClose={c.closeDialog} onSubmit={(command) => { void c.submitDialog(command); }} busy={c.busy} />
    {props.trashRepository && <TrashDialog repository={props.trashRepository} snapshot={c.snapshot} open={c.trashOpen} onClose={() => c.setTrashOpen(false)} onRestored={(snapshot, entry, destinationId, pendingSync) => {
      const restored = structuredClone(entry.snapshot);
      if (destinationId && entry.rootType === "collection") restored.collections[0].space_id = destinationId;
      if (destinationId && entry.rootType === "link") restored.links[0].collection_id = destinationId;
      c.acceptTrashRestoration(snapshot, restored, pendingSync);
    }} />}
    <ToastRegion toasts={c.toasts} onDismiss={c.dismissToast} />
  </div>;
}

function ControllerCard({ capabilities, resolveFavicon, link, ...props }: React.ComponentProps<typeof SavedLinkCard> & Pick<WorkspaceOrganizerProps, "capabilities" | "resolveFavicon">) {
  const [favicon, setFavicon] = useState<{ url: string; captured: string | null; src: string | null }>();
  useEffect(() => {
    if (resolveFavicon) return;
    let active = true;
    void capabilities.resolveFavicon(link.url, link.favicon_url).then((src) => { if (active) setFavicon({ url: link.url, captured: link.favicon_url, src }); }, () => undefined);
    return () => { active = false; };
  }, [capabilities, link.url, link.favicon_url, resolveFavicon]);
  const src = resolveFavicon ? resolveFavicon({ pageUrl: link.url, capturedUrl: link.favicon_url, size: 32 }) : favicon?.url === link.url && favicon.captured === link.favicon_url ? favicon.src : link.favicon_url;
  return <SavedLinkCard {...props} link={link} favicon={src} />;
}

function ControllerCollections({ controller: c, capabilities, resolveFavicon, share, externalDrop, onBookmarkDrop, trashRepository, highlightedLinkId }: WorkspaceOrganizerProps & { controller: WorkspaceController }) {
  const [sharingCollection, setSharingCollection] = useState<Collection | null>(null);
  const collections = c.snapshot.collections.filter((item) => item.space_id === c.selectedSpaceId).sort((a, b) => a.position - b.position);
  const drag = c.drag;
  const displayed = drag?.kind === "collection" ? previewCollectionDrop(collections, drag.id, drag.overIndex) : collections;
  const links = drag?.kind === "saved-link" ? previewLinkTransfer(c.snapshot.links, drag.id, drag.targetCollectionId, drag.overIndex) : c.snapshot.links;
  const canWrite = (collection: Collection) => !c.isPending(collection.id) && isWritable(collection) && isWritable(c.snapshot.spaces.find((space) => space.id === collection.space_id));
  function clearDrag() { c.setDrag(null); c.setExternalDropTarget(null); }
  function accept(event: DragEvent, collection: Collection) {
    if (!canWrite(collection)) return false;
    if (!drag && externalDrop?.isDrag(event) && externalDrop.accept(event, collection)) { clearDrag(); return true; }
    return false;
  }
  function previewLink(event: DragEvent, collection: Collection, targetId?: string) {
    if (!canWrite(collection)) return;
    event.preventDefault(); event.stopPropagation();
    if (!drag && externalDrop?.isDrag(event)) { c.setExternalDropTarget({ collectionId: collection.id, session: externalDrop.session }); return; }
    const remaining = c.snapshot.links.filter((link) => link.collection_id === collection.id && (drag?.kind !== "saved-link" || link.id !== drag.id)).sort((a, b) => a.position - b.position);
    const index = targetId ? remaining.findIndex((link) => link.id === targetId) : remaining.length;
    if (index < 0) return;
    if (drag?.kind === "saved-link") c.setDrag({ ...drag, targetCollectionId: collection.id, overIndex: index });
    if (drag?.kind === "browser-bookmark") c.setDrag({ ...drag, targetCollectionId: collection.id, overIndex: index });
  }
  async function drop(event: DragEvent, collection: Collection, directRow = false) {
    event.preventDefault(); event.stopPropagation();
    if (accept(event, collection)) return;
    if (!canWrite(collection)) return clearDrag();
    if (drag?.kind === "browser-bookmark" && onBookmarkDrop) {
      clearDrag();
      try { await onBookmarkDrop(drag.link, collection.id); await c.reload(); } catch { c.notify("Bookmark could not be copied.", "error"); }
    } else if (directRow && drag?.kind === "collection" && drag.id !== collection.id) {
      const remaining = collections.filter((item) => item.id !== drag.id);
      const bounds = event.currentTarget.getBoundingClientRect();
      clearDrag();
      await c.moveCollection(drag.id, remaining.findIndex((item) => item.id === collection.id) + (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0));
    } else await c.commitDrag();
  }
  function linkSlot(collection: Collection, index: number) {
    return <div aria-label={`Insert link at position ${index + 1} in ${collection.name}`} className="ext-link-drop-preview" onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={(event) => { void drop(event, collection); }}><span>Drop link here</span></div>;
  }
  return <>
    <CollectionLayout className={`ext-columns ${drag?.kind === "collection" ? "collection-reordering" : drag ? "link-dragging" : ""}`}>
      {drag?.kind === "browser-bookmark" && onBookmarkDrop && <aside className="bookmark-copy-tray" aria-label="Saved collection drop targets"><p>Copy to a saved collection</p><div>
        {c.snapshot.collections.filter(canWrite).map((collection) => <div key={collection.id} role="group" aria-label={`${collection.name} copy target`} className={drag.targetCollectionId === collection.id ? "bookmark-drop-target" : undefined} onDragOver={(event) => previewLink(event, collection)} onDrop={(event) => { void drop(event, collection); }}>{collection.name}</div>)}
      </div></aside>}
      {displayed.map((collection) => {
        const writable = canWrite(collection);
        const canonicalIndex = collections.findIndex((item) => item.id === collection.id);
        const collectionLinks = links.filter((item) => item.collection_id === collection.id).sort((a, b) => a.position - b.position);
        const canonicalLinks = c.snapshot.links.filter((item) => item.collection_id === collection.id).sort((a, b) => a.position - b.position);
        const collapsed = c.collapsedCollections.has(collection.id);
        const source = drag?.kind === "collection" && drag.id === collection.id;
        const preview = drag?.kind === "saved-link" && drag.targetCollectionId === collection.id;
        const externalTarget = c.externalDropTarget?.collectionId === collection.id && c.externalDropTarget.session === externalDrop?.session;
        return <Fragment key={collection.id}>
          {source && <div className="collection-drop-preview" onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={(event) => { void drop(event, collection); }}><span>Drop collection here</span></div>}
          <CollectionSection collection={collection} links={canonicalLinks} writable={writable} collapsed={collapsed} onOpenCollection={c.openCollection}
            className={`${collapsed ? "is-collapsed" : ""} ${source ? "collection-dragging" : ""} ${preview || externalTarget ? "drop-target" : ""}`} draggable={false}
            onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }} onDragEnd={clearDrag}
            onDragOver={(event) => {
              if (!writable) return;
              if (drag?.kind === "collection") {
                event.preventDefault(); event.stopPropagation();
                if (drag.id === collection.id) return;
                const remaining = collections.filter((item) => item.id !== drag.id);
                const bounds = event.currentTarget.getBoundingClientRect();
                c.setDrag({ ...drag, overIndex: remaining.findIndex((item) => item.id === collection.id) + (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0) });
              } else previewLink(event, collection);
            }} onDrop={(event) => { void drop(event, collection, true); }}
            header={<div className="ext-col-head"><div className="collection-title-group">
              {writable && <button aria-label={`Drag ${collection.name} collection`} className="collection-drag-handle" draggable onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; c.setDrag({ kind: "collection", id: collection.id, overIndex: canonicalIndex }); }} onDragEnd={clearDrag}><GripVertical size={14} /></button>}
              <button aria-label={`${collapsed ? "Expand" : "Collapse"} ${collection.name}`} aria-controls={`collection-body-${collection.id}`} aria-expanded={!collapsed} disabled={c.isPending(collection.id)} className="collection-collapse-toggle" onClick={() => c.toggleCollection(collection.id)}><ChevronRight size={17} /></button>
              {writable ? <button aria-label={`Rename ${collection.name}`} className="collection-name-edit" onClick={() => c.openDialog({ type: "edit-collection", collection })}><b>{collection.name}</b><Pencil size={13} /></button> : <b>{collection.name}</b>}
            </div><div className="ext-col-meta">
              {writable && <>
                <div className="collection-reorder-actions"><button aria-label={`Move ${collection.name} up`} disabled={canonicalIndex === 0 || !canWrite(collections[canonicalIndex - 1])} onClick={() => { void c.moveCollection(collection.id, canonicalIndex - 1); }}><ArrowUp size={14} /></button><button aria-label={`Move ${collection.name} down`} disabled={canonicalIndex === collections.length - 1 || !canWrite(collections[canonicalIndex + 1])} onClick={() => { void c.moveCollection(collection.id, canonicalIndex + 1); }}><ArrowDown size={14} /></button></div>
                {share && <button aria-label={`Share ${collection.name}`} className="collection-share" onClick={() => setSharingCollection(collection)}><Share2 size={15} /></button>}
                <button aria-label={`Add link to ${collection.name}`} onClick={() => c.openDialog({ type: "create-link", collectionId: collection.id })}><Plus size={15} /></button>
              </>}
              <span>{canonicalLinks.length} links</span>
              {writable && trashRepository && <button aria-label={`Delete ${collection.name}`} className="collection-delete" onClick={() => { void c.requestDelete("collection", collection.id); }}><Trash2 size={15} /></button>}
            </div></div>}>
            {collectionLinks.map((link, index) => {
              const sourceLink = drag?.kind === "saved-link" && drag.id === link.id;
              const canonicalIndex = canonicalLinks.findIndex((item) => item.id === link.id);
              return <Fragment key={link.id}>
                {preview && sourceLink && linkSlot(collection, index)}
                <ControllerCard capabilities={capabilities} resolveFavicon={resolveFavicon} link={link} highlighted={link.id === highlightedLinkId} writable={writable && !c.isPending(link.id)} dragging={sourceLink} previewSource={sourceLink && preview} copyable={link.origin === "browser-bookmark" && !!onBookmarkDrop}
                  moveDestinations={c.snapshot.collections.filter(canWrite)}
                  actions={{ onEdit: () => c.openDialog({ type: "edit-link", link }), onDelete: trashRepository ? () => { void c.deleteLink(link.id); } : undefined,
                    onMoveEarlier: canonicalIndex > 0 ? () => { void c.moveLink(link.id, collection.id, canonicalIndex - 1); } : undefined,
                    onMoveLater: canonicalIndex < canonicalLinks.length - 1 ? () => { void c.moveLink(link.id, collection.id, canonicalIndex + 1); } : undefined,
                    onMoveToCollection: (collectionId) => { void c.moveLink(link.id, collectionId, c.snapshot.links.filter((item) => item.collection_id === collectionId).length); },
                  }} onDragStart={(event) => {
                    event.stopPropagation(); event.dataTransfer.effectAllowed = link.origin === "browser-bookmark" ? "copy" : "move";
                    c.setDrag(link.origin === "browser-bookmark" ? { kind: "browser-bookmark", link } : { kind: "saved-link", id: link.id, sourceCollectionId: collection.id, targetCollectionId: collection.id, overIndex: canonicalIndex });
                  }} onDragEnd={clearDrag} onDragOver={(event) => previewLink(event, collection, link.id)} onDrop={(event) => { void drop(event, collection); }} />
              </Fragment>;
            })}
            {!collectionLinks.length && drag?.kind === "saved-link" && drag.targetCollectionId === collection.id && linkSlot(collection, 0)}
          </CollectionSection>
        </Fragment>;
      })}
    </CollectionLayout>
    {sharingCollection && share && <CollectionShareDialog {...share} collection={sharingCollection} onClose={() => setSharingCollection(null)} />}
  </>;
}
