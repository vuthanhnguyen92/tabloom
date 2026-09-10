import { useEffect, useMemo, useRef, useState } from "react";
import { findDuplicateLink, type Collection, type SavedLink, type WorkspaceSnapshot } from "../domain";
import { WorkspaceConflictError, type WebWorkspaceRepository } from "../repository";
import type { DeleteIntent, DeleteReceipt, TrashSource } from "../trash";
import { CommittedRestoreRefreshError } from "../trash";
import type { WorkspaceTrashRepository } from "../trash-repository";
import type { OrganizerCapabilities } from "./capabilities";
import { previewCollectionDrop, type OrganizerDragState } from "./drag-model";
import { applyMutationFailure, assertWritable, reduceWorkspaceSnapshot, type MutationPolicy, type WorkspaceMutation } from "./mutation-policy";
import { CollectionCollapsePreference, SelectedSpacePreference, type OrganizerPreferenceStore } from "./preferences";
import type { OrganizerToast } from "./ToastRegion";
import type { WorkspaceDialogCommand, WorkspaceDialogState } from "./WorkspaceDialogs";

export type WorkspaceControllerOptions = {
  repository: WebWorkspaceRepository;
  trashRepository?: WorkspaceTrashRepository;
  deleteSource?: TrashSource;
  userId: string;
  preferenceStore: OrganizerPreferenceStore;
  preferenceScope: string;
  capabilities: OrganizerCapabilities;
} & ({ mutationPolicy: "rollbackOnFailure"; onRetry?: () => Promise<void> } | { mutationPolicy: "preserveLocalOnFailure"; onRetry: () => Promise<void> });

const emptySnapshot: WorkspaceSnapshot = { spaces: [], collections: [], links: [] };
const railKey = "tabloom:sidebar-collapsed";
const order = <T extends { position: number }>(items: T[]) => [...items].sort((a, b) => a.position - b.position);
function retainBookmarks<T extends { id: string; origin: string }>(canonical: T[], combined: T[]): T[] {
  const ids = new Set(canonical.map((item) => item.id));
  return [...canonical, ...combined.filter((item) => item.origin === "browser-bookmark" && !ids.has(item.id))];
}

