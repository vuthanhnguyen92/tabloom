import type { WorkspaceSnapshot } from "../shared/domain";
import type { WorkspaceRepository } from "../shared/repository";
import { WorkspaceCommandError, LocallyCommittedTrashError, decodeTrashEntry, decodeDeleteReceipt, type DeleteIntent, type DeleteReceipt, type TrashRootType, type TrashSource, type WorkspaceTrashEntry } from "../shared/trash";
import type { WorkspaceTrashRepository } from "../shared/trash-repository";
import { assertWritable, reduceWorkspaceSnapshot } from "../shared/organizer/mutation-policy";
import type { StorageArea } from "./workspace-cache";

export type LocalTrashEntry = WorkspaceTrashEntry & { operationId: string; localId: string; remoteOnly?: boolean; restoreOperationId?: string; restorePending?: boolean; restoreDestinationId?: string };
export type LocalTrashMutation = { operationId: string; rootType: TrashRootType; rootId: string; action: "delete" | "restore"; deleteOperationId?: string; trashId?: string; destinationId?: string; snapshot?: WorkspaceSnapshot };
export type LocalTrashCommit = { snapshot: WorkspaceSnapshot; values: Record<string, unknown> };
export interface LocalTrashWorkspace {
  readonly syncsTrash?: boolean;
  readonly trashOwnerId: string;
  load(): Promise<WorkspaceSnapshot>;
  commitTrash(mutation: LocalTrashMutation | undefined, beforeCommit: (before: WorkspaceSnapshot) => Promise<LocalTrashCommit>): Promise<WorkspaceSnapshot>;
}
export const localTrashKey = (scope: string) => `tabloom-trash-v1:${scope}`;
const retention = 30 * 24 * 60 * 60 * 1000;

