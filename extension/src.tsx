import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/poppins/latin-400.css";
import "@fontsource/poppins/latin-500.css";
import "@fontsource/poppins/latin-600.css";
import "@fontsource/poppins/latin-700.css";
import { X } from "lucide-react";
import { BROWSER_BOOKMARKS_SPACE_ID } from "../shared/bookmarks";
import { CombinedWorkspaceRepository, SupabaseBookmarkRepository, copyBookmarkToCollection, type BookmarkRepository } from "../shared/bookmark-repository";
import { findDuplicateLink, type SavedLink, type WorkspaceSnapshot } from "../shared/domain";
import type { WorkspaceRepository } from "../shared/repository";
import type { WorkspaceMergePlan } from "../shared/workspace-merge";
import { SupabaseWorkspaceSyncRepository } from "../shared/workspace-sync-repository";
import { TabloomMark } from "../shared/TabloomMark";
import { openCollectionTabs, type CaptureTab } from "./chrome-api";
import { ChromeSnapshotCache, createLocalWorkspaceRepository, openLocalWorkspaceRepository } from "./storage";
import { extensionSupabase, recoverExtensionSessionSilently, signInExtensionWithGoogle } from "./supabase";
import { CollectionRows } from "./CollectionRows";
import { BrowserBookmarksPanel } from "./BrowserBookmarksPanel";
import { CurrentTabsSheet } from "./CurrentTabsSheet";
import { saveDroppedTab } from "./dropped-tab";
import { SpaceSidebar } from "./SpaceSidebar";
import { browserAdapter, browserTarget } from "./browser";
import { callbackForTarget, isSilentOAuthMiss, type ExtensionOAuthSession } from "./auth/oauth";
import { AuthRecoveryPreference } from "./auth/recovery-preference";
import { SyncLoginPrompt, type SyncUser } from "./SyncLoginPrompt";
import { CreateCollectionPrompt } from "./CreateCollectionPrompt";
import { WorkspaceSyncPrompt } from "./WorkspaceSyncPrompt";
import { ToastRegion } from "./ToastRegion";
import { GlobalSearch } from "./GlobalSearch";
import { advanceFirstSync, FirstSyncCoordinator, FirstSyncPreviewChangedError } from "./first-sync";
import { LocalFirstStorage } from "./local-first-storage";
import { LocalFirstWorkspaceRepository } from "./local-first-repository";
import { WorkspaceSyncCoordinator, type WorkspaceSyncState } from "./workspace-sync-coordinator";
import { WorkspaceSyncLock } from "./workspace-sync-lock";
import { SupabaseWorkspaceSyncTransport } from "./workspace-sync-transport";
import { registerWorkspaceSyncLifecycle } from "./workspace-sync-lifecycle";
import { SelectedSpacePreference } from "./selected-space-preference";
import { CollectionCollapsePreference } from "./collection-collapse-preference";
import { mergeAccountWorkspaceIntoLocal } from "./logout-workspace";
import { WorkspaceBootBoundary } from "./WorkspaceBootBoundary";
import { bootstrapWorkspace } from "./workspace-bootstrap";
import "./style.css";

const cache = new ChromeSnapshotCache();
const oauthCallbackUrl = callbackForTarget(browserTarget, browserAdapter.identity);
const selectedSpacePreference = new SelectedSpacePreference(browserAdapter.storage);
const collectionCollapsePreference = new CollectionCollapsePreference(browserAdapter.storage);
const authRecoveryPreference = new AuthRecoveryPreference(browserAdapter.storage);
const LOCAL_SPACE_SCOPE = "local";
const accountSpaceScope = (userId: string) => `account:${userId}`;

function waitForStorageKey(key: string, expiresAt: number): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe: () => void = () => undefined;
    const finish = () => {
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    const timeout = setTimeout(finish, Math.max(0, expiresAt - Date.now()));
    unsubscribe = browserAdapter.storageChanges.subscribe((keys) => {
      if (keys.includes(key)) finish();
    });
  });
}

function Mark() { return <span className="ext-brand"><TabloomMark className="ext-brand-mark" />tabloom</span>; }

