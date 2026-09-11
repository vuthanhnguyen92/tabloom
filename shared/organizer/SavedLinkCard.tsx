import { ArrowDown, ArrowUp, GripVertical, Pencil, Trash2 } from "lucide-react";
import type { DragEventHandler } from "react";
import { hostnameFor, type SavedLink } from "../domain";
import { FaviconTile } from "./FaviconTile";

export type OrganizerFaviconResolver = (input: { pageUrl: string; capturedUrl?: string | null; size?: number }) => string | null;
export type SavedLinkActions = {
  onEdit?(): void;
  onDelete?(): void;
  onMoveEarlier?(): void;
  onMoveLater?(): void;
};
export type SavedLinkCardProps = {
  link: SavedLink;
  writable: boolean;
  favicon?: string | null;
  actions?: SavedLinkActions;
  dragging?: boolean;
  previewSource?: boolean;
  removing?: boolean;
  highlighted?: boolean;
  copyable?: boolean;
  onDragStart?: DragEventHandler<HTMLElement>;
  onDragEnd?: DragEventHandler<HTMLElement>;
  onDragOver?: DragEventHandler<HTMLElement>;
  onDrop?: DragEventHandler<HTMLElement>;
};

export function SavedLinkCard({ link, writable, favicon, actions = {}, dragging, previewSource, removing, highlighted, copyable, onDragStart, onDragEnd, onDragOver, onDrop }: SavedLinkCardProps) {
  const canWrite = writable && link.origin === "saved" && !link.read_only && !removing;
  const canDrag = Boolean(onDragStart && !removing && (canWrite || copyable));
  const subtitle = link.description || hostnameFor(link.url);
  const start: DragEventHandler<HTMLElement> = (event) => {
    event.stopPropagation();
    if (!canDrag) { event.preventDefault(); return; }
    onDragStart?.(event);
  };
  return <div data-organizer-layout-id={`link:${link.id}`} aria-busy={removing || undefined} aria-hidden={previewSource || undefined} className={`ext-link-card classic-link-card${removing ? " is-removing" : ""}${previewSource ? " drag-preview-source" : ""}`}>
    <a aria-label={`${link.title} · ${subtitle}`} className={[dragging ? "dragging" : "", highlighted ? "duplicate-highlight" : ""].filter(Boolean).join(" ") || undefined}
      href={link.url} draggable={canDrag} onDragStart={start} onDragEnd={onDragEnd} onDragOver={onDragOver} onDrop={onDrop}>
      <FaviconTile src={favicon} title={link.title} />
      <span><b>{link.title}</b><small>{subtitle}</small>{link.device_label && <small className="bookmark-device-label">{link.device_label}</small>}</span>
    </a>
    {canDrag && <button aria-label={`Drag ${link.title}`} className={`card-drag-indicator${dragging ? " dragging" : ""}`} draggable onDragStart={start} onDragEnd={onDragEnd} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}><GripVertical aria-hidden="true" size={14} /></button>}
    {canWrite && <div className="classic-card-actions">
      {actions.onEdit && <button aria-label={`Edit ${link.title}`} className="saved-link-action saved-link-edit" draggable={false} onClick={(event) => { event.preventDefault(); event.stopPropagation(); actions.onEdit?.(); }}><Pencil aria-hidden="true" size={14} /></button>}
      {actions.onDelete && <button aria-label={`Delete ${link.title}`} className="saved-link-action saved-link-delete" draggable={false} onClick={(event) => { event.preventDefault(); event.stopPropagation(); actions.onDelete?.(); }}><Trash2 aria-hidden="true" size={14} /></button>}
      {(actions.onMoveEarlier || actions.onMoveLater) && <div className="saved-link-move-actions">
        <button aria-label={`Move ${link.title} earlier`} disabled={!actions.onMoveEarlier} draggable={false} onClick={(event) => { event.stopPropagation(); actions.onMoveEarlier?.(); }}><ArrowUp aria-hidden="true" size={12} /></button>
        <button aria-label={`Move ${link.title} later`} disabled={!actions.onMoveLater} draggable={false} onClick={(event) => { event.stopPropagation(); actions.onMoveLater?.(); }}><ArrowDown aria-hidden="true" size={12} /></button>
      </div>}
    </div>}
  </div>;
}
