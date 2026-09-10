import type { WorkspaceSnapshot } from "../shared/domain";
import type { WorkspaceRepository } from "../shared/repository";
import { WorkspaceCommandError, LocallyCommittedTrashError, decodeTrashEntry, decodeDeleteReceipt, type DeleteIntent, type DeleteReceipt, type TrashRootType, type TrashSource, type WorkspaceTrashEntry } from "../shared/trash";
import type { WorkspaceTrashRepository } from "../shared/trash-repository";
import { assertWritable, reduceWorkspaceSnapshot } from "../shared/organizer/mutation-policy";
import type { StorageArea } from "./workspace-cache";

export type LocalTrashEntry = WorkspaceTrashEntry & { operationId: string; localId: string; remoteOnly?: boolean; restoreOperationId?: string; restorePending?: boolean; restoreDestinationId?: string; restoreRejected?: boolean };
export type LocalTrashMutation = { operationId: string; rootType: TrashRootType; rootId: string; action: "delete" | "restore"; deleteOperationId?: string; trashId?: string; destinationId?: string; snapshot?: WorkspaceSnapshot };
export type LocalTrashCommit = { snapshot: WorkspaceSnapshot; values: Record<string, unknown> };
export interface LocalTrashWorkspace {
  readonly syncsTrash?: boolean;
  readonly trashOwnerId: string;
  load(): Promise<WorkspaceSnapshot>;
  pendingTrashOperation?(operationId: string): Promise<boolean>;
  commitTrash(mutation: LocalTrashMutation | undefined, beforeCommit: (before: WorkspaceSnapshot) => Promise<LocalTrashCommit>): Promise<WorkspaceSnapshot>;
}
export const localTrashKey = (scope: string) => `tabloom-trash-v1:${scope}`;
const generationKey = (scope: string) => `tabloom-trash-generation-v1:${scope}`;
const retention = 30 * 24 * 60 * 60 * 1000;

