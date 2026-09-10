import { decodeWorkspaceSnapshot } from "./repository";
import { isSaveableUrl, type Collection, type SavedLink, type Space, type WorkspaceSnapshot } from "./domain";

export type TrashRootType = "space" | "collection" | "link";
export type TrashSource = "web" | "extension" | "mcp";
export type WorkspaceCommandErrorCode =
  | "not_found" | "read_only" | "conflict" | "confirmation_required"
  | "confirmation_expired" | "destination_required" | "validation_failed";

export type TrashSnapshot = {
  version: 1;
  rootType: TrashRootType;
  spaces: Space[];
  collections: Collection[];
  links: SavedLink[];
};

export type WorkspaceTrashEntry = {
  id: string;
  rootType: TrashRootType;
  rootId: string;
  rootName: string;
  source: TrashSource;
  deletedAt: string;
  expiresAt: string;
  restoredAt: string | null;
  snapshot: TrashSnapshot;
  /** Local restoration is durable and awaiting remote acknowledgement. */
  restorePending?: boolean;
};

export type RestoreDestination = { spaceId?: string; collectionId?: string };

export type DeleteReceipt = {
  operationId: string;
  trashId: string;
  rootType: TrashRootType;
  rootId: string;
  restoreUntil: string;
};

export type DeleteIntent = {
  intentId: string;
  targetType: "space" | "collection";
  targetId: string;
  targetName: string;
  collectionCount: number;
  linkCount: number;
  expiresAt: string;
};

export class WorkspaceCommandError extends Error {
  constructor(
    readonly code: WorkspaceCommandErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WorkspaceCommandError";
  }
}

/** Distinguishes a rejected Trash payload from an unexpected runtime failure. */
export class TrashDecodeError extends Error {}

/** The restore committed; retry only the read, never apply mutation rollback. */
export class CommittedRestoreRefreshError extends Error {
  constructor(readonly trashId: string, options?: ErrorOptions) {
    super("Restored, but the workspace could not be refreshed.", options);
    this.name = "CommittedRestoreRefreshError";
  }
}

/** Durable local snapshot/outbox committed; only remote synchronization failed. */
export class LocallyCommittedTrashError extends Error {
  constructor(readonly snapshot: WorkspaceSnapshot, readonly receipt?: DeleteReceipt, options?: ErrorOptions) {
    super(options?.cause instanceof Error ? options.cause.message : "Changes are saved locally. Failed to sync.", options);
    this.name = "LocallyCommittedTrashError";
  }
}