export function useWorkspaceController(options: WorkspaceControllerOptions) {
  const { repository, preferenceScope: scope, preferenceStore, userId, capabilities, trashRepository, deleteSource = "web", mutationPolicy, onRetry } = options;
  // A new session invalidates all old loads/mutations, including ones settling after account switches.
  const session = useMemo(() => ({ repository, scope, preferenceStore, userId, active: true, queue: Promise.resolve(), snapshot: emptySnapshot, selected: "", generation: 0, selectionVersion: 0, pendingIds: new Set<string>(), deleteOperations: new Map<string, string>() }), [repository, scope, preferenceStore, userId]);
  const preferences = useMemo(() => ({ selected: new SelectedSpacePreference(preferenceStore), collapsed: new CollectionCollapsePreference(preferenceStore) }), [preferenceStore]);
  const [state, setState] = useState({ session, snapshot: emptySnapshot, ready: false, selected: "", collapsed: new Set<string>(), railCollapsed: true });
  const [dialog, setDialog] = useState<WorkspaceDialogState>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [drag, setDrag] = useState<OrganizerDragState>(null);
  const [externalDropTarget, setExternalDropTarget] = useState<{ collectionId: string; session: number } | null>(null);
  const [toasts, setToasts] = useState<OrganizerToast[]>([]);
  const [busy, setBusy] = useState(false);
  const [retryRequired, setRetryRequired] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [bootError, setBootError] = useState(false);
  const intent = useRef<DeleteIntent | null>(null);
  const dialogGeneration = useRef(0);
  const duplicateAction = useRef<(() => Promise<unknown>) | null>(null);

  const current = state.session === session ? state : { session, snapshot: emptySnapshot, ready: false, selected: "", collapsed: new Set<string>(), railCollapsed: true };
  function notify(message: string, tone: "success" | "error" = "success") {
    if (session.active) setToasts((items) => [...items, { id: globalThis.crypto.randomUUID(), message, tone }]);
  }
  function publish(snapshot: WorkspaceSnapshot, selected = session.selected) {
    if (!session.active) return;
    const nextSelected = snapshot.spaces.some((space) => space.id === selected) ? selected : order(snapshot.spaces)[0]?.id ?? "";
    session.snapshot = snapshot;
    session.selected = nextSelected;
    setState((previous) => ({ ...previous, session, snapshot, selected: nextSelected, collapsed: new Set([...previous.collapsed].filter((id) => snapshot.collections.some((item) => item.id === id))) }));
    void preferences.selected.select(scope, nextSelected).catch(() => notify("Could not remember the selected space.", "error"));
  }
  useEffect(() => {
    session.active = true;
    const generation = ++session.generation;
    intent.current = null; duplicateAction.current = null; dialogGeneration.current++;
    void (async () => {
      await Promise.resolve();
      if (!session.active || generation !== session.generation) return;
      setDialog(null); setSearchOpen(false); setDrag(null); setExternalDropTarget(null); setToasts([]); setBusy(false); setRetryRequired(false); setRefreshRequired(false); setBootError(false);
      try {
        const [snapshot, rail] = await Promise.all([repository.load(), preferenceStore.get(railKey)]);
        const [selected, collapsed] = await Promise.all([
          preferences.selected.load(scope, order(snapshot.spaces)),
          preferences.collapsed.load(scope, snapshot.collections.map((item) => item.id)),
        ]);
        if (!session.active || generation !== session.generation) return;
        session.snapshot = snapshot; session.selected = selected;
        setState({ session, snapshot, selected, collapsed, railCollapsed: rail !== "false", ready: true });
      } catch {
        if (session.active && generation === session.generation) setBootError(true);
      }
    })();
    return () => { session.active = false; session.generation++; };
  }, [repository, session, scope, preferenceStore, preferences]);

  function enqueue<T>(operation: () => Promise<T>): Promise<T | undefined> {
    const task = session.queue.then(() => session.active ? operation() : undefined);
    session.queue = task.then(() => undefined, () => undefined);
    return task;
  }
  async function reload() {
    await enqueue(async () => {
      try {
        const canonical = await repository.load();
        publish(canonical);
        if (session.active) { setRefreshRequired(false); setToasts((items) => items.filter((toast) => toast.id !== "workspace-refresh")); }
      }
      catch { notify("Workspace could not be refreshed.", "error"); }
    });
  }
  async function retry() {
    if (!onRetry) return;
    await enqueue(async () => {
      try {
        await onRetry();
        const canonical = await repository.load();
        if (!session.active) return;
        session.pendingIds.clear(); publish(canonical); setRetryRequired(false);
        setToasts((items) => items.filter((toast) => toast.id !== "sync-retry"));
      } catch { if (session.active) setRetryRequired(true); }
    });
  }
  function failure(policy: MutationPolicy, before: WorkspaceSnapshot, optimistic: WorkspaceSnapshot, selected: string, notifyRollback = true) {
    const result = applyMutationFailure(policy, before, optimistic);
    publish(result.snapshot, selected);
    if (result.retryRequired) {
      setRetryRequired(true);
      setToasts((items) => [...items.filter((toast) => toast.id !== "sync-retry"), { id: "sync-retry", message: "Changes are saved locally. Failed to sync.", tone: "error", persistent: true, action: { label: "Retry", onAction: () => { void retry(); } } }]);
    } else if (notifyRollback) notify("Changes could not be saved. Please try again.", "error");
  }
  /** Serialize writes and their canonical reads so rollback cannot erase a later mutation. */
  function mutate<T>(mutation: WorkspaceMutation | ((snapshot: WorkspaceSnapshot) => WorkspaceMutation), write: (optimistic: WorkspaceSnapshot, before: WorkspaceSnapshot) => Promise<T>, message = "Saved", resultOptions?: { select?: (result: T) => string; reconcile?: (result: T, optimistic: WorkspaceSnapshot) => WorkspaceSnapshot; canonical?: (result: T) => WorkspaceSnapshot; publishOptimistic?: boolean; notifyFailure?: boolean }): Promise<T | undefined> {
    return enqueue(async () => {
      const before = session.snapshot;
      const selected = session.selected;
      const selectionVersion = session.selectionVersion;
      let optimistic: WorkspaceSnapshot;
      let pendingId: string | undefined;
      try {
        const operation = typeof mutation === "function" ? mutation(before) : mutation;
        optimistic = reduceWorkspaceSnapshot(before, operation);
        if (operation.type === "create-space") pendingId = operation.space.id;
        if (operation.type === "create-collection") pendingId = operation.collection.id;
        if (operation.type === "create-link") pendingId = operation.link.id;
        if (pendingId) session.pendingIds.add(pendingId);
      }
      catch { notify("This change is unavailable for this item.", "error"); return; }
      setBusy(true); if (resultOptions?.publishOptimistic !== false) publish(optimistic); setDrag(null);
      try {
        let result: T;
        try { result = await write(optimistic, before); }
        catch (error) {
          if (!session.active) return;
          if (error instanceof CommittedRestoreRefreshError) {
            if (resultOptions?.publishOptimistic === false) publish(optimistic, session.selectionVersion === selectionVersion ? selected : session.selected);
            setRefreshRequired(true);
            setToasts((items) => [...items.filter((toast) => toast.id !== "workspace-refresh"), { id: "workspace-refresh", message: "Restored, but the workspace needs a refresh.", tone: "error", persistent: true, action: { label: "Refresh", onAction: () => { void reload(); } } }]);
          } else if (error instanceof WorkspaceConflictError && mutationPolicy === "rollbackOnFailure") {
            publish(before, session.selectionVersion === selectionVersion ? selected : session.selected);
            try {
              publish(await repository.load());
              notify("Workspace changed elsewhere. Please try the move again.", "error");
            } catch {
              if (!session.active) return;
              setRefreshRequired(true);
              setToasts((items) => [...items.filter((toast) => toast.id !== "workspace-refresh"), { id: "workspace-refresh", message: "Workspace changed elsewhere. Refresh before trying again.", tone: "error", persistent: true, action: { label: "Refresh", onAction: () => { void reload(); } } }]);
            }
          } else {
            if (pendingId && mutationPolicy === "rollbackOnFailure") session.pendingIds.delete(pendingId);
            failure(mutationPolicy, before, optimistic, session.selectionVersion === selectionVersion ? selected : session.selected, resultOptions?.notifyFailure !== false);
          }
          return;
        }
        if (!session.active) return;
        if (pendingId) session.pendingIds.delete(pendingId);
        const nextSelected = session.selectionVersion === selectionVersion ? resultOptions?.select?.(result) ?? session.selected : session.selected;
        if (resultOptions?.reconcile) publish(resultOptions.reconcile(result, optimistic), nextSelected);
        // A committed write must not be rolled back merely because the follow-up read fails.
        try {
          const canonical = resultOptions?.canonical ? resultOptions.canonical(result) : await repository.load();
          publish(canonical, session.selectionVersion === selectionVersion ? nextSelected : session.selected);
        }
        catch { notify("Saved, but the workspace could not be refreshed.", "error"); return result; }
        if (message) notify(message); return result;
      } finally { if (session.active) setBusy(false); }
    });
  }
  function selectSpace(id: string) {
    if (isPending(id)) return;
    if (!session.snapshot.spaces.some((space) => space.id === id)) return;
    session.selectionVersion++; publish(session.snapshot, id); setDrag(null); setExternalDropTarget(null);
  }
  function setRailCollapsed(value: boolean) {
    setState((previous) => ({ ...previous, railCollapsed: value }));
    void preferenceStore.set(railKey, String(value)).catch(() => notify("Could not remember the sidebar layout.", "error"));
  }
  function toggleCollection(id: string) {
    if (isPending(id)) return;
    const collapsed = !current.collapsed.has(id);
    setState((previous) => { const next = new Set(previous.collapsed); if (collapsed) next.add(id); else next.delete(id); return { ...previous, collapsed: next }; });
    void preferences.collapsed.setCollapsed(scope, id, collapsed).catch(() => notify("Could not remember the collection layout.", "error"));
  }
  function closeDialog() { dialogGeneration.current++; intent.current = null; duplicateAction.current = null; setDialog(null); }
  function isPending(id: string): boolean {
    const link = session.snapshot.links.find((item) => item.id === id);
    const collection = session.snapshot.collections.find((item) => item.id === (link?.collection_id ?? id));
    return session.pendingIds.has(id) || !!link && session.pendingIds.has(link.collection_id) || !!collection && session.pendingIds.has(collection.space_id);
  }
  function hasPendingDialogReference(value: NonNullable<WorkspaceDialogState> | WorkspaceDialogCommand): boolean {
    const id = "id" in value ? value.id : "spaceId" in value ? value.spaceId : "collectionId" in value ? value.collectionId : "space" in value ? value.space.id : "collection" in value ? value.collection.id : "link" in value ? value.link.id : undefined;
    return !!id && isPending(id);
  }
  function openDialog(value: WorkspaceDialogState) { if (value && hasPendingDialogReference(value)) return; closeDialog(); setDrag(null); setDialog(value); }
  async function requestDelete(type: "space" | "collection", id: string) {
    if (isPending(id)) return;
    if (!trashRepository) return;
    try { assertWritable(session.snapshot, type, id); } catch { return; }
    closeDialog();
    const generation = dialogGeneration.current;
    try {
      const prepared = await trashRepository.prepareDelete(type, id);
      if (!session.active || generation !== dialogGeneration.current) return;
      if (prepared.targetId !== id || prepared.targetType !== type) throw new Error("Invalid delete intent");
      intent.current = prepared;
      setDialog({ type: type === "space" ? "delete-space" : "delete-collection", id, name: prepared.targetName, linkCount: prepared.linkCount, collectionCount: prepared.collectionCount });
    } catch { notify("Deletion could not be prepared. Please try again.", "error"); }
  }
  async function deleteEntity(rootType: "space" | "collection" | "link", id: string, intentId?: string): Promise<DeleteReceipt | undefined> {
    if (!trashRepository || isPending(id)) return;
    const key = `${rootType}:${id}`;
    const operationId = session.deleteOperations.get(key) ?? globalThis.crypto.randomUUID();
    session.deleteOperations.set(key, operationId);
    let removed = emptySnapshot;
    const receipt = await mutate({ type: "delete", rootType, id }, async (optimistic, before) => {
      removed = {
        spaces: before.spaces.filter((item) => !optimistic.spaces.some((kept) => kept.id === item.id)),
        collections: before.collections.filter((item) => !optimistic.collections.some((kept) => kept.id === item.id)),
        links: before.links.filter((item) => !optimistic.links.some((kept) => kept.id === item.id)),
      };
      return trashRepository.deleteEntity(rootType, id, deleteSource, operationId, intentId);
    }, "");
    if (!receipt || !session.active) return receipt;
    session.deleteOperations.delete(key);
    const toastId = `undo:${receipt.operationId}`;
    let undoing = false;
    const undo = async () => {
      if (undoing || !session.active) return;
      undoing = true;
      setToasts((items) => items.map((toast) => toast.id === toastId ? { ...toast, persistent: true, action: { ...toast.action!, disabled: true } } : toast));
      const outcome = await restoreWithOutcome(receipt.trashId, removed, undefined, false);
      if (!session.active) return;
      undoing = false;
      if (outcome.committed) setToasts((items) => items.filter((toast) => toast.id !== toastId));
      else setToasts((items) => items.map((toast) => toast.id === toastId ? { id: toastId, message: "Undo could not be completed. Please retry.", tone: "error", persistent: true, action: { label: "Retry Undo", onAction: () => { void undo(); } } } : toast));
    };
    setToasts((items) => [...items, { id: toastId, message: "Moved to Trash", expiresAfter: 3_000, action: { label: "Undo", onAction: () => { void undo(); } } }]);
    return receipt;
  }
  function deleteLink(id: string): Promise<DeleteReceipt | undefined> {
    return deleteEntity("link", id);
  }
  function restore(trashId: string, restored: WorkspaceSnapshot, destinationId?: string) {
    return restoreWithOutcome(trashId, restored, destinationId).then((outcome) => outcome.snapshot);
  }
  async function restoreWithOutcome(trashId: string, restored: WorkspaceSnapshot, destinationId?: string, publishOptimistic = true) {
    if (!trashRepository) return { committed: false, snapshot: undefined };
    let committed = false;
    const snapshot = await mutate({ type: "restore", snapshot: restored }, async () => {
      try {
        const snapshot = await trashRepository.restore(trashId, destinationId);
        committed = true;
        return snapshot;
      } catch (error) {
        committed = error instanceof CommittedRestoreRefreshError;
        throw error;
      }
    }, "Restored", { publishOptimistic, notifyFailure: publishOptimistic, canonical: (snapshot) => ({
      spaces: retainBookmarks(snapshot.spaces, session.snapshot.spaces),
      collections: retainBookmarks(snapshot.collections, session.snapshot.collections),
      links: retainBookmarks(snapshot.links, session.snapshot.links),
    }) });
    return { committed, snapshot };
  }
  function meta(position: number) { const timestamp = new Date().toISOString(); return { id: globalThis.crypto.randomUUID(), user_id: userId, position, created_at: timestamp, updated_at: timestamp, origin: "saved" as const, read_only: false }; }
  async function submitDialog(command: WorkspaceDialogCommand): Promise<unknown> {
    if (hasPendingDialogReference(command)) return;
    if (command.type === "duplicate-link") { const action = duplicateAction.current; closeDialog(); return action?.(); }
    if (command.type === "delete-space" || command.type === "delete-collection") {
      const prepared = intent.current;
      const rootType = command.type === "delete-space" ? "space" : "collection";
      if (!trashRepository || !prepared || prepared.targetId !== command.id || prepared.targetType !== rootType || Date.parse(prepared.expiresAt) <= Date.now()) { notify("Deletion needs a fresh confirmation.", "error"); return; }
      const generation = dialogGeneration.current;
      const receipt = await deleteEntity(rootType, command.id, prepared.intentId);
      if (receipt && session.active && generation === dialogGeneration.current) closeDialog();
      return receipt;
    }
    if (command.type === "open-many") { closeDialog(); return openUrls(command.name, [...command.urls]); }
    const run = async () => {
      switch (command.type) {
        case "create-space": return mutate((snapshot) => ({ type: "create-space", space: { ...meta(snapshot.spaces.length), name: command.name, color: command.color } }), () => repository.createSpace({ name: command.name, color: command.color }), "Space created", { select: (space) => space.id, reconcile: (space, optimistic) => ({ ...optimistic, spaces: [...optimistic.spaces.slice(0, -1), space] }) });
        case "edit-space": return mutate({ type: "update-space", id: command.id, input: { name: command.name, color: command.color } }, () => repository.updateSpace(command.id, { name: command.name, color: command.color }));
        case "create-collection": return mutate((snapshot) => ({ type: "create-collection", collection: { ...meta(snapshot.collections.filter((item) => item.space_id === command.spaceId).length), name: command.name, space_id: command.spaceId } }), () => repository.createCollection({ name: command.name, space_id: command.spaceId }), "Collection created", { reconcile: (collection, optimistic) => ({ ...optimistic, collections: [...optimistic.collections.slice(0, -1), collection] }) });
        case "edit-collection": return mutate({ type: "update-collection", id: command.id, input: { name: command.name } }, () => repository.updateCollection(command.id, { name: command.name }));
        case "create-link": {
          const input = { collection_id: command.collectionId, title: command.title, url: command.url, description: command.description, favicon_url: null };
          return mutate((snapshot) => ({ type: "create-link", link: { ...meta(snapshot.links.filter((item) => item.collection_id === command.collectionId).length), ...input } }), () => repository.createLink(input), "Link saved", { reconcile: (link, optimistic) => ({ ...optimistic, links: [...optimistic.links.slice(0, -1), link] }) });
        }
        case "edit-link": {
          const input = { title: command.title, url: command.url, description: command.description };
          return mutate({ type: "update-link", id: command.id, input }, () => repository.updateLink(command.id, input));
        }
      }
    };
    if (command.type === "create-link") {
      const duplicate = findDuplicateLink(session.snapshot.links, command.collectionId, command.url);
      if (duplicate) { openDialog({ type: "duplicate-link", title: duplicate.title }); duplicateAction.current = run; return; }
    }
    closeDialog(); return run();
  }
  async function openUrls(name: string, urls: string[]) {
    try { await capabilities.openCollection(name, urls); } catch { notify("Links could not be opened.", "error"); }
  }
  function openCollection(collection: Collection, links: SavedLink[]) {
    const urls = order(links).map((link) => link.url);
    if (urls.length > 15) openDialog({ type: "open-many", name: collection.name, urls });
    else void openUrls(collection.name, urls);
  }
  function moveLink(id: string, collectionId: string, index: number) {
    const link = session.snapshot.links.find((item) => item.id === id);
    if (!link || isPending(id) || isPending(collectionId)) return Promise.resolve(undefined);
    const run = () => mutate({ type: "move-link", id, collectionId, index }, async (optimistic, before) => {
      const source = before.links.find((item) => item.id === id)!;
      const destinationOrderedIds = order(optimistic.links.filter((item) => item.collection_id === collectionId)).map((item) => item.id);
      if (source.collection_id === collectionId) await repository.reorderLinks(collectionId, destinationOrderedIds);
      else await repository.moveLink({
        id, sourceCollectionId: source.collection_id, destinationCollectionId: collectionId, destinationOrderedIds,
        sourceOrderedIds: order(optimistic.links.filter((item) => item.collection_id === source.collection_id)).map((item) => item.id),
        expectedSource: before.links.filter((item) => item.collection_id === source.collection_id).map(({ id, position }) => ({ id, position })),
        expectedDestination: before.links.filter((item) => item.collection_id === collectionId).map(({ id, position }) => ({ id, position })),
      });
    }, "Link moved");
    const duplicate = findDuplicateLink(session.snapshot.links, collectionId, link.url, id);
    if (link.collection_id !== collectionId && duplicate) { openDialog({ type: "duplicate-link", title: duplicate.title, actionLabel: "Move anyway" }); duplicateAction.current = run; return Promise.resolve(undefined); }
    return run();
  }
  function moveCollection(id: string, index: number) {
    if (isPending(id)) return Promise.resolve(undefined);
    const source = session.snapshot.collections.find((item) => item.id === id);
    if (!source) return Promise.resolve(undefined);
    return mutate((snapshot) => ({ type: "reorder-collections", spaceId: source.space_id, ids: previewCollectionDrop(snapshot.collections.filter((item) => item.space_id === source.space_id), id, index).map((item) => item.id) }), (optimistic) => repository.reorderCollections(source.space_id, order(optimistic.collections.filter((item) => item.space_id === source.space_id)).map((item) => item.id)), "Collection moved");
  }
  function commitDrag() {
    const currentDrag = drag; setDrag(null);
    if (currentDrag?.kind === "collection") return moveCollection(currentDrag.id, currentDrag.overIndex);
    if (currentDrag?.kind === "saved-link") return moveLink(currentDrag.id, currentDrag.targetCollectionId, currentDrag.overIndex);
  }
  return {
    ready: current.ready, bootError, snapshot: current.snapshot, selectedSpaceId: current.selected,
    activeSpace: current.snapshot.spaces.find((space) => space.id === current.selected),
    collapsedCollections: current.collapsed, railCollapsed: current.railCollapsed,
    dialog, searchOpen, drag, externalDropTarget, toasts, busy, retryRequired, refreshRequired, isPending,
    selectSpace, setRailCollapsed, toggleCollection, openDialog, closeDialog, submitDialog,
    requestDelete, deleteLink, restore, reload, retry, mutate, notify, openCollection, moveLink, moveCollection,
    setSearchOpen, setDrag: (value: OrganizerDragState) => {
      if (value?.kind === "collection" && isPending(value.id) || value?.kind === "saved-link" && (isPending(value.id) || isPending(value.targetCollectionId))) return;
      setDrag(value);
    }, setExternalDropTarget, commitDrag,
    dismissToast: (id: string) => setToasts((items) => items.filter((toast) => toast.id !== id)),
  };
}

export type WorkspaceController = ReturnType<typeof useWorkspaceController>;