/** Local confirmation metadata is ephemeral human intent, never server authorization. */
export class LocalTrashRepository implements WorkspaceTrashRepository {
  private intents = new Map<string, { intent: DeleteIntent; fingerprint: string }>();
  private now: () => number;
  private remote?: WorkspaceTrashRepository;
  constructor(private area: StorageArea, private workspace: WorkspaceRepository | LocalTrashWorkspace, private scope: string, options: { now?: () => number; remote?: WorkspaceTrashRepository } = {}) { this.now = options.now ?? Date.now; this.remote = options.remote; }
  private async entries(): Promise<LocalTrashEntry[]> {
    const stored = (await this.area.get(localTrashKey(this.scope)))[localTrashKey(this.scope)];
    if (stored === undefined) return [];
    if (!Array.isArray(stored)) throw new Error("Local Trash is unavailable.");
    return stored.map((value) => this.validateEntry(value));
  }
  private validateEntry(value: unknown): LocalTrashEntry {
    if (!value || typeof value !== "object") throw new Error("Invalid local Trash.");
    const entry = structuredClone(value) as LocalTrashEntry;
    const { operationId, localId, remoteOnly, restoreOperationId, restorePending, restoreDestinationId, ...common } = entry;
    if (typeof localId !== "string" || (remoteOnly !== undefined && typeof remoteOnly !== "boolean") || (restorePending !== undefined && typeof restorePending !== "boolean") || (restoreDestinationId !== undefined && typeof restoreDestinationId !== "string")) throw new Error("Invalid local Trash.");
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
          const remote = remoteEntries.find((item) => item.operationId === entry.operationId);
          return remote ? { ...entry, id: remote.id, expiresAt: remote.expiresAt } : entry;
        });
        return [...retained, ...remoteEntries.filter((entry) => !retained.some((local) => local.id === entry.id)).map((entry) => ({ ...entry, operationId: entry.operationId ?? crypto.randomUUID(), localId: entry.id, remoteOnly: true }))];
      });
    }
    const entries = await this.entries();
    let purged = 0;
    const retained = entries.filter((entry) => !(Date.parse(entry.expiresAt) <= this.now() && purged++ < 100));
    if (retained.length !== entries.length) await this.updateEntries((current) => { let count = 0; return current.filter((entry) => !(Date.parse(entry.expiresAt) <= this.now() && count++ < 100)); });
    return retained.filter((entry) => (!entry.restoredAt || entry.restorePending) && Date.parse(entry.expiresAt) > this.now()).sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
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
      return entries.map((item) => item === entry ? { ...item, id: receipt.trashId, expiresAt: receipt.restoreUntil } : item);
    });
  }
  async completeRestore(operationId: string): Promise<void> {
    await this.updateEntries((entries) => entries.map((entry) => entry.restoreOperationId === operationId ? { ...entry, restorePending: false } : entry));
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
    const { tree } = this.tree(await this.workspace.load(), rootType, rootId);
    const intent: DeleteIntent = { intentId: crypto.randomUUID(), targetType: rootType, targetId: rootId, targetName: (rootType === "space" ? tree.spaces : tree.collections)[0].name,
      collectionCount: rootType === "space" ? tree.collections.length : 0, linkCount: tree.links.length, expiresAt: new Date(this.now() + 5 * 60 * 1000).toISOString() };
    this.intents.set(intent.intentId, { intent, fingerprint: JSON.stringify(tree) });
    return intent;
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
        if (rootType !== "link" && this.intents.get(confirmationIntentId ?? "")?.fingerprint !== JSON.stringify(tree)) throw new WorkspaceCommandError("confirmation_required", "The tree changed. Confirm deletion again.");
        const id = crypto.randomUUID();
        entry = { id, localId: id, operationId, rootType, rootId, rootName: rootType === "link" ? tree.links[0].title : (rootType === "space" ? tree.spaces : tree.collections)[0].name,
          source, deletedAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + retention).toISOString(), restoredAt: null, snapshot: tree };
        return { snapshot: after, values: this.values([...(await this.entries()), entry]) };
      }); } catch (cause) {
        if (cause instanceof LocallyCommittedTrashError) {
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
    const entry = entries.find((item) => item.id === trashId || item.localId === trashId);
    if (!entry || Date.parse(entry.expiresAt) <= this.now()) throw new WorkspaceCommandError("not_found", "Recovery has expired.");
    if (entry.restoredAt && !entry.restorePending) return this.workspace.load();
    destinationId ??= entry.restoreDestinationId;
    const restored = structuredClone(entry.snapshot);
    if (entry.rootType === "space" && destinationId) throw new WorkspaceCommandError("validation_failed", "Spaces do not accept destinations.");
    if (entry.rootType === "collection" && destinationId) restored.collections[0].space_id = destinationId;
    if (entry.rootType === "link" && destinationId) restored.links[0].collection_id = destinationId;
    const operationId = entry.restoreOperationId ?? crypto.randomUUID();
    const mutation: LocalTrashMutation = { action: "restore", operationId, rootType: entry.rootType, rootId: entry.rootId, ...(entry.remoteOnly ? { trashId: entry.id } : { deleteOperationId: entry.operationId }), destinationId,
      snapshot: { spaces: restored.spaces, collections: restored.collections, links: restored.links } };
    return this.backend().commitTrash(mutation, async (before) => {
      if (entry.restorePending) {
        restored.spaces = restored.spaces.map((item) => before.spaces.find((live) => live.id === item.id) ?? item);
        restored.collections = restored.collections.map((item) => before.collections.find((live) => live.id === item.id) ?? item);
        restored.links = restored.links.map((item) => before.links.find((live) => live.id === item.id) ?? item);
        if (destinationId && entry.rootType === "collection") restored.collections = restored.collections.map((item) => item.id === entry.rootId ? { ...item, space_id: destinationId } : item);
        if (destinationId && entry.rootType === "link") restored.links = restored.links.map((item) => item.id === entry.rootId ? { ...item, collection_id: destinationId } : item);
        mutation.snapshot = { spaces: restored.spaces, collections: restored.collections, links: restored.links };
      }
      if (entry.rootType !== "space") {
        const type = entry.rootType === "link" ? "collection" : "space";
        const id = entry.rootType === "link" ? restored.links[0].collection_id : restored.collections[0].space_id;
        try { assertWritable(before, type, id); }
        catch { throw new WorkspaceCommandError("destination_required", "Choose a writable destination.", { destinationType: type }); }
      }
      const live = entry.restorePending ? {
        spaces: before.spaces.filter((item) => !restored.spaces.some((row) => row.id === item.id)),
        collections: before.collections.filter((item) => !restored.collections.some((row) => row.id === item.id)),
        links: before.links.filter((item) => !restored.links.some((row) => row.id === item.id)),
      } : before;
      const after = reduceWorkspaceSnapshot(live, { type: "restore", snapshot: restored });
      const current = await this.entries();
      return { snapshot: after, values: this.values(current.map((item) => item.operationId === entry.operationId ? { ...item, restoredAt: new Date(this.now()).toISOString(), restoreOperationId: operationId, restorePending: this.backend().syncsTrash === true, ...(destinationId ? { restoreDestinationId: destinationId } : {}) } : item)) };
    });
  }
}