const ROOT_TYPES = new Set<TrashRootType>(["space", "collection", "link"]);
const SOURCES = new Set<TrashSource>(["web", "extension", "mcp"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function string(value: unknown): value is string { return typeof value === "string"; }
function uuid(value: unknown): value is string { return string(value) && UUID.test(value); }
function timestamp(value: unknown): value is string { return string(value) && Number.isFinite(Date.parse(value)); }
function fail(kind: string): never { throw new TrashDecodeError(`invalid ${kind}`); }
function enumValue<T extends string>(value: unknown, values: Set<T>): value is T { return string(value) && values.has(value as T); }

function domainMeta(value: Record<string, unknown>): boolean {
  // Trash contains only writable saved records. Reject browser/read-only data
  // before the saved-workspace decoder can normalize away that metadata.
  return value.origin === "saved" && value.read_only === false;
}
function domainBase(value: Record<string, unknown>): boolean {
  return uuid(value.id) && uuid(value.user_id)
    && Number.isInteger(value.position) && (value.position as number) >= 0
    && timestamp(value.created_at) && timestamp(value.updated_at) && domainMeta(value);
}
function validSpace(value: unknown): value is Space {
  const item = object(value);
  return !!item && exact(item, ["id", "user_id", "name", "color", "position", "created_at", "updated_at", "origin", "read_only"])
    && string(item.name) && string(item.color) && domainBase(item);
}
function validCollection(value: unknown): value is Collection {
  const item = object(value);
  return !!item && exact(item, ["id", "user_id", "space_id", "name", "position", "created_at", "updated_at", "origin", "read_only"])
    && uuid(item.space_id) && string(item.name) && domainBase(item);
}
function validLink(value: unknown): value is SavedLink {
  const item = object(value);
  const exactKeys = item && (exact(item, ["id", "user_id", "collection_id", "url", "title", "description", "favicon_url", "position", "created_at", "updated_at", "origin", "read_only"])
    || exact(item, ["id", "user_id", "collection_id", "url", "title", "description", "favicon_url", "position", "created_at", "updated_at", "origin", "read_only", "device_label"]));
  return !!item && !!exactKeys && uuid(item.collection_id) && isSaveableUrl(string(item.url) ? item.url : null)
    && string(item.url) && string(item.title) && string(item.description)
    && (item.favicon_url === null || string(item.favicon_url))
    && (item.device_label === undefined || item.device_label === null || string(item.device_label)) && domainBase(item);
}

export function decodeTrashSnapshot(value: unknown): TrashSnapshot {
  const candidate = object(value);
  if (!candidate || !exact(candidate, ["version", "rootType", "spaces", "collections", "links"])
    || candidate.version !== 1 || !enumValue(candidate.rootType, ROOT_TYPES)
    || !Array.isArray(candidate.spaces) || !Array.isArray(candidate.collections) || !Array.isArray(candidate.links)) fail("trash snapshot");
  if (!candidate.spaces.every(validSpace) || !candidate.collections.every(validCollection) || !candidate.links.every(validLink)) fail("trash snapshot");
  let snapshot: WorkspaceSnapshot;
  try { snapshot = decodeWorkspaceSnapshot({ spaces: candidate.spaces, collections: candidate.collections, links: candidate.links }); }
  catch { fail("trash snapshot"); }
  return { version: 1, rootType: candidate.rootType, ...snapshot };
}

export function decodeTrashEntry(value: unknown): WorkspaceTrashEntry {
  const candidate = object(value);
  if (!candidate || !exact(candidate, ["id", "rootType", "rootId", "rootName", "source", "deletedAt", "expiresAt", "restoredAt", "snapshot"])
    || !uuid(candidate.id) || !enumValue(candidate.rootType, ROOT_TYPES) || !uuid(candidate.rootId)
    || !string(candidate.rootName) || !enumValue(candidate.source, SOURCES)
    || !timestamp(candidate.deletedAt) || !timestamp(candidate.expiresAt)
    || (candidate.restoredAt !== null && !timestamp(candidate.restoredAt))) fail("trash entry");
  const snapshot = decodeTrashSnapshot(candidate.snapshot);
  const roots = snapshot.rootType === "space" ? snapshot.spaces : snapshot.rootType === "collection" ? snapshot.collections : snapshot.links;
  if (candidate.rootType !== snapshot.rootType || !roots.some((item) => item.id === candidate.rootId)) fail("trash entry");
  return { id: candidate.id, rootType: candidate.rootType, rootId: candidate.rootId, rootName: candidate.rootName,
    source: candidate.source, deletedAt: candidate.deletedAt, expiresAt: candidate.expiresAt,
    restoredAt: candidate.restoredAt, snapshot };
}

export function decodeDeleteReceipt(value: unknown): DeleteReceipt {
  const candidate = object(value);
  if (!candidate || !exact(candidate, ["operationId", "trashId", "rootType", "rootId", "restoreUntil"])
    || !uuid(candidate.operationId) || !uuid(candidate.trashId) || !enumValue(candidate.rootType, ROOT_TYPES)
    || !uuid(candidate.rootId) || !timestamp(candidate.restoreUntil)) fail("delete receipt");
  return {
    operationId: candidate.operationId,
    trashId: candidate.trashId,
    rootType: candidate.rootType,
    rootId: candidate.rootId,
    restoreUntil: candidate.restoreUntil,
  };
}

export function decodeDeleteIntent(value: unknown): DeleteIntent {
  const candidate = object(value);
  if (!candidate || !exact(candidate, ["intentId", "targetType", "targetId", "targetName", "collectionCount", "linkCount", "expiresAt"])
    || !uuid(candidate.intentId) || (candidate.targetType !== "space" && candidate.targetType !== "collection")
    || !uuid(candidate.targetId) || !string(candidate.targetName)
    || !Number.isInteger(candidate.collectionCount) || (candidate.collectionCount as number) < 0
    || !Number.isInteger(candidate.linkCount) || (candidate.linkCount as number) < 0
    || !timestamp(candidate.expiresAt) || Date.parse(candidate.expiresAt as string) <= Date.now()) fail("delete intent");
  return {
    intentId: candidate.intentId,
    targetType: candidate.targetType,
    targetId: candidate.targetId,
    targetName: candidate.targetName,
    collectionCount: candidate.collectionCount as number,
    linkCount: candidate.linkCount as number,
    expiresAt: candidate.expiresAt,
  };
}
