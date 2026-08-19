"use client";

import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  GripVertical,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Brand } from "../components/Brand";
import { filterWorkspace, hostnameFor, isSaveableUrl, type SavedLink, type WorkspaceSnapshot } from "../../shared/domain";
import type { WorkspaceRepository } from "../../shared/repository";

type DialogState =
  | { type: "space" }
  | { type: "edit-space"; spaceId: string }
  | { type: "delete-space"; spaceId: string }
  | { type: "collection" }
  | { type: "edit-collection"; collectionId: string }
  | { type: "link"; collectionId: string; link?: SavedLink }
  | { type: "delete-collection"; collectionId: string }
  | { type: "open-many"; links: SavedLink[] }
  | null;

export function WorkspaceClient({ repository, mode, onSignOut, initialSnapshot }: { repository: WorkspaceRepository; mode: "demo" | "synced"; onSignOut?: () => void; initialSnapshot?: WorkspaceSnapshot }) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(initialSnapshot ?? { spaces: [], collections: [], links: [] });
  const [selectedSpaceId, setSelectedSpaceId] = useState(initialSnapshot?.spaces[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!initialSnapshot);
  const [draggedLinkId, setDraggedLinkId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await repository.load();
      setSnapshot(next);
      setSelectedSpaceId((current) => current || next.spaces[0]?.id || "");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load your workspace.");
    } finally { setLoading(false); }
  }, [repository]);

  // The repository is external state; load its current snapshot on adapter changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void reload(); }, [reload]);
  const visible = useMemo(() => filterWorkspace(snapshot, query), [snapshot, query]);
  const selectedSpace = snapshot.spaces.find((space) => space.id === selectedSpaceId) ?? snapshot.spaces[0];
  const collections = visible.collections.filter((collection) => query || collection.space_id === selectedSpace?.id);

  async function mutate(operation: () => Promise<unknown>) {
    try { await operation(); setDialog(null); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "That change could not be saved."); }
  }

  async function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (dialog?.type === "space" || dialog?.type === "edit-space") {
      const name = String(data.get("name") || "").trim();
      if (!name) return setError("Space name is required.");
      const input = { name, color: String(data.get("color") || "#f56f72") };
      return mutate(() => dialog.type === "edit-space" ? repository.updateSpace(dialog.spaceId, input) : repository.createSpace(input));
    }
    if (dialog?.type === "collection" || dialog?.type === "edit-collection") {
      const name = String(data.get("name") || "").trim();
      if (!name || !selectedSpace) return setError("Collection name is required.");
      return mutate(() => dialog.type === "edit-collection" ? repository.updateCollection(dialog.collectionId, { name }) : repository.createCollection({ name, space_id: selectedSpace.id }));
    }
    if (dialog?.type === "link") {
      const title = String(data.get("title") || "").trim();
      const url = String(data.get("url") || "").trim();
      const description = String(data.get("description") || "").trim();
      if (!title) return setError("Link title is required.");
      if (!isSaveableUrl(url)) return setError("Enter an http or https URL.");
      const input = { collection_id: dialog.collectionId, title, url, description, favicon_url: dialog.link?.favicon_url ?? null };
      return mutate(() => dialog.link ? repository.updateLink(dialog.link!.id, input) : repository.createLink(input));
    }
  }

  async function moveCollection(collectionId: string, delta: number) {
    if (!selectedSpace) return;
    const items = snapshot.collections.filter((item) => item.space_id === selectedSpace.id).sort((a, b) => a.position - b.position);
    const index = items.findIndex((item) => item.id === collectionId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= items.length) return;
    [items[index], items[target]] = [items[target], items[index]];
    await mutate(() => repository.reorderCollections(selectedSpace.id, items.map((item) => item.id)));
  }

  async function dropLink(collectionId: string) {
    if (!draggedLinkId) return;
    const orderedIds = snapshot.links.filter((item) => item.collection_id === collectionId && item.id !== draggedLinkId).sort((a, b) => a.position - b.position).map((item) => item.id);
    orderedIds.push(draggedLinkId);
    setDraggedLinkId(null);
    await mutate(() => repository.reorderLinks(collectionId, orderedIds));
  }

  async function moveLink(link: SavedLink, delta: number) {
    if (!selectedSpace) return;
    const orderedCollections = snapshot.collections.filter((item) => item.space_id === selectedSpace.id).sort((a, b) => a.position - b.position);
    const currentIndex = orderedCollections.findIndex((item) => item.id === link.collection_id);
    const target = orderedCollections[currentIndex + delta];
    if (!target) return;
    const orderedIds = snapshot.links.filter((item) => item.collection_id === target.id).sort((a, b) => a.position - b.position).map((item) => item.id);
    orderedIds.push(link.id);
    await mutate(() => repository.reorderLinks(target.id, orderedIds));
  }

  function openLinks(links: SavedLink[]) {
    links.forEach((link) => window.open(link.url, "_blank", "noopener,noreferrer"));
    setDialog(null);
  }

  if (loading) return <main className="workspace-loading" aria-live="polite"><Brand /><span>Growing your workspace…</span></main>;

  return (
    <main className="workspace-shell">
      <aside className="workspace-sidebar">
        <Link href="/"><Brand /></Link>
        <span className="sidebar-label">MY SPACES</span>
        {snapshot.spaces.map((space) => <button key={space.id} className={`space-button ${space.id === selectedSpace?.id ? "active" : ""}`} onClick={() => { setSelectedSpaceId(space.id); setQuery(""); }}><i style={{ background: space.color }} />{space.name}</button>)}
        <button className="add-space" onClick={() => setDialog({ type: "space" })}><Plus size={15} /> New space</button>
        <div className="sidebar-foot"><span className={`sync-dot ${mode}`} />{mode === "synced" ? "Synced" : "Demo workspace"}{onSignOut && <button aria-label="Sign out" onClick={onSignOut}><LogOut size={15} /></button>}</div>
      </aside>
      <section className="workspace-main">
        <header className="workspace-header">
          <div><span className="eyebrow">{mode === "synced" ? "PERSONAL WORKSPACE" : "DEMO WORKSPACE"}</span><h1>Your workspace</h1></div>
          <label className="workspace-search"><Search size={18} /><span className="sr-only">Search your links</span><input aria-label="Search your links" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your links" /><kbd>⌘ K</kbd></label>
          <Link className="button button-quiet" href="/">Home</Link>
        </header>
        {error && <div className="notice error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")}><X size={16} /></button></div>}
        {selectedSpace ? <>
          <div className="workspace-intro"><div><span>✦</span><h2>{query ? `Results for “${query}”` : selectedSpace.name}</h2><p>{query ? `${visible.links.length} matching links across your workspace.` : "A clear place for the work that moves this project forward."}</p></div>{!query && <div className="collection-actions"><button aria-label={`Rename ${selectedSpace.name} space`} onClick={() => setDialog({ type: "edit-space", spaceId: selectedSpace.id })}><Pencil size={15} /></button><button aria-label={`Delete ${selectedSpace.name} space`} onClick={() => setDialog({ type: "delete-space", spaceId: selectedSpace.id })}><Trash2 size={15} /></button><button onClick={() => setDialog({ type: "collection" })}><Plus size={15} /> New collection</button></div>}</div>
          {collections.length ? <div className="workspace-columns">
            {collections.map((collection, collectionIndex) => {
              const links = visible.links.filter((link) => link.collection_id === collection.id).sort((a, b) => a.position - b.position);
              return <article className="collection" key={collection.id} onDragOver={(event) => event.preventDefault()} onDrop={() => void dropLink(collection.id)}>
                <header><div><h3>{collection.name}</h3><span>{links.length} links</span></div><div className="collection-actions"><button aria-label={`Rename ${collection.name} collection`} onClick={() => setDialog({ type: "edit-collection", collectionId: collection.id })}><Pencil size={14} /></button><button aria-label={`Move ${collection.name} left`} disabled={collectionIndex === 0} onClick={() => void moveCollection(collection.id, -1)}><ChevronLeft size={15} /></button><button aria-label={`Move ${collection.name} right`} disabled={collectionIndex === collections.length - 1} onClick={() => void moveCollection(collection.id, 1)}><ChevronRight size={15} /></button><button aria-label={`Delete ${collection.name}`} onClick={() => links.length ? setDialog({ type: "delete-collection", collectionId: collection.id }) : void mutate(() => repository.deleteCollection(collection.id))}><Trash2 size={14} /></button></div></header>
                {links.map((link) => <div className="link-card" draggable onDragStart={() => setDraggedLinkId(link.id)} key={link.id}><GripVertical className="drag-handle" size={14} /><a href={link.url} target="_blank" rel="noreferrer"><i>{link.title[0]?.toUpperCase()}</i><span><b>{link.title}</b><small>{hostnameFor(link.url)}</small></span></a><button aria-label={`Move ${link.title} to previous collection`} disabled={collectionIndex === 0} onClick={() => void moveLink(link, -1)}><ChevronLeft size={14} /></button><button aria-label={`Move ${link.title} to next collection`} disabled={collectionIndex === collections.length - 1} onClick={() => void moveLink(link, 1)}><ChevronRight size={14} /></button><button aria-label={`Edit ${link.title}`} onClick={() => setDialog({ type: "link", collectionId: collection.id, link })}><MoreHorizontal size={15} /></button><button aria-label={`Delete ${link.title}`} onClick={() => void mutate(() => repository.deleteLink(link.id))}><Trash2 size={14} /></button></div>)}
                {!query && <button className="add-link" onClick={() => setDialog({ type: "link", collectionId: collection.id })}><Plus size={14} /> Add link</button>}
                {!!links.length && <button className="open-all" onClick={() => links.length > 10 ? setDialog({ type: "open-many", links }) : openLinks(links)}><ExternalLink size={13} /> Open all</button>}
              </article>;
            })}
          </div> : <div className="workspace-empty"><Search size={28} /><h3>{query ? "No links found" : "Start your first collection"}</h3><p>{query ? "Try a title, URL, collection, or space name." : "Collections keep related links together."}</p>{!query && <button className="button button-primary" onClick={() => setDialog({ type: "collection" })}>Create collection</button>}</div>}
        </> : <div className="workspace-empty"><h2>Plant your first space</h2><p>Spaces are the top-level home for each part of your work.</p><button className="button button-primary" onClick={() => setDialog({ type: "space" })}>Create a space</button></div>}
      </section>

      {dialog && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(null); }}><section className="dialog" role="dialog" aria-modal="true" aria-label="Workspace action"><button className="dialog-close" aria-label="Close dialog" onClick={() => setDialog(null)}><X size={18} /></button>
        {dialog.type === "delete-collection" ? <><h2>Delete this collection?</h2><p>Its saved links will also be removed. This cannot be undone.</p><div className="dialog-actions"><button onClick={() => setDialog(null)}>Cancel</button><button className="danger" onClick={() => void mutate(() => repository.deleteCollection(dialog.collectionId))}>Delete collection</button></div></> : dialog.type === "delete-space" ? <><h2>Delete this space?</h2><p>All of its collections and saved links will also be removed. This cannot be undone.</p><div className="dialog-actions"><button onClick={() => setDialog(null)}>Cancel</button><button className="danger" onClick={() => void mutate(() => repository.deleteSpace(dialog.spaceId))}>Delete space</button></div></> : dialog.type === "open-many" ? <><h2>Open {dialog.links.length} tabs?</h2><p>Opening a large collection can make your browser feel busy.</p><div className="dialog-actions"><button onClick={() => setDialog(null)}>Cancel</button><button className="button-primary" onClick={() => openLinks(dialog.links)}>Open tabs</button></div></> : <form onSubmit={submitDialog}><h2>{dialog.type === "space" ? "New space" : dialog.type === "edit-space" ? "Rename space" : dialog.type === "collection" ? "New collection" : dialog.type === "edit-collection" ? "Rename collection" : dialog.link ? "Edit link" : "Add link"}</h2>{dialog.type !== "link" ? <label>Name<input aria-label="Name" name="name" maxLength={80} defaultValue={dialog.type === "edit-space" ? snapshot.spaces.find((item) => item.id === dialog.spaceId)?.name : dialog.type === "edit-collection" ? snapshot.collections.find((item) => item.id === dialog.collectionId)?.name : ""} /></label> : <><label>Link title<input aria-label="Link title" name="title" defaultValue={dialog.link?.title} maxLength={300} /></label><label>Link URL<input aria-label="Link URL" name="url" type="text" defaultValue={dialog.link?.url ?? "https://"} /></label><label>Note<textarea name="description" defaultValue={dialog.link?.description} maxLength={1000} /></label></>}{(dialog.type === "space" || dialog.type === "edit-space") && <label>Color<input name="color" type="color" defaultValue={dialog.type === "edit-space" ? snapshot.spaces.find((item) => item.id === dialog.spaceId)?.color : "#f56f72"} /></label>}<button className="button button-primary" type="submit">{dialog.type === "link" ? "Save link" : "Save"}</button></form>}
      </section></div>}
    </main>
  );
}
