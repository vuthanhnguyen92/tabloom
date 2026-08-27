import { ChevronLeft, ChevronRight, Layers3, Plus, RefreshCw, X } from "lucide-react";
import { type DragEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { normalizeUrlForDuplicate, type Collection } from "../shared/domain";
import type { WorkspaceRepository } from "../shared/repository";
import { listCurrentWindowTabs, type CaptureTab } from "./chrome-api";

export const BROWSER_TAB_MIME = "application/x-tabloom-tab";

export type CurrentTabsSheetProps = {
  activeSpaceId?: string;
  collections: Collection[];
  expanded: boolean;
  repository: WorkspaceRepository | null;
  refreshVersion?: number;
  onError: (message: string) => void;
  onExpandedChange: (expanded: boolean) => void;
  onMessage: (message: string) => void;
  onTabDragChange?: (dragging: boolean) => void;
  onWorkspaceReload: () => Promise<void>;
  listTabs?: () => Promise<CaptureTab[]>;
};

export function CurrentTabsSheet({ activeSpaceId, expanded, repository, refreshVersion = 0, onError, onExpandedChange, onMessage, onTabDragChange, onWorkspaceReload, listTabs = listCurrentWindowTabs }: CurrentTabsSheetProps) {
  const [tabs, setTabs] = useState<CaptureTab[]>([]);
  const [loading, setLoading] = useState(true);
  const [naming, setNaming] = useState(false);
  const [collectionName, setCollectionName] = useState("");
  const [savingAll, setSavingAll] = useState(false);
  const savingAllRef = useRef(false);

  const refresh = useCallback(async () => {
    try { setLoading(true); setTabs(await listTabs()); }
    catch (reason) { onError(reason instanceof Error ? reason.message : "Could not read current tabs."); }
    finally { setLoading(false); }
  }, [listTabs, onError]);

  useEffect(() => {
    let active = true;
    void listTabs().then((next) => { if (active) { setTabs(next); setLoading(false); } }).catch((reason) => { if (active) { onError(reason instanceof Error ? reason.message : "Could not read current tabs."); setLoading(false); } });
    return () => { active = false; };
  }, [listTabs, onError, refreshVersion]);

  function startDrag(event: DragEvent, tab: CaptureTab) {
    if (!tab.saveable) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(BROWSER_TAB_MIME, JSON.stringify(tab));
    onTabDragChange?.(true);
  }

  async function saveAll(event: FormEvent) {
    event.preventDefault();
    if (savingAllRef.current) return;
    const name = collectionName.trim();
    if (!name) return onError("Collection name is required.");
    if (!repository || !activeSpaceId) return onError("Sign in or select a space before saving tabs.");
    const supported = tabs.filter((tab) => tab.saveable && tab.url);
    if (!supported.length) return onError("There are no supported tabs to save.");
    const seenUrls = new Set<string>();
    const uniqueSupported = supported.filter((tab) => {
      const normalized = normalizeUrlForDuplicate(tab.url);
      if (!normalized || seenUrls.has(normalized)) return false;
      seenUrls.add(normalized);
      return true;
    });
    savingAllRef.current = true;
    setSavingAll(true);
    let collection: Collection | undefined;
    try {
      const created = await repository.createCollection({ name, space_id: activeSpaceId });
      collection = created;
      await repository.createLinks(uniqueSupported.map((tab) => ({ collection_id: created.id, url: tab.url!, title: tab.title || tab.url!, description: "", favicon_url: tab.favIconUrl ?? null })));
      await onWorkspaceReload();
      const duplicateCount = supported.length - uniqueSupported.length;
      const unsupportedCount = tabs.length - supported.length;
      const summary = [`${uniqueSupported.length} saved`];
      if (duplicateCount) summary.push(`${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} skipped`);
      if (unsupportedCount) summary.push(`${unsupportedCount} unsupported skipped`);
      onMessage(summary.join(" · "));
      setCollectionName(""); setNaming(false);
    } catch (reason) {
      if (collection) await repository.deleteCollection(collection.id).catch(() => undefined);
      onError(reason instanceof Error ? reason.message : "Could not save this collection.");
    } finally {
      savingAllRef.current = false;
      setSavingAll(false);
    }
  }

  if (!expanded) return <aside className="current-tabs-sheet collapsed"><button aria-label="Expand current tabs" onClick={() => onExpandedChange(true)}><ChevronLeft size={18} /><span>Current tabs</span></button></aside>;

  return <aside className="current-tabs-sheet">
    <header><div><small>CURRENT WINDOW</small><h2>Current tabs</h2></div><div><button aria-label="Refresh current tabs" onClick={() => void refresh()}><RefreshCw size={16} /></button><button aria-label="Collapse current tabs" onClick={() => onExpandedChange(false)}><ChevronRight size={18} /></button></div></header>
    <p className="current-tabs-hint">Drag a tab into any collection to save it.</p>
    <div className="current-tab-list">{loading ? <p>Reading this window…</p> : tabs.map((tab, index) => <div className={!tab.saveable ? "disabled" : ""} draggable={tab.saveable} key={tab.id ?? index} onDragEnd={() => { if (tab.saveable) onTabDragChange?.(false); }} onDragStart={(event) => startDrag(event, tab)}><i>{tab.title?.[0]?.toUpperCase() || "?"}</i><span><b>{tab.title || "Untitled tab"}</b><small>{tab.saveable ? new URL(tab.url!).hostname : "Unsupported browser page"}</small></span></div>)}</div>
    <div className="save-window">{naming ? <form onSubmit={(event) => void saveAll(event)}><label>Collection name<input aria-label="Collection name" disabled={savingAll} maxLength={80} value={collectionName} onChange={(event) => setCollectionName(event.target.value)} /></label><div><button type="button" aria-label="Cancel new collection" disabled={savingAll} onClick={() => setNaming(false)}><X size={15} /></button><button className="create-collection" disabled={savingAll} type="submit">{savingAll ? "Saving…" : "Create and save"}</button></div></form> : <button disabled={!repository || !activeSpaceId || savingAll} onClick={() => setNaming(true)}><Layers3 size={16} /> Save all as collection <Plus size={14} /></button>}</div>
  </aside>;
}
