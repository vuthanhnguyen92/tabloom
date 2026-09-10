import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/poppins/latin-400.css";
import "@fontsource/poppins/latin-500.css";
import "@fontsource/poppins/latin-600.css";
import "@fontsource/poppins/latin-700.css";
import { X } from "lucide-react";
import { BROWSER_BOOKMARKS_SPACE_ID } from "../shared/bookmarks";
import { CombinedWorkspaceRepository, SupabaseBookmarkRepository, copyBookmarkToCollection, type BookmarkRepository } from "../shared/bookmark-repository";
import { findDuplicateLink, type SavedLink } from "../shared/domain";
import type { WorkspaceRepository } from "../shared/repository";
import type { WorkspaceMergePlan } from "../shared/workspace-merge";
import { SupabaseWorkspaceSyncRepository } from "../shared/workspace-sync-repository";
import type { WorkspaceTrashRepository } from "../shared/trash-repository";
import { WorkspaceOrganizerView } from "../shared/organizer/WorkspaceOrganizer";
import { useWorkspaceController } from "../shared/organizer/useWorkspaceController";
import type { OrganizerCapabilities } from "../shared/organizer/capabilities";
import { createExtensionPreferenceStore } from "./organizer-preference-store";
import { SupabaseCollectionShareRepository, type CollectionShareClient, type ShareAvailability } from "../shared/collection-sharing";
import { openCollectionTabs, type CaptureTab } from "./chrome-api";
import { ChromeSnapshotCache, createLocalWorkspaceRepository, openLocalWorkspaceRepository } from "./storage";
import { extensionSupabase, recoverExtensionSessionSilently, signInExtensionWithGoogle } from "./supabase";
import { browserTabDropAdapter } from "./CollectionRows";
import { BrowserBookmarksPanel } from "./BrowserBookmarksPanel";
import { CurrentTabsSheet } from "./CurrentTabsSheet";
import { saveDroppedTab } from "./dropped-tab";
import { browserAdapter, browserTarget } from "./browser";
import { callbackForTarget, isSilentOAuthMiss, type ExtensionOAuthSession } from "./auth/oauth";
import { AuthRecoveryPreference } from "./auth/recovery-preference";
import { SyncLoginPrompt, type SyncUser } from "./SyncLoginPrompt";
import { WorkspaceSyncPrompt } from "./WorkspaceSyncPrompt";
import { advanceFirstSync, FirstSyncCoordinator, FirstSyncPreviewChangedError } from "./first-sync";
import { LocalFirstStorage } from "./local-first-storage";
import { LocalFirstWorkspaceRepository } from "./local-first-repository";
import { WorkspaceSyncCoordinator, type WorkspaceSyncState } from "./workspace-sync-coordinator";
import { WorkspaceSyncLock } from "./workspace-sync-lock";
import { SupabaseWorkspaceSyncTransport } from "./workspace-sync-transport";
import { registerWorkspaceSyncLifecycle } from "./workspace-sync-lifecycle";
import { mergeAccountWorkspaceIntoLocal } from "./logout-workspace";
import { WorkspaceBootBoundary } from "./WorkspaceBootBoundary";
import { bootstrapWorkspace } from "./workspace-bootstrap";
import { useOnlineStatus } from "./online-status";
import "./style.css";

const cache = new ChromeSnapshotCache();
const oauthCallbackUrl = callbackForTarget(browserTarget, browserAdapter.identity);
const authRecoveryPreference = new AuthRecoveryPreference(browserAdapter.storage);
const LOCAL_SPACE_SCOPE = "local";
const accountSpaceScope = (userId: string) => `account:${userId}`;
const tabloomSiteUrl = import.meta.env.VITE_TABLOOM_WEB_URL || "https://tabloom.nickvu.dev";

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