export function ExtensionApp() {
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [repository, setRepository] = useState<WorkspaceRepository | null>(null);
  const [bookmarkRepository, setBookmarkRepository] = useState<BookmarkRepository | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [selectedSpace, setSelectedSpace] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [user, setUser] = useState<SyncUser | null>(null);
  const [syncStatus, setSyncStatus] = useState<"local" | "checking" | "pending" | "synced" | "error">("local");
  const [workspaceSync, setWorkspaceSync] = useState<{ coordinator: FirstSyncCoordinator; preview: WorkspaceMergePlan; generation: number } | null>(null);
  const [workspaceSyncBusy, setWorkspaceSyncBusy] = useState(false);
  const [workspaceSyncError, setWorkspaceSyncError] = useState<string | null>(null);
  const [tabsExpanded, setTabsExpanded] = useState(true);
  const [tabsRefreshVersion, setTabsRefreshVersion] = useState(0);
  const [pendingTab, setPendingTab] = useState<{ tab: CaptureTab; collectionId: string; duplicate?: SavedLink } | null>(null);
  const [pendingBookmark, setPendingBookmark] = useState<{ link: SavedLink; collectionId: string; duplicate: SavedLink } | null>(null);
  const [savingDroppedTab, setSavingDroppedTab] = useState(false);
  const [browserTabDrag, setBrowserTabDrag] = useState({ active: false, session: 0 });
  const [workspaceScope, setWorkspaceScope] = useState(LOCAL_SPACE_SCOPE);
  const [recoverySuggested, setRecoverySuggested] = useState(false);
  const savingDroppedTabRef = useRef(false);
  const silentRecoveryBusyRef = useRef(false);
  const localRepositoryRef = useRef<WorkspaceRepository | null>(null);
  const syncUserIdRef = useRef<string | null>(null);
  const localFirstStorageRef = useRef<LocalFirstStorage | null>(null);
  const coordinatorRef = useRef<WorkspaceSyncCoordinator | null>(null);
  const coordinatorCleanupRef = useRef<(() => void) | null>(null);
  const activationGenerationRef = useRef(0);
  const selectionScopeRef = useRef(LOCAL_SPACE_SCOPE);
  const [coordinatorState, setCoordinatorState] = useState<WorkspaceSyncState | null>(null);

  async function preferredSpaceId(next: WorkspaceSnapshot, scope: string): Promise<string> {
    try {
      return await selectedSpacePreference.reconcile(scope, next.spaces);
    } catch {
      return next.spaces[0]?.id ?? "";
    }
  }

  function selectSpace(spaceId: string) {
    setSelectedSpace(spaceId);
    void selectedSpacePreference.select(selectionScopeRef.current, spaceId).catch(() => undefined);
  }

  async function load(repo: WorkspaceRepository, scope = selectionScopeRef.current) {
    try {
      const next = await repo.load();
      const preferred = await preferredSpaceId(next, scope);
      if (selectionScopeRef.current !== scope) return;
      setSnapshot(next);
      setSelectedSpace(preferred);
      setError("");
    } catch {
      const cached = syncUserIdRef.current
        ? (await cache.loadCloud(syncUserIdRef.current))?.snapshot ?? null
        : await cache.read();
      if (cached) {
        const preferred = await preferredSpaceId(cached, scope);
        if (selectionScopeRef.current !== scope) return;
        setSnapshot(cached);
        setSelectedSpace(preferred);
        setMessage("Offline · showing your last synced workspace");
      }
      else setError("Connect to the internet to load your workspace.");
    }
  }

  function stopActiveCoordinator() {
    coordinatorCleanupRef.current?.();
    coordinatorCleanupRef.current = null;
    coordinatorRef.current?.stop();
    coordinatorRef.current = null;
    localFirstStorageRef.current = null;
    setCoordinatorState(null);
  }

  async function activateCanonical(userId: string, generation: number) {
    if (!extensionSupabase || activationGenerationRef.current !== generation) return;
    const selectionScope = accountSpaceScope(userId);
    selectionScopeRef.current = selectionScope;
    setWorkspaceScope(selectionScope);
    stopActiveCoordinator();
    const storage = new LocalFirstStorage(browserAdapter.storage, userId, {
      subscribeToChanges: (listener) => browserAdapter.storageChanges.subscribe(listener),
    });
    localFirstStorageRef.current = storage;
    const coordinator = new WorkspaceSyncCoordinator({
      userId,
      storage,
      transport: new SupabaseWorkspaceSyncTransport(extensionSupabase),
      exclusiveRunner: new WorkspaceSyncLock({
        area: browserAdapter.storage,
        waitForLeaseChange: waitForStorageKey,
      }),
      onActionRequired: setError,
      onSnapshotCommitted: (next) => {
        if (coordinatorRef.current !== coordinator || syncUserIdRef.current !== userId || activationGenerationRef.current !== generation) return;
        void preferredSpaceId(next, selectionScope).then((preferred) => {
          if (coordinatorRef.current !== coordinator || syncUserIdRef.current !== userId || activationGenerationRef.current !== generation || selectionScopeRef.current !== selectionScope) return;
          setSnapshot(next);
          setSelectedSpace(preferred);
        });
      },
    });
    coordinatorRef.current = coordinator;
    const localFirst = await LocalFirstWorkspaceRepository.create({
      userId,
      storage,
      onMutation: async (operations) => {
        for (const operation of operations) await coordinator.submit(operation);
      },
    });
    if (activationGenerationRef.current !== generation) return;
    const unsubscribe = coordinator.subscribe((state) => {
      if (coordinatorRef.current !== coordinator || activationGenerationRef.current !== generation) return;
      setCoordinatorState(state);
      setSyncStatus(state.phase === "syncing" ? "checking" : state.phase === "synced" ? "synced" : state.phase === "failed" ? "pending" : "error");
    });
    const unregisterLifecycle = registerWorkspaceSyncLifecycle(coordinator);
    coordinatorCleanupRef.current = () => {
      unsubscribe();
      unregisterLifecycle();
    };
    setRepository(localFirst);
    const activated = await localFirst.load();
    if (activationGenerationRef.current !== generation || coordinatorRef.current !== coordinator) {
      coordinator.stop();
      return;
    }
    const preferred = await preferredSpaceId(activated, selectionScope);
    if (activationGenerationRef.current !== generation || coordinatorRef.current !== coordinator || selectionScopeRef.current !== selectionScope) {
      coordinator.stop();
      return;
    }
    setSnapshot(activated);
    setSelectedSpace(preferred);
    setError("");
    void coordinator.start().catch((reason) => {
      if (coordinatorRef.current === coordinator) setError(reason instanceof Error ? reason.message : "Could not refresh the synced workspace.");
    });
  }

  async function beginWorkspaceSync(userId: string, localRepository: WorkspaceRepository, generation = ++activationGenerationRef.current) {
    if (!extensionSupabase || activationGenerationRef.current !== generation) return;
    setWorkspaceSyncBusy(false);
    setWorkspaceSyncError(null);
    setSyncStatus("checking");
    syncUserIdRef.current = userId;
    const bookmarks = new SupabaseBookmarkRepository(extensionSupabase, userId);
    setBookmarkRepository(bookmarks);
    const cached = await cache.loadCloud(userId);
    if (activationGenerationRef.current !== generation) return;
    if (cached) {
      await activateCanonical(userId, generation);
      if (activationGenerationRef.current !== generation) return;
      setWorkspaceSync(null);
      return;
    }
    const coordinator = new FirstSyncCoordinator({
      userId,
      localRepository,
      syncRepository: new SupabaseWorkspaceSyncRepository(extensionSupabase),
      cache,
      activateCanonical: async (next, revision) => {
        void next;
        if (activationGenerationRef.current !== generation) return;
        await activateCanonical(userId, generation);
        if (activationGenerationRef.current !== generation) return;
        setCoordinatorState({ phase: "synced", revision, failed: 0, waiting: 0, lastSyncedAt: new Date().toISOString() });
      },
    });
    try {
      const advanced = await advanceFirstSync(coordinator);
      if (activationGenerationRef.current !== generation) return;
      if (advanced.kind === "confirmation") {
        setWorkspaceSync({ coordinator, preview: advanced.preview, generation });
        setWorkspaceSyncError(null);
        setSyncStatus("pending");
        setMessage("Review how local and synced tabs should be combined");
      } else {
        setWorkspaceSync(null);
        setSyncStatus("synced");
        setMessage("");
      }
    } catch (reason) {
      if (activationGenerationRef.current !== generation) return;
      setSyncStatus("error");
      setMessage("Cloud sync is unavailable · your local workspace is still ready");
      throw reason;
    }
  }

  async function activateRecoveredSession(userId: string, generation: number) {
    if (!extensionSupabase || activationGenerationRef.current !== generation) return;
    syncUserIdRef.current = userId;
    setBookmarkRepository(new SupabaseBookmarkRepository(extensionSupabase, userId));
    setSyncStatus("checking");
    await activateCanonical(userId, generation);
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const generation = ++activationGenerationRef.current;
        const result = await bootstrapWorkspace({
          openLocal: () => openLocalWorkspaceRepository(),
          createLocal: () => createLocalWorkspaceRepository(),
          getStoredSession: async (): Promise<ExtensionOAuthSession | null> => {
            if (!extensionSupabase) return null;
            const session = (await extensionSupabase.auth.getSession()).data.session;
            return session ? {
              user: {
                id: session.user.id,
                email: session.user.email,
                user_metadata: session.user.user_metadata,
              },
            } : null;
          },
          recoverSession: recoverExtensionSessionSilently,
          loadRemote: () => {
            if (!extensionSupabase) throw new Error("Supabase is not configured.");
            return new SupabaseWorkspaceSyncRepository(extensionSupabase).loadVersioned();
          },
          saveRemote: (userId, value) => cache.saveCloud(userId, value),
          recoveryState: () => authRecoveryPreference.read(),
          markRecoveryPending: () => authRecoveryPreference.markPending(),
          clearRecoveryState: () => authRecoveryPreference.clear(),
          canRecover: () => Boolean(extensionSupabase) && browserAdapter.capabilities.identity,
          isOnline: () => navigator.onLine,
        });
        if (!active || activationGenerationRef.current !== generation) return;

        setRecoverySuggested(result.recoverySuggested);
        if (result.session) setUser(result.session.user);

        if (result.mode === "recovered") {
          await activateRecoveredSession(result.session.user.id, generation);
          return;
        }

        const local = result.localRepository;
        localRepositoryRef.current = local;
        setRepository(local);
        await load(local);
        if (!active || activationGenerationRef.current !== generation) return;
        setBootstrapReady(true);

        if (result.mode === "local-session") {
          await beginWorkspaceSync(result.session.user.id, local, generation);
        } else if (result.mode === "offline") {
          setMessage("Cloud sync is unavailable · your local workspace is still ready");
        }
      } catch {
        if (active) setError("Could not restore your local Tabloom workspace.");
      } finally {
        if (active) setBootstrapReady(true);
      }
    })();
    return () => {
      active = false;
      activationGenerationRef.current += 1;
      stopActiveCoordinator();
    };
    // Bootstrap owns the initial repository and coordinator lifecycle; rerunning it would create duplicate listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function retrySilentRecovery(local: WorkspaceRepository) {
    if (!extensionSupabase || !recoverySuggested || silentRecoveryBusyRef.current) return;
    silentRecoveryBusyRef.current = true;
    const generation = ++activationGenerationRef.current;
    try {
      const session = await recoverExtensionSessionSilently();
      if (activationGenerationRef.current !== generation) return;
      await authRecoveryPreference.clear();
      setRecoverySuggested(false);
      setUser(session.user);
      await beginWorkspaceSync(session.user.id, local, generation);
    } catch (reason) {
      if (!isSilentOAuthMiss(reason) && activationGenerationRef.current === generation) {
        setError(reason instanceof Error ? reason.message : "Could not restore your workspace.");
      }
    } finally {
      silentRecoveryBusyRef.current = false;
    }
  }

  useEffect(() => {
    const local = localRepositoryRef.current;
    if (!recoverySuggested || !local) return;
    let attempted = false;
    const attempt = () => {
      if (attempted || document.visibilityState !== "visible") return;
      attempted = true;
      void retrySilentRecovery(local);
    };
    window.addEventListener("focus", attempt);
    document.addEventListener("visibilitychange", attempt);
    return () => {
      window.removeEventListener("focus", attempt);
      document.removeEventListener("visibilitychange", attempt);
    };
    // Recovery is deliberately limited to one attempt for each mounted new-tab lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoverySuggested]);

  const activeSpace = snapshot?.spaces.find((space) => space.id === selectedSpace) ?? snapshot?.spaces[0];
  const collections = snapshot?.collections.filter((collection) => collection.space_id === activeSpace?.id) ?? [];
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
    const generation = ++activationGenerationRef.current;
    const session = await signInExtensionWithGoogle();
    const local = localRepositoryRef.current;
    if (!extensionSupabase || !local || activationGenerationRef.current !== generation) return;
    await authRecoveryPreference.clear();
    setRecoverySuggested(false);
    setUser(session.user);
    await beginWorkspaceSync(session.user.id, local, generation);
  }

  async function logout() {
    const generation = ++activationGenerationRef.current;
    const local = localRepositoryRef.current;
    const accountRepository = repository;
    const userId = syncUserIdRef.current;
    if (!extensionSupabase || !accountRepository || !userId) return;
    stopActiveCoordinator();
    const accountSnapshot = await accountRepository.load();
    if (local) {
      const localSnapshot = await local.load();
      await cache.write(mergeAccountWorkspaceIntoLocal(localSnapshot, accountSnapshot));
    } else {
      await cache.write(accountSnapshot);
    }
    const nextLocal = await createLocalWorkspaceRepository();
    try {
      const { error: signOutError } = await extensionSupabase.auth.signOut();
      if (signOutError) throw signOutError;
    } catch (reason) {
      if (activationGenerationRef.current === generation) await activateCanonical(userId, generation);
      throw reason;
    }
    if (activationGenerationRef.current !== generation) return;
    await authRecoveryPreference.suppress();
    syncUserIdRef.current = null;
    localRepositoryRef.current = nextLocal;
    setBookmarkRepository(null);
    setWorkspaceSync(null);
    setSyncStatus("local");
    setUser(null);
    setRepository(nextLocal);
    selectionScopeRef.current = LOCAL_SPACE_SCOPE;
    setWorkspaceScope(LOCAL_SPACE_SCOPE);
    await load(nextLocal, LOCAL_SPACE_SCOPE);
    setMessage("Logged out · workspace kept on this device");
  }

  async function confirmWorkspaceSync() {
    if (!workspaceSync || workspaceSyncBusy) return;
    const generation = workspaceSync.generation;
    setWorkspaceSyncBusy(true);
    setWorkspaceSyncError(null);
    try {
      await workspaceSync.coordinator.confirm(workspaceSync.preview);
      if (activationGenerationRef.current !== generation) return;
      setWorkspaceSync(null);
      setSyncStatus("synced");
      setMessage("Local and synced tabs were combined");
    } catch (reason) {
      if (activationGenerationRef.current !== generation) return;
      if (reason instanceof FirstSyncPreviewChangedError) {
        setWorkspaceSync({ coordinator: workspaceSync.coordinator, preview: reason.preview, generation: workspaceSync.generation });
        setWorkspaceSyncError(reason.message);
        setSyncStatus("pending");
      } else {
        setWorkspaceSyncError(reason instanceof Error ? reason.message : "Could not synchronize this workspace.");
        setSyncStatus("error");
      }
    } finally {
      if (activationGenerationRef.current === generation) setWorkspaceSyncBusy(false);
    }
  }

  async function cancelWorkspaceSync() {
    if (!workspaceSync || workspaceSyncBusy) return;
    const generation = workspaceSync.generation;
    setWorkspaceSyncBusy(true);
    try {
      await workspaceSync.coordinator.cancel();
      if (activationGenerationRef.current !== generation) return;
      setWorkspaceSync(null);
      setWorkspaceSyncError(null);
      setSyncStatus("pending");
      setMessage("Sync pending · this browser is still using local storage");
    } finally {
      if (activationGenerationRef.current === generation) setWorkspaceSyncBusy(false);
    }
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
      const storage = localFirstStorageRef.current;
      if (!storage) return cache.writeEnvelope(envelope);
      await storage.update(async (current) => [{
        ...current,
        snapshot: {
          spaces: [
            ...current.snapshot.spaces.filter((item) => item.origin === "saved"),
            ...envelope.snapshot.spaces.filter((item) => item.origin === "browser-bookmark"),
          ],
          collections: [
            ...current.snapshot.collections.filter((item) => item.origin === "saved"),
            ...envelope.snapshot.collections.filter((item) => item.origin === "browser-bookmark"),
          ],
          links: [
            ...current.snapshot.links.filter((item) => item.origin === "saved"),
            ...envelope.snapshot.links.filter((item) => item.origin === "browser-bookmark"),
          ],
        },
        cachedAt: envelope.cachedAt,
      }, undefined]);
    },
  };

  const bookmarkWorkspace = repository && bookmarkRepository
    ? new CombinedWorkspaceRepository(repository, bookmarkRepository)
    : null;

  return <WorkspaceBootBoundary ready={bootstrapReady} label="Restoring workspace"><main className={`ext-shell ${tabsExpanded ? "sheet-open" : "sheet-collapsed"}`}>
    {snapshot ? <SpaceSidebar activeSpaceId={activeSpace?.id ?? ""} brand={<Mark />} repository={repository} snapshot={snapshot} onError={setError} onMessage={setMessage} onReload={() => repository ? load(repository) : Promise.resolve()} onSelect={selectSpace} /> : <aside className="ext-sidebar collapsed"><div className="sidebar-top" /></aside>}
    <section className="ext-main"><header><div><h1>{activeSpace?.name || "Your workspace"}</h1></div><div className="ext-header-tools">{repository && <CreateCollectionPrompt activeSpaceId={activeSpace?.origin === "saved" && !activeSpace.read_only ? activeSpace.id : undefined} repository={repository} onCreated={() => load(repository)} onError={setError} />}{user && !coordinatorState && (syncStatus === "pending" || syncStatus === "error") && <button className="sync-login-trigger sync-retry-trigger" onClick={() => void retryWorkspaceSync()}>Retry sync</button>}{snapshot && <GlobalSearch listCurrentTabs={() => browserAdapter.tabs.listCurrentWindow()} onActivateCurrentTab={async (tabId) => { const result = await browserAdapter.tabs.activateExisting(tabId); if (result.cleanupError) setError(result.cleanupError); }} onError={setError} resolveFavicon={browserAdapter.favicons.resolve} snapshot={snapshot} />}<SyncLoginPrompt callbackUrl={oauthCallbackUrl} configured={Boolean(extensionSupabase)} onSignIn={signIn} onLogout={logout} onRetrySync={() => coordinatorRef.current?.retryFailed() ?? Promise.resolve()} recoverySuggested={recoverySuggested} syncState={coordinatorState ?? undefined} target={browserTarget} user={user} /></div></header>
      {activeSpace?.id === BROWSER_BOOKMARKS_SPACE_ID && bookmarkRepository && repository && bookmarkWorkspace && browserAdapter.capabilities.bookmarks
        ? <BrowserBookmarksPanel repository={bookmarkRepository} workspace={bookmarkWorkspace} cache={bookmarkCache} onWorkspaceReload={() => load(repository)} />
        : null}
      {repository && snapshot && <CollectionRows bookmarkDropCollections={savedCollections} browserTabDragSession={browserTabDrag.active ? browserTabDrag.session : 0} collapsePreference={collectionCollapsePreference} collapseScope={workspaceScope} collections={collections} links={snapshot.links} allLinks={snapshot.links} highlightedLinkId={pendingTab?.duplicate?.id ?? pendingBookmark?.duplicate.id} repository={repository} resolveFavicon={browserAdapter.favicons.resolve} onError={setError} onMessage={setMessage} onReload={() => load(repository)} onOpenCollection={(collection, collectionLinks) => openCollection(collection.name, collectionLinks.map((link) => link.url))} onBookmarkDrop={handleBookmarkDrop} onBrowserTabDrop={(tab, collectionId) => { setBrowserTabDrag((current) => ({ ...current, active: false })); setPendingTab({ tab, collectionId, duplicate: findDuplicateLink(snapshot.links.filter((item) => item.origin === "saved"), collectionId, tab.url ?? "") }); }} />}
    </section>
    <CurrentTabsSheet activeSpaceId={activeSpace?.origin === "saved" ? activeSpace.id : undefined} collections={snapshot?.collections.filter((item) => item.origin === "saved" && item.space_id === activeSpace?.id) ?? []} expanded={tabsExpanded} repository={repository} refreshVersion={tabsRefreshVersion} resolveFavicon={browserAdapter.favicons.resolve} onError={setError} onExpandedChange={setTabsExpanded} onMessage={setMessage} onTabDragChange={(dragging) => setBrowserTabDrag((current) => dragging ? { active: true, session: current.session + 1 } : { ...current, active: false })} onWorkspaceReload={() => repository ? load(repository) : Promise.resolve()} />
    {pendingTab && <div className="drop-confirm-backdrop"><section className="drop-confirm" role="dialog" aria-modal="true" aria-label={pendingTab.duplicate ? "Duplicate current tab" : "Save dropped tab"}><button className="dialog-close" aria-label="Cancel dropped tab" disabled={savingDroppedTab} onClick={() => setPendingTab(null)}><X size={18} /></button>{pendingTab.duplicate ? <><small>DUPLICATE LINK</small><h2>Already saved in {snapshot?.collections.find((item) => item.id === pendingTab.collectionId)?.name ?? "this collection"}</h2><p>The existing saved card is highlighted. Keep or close the current tab without creating a duplicate, or save another copy.</p><div><button disabled={savingDroppedTab} onClick={keepDuplicateTabOpen}>Keep tab open</button><button disabled={savingDroppedTab || typeof pendingTab.tab.id !== "number"} onClick={() => void closeDuplicateTab()}>Close tab</button><button className="close-after-save" disabled={savingDroppedTab} onClick={() => void confirmDroppedTab(false)}>Save another copy</button></div></> : <><small>SAVE CURRENT TAB</small><h2>{pendingTab.tab.title || "Untitled tab"}</h2><p>Save this tab and keep it open, or close it after Tabloom confirms the link was saved?</p><div><button disabled={savingDroppedTab} onClick={() => setPendingTab(null)}>Cancel</button><button disabled={savingDroppedTab} onClick={() => void confirmDroppedTab(false)}>Save and keep tab open</button><button className="close-after-save" disabled={savingDroppedTab} onClick={() => void confirmDroppedTab(true)}>Save and close tab</button></div></>}</section></div>}
    {pendingBookmark && <div className="drop-confirm-backdrop"><section className="drop-confirm" role="dialog" aria-modal="true" aria-label="Duplicate browser bookmark"><button className="dialog-close" aria-label="Cancel bookmark copy" onClick={() => setPendingBookmark(null)}><X size={18} /></button><small>DUPLICATE LINK</small><h2>Already saved in this collection</h2><p>The existing saved card is highlighted. Keep the Chrome bookmark unchanged, or save another Tabloom copy.</p><div><button onClick={() => setPendingBookmark(null)}>Cancel</button><button className="close-after-save" onClick={() => void confirmBookmarkCopy()}>Save another copy</button></div></section></div>}
    {workspaceSync && <WorkspaceSyncPrompt plan={workspaceSync.preview} busy={workspaceSyncBusy} error={workspaceSyncError} onConfirm={confirmWorkspaceSync} onCancel={cancelWorkspaceSync} />}
    <ToastRegion error={error} message={message} onDismissError={() => setError("")} onDismissMessage={() => setMessage("")} />
  </main></WorkspaceBootBoundary>;
}

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<React.StrictMode><ExtensionApp /></React.StrictMode>);
