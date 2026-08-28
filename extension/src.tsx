import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/poppins/latin-400.css";
import "@fontsource/poppins/latin-500.css";
import "@fontsource/poppins/latin-600.css";
import "@fontsource/poppins/latin-700.css";
import { LogIn, Search, Sprout, X } from "lucide-react";
import { BROWSER_BOOKMARKS_SPACE_ID } from "../shared/bookmarks";
import { CombinedWorkspaceRepository, SupabaseBookmarkRepository, copyBookmarkToCollection, type BookmarkRepository } from "../shared/bookmark-repository";
import { createDemoSnapshot, filterWorkspace, findDuplicateLink, type SavedLink, type WorkspaceSnapshot } from "../shared/domain";
import { MemoryWorkspaceRepository, SupabaseWorkspaceRepository, type WorkspaceRepository } from "../shared/repository";
import { openCollectionTabs, type CaptureTab } from "./chrome-api";
import { ChromeSnapshotCache } from "./storage";
import { extensionSupabase, signInExtensionWithGoogle } from "./supabase";
import { CollectionRows } from "./CollectionRows";
import { BrowserBookmarksPanel } from "./BrowserBookmarksPanel";
import { CurrentTabsSheet } from "./CurrentTabsSheet";
import { saveDroppedTab } from "./dropped-tab";
import { SpaceSidebar } from "./SpaceSidebar";
import { browserAdapter } from "./browser";
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
  const [tabsExpanded, setTabsExpanded] = useState(true);
  const [tabsRefreshVersion, setTabsRefreshVersion] = useState(0);
  const [pendingTab, setPendingTab] = useState<{ tab: CaptureTab; collectionId: string; duplicate?: SavedLink } | null>(null);
  const [pendingBookmark, setPendingBookmark] = useState<{ link: SavedLink; collectionId: string; duplicate: SavedLink } | null>(null);
  const [savingDroppedTab, setSavingDroppedTab] = useState(false);
  const [browserTabDrag, setBrowserTabDrag] = useState({ active: false, session: 0 });
  const savingDroppedTabRef = useRef(false);

  async function load(repo: WorkspaceRepository) {
    try {
      const next = await repo.load();
      setSnapshot(next); setSelectedSpace((current) => current || next.spaces[0]?.id || "");
      await cache.write(next); setError("");
    } catch {
      const cached = await cache.read();
      if (cached) { setSnapshot(cached); setMessage("Offline · showing your last synced workspace"); }
      else setError("Connect to the internet to load your workspace.");
    }
  }

  useEffect(() => {
    void (async () => {
      if (!extensionSupabase) {
        const repo = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());
        setRepository(repo); await load(repo); return;
      }
      const { data } = await extensionSupabase.auth.getSession();
      if (data.session) {
        const normal = new SupabaseWorkspaceRepository(extensionSupabase, data.session.user.id);
        const bookmarks = new SupabaseBookmarkRepository(extensionSupabase, data.session.user.id);
        const repo = new CombinedWorkspaceRepository(normal, bookmarks);
        setBookmarkRepository(bookmarks);
        setSignedIn(true); setRepository(repo); await load(repo);
      } else {
        const cached = await cache.read(); if (cached) setSnapshot(cached);
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
    try {
      const session = await signInExtensionWithGoogle();
      if (!extensionSupabase) return;
      const normal = new SupabaseWorkspaceRepository(extensionSupabase, session.user.id);
      const bookmarks = new SupabaseBookmarkRepository(extensionSupabase, session.user.id);
      const repo = new CombinedWorkspaceRepository(normal, bookmarks);
      setBookmarkRepository(bookmarks);
      setSignedIn(true); setRepository(repo); await load(repo);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not sign in."); }
  }

  return <main className={`ext-shell ${tabsExpanded ? "sheet-open" : "sheet-collapsed"}`}>
    {snapshot ? <SpaceSidebar activeSpaceId={activeSpace?.id ?? ""} brand={<Mark />} repository={repository} snapshot={snapshot} onError={setError} onMessage={setMessage} onReload={() => repository ? load(repository) : Promise.resolve()} onSelect={(spaceId) => { setSelectedSpace(spaceId); setQuery(""); }} /> : <aside className="ext-sidebar"><Mark /></aside>}
    <section className="ext-main"><header><div><small>{signedIn ? "SYNCED WORKSPACE" : "DEMO WORKSPACE"}</small><h1>{activeSpace?.name || "Your workspace"}</h1></div><label><Search size={17} /><input aria-label="Search your links" placeholder="Search your links" value={query} onChange={(event) => setQuery(event.target.value)} /></label></header>
      {message && <p className="ext-message">{message}</p>}{error && <p className="ext-message error">{error}<button onClick={() => setError("")}><X size={14} /></button></p>}
      {!extensionSupabase && <p className="demo-note">Demo mode · add Supabase settings to synchronize this new-tab page.</p>}
      {extensionSupabase && !signedIn && <div className="ext-signin"><Sprout size={32} /><h2>Your workspace is ready to bloom.</h2><p>Sign in to capture tabs and sync them with Tabloom on the web.</p><button onClick={() => void signIn()}><LogIn size={16} /> Sign in with Google</button></div>}
      {activeSpace?.id === BROWSER_BOOKMARKS_SPACE_ID && bookmarkRepository && repository && (browserAdapter.capabilities.bookmarks
        ? <BrowserBookmarksPanel repository={bookmarkRepository} workspace={repository} cache={cache} onWorkspaceReload={() => load(repository)} />
        : <section className="bookmark-sync-panel" aria-label="Browser bookmark sync unavailable"><p className="bookmark-sync-status">Safari cannot read local browser bookmarks. Collections synchronized from your other devices remain available here.</p></section>)}
      {(!extensionSupabase || signedIn) && repository && visible && <CollectionRows bookmarkDropCollections={savedCollections} browserTabDragSession={browserTabDrag.active ? browserTabDrag.session : 0} collections={collections} links={visible.links} allLinks={snapshot?.links ?? visible.links} highlightedLinkId={pendingTab?.duplicate?.id ?? pendingBookmark?.duplicate.id} repository={repository} onError={setError} onReload={() => load(repository)} onOpenCollection={(collection, collectionLinks) => openCollection(collection.name, collectionLinks.map((link) => link.url))} onBookmarkDrop={handleBookmarkDrop} onBrowserTabDrop={(tab, collectionId) => { setBrowserTabDrag((current) => ({ ...current, active: false })); setPendingTab({ tab, collectionId, duplicate: findDuplicateLink((snapshot?.links ?? []).filter((item) => item.origin === "saved"), collectionId, tab.url ?? "") }); }} />}
    </section>
    <CurrentTabsSheet activeSpaceId={activeSpace?.origin === "saved" ? activeSpace.id : undefined} collections={snapshot?.collections.filter((item) => item.origin === "saved" && item.space_id === activeSpace?.id) ?? []} expanded={tabsExpanded} repository={repository} refreshVersion={tabsRefreshVersion} onError={setError} onExpandedChange={setTabsExpanded} onMessage={setMessage} onTabDragChange={(dragging) => setBrowserTabDrag((current) => dragging ? { active: true, session: current.session + 1 } : { ...current, active: false })} onWorkspaceReload={() => repository ? load(repository) : Promise.resolve()} />
    {pendingTab && <div className="drop-confirm-backdrop"><section className="drop-confirm" role="dialog" aria-modal="true" aria-label={pendingTab.duplicate ? "Duplicate current tab" : "Save dropped tab"}><button className="dialog-close" aria-label="Cancel dropped tab" disabled={savingDroppedTab} onClick={() => setPendingTab(null)}><X size={18} /></button>{pendingTab.duplicate ? <><small>DUPLICATE LINK</small><h2>Already saved in {snapshot?.collections.find((item) => item.id === pendingTab.collectionId)?.name ?? "this collection"}</h2><p>The existing saved card is highlighted. Keep or close the current tab without creating a duplicate, or save another copy.</p><div><button disabled={savingDroppedTab} onClick={keepDuplicateTabOpen}>Keep tab open</button><button disabled={savingDroppedTab || typeof pendingTab.tab.id !== "number"} onClick={() => void closeDuplicateTab()}>Close tab</button><button className="close-after-save" disabled={savingDroppedTab} onClick={() => void confirmDroppedTab(false)}>Save another copy</button></div></> : <><small>SAVE CURRENT TAB</small><h2>{pendingTab.tab.title || "Untitled tab"}</h2><p>Save this tab and keep it open, or close it after Tabloom confirms the link was saved?</p><div><button disabled={savingDroppedTab} onClick={() => setPendingTab(null)}>Cancel</button><button disabled={savingDroppedTab} onClick={() => void confirmDroppedTab(false)}>Save and keep tab open</button><button className="close-after-save" disabled={savingDroppedTab} onClick={() => void confirmDroppedTab(true)}>Save and close tab</button></div></>}</section></div>}
    {pendingBookmark && <div className="drop-confirm-backdrop"><section className="drop-confirm" role="dialog" aria-modal="true" aria-label="Duplicate browser bookmark"><button className="dialog-close" aria-label="Cancel bookmark copy" onClick={() => setPendingBookmark(null)}><X size={18} /></button><small>DUPLICATE LINK</small><h2>Already saved in this collection</h2><p>The existing saved card is highlighted. Keep the Chrome bookmark unchanged, or save another Tabloom copy.</p><div><button onClick={() => setPendingBookmark(null)}>Cancel</button><button className="close-after-save" onClick={() => void confirmBookmarkCopy()}>Save another copy</button></div></section></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><ExtensionApp /></React.StrictMode>);
