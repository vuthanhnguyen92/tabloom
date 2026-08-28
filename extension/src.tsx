import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/poppins/latin-400.css";
import "@fontsource/poppins/latin-500.css";
import "@fontsource/poppins/latin-600.css";
import "@fontsource/poppins/latin-700.css";
import { Search, X } from "lucide-react";
import { BROWSER_BOOKMARKS_SPACE_ID } from "../shared/bookmarks";
import { CombinedWorkspaceRepository, SupabaseBookmarkRepository, copyBookmarkToCollection, type BookmarkRepository } from "../shared/bookmark-repository";
import { filterWorkspace, findDuplicateLink, type SavedLink, type WorkspaceSnapshot } from "../shared/domain";
import { SupabaseWorkspaceRepository, type WorkspaceRepository } from "../shared/repository";
import type { WorkspaceMergePlan } from "../shared/workspace-merge";
import { SupabaseWorkspaceSyncRepository } from "../shared/workspace-sync-repository";
import { openCollectionTabs, type CaptureTab } from "./chrome-api";
import { ChromeSnapshotCache, createLocalWorkspaceRepository } from "./storage";
import { extensionSupabase, signInExtensionWithGoogle } from "./supabase";
import { CollectionRows } from "./CollectionRows";
import { BrowserBookmarksPanel } from "./BrowserBookmarksPanel";
import { CurrentTabsSheet } from "./CurrentTabsSheet";
import { saveDroppedTab } from "./dropped-tab";
import { SpaceSidebar } from "./SpaceSidebar";
import { browserAdapter } from "./browser";
import { SyncLoginPrompt } from "./SyncLoginPrompt";
import { CreateCollectionPrompt } from "./CreateCollectionPrompt";
import { WorkspaceSyncPrompt } from "./WorkspaceSyncPrompt";
import { advanceFirstSync, FirstSyncCoordinator, FirstSyncPreviewChangedError } from "./first-sync";
import "./style.css";

const cache = new ChromeSnapshotCache();

function Mark() { return <span className="ext-brand"><i>✦</i>tabloom</span>; }