function useExtensionRuntime() {
  const [bootstrapReady, setBootstrapReady] = useState(false);
  // Repository, identity and preference namespace must become visible in one render.
  const [workspace, setWorkspace] = useState<{
    repository: WorkspaceRepository;
    scope: string;
    userId: string;
    bookmarkRepository: BookmarkRepository | null;
  } | null>(null);
  const repository = workspace?.repository ?? null;
  const bookmarkRepository = workspace?.bookmarkRepository ?? null;
  const workspaceScope = workspace?.scope ?? LOCAL_SPACE_SCOPE;
  const workspaceUserId = workspace?.userId ?? "local-user";
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [user, setUser] = useState<(SyncUser & { id: string }) | null>(null);
  const [syncStatus, setSyncStatus] = useState<"local" | "checking" | "pending" | "synced" | "error">("local");
  const [workspaceSync, setWorkspaceSync] = useState<{ coordinator: FirstSyncCoordinator; preview: WorkspaceMergePlan; generation: number } | null>(null);
  const [workspaceSyncBusy, setWorkspaceSyncBusy] = useState(false);
  const [workspaceSyncError, setWorkspaceSyncError] = useState<string | null>(null);
  const [recoverySuggested, setRecoverySuggested] = useState(false);
  const [signInOpenRequest, setSignInOpenRequest] = useState(0);
  const online = useOnlineStatus();
  const silentRecoveryBusyRef = useRef(false);
  const localRepositoryRef = useRef<WorkspaceRepository | null>(null);
  const syncUserIdRef = useRef<string | null>(null);
  const localFirstStorageRef = useRef<LocalFirstStorage | null>(null);
  const coordinatorRef = useRef<WorkspaceSyncCoordinator | null>(null);
  const coordinatorCleanupRef = useRef<(() => void) | null>(null);
  const activationGenerationRef = useRef(0);
  const [coordinatorState, setCoordinatorState] = useState<WorkspaceSyncState | null>(null);
  const shareRepository = useMemo(
    () => extensionSupabase && user
      ? new SupabaseCollectionShareRepository(extensionSupabase as unknown as CollectionShareClient)
      : null,
    [user],
  );
  const shareAvailability: ShareAvailability = !extensionSupabase || !user
    ? "sign-in-required"
    : !online || coordinatorState?.phase === "offline"
      ? "offline"
      : syncStatus === "synced" && (!coordinatorState || coordinatorState.phase === "synced")
        ? "ready"
        : "sync-required";

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
    stopActiveCoordinator();
    const storage = new LocalFirstStorage(browserAdapter.storage, userId, {
      subscribeToChanges: (listener) => browserAdapter.storageChanges.subscribe(listener),
    });
    const coordinator = new WorkspaceSyncCoordinator({
      userId,
      storage,
      transport: new SupabaseWorkspaceSyncTransport(extensionSupabase),
      exclusiveRunner: new WorkspaceSyncLock({
        area: browserAdapter.storage,
        waitForLeaseChange: waitForStorageKey,
      }),
      onActionRequired: (message) => {
        if (coordinatorRef.current === coordinator && activationGenerationRef.current === generation) setError(message);
      },
      onSnapshotCommitted: () => {
        if (coordinatorRef.current !== coordinator || syncUserIdRef.current !== userId || activationGenerationRef.current !== generation) return;
        setRefreshVersion((value) => value + 1);
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
    if (activationGenerationRef.current !== generation) { coordinator.stop(); return; }
    localFirstStorageRef.current = storage;
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
    setWorkspace({ repository: localFirst, scope: accountSpaceScope(userId), userId, bookmarkRepository: new SupabaseBookmarkRepository(extensionSupabase, userId) });
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
        setWorkspace({ repository: local, scope: LOCAL_SPACE_SCOPE, userId: "local-user", bookmarkRepository: null });
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
      if (activationGenerationRef.current !== generation) return;
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

  async function signIn() {
    const generation = ++activationGenerationRef.current;
    const session = await signInExtensionWithGoogle();
    const local = localRepositoryRef.current;
    if (!extensionSupabase || !local || activationGenerationRef.current !== generation) return;
    await authRecoveryPreference.clear();
    if (activationGenerationRef.current !== generation) return;
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
    if (activationGenerationRef.current !== generation) return;
    if (local) {
      const localSnapshot = await local.load();
      if (activationGenerationRef.current !== generation) return;
      await cache.write(mergeAccountWorkspaceIntoLocal(localSnapshot, accountSnapshot));
    } else {
      await cache.write(accountSnapshot);
    }
    if (activationGenerationRef.current !== generation) return;
    const nextLocal = await createLocalWorkspaceRepository();
    if (activationGenerationRef.current !== generation) return;
    try {
      const { error: signOutError } = await extensionSupabase.auth.signOut();
      if (signOutError) throw signOutError;
    } catch (reason) {
      if (activationGenerationRef.current === generation) await activateCanonical(userId, generation);
      throw reason;
    }
    if (activationGenerationRef.current !== generation) return;
    await authRecoveryPreference.suppress();
    if (activationGenerationRef.current !== generation) return;
    syncUserIdRef.current = null;
    localRepositoryRef.current = nextLocal;
    setWorkspaceSync(null);
    setSyncStatus("local");
    setUser(null);
    setWorkspace({ repository: nextLocal, scope: LOCAL_SPACE_SCOPE, userId: "local-user", bookmarkRepository: null });
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


  return {
    bootstrapReady, repository, bookmarkRepository, workspaceScope, workspaceUserId, refreshVersion,
    message, setMessage, error, setError, user, syncStatus, coordinatorState,
    workspaceSync, workspaceSyncBusy, workspaceSyncError, confirmWorkspaceSync, cancelWorkspaceSync,
    signIn, logout, retryWorkspaceSync, recoverySuggested, signInOpenRequest, setSignInOpenRequest,
    shareAvailability, shareRepository, bookmarkCache,
    retryFailed: () => coordinatorRef.current?.retryFailed() ?? retryWorkspaceSync(),
  };
}

type ExtensionRuntime = ReturnType<typeof useExtensionRuntime>;

export function ExtensionApp({ trashRepository }: { trashRepository?: WorkspaceTrashRepository } = {}) {
  const runtime = useExtensionRuntime();
  return <WorkspaceBootBoundary ready={runtime.bootstrapReady} label="Restoring workspace">
    {runtime.repository && <ExtensionOrganizer runtime={runtime} repository={runtime.repository} trashRepository={trashRepository} />}
    {!runtime.repository && runtime.error && <p role="alert">{runtime.error}</p>}
  </WorkspaceBootBoundary>;
}

function ExtensionOrganizer({ runtime, repository, trashRepository }: { runtime: ExtensionRuntime; repository: WorkspaceRepository; trashRepository?: WorkspaceTrashRepository }) {
  const { bookmarkRepository, workspaceScope, user, message, error, setMessage, setError, syncStatus, coordinatorState, signIn, logout, retryWorkspaceSync, recoverySuggested, signInOpenRequest, setSignInOpenRequest, shareAvailability, shareRepository, bookmarkCache, workspaceSync, workspaceSyncBusy, workspaceSyncError, confirmWorkspaceSync, cancelWorkspaceSync } = runtime;
  const [tabsExpanded, setTabsExpanded] = useState(true);
  const [tabsRefreshVersion, setTabsRefreshVersion] = useState(0);
  const [pendingTab, setPendingTab] = useState<{ tab: CaptureTab; collectionId: string; duplicate?: SavedLink } | null>(null);
  const [pendingBookmark, setPendingBookmark] = useState<{ link: SavedLink; collectionId: string; duplicate: SavedLink } | null>(null);
  const [savingDroppedTab, setSavingDroppedTab] = useState(false);
  const [browserTabDrag, setBrowserTabDrag] = useState({ active: false, session: 0 });

  const savingDroppedTabRef = useRef(false);
  const preferenceStore = useMemo(() => createExtensionPreferenceStore(browserAdapter.storage), []);
  const capabilities = useMemo<OrganizerCapabilities>(() => ({
    currentTabs: {
      async list() { return (await browserAdapter.tabs.listCurrentWindow()).filter((tab) => !tab.active); },
      async activate(tabId) {
        const result = await browserAdapter.tabs.activateExisting(tabId);
        if (result.cleanupError) setError(result.cleanupError);
      },
    },
    ...(browserAdapter.capabilities.bookmarks ? { bookmarks: { supported: true as const } } : {}),
    async openLink({ url, newTab }) { if (newTab) window.open(url, "_blank", "noopener,noreferrer"); else window.location.assign(url); },
    openCollection,
    async resolveFavicon(url, capturedUrl) { return browserAdapter.favicons.resolve({ pageUrl: url, capturedUrl, size: 32 }); },
  // Native callbacks only depend on React's stable notification setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [setError, setMessage]);
  const organizerOptions = {
    repository, trashRepository, deleteSource: "extension" as const, userId: runtime.workspaceUserId,
    preferenceStore, preferenceScope: workspaceScope, capabilities,
    mutationPolicy: "preserveLocalOnFailure" as const, onRetry: runtime.retryFailed,
  };
  const controller = useWorkspaceController(organizerOptions);
  const { snapshot, activeSpace } = controller;
  useEffect(() => {
    if (!controller.ready || (!message && !error)) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (message) { controller.notify(message); setMessage((current) => current === message ? "" : current); }
      if (error) { controller.notify(error, "error"); setError((current) => current === error ? "" : current); }
    });
    return () => { active = false; };
  // Browser status is handed to the organizer's single notification queue once ready.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.ready, message, error, setMessage, setError]);
  const refreshSeen = useRef(runtime.refreshVersion);
  useEffect(() => {
    if (!controller.ready || refreshSeen.current === runtime.refreshVersion) return;
    refreshSeen.current = runtime.refreshVersion;
    void controller.reload();
  // Leave pending commits unconsumed during initialization, then coalesce into one canonical read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.refreshVersion, controller.ready]);
  const load = () => controller.reload();
  async function confirmDroppedTab(closeAfterSave: boolean) {
    if (!repository || !pendingTab || savingDroppedTabRef.current) return;
    savingDroppedTabRef.current = true;
    setSavingDroppedTab(true);
    try {
      const result = await saveDroppedTab({ tab: pendingTab.tab, collectionId: pendingTab.collectionId, closeAfterSave, repository, closeTabs: browserAdapter.tabs.close });
      await load();
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
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not copy this bookmark.");
    }
  }

  const bookmarkWorkspace = repository && bookmarkRepository
    ? new CombinedWorkspaceRepository(repository, bookmarkRepository)
    : null;

  return <div className="extension-workspace">
    <WorkspaceOrganizerView {...organizerOptions} controller={controller} savedLinkNewTab={false}
      highlightedLinkId={pendingTab?.duplicate?.id ?? pendingBookmark?.duplicate.id}
      resolveFavicon={browserAdapter.favicons.resolve}
      mainContentBefore={activeSpace?.id === BROWSER_BOOKMARKS_SPACE_ID && bookmarkRepository && bookmarkWorkspace && browserAdapter.capabilities.bookmarks
        ? <BrowserBookmarksPanel repository={bookmarkRepository} workspace={bookmarkWorkspace} cache={bookmarkCache} onWorkspaceReload={load} /> : null}
      headerActions={user && !coordinatorState && (syncStatus === "pending" || syncStatus === "error") ? <button className="sync-login-trigger sync-retry-trigger" onClick={() => void retryWorkspaceSync()}>Retry sync</button> : null}
      accountControls={<SyncLoginPrompt callbackUrl={oauthCallbackUrl} configured={Boolean(extensionSupabase)} onSignIn={signIn} onLogout={logout} onRetrySync={controller.retry} openRequest={signInOpenRequest} recoverySuggested={recoverySuggested} syncState={coordinatorState ?? undefined} target={browserTarget} user={user} />}
      currentTabs={<CurrentTabsSheet activeSpaceId={activeSpace?.origin === "saved" ? activeSpace.id : undefined} collections={snapshot?.collections.filter((item) => item.origin === "saved" && item.space_id === activeSpace?.id) ?? []} expanded={tabsExpanded} repository={repository} refreshVersion={tabsRefreshVersion} resolveFavicon={browserAdapter.favicons.resolve} subscribeToTabChanges={browserAdapter.tabChanges.subscribe} onError={setError} onExpandedChange={setTabsExpanded} onMessage={setMessage} onTabDragChange={(dragging) => setBrowserTabDrag((current) => dragging ? { active: true, session: current.session + 1 } : { ...current, active: false })} onWorkspaceReload={() => load()} />}
      externalDrop={browserTabDropAdapter(browserTabDrag.active ? browserTabDrag.session : 0, (tab, collectionId) => {
        setBrowserTabDrag((current) => ({ ...current, active: false }));
        setPendingTab({ tab, collectionId, duplicate: findDuplicateLink(snapshot.links.filter((item) => item.origin === "saved"), collectionId, tab.url ?? "") });
      })}
      onBookmarkDrop={handleBookmarkDrop}
      share={{ availability: shareAvailability, repository: shareRepository, siteUrl: tabloomSiteUrl, onRequestSignIn: () => setSignInOpenRequest((value) => value + 1), onRequestSyncRetry: () => { void retryWorkspaceSync(); }, onToast: setMessage }}
    />
    {pendingTab && <div className="drop-confirm-backdrop"><section className="drop-confirm" role="dialog" aria-modal="true" aria-label={pendingTab.duplicate ? "Duplicate current tab" : "Save dropped tab"}><button className="dialog-close" aria-label="Cancel dropped tab" disabled={savingDroppedTab} onClick={() => setPendingTab(null)}><X size={18} /></button>{pendingTab.duplicate ? <><small>DUPLICATE LINK</small><h2>Already saved in {snapshot?.collections.find((item) => item.id === pendingTab.collectionId)?.name ?? "this collection"}</h2><p>The existing saved card is highlighted. Keep or close the current tab without creating a duplicate, or save another copy.</p><div><button disabled={savingDroppedTab} onClick={keepDuplicateTabOpen}>Keep tab open</button><button disabled={savingDroppedTab || typeof pendingTab.tab.id !== "number"} onClick={() => void closeDuplicateTab()}>Close tab</button><button className="close-after-save" disabled={savingDroppedTab} onClick={() => void confirmDroppedTab(false)}>Save another copy</button></div></> : <><small>SAVE CURRENT TAB</small><h2>{pendingTab.tab.title || "Untitled tab"}</h2><p>Save this tab and keep it open, or close it after Tabloom confirms the link was saved?</p><div><button disabled={savingDroppedTab} onClick={() => setPendingTab(null)}>Cancel</button><button disabled={savingDroppedTab} onClick={() => void confirmDroppedTab(false)}>Save and keep tab open</button><button className="close-after-save" disabled={savingDroppedTab} onClick={() => void confirmDroppedTab(true)}>Save and close tab</button></div></>}</section></div>}
    {pendingBookmark && <div className="drop-confirm-backdrop"><section className="drop-confirm" role="dialog" aria-modal="true" aria-label="Duplicate browser bookmark"><button className="dialog-close" aria-label="Cancel bookmark copy" onClick={() => setPendingBookmark(null)}><X size={18} /></button><small>DUPLICATE LINK</small><h2>Already saved in this collection</h2><p>The existing saved card is highlighted. Keep the Chrome bookmark unchanged, or save another Tabloom copy.</p><div><button onClick={() => setPendingBookmark(null)}>Cancel</button><button className="close-after-save" onClick={() => void confirmBookmarkCopy()}>Save another copy</button></div></section></div>}
    {workspaceSync && <WorkspaceSyncPrompt plan={workspaceSync.preview} busy={workspaceSyncBusy} error={workspaceSyncError} onConfirm={confirmWorkspaceSync} onCancel={cancelWorkspaceSync} />}
  </div>;
}

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<React.StrictMode><ExtensionApp /></React.StrictMode>);
