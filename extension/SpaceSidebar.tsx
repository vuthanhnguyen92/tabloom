import { Check, ChevronLeft, PanelLeftOpen, Pencil, Plus, Trash2, X } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import type { Space, WorkspaceSnapshot } from "../shared/domain";
import type { WorkspaceRepository } from "../shared/repository";

type EditorState = { mode: "create"; name: string; color: string } | { mode: "edit"; space: Space; name: string; color: string };

export type SpaceSidebarProps = {
  activeSpaceId: string;
  brand?: ReactNode;
  onError: (message: string) => void;
  onMessage?: (message: string) => void;
  onReload: () => Promise<void>;
  onSelect: (spaceId: string) => void;
  repository: WorkspaceRepository | null;
  snapshot: WorkspaceSnapshot;
};

export function SpaceSidebar({ activeSpaceId, brand, onError, onMessage, onReload, onSelect, repository, snapshot }: SpaceSidebarProps) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Space | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const savedSpaces = snapshot.spaces.filter((space) => space.origin === "saved" && !space.read_only);
  const canDeleteSavedSpace = savedSpaces.length > 1;

  function beginCreate() {
    setCollapsed(false);
    setEditor({ mode: "create", name: "", color: "#f56f72" });
  }

  function beginEdit(space: Space) {
    if (space.read_only || space.origin !== "saved") return;
    setEditor({ mode: "edit", space, name: space.name, color: space.color });
  }

  function toggleCollapsed() {
    if (!collapsed) setEditor(null);
    setCollapsed((current) => !current);
  }

  async function saveSpace(event: FormEvent) {
    event.preventDefault();
    if (!repository || !editor || busy) return;
    const name = editor.name.trim();
    if (!name) return onError("Space name is required.");
    setBusy(true);
    try {
      if (editor.mode === "create") {
        const created = await repository.createSpace({ name, color: editor.color });
        onSelect(created.id);
        onMessage?.(`${name} created`);
      } else {
        await repository.updateSpace(editor.space.id, { name, color: editor.color });
        onMessage?.(`${name} updated`);
      }
      setEditor(null);
      await onReload();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not save this space.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSpace() {
    if (!repository || !pendingDelete || !canDeleteSavedSpace || busy) return;
    const deleted = pendingDelete;
    const nextSpace = savedSpaces.find((space) => space.id !== deleted.id);
    setBusy(true);
    try {
      await repository.deleteSpace(deleted.id);
      if (activeSpaceId === deleted.id && nextSpace) onSelect(nextSpace.id);
      setPendingDelete(null);
      setEditor(null);
      onMessage?.(`${deleted.name} deleted`);
      await onReload();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not delete this space.");
    } finally {
      setBusy(false);
    }
  }

  const deleteCollectionIds = new Set(snapshot.collections.filter((collection) => collection.space_id === pendingDelete?.id).map((collection) => collection.id));
  const deleteCollectionCount = deleteCollectionIds.size;
  const deleteLinkCount = snapshot.links.filter((link) => deleteCollectionIds.has(link.collection_id)).length;

  function editorForm(label: string) {
    if (!editor) return null;
    return <form aria-label={label} className="space-inline-form" onSubmit={(event) => void saveSpace(event)}>
      <label>Space name<input aria-label="Space name" maxLength={80} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
      <label className="space-color">Color<input aria-label="Space color" type="color" value={editor.color} onChange={(event) => setEditor({ ...editor, color: event.target.value })} /></label>
      <div>
        <button aria-label="Cancel space editing" disabled={busy} type="button" onClick={() => setEditor(null)}><X size={15} /></button>
        <button aria-label={editor.mode === "create" ? "Create space" : "Save changes"} className="space-save" disabled={busy || !editor.name.trim()} type="submit"><Check size={15} /></button>
        {editor.mode === "edit" && <button aria-label="Delete space" className="space-delete" disabled={busy || !canDeleteSavedSpace} title={canDeleteSavedSpace ? "Delete space" : "Keep at least one saved space"} type="button" onClick={() => setPendingDelete(editor.space)}><Trash2 size={15} /></button>}
      </div>
    </form>;
  }

  return <aside aria-label="Spaces" className={`ext-sidebar ${collapsed ? "collapsed" : "expanded"}`}>
    <div className="sidebar-top">{!collapsed && brand}<button aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} className="sidebar-toggle" onClick={toggleCollapsed}>{collapsed ? <PanelLeftOpen size={18} /> : <ChevronLeft size={17} />}</button></div>
    <div className="space-sidebar-heading">{!collapsed && <span>MY SPACES</span>}<button aria-label="Add space" disabled={!repository || busy} onClick={beginCreate}><Plus size={15} /></button></div>
    {editor?.mode === "create" && editorForm("Create space")}
    <div className="space-list">{snapshot.spaces.map((space) => editor?.mode === "edit" && editor.space.id === space.id
      ? <div className="space-editor-row" key={space.id}>{editorForm(`Edit ${space.name}`)}</div>
      : <div className={`space-row ${space.id === activeSpaceId ? "active" : ""}`} key={space.id}>
        <button aria-label={`Select ${space.name}`} className="space-select" title={space.name} onClick={() => onSelect(space.id)}><i style={{ background: space.color }}>{space.name.trim().charAt(0).toUpperCase() || "•"}</i>{!collapsed && <span>{space.name}</span>}</button>
        {!collapsed && !space.read_only && space.origin === "saved" && <button aria-label={`Edit ${space.name}`} className="space-edit" onClick={() => beginEdit(space)}><Pencil size={13} /></button>}
      </div>)}</div>
    {pendingDelete && <div className="drop-confirm-backdrop"><section aria-label={`Delete ${pendingDelete.name}`} aria-modal="true" className="drop-confirm" role="dialog">
      <button aria-label="Cancel deleting space" className="dialog-close" disabled={busy} onClick={() => setPendingDelete(null)}><X size={18} /></button>
      <small>DELETE SPACE</small><h2>Delete “{pendingDelete.name}”?</h2>
      <p>This permanently deletes {deleteCollectionCount} collection{deleteCollectionCount === 1 ? "" : "s"} and {deleteLinkCount} saved link{deleteLinkCount === 1 ? "" : "s"}. Open browser tabs will not be closed.</p>
      <div><button disabled={busy} onClick={() => setPendingDelete(null)}>Cancel</button><button className="close-after-save" disabled={busy} onClick={() => void deleteSpace()}>Delete space permanently</button></div>
    </section></div>}
  </aside>;
}