function ExtensionApp() {
  const [repository, setRepository] = useState<WorkspaceRepository | null>(null);
  const [bookmarkRepository, setBookmarkRepository] = useState<BookmarkRepository | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [selectedSpace, setSelectedSpace] = useState("");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [syncStatus, setSyncStatus] = useState<"local" | "checking" | "pending" | "synced" | "error">("local");
  const [workspaceSync, setWorkspaceSync] = useState<{ coordinator: FirstSyncCoordinator; preview: WorkspaceMergePlan } | null>(null);
  const [workspaceSyncBusy, setWorkspaceSyncBusy] = useState(false);
  const [workspaceSyncError, setWorkspaceSyncError] = useState<string | null>(null);
  const [tabsExpanded, setTabsExpanded] = useState(true);
  const [tabsRefreshVersion, setTabsRefreshVersion] = useState(0);
  const [pendingTab, setPendingTab] = useState<{ tab: CaptureTab; collectionId: string; duplicate?: SavedLink } | null>(null);
  const [pendingBookmark, setPendingBookmark] = useState<{ link: SavedLink; collectionId: string; duplicate: SavedLink } | null>(null);
  const [savingDroppedTab, setSavingDroppedTab] = useState(false);
  const [browserTabDrag, setBrowserTabDrag] = useState({ active: false, session: 0 });
  const savingDroppedTabRef = useRef(false);
  const localRepositoryRef = useRef<WorkspaceRepository | null>(null);
  const syncUserIdRef = useRef<string | null>(null);
  const cloudAuthorityRef = useRef(false);

  async function load(repo: WorkspaceRepository) {
    try {
      const next = await repo.load();
      setSnapshot(next); setSelectedSpace((current) => current || next.spaces[0]?.id || "");
      setError("");
    } catch {
      const cached = cloudAuthorityRef.current && syncUserIdRef.current
        ? (await cache.loadCloud(syncUserIdRef.current))?.snapshot ?? null
        : await cache.read();
      if (cached) { setSnapshot(cached); setMessage("Offline · showing your last synced workspace"); }
      else setError("Connect to the internet to load your workspace.");
    }
  }

  async function beginWorkspaceSync(userId: string, localRepository: WorkspaceRepository) {
    if (!extensionSupabase) return;
    setSignedIn(true);
    setSyncStatus("checking");
    syncUserIdRef.current = userId;
    const normal = new SupabaseWorkspaceRepository(extensionSupabase, userId);
    const bookmarks = new SupabaseBookmarkRepository(extensionSupabase, userId);
    const cloudRepository = new CombinedWorkspaceRepository(normal, bookmarks);
    const coordinator = new FirstSyncCoordinator({
      userId,
      localRepository,
      cloudRepository,
      syncRepository: new SupabaseWorkspaceSyncRepository(extensionSupabase),
      cache,
      activateCloud: async (nextRepository) => {
        const next = await nextRepository.load();
        cloudAuthorityRef.current = true;
        setRepository(nextRepository);
        setSnapshot(next);
        setSelectedSpace((current) => next.spaces.some((space) => space.id === current) ? current : next.spaces[0]?.id ?? "");
        setError("");
      },
    });
    setBookmarkRepository(bookmarks);
    try {
      const advanced = await advanceFirstSync(coordinator);
      if (advanced.kind === "confirmation") {
        setWorkspaceSync({ coordinator, preview: advanced.preview });
        setWorkspaceSyncError(null);
        setSyncStatus("pending");
        setMessage("Review how local and synced tabs should be combined");
      } else {
        setWorkspaceSync(null);
        setSyncStatus("synced");
        setMessage("Workspace sync is ready");
      }
    } catch (reason) {
      cloudAuthorityRef.current = false;
      setSyncStatus("error");
      setMessage("Cloud sync is unavailable · your local workspace is still ready");
      throw reason;
    }
  }

  useEffect(() => {
    void (async () => {
      const local = await createLocalWorkspaceRepository();
      localRepositoryRef.current = local;
      setRepository(local);
      await load(local);
      if (!extensionSupabase) return;
      try {
        const { data } = await extensionSupabase.auth.getSession();
        if (data.session) {
          await beginWorkspaceSync(data.session.user.id, local);
        }
      } catch {
        setMessage("Cloud sync is unavailable · your local workspace is still ready");
      }
    })();
  }, []);

  const visible = useMemo(() => snapshot ? filterWorkspace(snapshot, query) : null, [snapshot, query]);
  const activeSpace = snapshot?.spaces.find((space) => space.id === selectedSpace) ?? snapshot?.spaces[0];
  const collections = visible?.collections.filter((collection) => query || collection.space_id === activeSpace?.id) ?? [];
  const savedCollections = snapshot?.collections.filter((collection) => collection.origin === "saved" && !collection.read_only) ?? [];

  async function confirmDroppedTab(closeAfterSave: boolean) {
    if (!repository || !pendingTab || savingDroppedTabRef.current) return;
    savingDroppedTabRef.current = true;
    setSavingDroppedTab(true);
    try {
      const result = await saveDroppedTab({ tab: pendingTab.tab, collectionId: pendingTab.collectionId, closeAfterSave, repository, closeTabs: browserAdapter.tabs.close });
      await load(repository);
      if (closeAfterSave && !result.closeError) setTabsRefreshVersion((value) => value + 1);
      setMessage(result.closeError ? "1 saved · tab could not be closed" : closeAfterSave ? "1 saved · tab closed" : "1 saved · tab kept open");
      if (result.closeError) setError(result.closeError.message);
      setPendingTab(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save this tab."); }
    finally { savingDroppedTabRef.current = false; setSavingDroppedTab(false); }
  }

  function keepDuplicateTabOpen() {
    setMessage("Already saved · tab kept open");
    setPendingTab(null);
  }

  async function closeDuplicateTab() {
    if (!pendingTab?.duplicate || savingDroppedTabRef.current || typeof pendingTab.tab.id !== "number") return;
    savingDroppedTabRef.current = true;
    setSavingDroppedTab(true);
    try {
      await browserAdapter.tabs.close([pendingTab.tab.id]);
      setTabsRefreshVersion((value) => value + 1);
      setMessage("Already saved · tab closed");
      setPendingTab(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not close this tab.");
    } finally {
      savingDroppedTabRef.current = false;
      setSavingDroppedTab(false);
    }
  }

  async function openCollection(name: string, urls: string[]) {
    try {
      const result = await openCollectionTabs(name, urls);
      const tabLabel = `${result.opened} tab${result.opened === 1 ? "" : "s"}`;
      setMessage(result.grouped ? `${tabLabel} opened in ${name}` : `${tabLabel} opened without a group`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open this collection.");
    }
  }

  async function handleBookmarkDrop(link: SavedLink, collectionId: string) {
    if (!repository) throw new Error("Sign in before copying browser bookmarks.");
    const duplicate = findDuplicateLink((snapshot?.links ?? []).filter((item) => item.origin === "saved"), collectionId, link.url);
    if (duplicate) {
      setPendingBookmark({ link, collectionId, duplicate });
      return;
    }
    await copyBookmarkToCollection(repository, link, collectionId);
    setMessage("Bookmark copied to your saved collection");
  }

  async function confirmBookmarkCopy() {
    if (!repository || !pendingBookmark) return;
    try {
      await copyBookmarkToCollection(repository, pendingBookmark.link, pendingBookmark.collectionId);
      setPendingBookmark(null);
      setMessage("Another copy was saved");
      await load(repository);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not copy this bookmark.");
    }
  }

  async function signIn() {
    const session = await signInExtensionWithGoogle();
    const local = localRepositoryRef.current;
    if (!extensionSupabase || !local) return;
    await beginWorkspaceSync(session.user.id, local);
  }

  async function confirmWorkspaceSync() {
    if (!workspaceSync || workspaceSyncBusy) return;
    setWorkspaceSyncBusy(true);
    setWorkspaceSyncError(null);
    try {
      await workspaceSync.coordinator.confirm(workspaceSync.preview);
      setWorkspaceSync(null);
      setSyncStatus("synced");
      setMessage("Local and synced tabs were combined");
    } catch (reason) {
      if (reason instanceof FirstSyncPreviewChangedError) {
        setWorkspaceSync({ coordinator: workspaceSync.coordinator, preview: reason.preview });
        setWorkspaceSyncError(reason.message);
        setSyncStatus("pending");
      } else {
        setWorkspaceSyncError(reason instanceof Error ? reason.message : "Could not synchronize this workspace.");
        setSyncStatus("error");
      }
    } finally {
      setWorkspaceSyncBusy(false);
    }
  }

  async function cancelWorkspaceSync() {
    if (!workspaceSync || workspaceSyncBusy) return;
    await workspaceSync.coordinator.cancel();
    setWorkspaceSync(null);
    setWorkspaceSyncError(null);
    setSyncStatus("pending");
    setMessage("Sync pending · this browser is still using local storage");
  }

  async function retryWorkspaceSync() {
    const local = localRepositoryRef.current;
    const userId = syncUserIdRef.current;
    if (!local || !userId || syncStatus === "checking") return;
    try {
      await beginWorkspaceSync(userId, local);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not retry workspace sync.");
    }
  }

  const bookmarkCache = {
    writeEnvelope: async (envelope: Parameters<ChromeSnapshotCache["writeEnvelope"]>[0]) => {
      const userId = syncUserIdRef.current;
      if (!userId) return cache.writeEnvelope(envelope);
      const state = await cache.loadSyncState(userId);
      await cache.saveCloud(userId, { snapshot: envelope.snapshot, revision: state?.revision ?? 0 });
    },
  };

  return <main className={`ext-shell ${tabsExpanded ? "sheet-open" : "sheet-collapsed"}`}>
    {snapshot ? <SpaceSidebar activeSpaceId={activeSpace?.id ?? ""} brand={<Mark />} repository={repository} snapshot={snapshot} onError={setError} onMessage={setMessage} onReload={() => repository ? load(repository) : Promise.resolve()} onSelect={(spaceId) => { setSelectedSpace(spaceId); setQuery(""); }} /> : <aside className="ext-sidebar"><Mark /></aside>}
    <section className="ext-main"><header><div><small>{syncStatus === "synced" ? "SYNCED WORKSPACE" : syncStatus === "checking" ? "CHECKING WORKSPACE SYNC" : syncStatus === "pending" || syncStatus === "error" ? "LOCAL WORKSPACE · SYNC PENDING" : "LOCAL WORKSPACE"}</small><h1>{activeSpace?.name || "Your workspace"}</h1></div><div className="ext-header-tools">{repository && <CreateCollectionPrompt activeSpaceId={activeSpace?.origin === "saved" && !activeSpace.read_only ? activeSpace.id : undefined} repository={repository} onCreated={() => load(repository)} onError={setError} />}{!signedIn && <SyncLoginPrompt configured={Boolean(extensionSupabase)} onSignIn={signIn} />}{signedIn && (syncStatus === "pending" || syncStatus === "error") && <button className="sync-login-trigger sync-retry-trigger" onClick={() => void retryWorkspaceSync()}>Retry sync</button>}<label><Search size={17} /><input aria-label="Search your links" placeholder="Search your links" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div></header>
      {message && <p className="ext-message">{message}</p>}{error && <p className="ext-message error">{error}<button onClick={() => setError("")}><X size={14} /></button></p>}
      {activeSpace?.id === BROWSER_BOOKMARKS_SPACE_ID && bookmarkRepository && repository && (browserAdapter.capabilities.bookmarks
        ? <BrowserBookmarksPanel repository={bookmarkRepository} workspace={repository} cache={bookmarkCache} onWorkspaceReload={() => load(repository)} />
        : <section className="bookmark-sync-panel" aria-label="Browser bookmark sync unavailable"><p className="bookmark-sync-status">Safari cannot read local browser bookmarks. Collections synchronized from your other devices remain available here.</p></section>)}
      {repository && visible && <CollectionRows bookmarkDropCollections={savedCollections} browserTabDragSession={browserTabDrag.active ? browserTabDrag.session : 0} collections={collections} links={visible.links} allLinks={snapshot?.links ?? visible.links} highlightedLinkId={pendingTab?.duplicate?.id ?? pendingBookmark?.duplicate.id} repository={repository} onError={setError} onReload={() => load(repository)} onOpenCollection={(collection, collectionLinks) => openCollection(collection.name, collectionLinks.map((link) => link.url))} onBookmarkDrop={handleBookmarkDrop} onBrowserTabDrop={(tab, collectionId) => { setBrowserTabDrag((current) => ({ ...current, active: false })); setPendingTab({ tab, collectionId, duplicate: findDuplicateLink((snapshot?.links ?? []).filter((item) => item.origin === "saved"), collectionId, tab.url ?? "") }); }} />}
    </section>
    <CurrentTabsSheet activeSpaceId={activeSpace?.origin === "saved" ? activeSpace.id : undefined} collections={snapshot?.collections.filter((item) => item.origin === "saved" && item.space_id === activeSpace?.id) ?? []} expanded={tabsExpanded} repository={repository} refreshVersion={tabsRefreshVersion} onError={setError} onExpandedChange={setTabsExpanded} onMessage={setMessage} onTabDragChange={(dragging) => setBrowserTabDrag((current) => dragging ? { active: true, session: current.session + 1 } : { ...current, active: false })} onWorkspaceReload={() => repository ? load(repository) : Promise.resolve()} />
    {pendingTab && <div className="drop-confirm-backdrop"><section className="drop-confirm" role="dialog" aria-modal="true" aria-label={pendingTab.duplicate ? "Duplicate current tab" : "Save dropped tab"}><button className="dialog-close" aria-label="Cancel dropped tab" disabled={savingDroppedTab} onClick={() => setPendingTab(null)}><X size={18} /></button>{pendingTab.duplicate ? <><small>DUPLICATE LINK</small><h2>Already saved in {snapshot?.collections.find((item) => item.id === pendingTab.collectionId)?.name ?? "this collection"}</h2><p>The existing saved card is highlighted. Keep or close the current tab without creating a duplicate, or save another copy.</p><div><button disabled={savingDroppedTab} onClick={keepDuplicateTabOpen}>Keep tab open</button><button disabled={savingDroppedTab || typeof pendingTab.tab.id !== "number"} onClick={() => void closeDuplicateTab()}>Close tab</button><button className="close-after-save" disabled={savingDroppedTab} onClick={() => void confirmDroppedTab(false)}>Save another copy</button></div></> : <><small>SAVE CURRENT TAB</small><h2>{pendingTab.tab.title || "Untitled tab"}</h2><p>Save this tab and keep it open, or close it after Tabloom confirms the link was saved?</p><div><button disabled={savingDroppedTab} onClick={() => setPendingTab(null)}>Cancel</button><button disabled={savingDroppedTab} onClick={() => void confirmDroppedTab(false)}>Save and keep tab open</button><button className="close-after-save" disabled={savingDroppedTab} onClick={() => void confirmDroppedTab(true)}>Save and close tab</button></div></>}</section></div>}
    {pendingBookmark && <div className="drop-confirm-backdrop"><section className="drop-confirm" role="dialog" aria-modal="true" aria-label="Duplicate browser bookmark"><button className="dialog-close" aria-label="Cancel bookmark copy" onClick={() => setPendingBookmark(null)}><X size={18} /></button><small>DUPLICATE LINK</small><h2>Already saved in this collection</h2><p>The existing saved card is highlighted. Keep the Chrome bookmark unchanged, or save another Tabloom copy.</p><div><button onClick={() => setPendingBookmark(null)}>Cancel</button><button className="close-after-save" onClick={() => void confirmBookmarkCopy()}>Save another copy</button></div></section></div>}
    {workspaceSync && <WorkspaceSyncPrompt plan={workspaceSync.preview} busy={workspaceSyncBusy} error={workspaceSyncError} onConfirm={confirmWorkspaceSync} onCancel={cancelWorkspaceSync} />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><ExtensionApp /></React.StrictMode>);
