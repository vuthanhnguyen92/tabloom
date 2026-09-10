import { ChevronLeft, ChevronRight, CopyMinus, GripVertical, Layers3, Plus, RefreshCw, X } from "lucide-react";
import { type DragEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { normalizeUrlForDuplicate, type Collection } from "../shared/domain";
import type { WorkspaceRepository } from "../shared/repository";
import { findDuplicateTabIds, listCurrentWindowTabs, type CaptureTab } from "./chrome-api";
import { FaviconTile } from "../shared/organizer/FaviconTile";
import { browserAdapter } from "./browser";
import type { FaviconResolver } from "./browser/types";

const capturedFavicon: FaviconResolver = ({ capturedUrl }) => capturedUrl ?? null;

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
  onOpenTab?: (tabId: number) => Promise<void>;
  onTabDragChange?: (dragging: boolean) => void;
  onWorkspaceReload: () => Promise<void>;
  listTabs?: () => Promise<CaptureTab[]>;
  closeTabs?: (tabIds: number[]) => Promise<void>;
  subscribeToTabChanges?: (listener: () => void) => () => void;
  resolveFavicon?: FaviconResolver;
};

export function CurrentTabsSheet({ activeSpaceId, expanded, repository, refreshVersion = 0, onError, onExpandedChange, onMessage, onOpenTab, onTabDragChange, onWorkspaceReload, listTabs = listCurrentWindowTabs, closeTabs = (tabIds) => browserAdapter.tabs.close(tabIds), subscribeToTabChanges, resolveFavicon = capturedFavicon }: CurrentTabsSheetProps) {
  const [tabs, setTabs] = useState<CaptureTab[]>([]);
  const [loading, setLoading] = useState(true);
  const [naming, setNaming] = useState(false);
  const [collectionName, setCollectionName] = useState("");
  const [savingAll, setSavingAll] = useState(false);
  const [confirmingDuplicates, setConfirmingDuplicates] = useState(false);
  const [closingDuplicates, setClosingDuplicates] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<number | null>(null);
  const savingAllRef = useRef(false);
  const closingDuplicatesRef = useRef(false);
  const duplicateTabIds = findDuplicateTabIds(tabs);

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

  useEffect(() => {
    if (!subscribeToTabChanges) return;
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeToTabChanges(() => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void listTabs()
          .then((next) => { if (active) setTabs(next); })
          .catch((reason) => { if (active) onError(reason instanceof Error ? reason.message : "Could not refresh current tabs."); });
      }, 80);
    });
    return () => {
      active = false;
      clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [listTabs, onError, subscribeToTabChanges]);

  function startDrag(event: DragEvent, tab: CaptureTab) {
    if (!tab.saveable) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(BROWSER_TAB_MIME, JSON.stringify(tab));
    setDraggingTabId(tab.id ?? null);
    onTabDragChange?.(true);
  }

  async function openTab(tab: CaptureTab) {
    if (tab.id == null) return;
    try {
      if (onOpenTab) await onOpenTab(tab.id);
      else {
        const result = await browserAdapter.tabs.activateExisting(tab.id);
        if (result.cleanupError) onError(result.cleanupError);
      }
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not open this browser tab.");
    }
  }

  async function confirmDuplicateCleanup() {
    if (closingDuplicatesRef.current || !duplicateTabIds.length) return;
    const idsToClose = [...duplicateTabIds];
    closingDuplicatesRef.current = true;
    setClosingDuplicates(true);
    try {
      await closeTabs(idsToClose);
      onMessage(`${idsToClose.length} duplicate tab${idsToClose.length === 1 ? "" : "s"} closed`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not close duplicate tabs.");
    } finally {
      setConfirmingDuplicates(false);
      await refresh();
      closingDuplicatesRef.current = false;
      setClosingDuplicates(false);
    }
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

  if (!expanded) return <aside aria-label="Current tabs" className="current-tabs-sheet collapsed"><button aria-label="Expand current tabs" onClick={() => onExpandedChange(true)}><ChevronLeft size={18} /><span>Current tabs</span></button></aside>;

  return <aside aria-label="Current tabs" className="current-tabs-sheet">
    <header><div><small>CURRENT WINDOW</small><h2>Current tabs</h2></div><div><button aria-label="Close duplicate tabs" disabled={loading || closingDuplicates || !duplicateTabIds.length} onClick={() => setConfirmingDuplicates(true)}><CopyMinus size={16} /></button><button aria-label="Refresh current tabs" disabled={closingDuplicates} onClick={() => void refresh()}><RefreshCw size={16} /></button><button aria-label="Collapse current tabs" disabled={closingDuplicates} onClick={() => onExpandedChange(false)}><ChevronRight size={18} /></button></div></header>
    <p className="current-tabs-hint">Drag a tab into any collection to save it.</p>
    <div className="current-tab-list">{loading ? <p>Reading this window…</p> : tabs.map((tab, index) => <div
      aria-label={`Open ${tab.title || "Untitled tab"}`}
      className={[!tab.saveable ? "disabled" : "", draggingTabId != null && draggingTabId === tab.id ? "dragging" : ""].filter(Boolean).join(" ")}
      draggable={tab.saveable}
      key={tab.id ?? index}
      onClick={() => void openTab(tab)}
      onDragEnd={() => { setDraggingTabId(null); if (tab.saveable) onTabDragChange?.(false); }}
      onDragStart={(event) => startDrag(event, tab)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void openTab(tab); } }}
      role="button"
      tabIndex={0}
    ><FaviconTile src={resolveFavicon({ pageUrl: tab.url, capturedUrl: tab.favIconUrl, size: 32 })} title={tab.title} /><span><b>{tab.title || "Untitled tab"}</b><small>{tab.saveable ? new URL(tab.url!).hostname : "Unsupported browser page"}</small></span>{tab.saveable && <GripVertical aria-hidden="true" className="card-drag-indicator" size={14} />}</div>)}</div>
    <div className="save-window">{naming ? <form onSubmit={(event) => void saveAll(event)}><label>Collection name<input aria-label="Collection name" disabled={savingAll} maxLength={80} value={collectionName} onChange={(event) => setCollectionName(event.target.value)} /></label><div><button type="button" aria-label="Cancel new collection" disabled={savingAll} onClick={() => setNaming(false)}><X size={15} /></button><button className="create-collection" disabled={savingAll} type="submit">{savingAll ? "Saving…" : "Create and save"}</button></div></form> : <button disabled={!repository || !activeSpaceId || savingAll} onClick={() => setNaming(true)}><Layers3 size={16} /> Save all as collection <Plus size={14} /></button>}</div>
    {confirmingDuplicates && <div className="drop-confirm-backdrop"><section className="drop-confirm" role="dialog" aria-modal="true" aria-label="Close duplicate tabs"><small>DUPLICATE TABS</small><h2>Close {duplicateTabIds.length} duplicate tab{duplicateTabIds.length === 1 ? "" : "s"}?</h2><p>Tabloom will keep the active copy when possible, otherwise the leftmost copy. Chrome and extension pages are not included.</p><div><button aria-label="Cancel duplicate cleanup" disabled={closingDuplicates} onClick={() => setConfirmingDuplicates(false)}>Cancel</button><button className="close-after-save" disabled={closingDuplicates} onClick={() => void confirmDuplicateCleanup()}>{closingDuplicates ? "Closing…" : "Close duplicates"}</button></div></section></div>}
  </aside>;
}
