import { ChevronRight, Pencil, Plus, Share2, Trash2 } from "lucide-react";
import { Fragment, useEffect, useState, type DragEvent } from "react";
import { CollectionShareDialog } from "../CollectionShareDialog";
import type { Collection } from "../domain";
import { CollectionLayout } from "./CollectionList";
import { CollectionSection } from "./CollectionSection";
import { SavedLinkCard } from "./SavedLinkCard";
import { previewLinkTransfer } from "./drag-model";
import { isWritable } from "./mutation-policy";
import type { WorkspaceController } from "./useWorkspaceController";
import type { WorkspaceOrganizerProps } from "./WorkspaceOrganizer";

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

export function ControllerCollections({ controller: c, capabilities, resolveFavicon, share, externalDrop, onBookmarkDrop, trashRepository, highlightedLinkId }: WorkspaceOrganizerProps & { controller: WorkspaceController }) {
  const [sharingCollection, setSharingCollection] = useState<Collection | null>(null);
  const collections = c.snapshot.collections.filter((item) => item.space_id === c.selectedSpaceId).sort((a, b) => a.position - b.position);
  const drag = c.drag;
  const hasLinkTarget = drag?.kind === "saved-link" && drag.targetCollectionId !== undefined && drag.overIndex !== undefined;
  const links = drag?.kind === "saved-link" && drag.targetCollectionId !== undefined && drag.overIndex !== undefined
    ? previewLinkTransfer(c.snapshot.links, drag.id, drag.targetCollectionId, drag.overIndex)
    : c.snapshot.links;
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
  async function drop(event: DragEvent, collection: Collection) {
    event.preventDefault(); event.stopPropagation();
    if (accept(event, collection)) return;
    if (!canWrite(collection)) return clearDrag();
    if (drag?.kind === "browser-bookmark" && onBookmarkDrop) {
      clearDrag();
      try { await onBookmarkDrop(drag.link, collection.id); await c.reload(); } catch { c.notify("Bookmark could not be copied.", "error"); }
    } else await c.commitDrag();
  }
  function linkSlot(collection: Collection, index: number) {
    return <div aria-label={`Insert link at position ${index + 1} in ${collection.name}`} className="ext-link-drop-preview" onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={(event) => { void drop(event, collection); }}><span>Drop link here</span></div>;
  }
  return <>
    <CollectionLayout className={`ext-columns ${drag ? "link-dragging" : ""}`}>
      {drag?.kind === "browser-bookmark" && onBookmarkDrop && <aside className="bookmark-copy-tray" aria-label="Saved collection drop targets"><p>Copy to a saved collection</p><div>
        {c.snapshot.collections.filter(canWrite).map((collection) => <div key={collection.id} role="group" aria-label={`${collection.name} copy target`} className={drag.targetCollectionId === collection.id ? "bookmark-drop-target" : undefined} onDragOver={(event) => previewLink(event, collection)} onDrop={(event) => { void drop(event, collection); }}>{collection.name}</div>)}
      </div></aside>}
      {collections.map((collection) => {
        const writable = canWrite(collection);
        const collectionLinks = links.filter((item) => item.collection_id === collection.id).sort((a, b) => a.position - b.position);
        const canonicalLinks = c.snapshot.links.filter((item) => item.collection_id === collection.id).sort((a, b) => a.position - b.position);
        const collapsed = c.collapsedCollections.has(collection.id);
        const preview = hasLinkTarget && drag.targetCollectionId === collection.id;
        const externalTarget = c.externalDropTarget?.collectionId === collection.id && c.externalDropTarget.session === externalDrop?.session;
        return <Fragment key={collection.id}>
          <CollectionSection collection={collection} links={canonicalLinks} writable={writable} collapsed={collapsed} onOpenCollection={c.openCollection}
            className={`${collapsed ? "is-collapsed" : ""} ${preview || externalTarget ? "drop-target" : ""}`} draggable={false}
            onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }} onDragEnd={clearDrag}
            onDragOver={(event) => {
              if (!writable) return;
              previewLink(event, collection);
            }} onDrop={(event) => { void drop(event, collection); }}
            header={<div className="ext-col-head classic-collection-header"><div className="collection-title-group">
              <button aria-label={`${collapsed ? "Expand" : "Collapse"} ${collection.name}`} aria-controls={`collection-body-${collection.id}`} aria-expanded={!collapsed} disabled={c.isPending(collection.id)} className="collection-collapse-toggle" onClick={() => c.toggleCollection(collection.id)}><ChevronRight size={17} /></button>
              {writable ? <button aria-label={`Rename ${collection.name}`} className="collection-name-edit" onClick={() => c.openDialog({ type: "edit-collection", collection })}><b>{collection.name}</b><Pencil size={13} /></button> : <b>{collection.name}</b>}
            </div><div className="ext-col-meta">
              {writable && <>
                {share && <button aria-label={`Share ${collection.name}`} className="collection-share" onClick={() => setSharingCollection(collection)}><Share2 size={15} /></button>}
                <button aria-label={`Add link to ${collection.name}`} onClick={() => c.openDialog({ type: "create-link", collectionId: collection.id })}><Plus size={15} /></button>
              </>}
              <span>{canonicalLinks.length} links</span>
              {writable && trashRepository && <button aria-label={`Delete ${collection.name}`} className="collection-delete" onClick={() => { void c.requestDelete("collection", collection.id); }}><Trash2 size={15} /></button>}
            </div></div>}>
            {collectionLinks.map((link, index) => {
              const sourceLink = drag?.kind === "saved-link" && drag.id === link.id;
              return <Fragment key={link.id}>
                {preview && sourceLink && linkSlot(collection, index)}
                <ControllerCard capabilities={capabilities} resolveFavicon={resolveFavicon} link={link} highlighted={link.id === highlightedLinkId} writable={writable && !c.isPending(link.id)} dragging={sourceLink} previewSource={sourceLink && preview} copyable={link.origin === "browser-bookmark" && !!onBookmarkDrop}
                  actions={{ onEdit: () => c.openDialog({ type: "edit-link", link }), onDelete: trashRepository ? () => { void c.deleteLink(link.id); } : undefined }} onDragStart={(event) => {
                    event.stopPropagation(); event.dataTransfer.effectAllowed = link.origin === "browser-bookmark" ? "copy" : "move";
                    c.setDrag(link.origin === "browser-bookmark" ? { kind: "browser-bookmark", link } : { kind: "saved-link", id: link.id, sourceCollectionId: collection.id });
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