/** Local confirmation metadata is ephemeral human intent, never server authorization. */
export class LocalTrashRepository implements WorkspaceTrashRepository {
  private intents = new Map<string, { intent: DeleteIntent; fingerprint: string; generation: number }>();
  private now: () => number;
  private remote?: WorkspaceTrashRepository;
  constructor(private area: StorageArea, private workspace: WorkspaceRepository | LocalTrashWorkspace, private scope: string, options: { now?: () => number; remote?: WorkspaceTrashRepository } = {}) { this.now = options.now ?? Date.now; this.remote = options.remote; }
  private async entries(): Promise<LocalTrashEntry[]> {
    const stored = (await this.area.get(localTrashKey(this.scope)))[localTrashKey(this.scope)];
    if (stored === undefined) return [];
    if (!Array.isArray(stored)) throw new Error("Local Trash is unavailable.");
    const entries = stored.map((value) => this.validateEntry(value));
    // Keep backing rows as operation/local-receipt aliases, but a canonical
    // receipt has one deadline even in caches written by older versions.
    const receipts = new Map<string, LocalTrashEntry>();
    for (const entry of entries) {
      const previous = receipts.get(entry.id);
      if (previous && (previous.rootId !== entry.rootId || previous.rootType !== entry.rootType)) throw new Error("Conflicting canonical Trash aliases.");
      if (!previous || Date.parse(entry.expiresAt) < Date.parse(previous.expiresAt)) receipts.set(entry.id, entry);
    }
    return entries.map((entry) => ({ ...entry, expiresAt: receipts.get(entry.id)!.expiresAt }));
  }
  private canonicalEntries(entries: LocalTrashEntry[]): LocalTrashEntry[] {
    const canonical = new Map<string, LocalTrashEntry>();
    for (const entry of entries) {
      const previous = canonical.get(entry.id);
      if (!previous || entry.restorePending && !previous.restorePending || !previous.restorePending && entry.restoredAt && !previous.restoredAt) canonical.set(entry.id, entry);
    }
    return [...canonical.values()];
  }
  private validateEntry(value: unknown): LocalTrashEntry {
    if (!value || typeof value !== "object") throw new Error("Invalid local Trash.");
    const entry = structuredClone(value) as LocalTrashEntry;
    const { operationId, localId, remoteOnly, restoreOperationId, restorePending, restoreDestinationId, restoreRejected, ...common } = entry;
    if (typeof localId !== "string" || (remoteOnly !== undefined && typeof remoteOnly !== "boolean") || (restorePending !== undefined && typeof restorePending !== "boolean") || (restoreRejected !== undefined && typeof restoreRejected !== "boolean") || (restoreDestinationId !== undefined && typeof restoreDestinationId !== "string")) throw new Error("Invalid local Trash.");
    const snapshot = common.snapshot;
    if (!snapshot || !Array.isArray(snapshot.spaces) || !Array.isArray(snapshot.collections) || !Array.isArray(snapshot.links)) throw new Error("Invalid local Trash snapshot.");
    const owner = this.backend().trashOwnerId;
    for (const item of [...snapshot.spaces, ...snapshot.collections, ...snapshot.links]) if (item.user_id !== owner) throw new Error("Invalid Trash owner.");
    const normalized = owner === "local-user" ? {
      ...snapshot, spaces: snapshot.spaces.map((item) => ({ ...item, user_id: "00000000-0000-4000-8000-000000000001" })),
      collections: snapshot.collections.map((item) => ({ ...item, user_id: "00000000-0000-4000-8000-000000000001" })),
      links: snapshot.links.map((item) => ({ ...item, user_id: "00000000-0000-4000-8000-000000000001" })),
    } : snapshot;
    decodeTrashEntry({ ...common, snapshot: normalized });
    decodeDeleteReceipt({ operationId, trashId: localId, rootType: entry.rootType, rootId: entry.rootId, restoreUntil: entry.expiresAt });
    if (restoreOperationId) decodeDeleteReceipt({ operationId: restoreOperationId, trashId: localId, rootType: entry.rootType, rootId: entry.rootId, restoreUntil: entry.expiresAt });
    return entry;
  }
  private values(entries: LocalTrashEntry[]) { return { [localTrashKey(this.scope)]: entries }; }
  private async generation(): Promise<number> {
    const value = (await this.area.get(generationKey(this.scope)))[generationKey(this.scope)];
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Local confirmation generation is unavailable.");
    return value as number;
  }
  private async updateEntries(update: (entries: LocalTrashEntry[]) => LocalTrashEntry[]) {
    await this.backend().commitTrash(undefined, async (snapshot) => ({ snapshot, values: this.values(update(await this.entries())) }));
  }
  async list(): Promise<LocalTrashEntry[]> {
    if (this.remote) {
      let remoteEntries: Array<WorkspaceTrashEntry & { operationId?: string }> | undefined;
      try { remoteEntries = await (this.remote.listForSync?.() ?? this.remote.list()); } catch { /* Previously cached entries remain available offline. */ }
      if (remoteEntries) await this.updateEntries((entries) => {
        const remoteIds = new Set(remoteEntries.map((entry) => entry.id));
        const retained = entries.filter((entry) => entry.restoredAt || entry.id === entry.localId && !entry.remoteOnly || remoteIds.has(entry.id)).map((entry) => {
          const remote = remoteEntries.find((item) => item.operationId === entry.operationId || item.id === entry.id);
          return remote ? { ...entry, id: remote.id, expiresAt: remote.expiresAt } : entry;
        });
        return [...retained, ...remoteEntries.filter((entry) => !retained.some((local) => local.id === entry.id)).map((entry) => ({ ...entry, operationId: entry.operationId ?? crypto.randomUUID(), localId: entry.id, remoteOnly: true }))];
      });
    }
    const entries = await this.entries();
    let purged = 0;
    const retained = entries.filter((entry) => !(Date.parse(entry.expiresAt) <= this.now() && purged++ < 100));
    if (retained.length !== entries.length) await this.updateEntries((current) => { let count = 0; return current.filter((entry) => !(Date.parse(entry.expiresAt) <= this.now() && count++ < 100)); });
    return this.canonicalEntries(retained).filter((entry) => (!entry.restoredAt || entry.restorePending) && Date.parse(entry.expiresAt) > this.now()).sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
  }
  async saveLocal(entry: LocalTrashEntry): Promise<void> {
    this.validateEntry(entry);
    await this.updateEntries((entries) => {
      const previous = entries.find((item) => item.operationId === entry.operationId);
      if (previous && (previous.rootId !== entry.rootId || previous.rootType !== entry.rootType)) throw new WorkspaceCommandError("conflict", "Deletion operation was already used.");
      return previous ? entries : [...entries, entry];
    });
  }
  async reconcileRemote(operationId: string, receipt: DeleteReceipt): Promise<void> {
    await this.updateEntries((entries) => {
      const entry = entries.find((item) => item.operationId === operationId);
      if (!entry) return entries;
      if (receipt.operationId !== operationId || receipt.rootId !== entry.rootId || receipt.rootType !== entry.rootType) throw new WorkspaceCommandError("conflict", "Trash receipt did not match.");
      return entries.map((item) => item === entry || item.id === receipt.trashId ? { ...item, id: receipt.trashId, expiresAt: receipt.restoreUntil } : item);
    });
  }
  async completeRestore(operationId: string): Promise<void> {
    await this.updateEntries((entries) => entries.map((entry) => entry.restoreOperationId === operationId ? { ...entry, restorePending: false } : entry));
  }
  async rejectRestore(operationId: string): Promise<void> {
    await this.updateEntries((entries) => entries.map((entry) => entry.restoreOperationId === operationId
      ? { ...entry, restoreRejected: true, restorePending: false, restoredAt: null } : entry));
  }
  private tree(snapshot: WorkspaceSnapshot, rootType: TrashRootType, rootId: string) {
    assertWritable(snapshot, rootType, rootId);
    const after = reduceWorkspaceSnapshot(snapshot, { type: "delete", rootType, id: rootId });
    const tree = { version: 1 as const, rootType,
      spaces: snapshot.spaces.filter((item) => !after.spaces.some((live) => live.id === item.id)),
      collections: snapshot.collections.filter((item) => !after.collections.some((live) => live.id === item.id)),
      links: snapshot.links.filter((item) => !after.links.some((live) => live.id === item.id)),
    };
    for (const item of [...tree.spaces, ...tree.collections, ...tree.links]) if (item.read_only || item.origin !== "saved") throw new WorkspaceCommandError("read_only", "Protected items cannot be deleted.");
    return { tree, after };
  }
  async prepareDelete(rootType: "space" | "collection", rootId: string): Promise<DeleteIntent> {
    let prepared!: DeleteIntent;
    await this.backend().commitTrash(undefined, async (snapshot) => {
      const { tree } = this.tree(snapshot, rootType, rootId);
      prepared = { intentId: crypto.randomUUID(), targetType: rootType, targetId: rootId, targetName: (rootType === "space" ? tree.spaces : tree.collections)[0].name,
        collectionCount: rootType === "space" ? tree.collections.length : 0, linkCount: tree.links.length, expiresAt: new Date(this.now() + 5 * 60 * 1000).toISOString() };
      this.intents.set(prepared.intentId, { intent: prepared, fingerprint: JSON.stringify(tree), generation: await this.generation() });
      return { snapshot, values: {} };
    });
    return prepared;
  }
  private backend(): LocalTrashWorkspace {
    if (!("commitTrash" in this.workspace)) throw new Error("Workspace does not support local Trash.");
    return this.workspace as LocalTrashWorkspace;
  }
  async deleteEntity(rootType: TrashRootType, rootId: string, source: TrashSource, operationId: string, confirmationIntentId?: string): Promise<DeleteReceipt> {
    let entry = (await this.entries()).find((item) => item.operationId === operationId);
    if (entry && (entry.rootId !== rootId || entry.rootType !== rootType)) throw new WorkspaceCommandError("conflict", "Deletion operation was already used.");
    if (!entry) {
      if (rootType !== "link") {
        const intent = this.intents.get(confirmationIntentId ?? "")?.intent;
        if (!intent || intent.targetType !== rootType || intent.targetId !== rootId) throw new WorkspaceCommandError("confirmation_required", "Confirm deletion first.");
        if (Date.parse(intent.expiresAt) <= this.now()) throw new WorkspaceCommandError("confirmation_expired", "Confirm deletion again.");
      }
      try { await this.backend().commitTrash({ action: "delete", rootType, rootId, operationId }, async (before) => {
        const { tree, after } = this.tree(before, rootType, rootId);
        const generation = await this.generation();
        const intent = this.intents.get(confirmationIntentId ?? "");
        if (rootType !== "link" && (!intent || intent.fingerprint !== JSON.stringify(tree) || intent.generation !== generation)) throw new WorkspaceCommandError("confirmation_required", "The tree changed. Confirm deletion again.");
        const id = crypto.randomUUID();
        entry = { id, localId: id, operationId, rootType, rootId, rootName: rootType === "link" ? tree.links[0].title : (rootType === "space" ? tree.spaces : tree.collections)[0].name,
          source, deletedAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + retention).toISOString(), restoredAt: null, snapshot: tree };
        this.validateEntry(entry);
        return { snapshot: after, values: { ...this.values([...(await this.entries()), entry]), [generationKey(this.scope)]: generation + 1 } };
      }); this.intents.clear(); } catch (cause) {
        if (cause instanceof LocallyCommittedTrashError) {
          this.intents.clear();
          const saved = (await this.entries()).find((item) => item.operationId === operationId)!;
          throw new LocallyCommittedTrashError(cause.snapshot, { operationId, trashId: saved.id, rootType, rootId, restoreUntil: saved.expiresAt }, { cause });
        }
        throw cause;
      }
    }
    return { operationId, trashId: entry!.id, rootType, rootId, restoreUntil: entry!.expiresAt };
  }
  async restore(trashId: string, destinationId?: string): Promise<WorkspaceSnapshot> {
    const entries = await this.entries();
    const alias = entries.find((item) => item.id === trashId || item.localId === trashId);
    const entry = alias && this.canonicalEntries(entries.filter((item) => item.id === alias.id))[0];
    if (!entry || Date.parse(entry.expiresAt) <= this.now()) throw new WorkspaceCommandError("not_found", "Recovery has expired.");
    // A receipt callback can finish before the queue acknowledgement is saved.
    // The queue is the authority for whether an attempted outcome is resolved.
    if (entry.restoreOperationId && this.backend().pendingTrashOperation) entry.restorePending = await this.backend().pendingTrashOperation!(entry.restoreOperationId);
    if (entry.restoredAt && !entry.restorePending) {
      const current = await this.workspace.load();
      return destinationId ? this.relocate(entry, current, destinationId) : current;
    }
    destinationId ??= entry.restoreDestinationId;
    const restored = structuredClone(entry.snapshot);
    if (entry.rootType === "space" && destinationId) throw new WorkspaceCommandError("validation_failed", "Spaces do not accept destinations.");
    if (entry.rootType === "collection" && destinationId) restored.collections[0].space_id = destinationId;
    if (entry.rootType === "link" && destinationId) restored.links[0].collection_id = destinationId;
    const operationId = entry.restoreRejected && !entry.restorePending ? crypto.randomUUID() : entry.restoreOperationId ?? crypto.randomUUID();
    const mutation: LocalTrashMutation = { action: "restore", operationId, rootType: entry.rootType, rootId: entry.rootId, ...(entry.remoteOnly ? { trashId: entry.id } : { deleteOperationId: entry.operationId }), destinationId,
      snapshot: { spaces: restored.spaces, collections: restored.collections, links: restored.links } };
    const result = await this.backend().commitTrash(mutation, async (before) => {
      if (entry.restorePending) throw new WorkspaceCommandError("conflict", "The original restore must be reconciled before retrying.");
      if (entry.rootType !== "space") {
        const type = entry.rootType === "link" ? "collection" : "space";
        const id = entry.rootType === "link" ? restored.links[0].collection_id : restored.collections[0].space_id;
        try { assertWritable(before, type, id); }
        catch { throw new WorkspaceCommandError("destination_required", "Choose a writable destination.", { destinationType: type }); }
      }
      const after = reduceWorkspaceSnapshot(before, { type: "restore", snapshot: restored });
      const current = await this.entries();
      return { snapshot: after, values: { ...this.values(current.map((item) => item.id === entry.id ? { ...item, restoredAt: new Date(this.now()).toISOString(), restoreOperationId: operationId, restorePending: this.backend().syncsTrash === true, restoreRejected: false, ...(destinationId ? { restoreDestinationId: destinationId } : {}) } : item)), [generationKey(this.scope)]: (await this.generation()) + 1 } };
    });
    // A successful replay established the original canonical outcome first.
    // Any subsequent destination change is an ordinary new move identity.
    if (entry.restorePending && destinationId && destinationId !== entry.restoreDestinationId) {
      const current = (await this.entries()).find((item) => item.operationId === entry.operationId);
      if (current?.restorePending) throw new WorkspaceCommandError("conflict", "Retry the original restore before changing destination.");
      if (current && !current.restoredAt) return this.restore(trashId, destinationId);
      return this.relocate(entry, result, destinationId);
    }
    return result;
  }
  private async relocate(entry: LocalTrashEntry, snapshot: WorkspaceSnapshot, destinationId: string): Promise<WorkspaceSnapshot> {
    if (entry.rootType === "space") throw new WorkspaceCommandError("validation_failed", "Spaces do not accept destinations.");
    if (!("reorderCollections" in this.workspace)) throw new WorkspaceCommandError("conflict", "Restore completed. Move the item to change its destination.");
    assertWritable(snapshot, entry.rootType, entry.rootId);
    assertWritable(snapshot, entry.rootType === "collection" ? "space" : "collection", destinationId);
    const currentParent = entry.rootType === "collection" ? snapshot.collections.find((item) => item.id === entry.rootId)!.space_id : snapshot.links.find((item) => item.id === entry.rootId)!.collection_id;
    if (currentParent === destinationId) return snapshot;
    try {
      if (entry.rootType === "collection") {
        if (!this.workspace.moveCollection) throw new WorkspaceCommandError("conflict", "This workspace cannot move collections.");
        await this.workspace.moveCollection({ id: entry.rootId, sourceSpaceId: currentParent, destinationSpaceId: destinationId });
      }
      else await this.workspace.updateLink(entry.rootId, { collection_id: destinationId });
    } catch (cause) { throw new LocallyCommittedTrashError(await this.workspace.load(), undefined, { cause }); }
    return this.workspace.load();
  }
}
