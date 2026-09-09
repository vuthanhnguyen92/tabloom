import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../../shared/domain";
import { isWorkspaceOperation, type WorkspaceOperation } from "../../shared/workspace-operations";
import type { TabloomRequestContext } from "../../services/tabloom-mcp/src/auth/request-context";
import { WorkspaceCommandService } from "../../services/tabloom-mcp/src/workspace/command-service";
import { mapWorkspaceCommandError, WorkspaceCommandError } from "../../services/tabloom-mcp/src/workspace/errors";

const USER = "10000000-0000-4000-8000-000000000001";
const SPACE_ID = "20000000-0000-4000-8000-000000000001";
const COLLECTION_ID = "30000000-0000-4000-8000-000000000001";
const DESTINATION_ID = "30000000-0000-4000-8000-000000000002";
const ITEM_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_ITEM_ID = "40000000-0000-4000-8000-000000000002";
const KEY = "50000000-0000-4000-8000-000000000001";
const OLD = "2026-09-09T00:00:00.000Z";
const NOW = "2026-09-10T00:00:00.000Z";
const LATER = "2026-09-10T01:00:00.000Z";
const META = { user_id: USER, created_at: OLD, updated_at: NOW, origin: "saved" as const, read_only: false, position: 0 };
const SPACE = { ...META, id: SPACE_ID, name: "Research", color: "#7357e6" };
const COLLECTION = { ...META, id: COLLECTION_ID, space_id: SPACE_ID, name: "Reading" };
const LINK = { ...META, id: ITEM_ID, collection_id: COLLECTION_ID, title: "Tabloom notes", description: "Useful", url: "https://example.com", favicon_url: null, device_label: null };
const INITIAL = { spaces: [SPACE], collections: [COLLECTION], links: [LINK] };

// Only the external database boundary is substituted. Commands, validation,
// ownership filtering, replay handling, and concurrency decisions stay real.
function setup(initial: WorkspaceSnapshot = INITIAL) {
  let snapshot = structuredClone(initial);
  let revision = 7;
  let beforeApply: (() => void) | undefined;
  let rpcError: { code: string; message: string } | undefined;
  const ledger = new Map<string, { operation_id: string; device_id: string; applied_revision: number }>();
  const writes: WorkspaceOperation[] = [];
  const tableFor = (entity: string) => entity === "space" ? "spaces" : entity === "collection" ? "collections" : "links";
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (rpcError) return { data: null, error: rpcError };
    if (name === "load_workspace_snapshot") return { data: { revision, snapshot: structuredClone(snapshot) }, error: null };
    if (name !== "apply_workspace_operations") throw new Error(`Unexpected RPC ${name}`);
    if (beforeApply) { const hook = beforeApply; beforeApply = undefined; hook(); }
    if (args?.expected_revision !== revision) return { data: null, error: { code: "40001", message: "workspace revision conflict" } };
    const operations = args.operations as WorkspaceOperation[];
    const outcomes = operations.map((operation) => {
      if (!isWorkspaceOperation(operation)) throw new Error("Service emitted an invalid workspace operation");
      if (ledger.has(operation.operationId)) return { operationId: operation.operationId, status: "already_applied" };
      writes.push(structuredClone(operation));
      const table = tableFor(operation.entity);
      if (operation.action === "create") {
        // The real sync RPC upserts, so an accidental second create would overwrite.
        const row = { ...META, ...operation.payload, ...(table === "links" ? { device_label: null } : {}) };
        snapshot = { ...snapshot, [table]: [...snapshot[table].filter((item) => item.id !== operation.entityId), row] };
      } else if (operation.action === "update") {
        snapshot = { ...snapshot, [table]: snapshot[table].map((row) => row.id === operation.entityId ? { ...row, ...operation.payload, updated_at: LATER } : row) };
      } else if (operation.action === "reorder") {
        snapshot = { ...snapshot, [table]: snapshot[table].map((row) => operation.payload.orderedIds.includes(row.id) ? { ...row, position: operation.payload.orderedIds.indexOf(row.id), updated_at: LATER } : row) };
      } else throw new Error("Task 4 must not issue a destructive sync operation");
      revision += 1;
      ledger.set(operation.operationId, { operation_id: operation.operationId, device_id: operation.deviceId, applied_revision: revision });
      return { operationId: operation.operationId, status: "applied" };
    });
    return { data: { revision, outcomes, patches: structuredClone(snapshot), tombstones: [], conflicts: [] }, error: null };
  });
  const from = vi.fn((table: string) => {
    if (table !== "workspace_operations") throw new Error(`Unexpected table ${table}`);
    const filters: Record<string, unknown> = {};
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((key: string, value: unknown) => { filters[key] = value; return query; }),
      maybeSingle: async () => ({ data: filters.user_id === USER ? ledger.get(String(filters.operation_id)) ?? null : null, error: null }),
    };
    return query;
  });
  const context: TabloomRequestContext = { userId: USER, clientId: "mcp-client", scope: "tabloom:workspace", supabase: { rpc, from } as unknown as SupabaseClient };
  return {
    service: new WorkspaceCommandService(context), context, writes, rpc,
    state: () => structuredClone(snapshot),
    concurrentChange: (change: (current: WorkspaceSnapshot) => void) => { beforeApply = () => { change(snapshot); revision += 1; }; },
    failWith: (error: { code: string; message: string }) => { rpcError = error; },
  };
}

describe("request-scoped workspace commands", () => {
  it("lists only authenticated saved records and uses stable IDs", async () => {
    const foreign = { ...SPACE, id: DESTINATION_ID, user_id: KEY };
    const bookmark = { ...SPACE, id: OTHER_ITEM_ID, origin: "browser-bookmark" as const, read_only: true };
    const { service } = setup({ ...INITIAL, spaces: [SPACE, foreign, bookmark] });
    expect(await service.listSpaces()).toEqual([SPACE]);
    expect(await service.listCollections({ spaceId: SPACE_ID })).toEqual([COLLECTION]);
    expect(await service.listCollectionItems({ collectionId: COLLECTION_ID })).toEqual([LINK]);
    expect(await service.getWorkspace()).toMatchObject({ revision: 7, snapshot: INITIAL });
  });

  it("searches across synchronized collections and returns stable parent IDs", async () => {
    const { service } = setup();
    expect(await service.searchWorkspace({ query: "research" })).toMatchObject([{ link: { id: ITEM_ID }, collection: { id: COLLECTION_ID }, space: { id: SPACE_ID } }]);
  });

  it("returns the same not_found for missing and foreign records", async () => {
    const { service } = setup({ ...INITIAL, spaces: [SPACE, { ...SPACE, id: DESTINATION_ID, user_id: KEY }] });
    for (const spaceId of [DESTINATION_ID, KEY]) {
      await expect(service.listCollections({ spaceId })).rejects.toMatchObject({ code: "not_found" });
    }
  });

  it("rejects stale updates before writing with current timestamp metadata", async () => {
    const { service, writes } = setup();
    await expect(service.updateSpace({ spaceId: SPACE_ID, expectedUpdatedAt: OLD, name: "Renamed", idempotencyKey: KEY })).rejects.toMatchObject({ code: "conflict", details: { id: SPACE_ID, updatedAt: NOW } });
    expect(writes).toEqual([]);
  });

  it("updates a space using the caller operation ID and current revision", async () => {
    const { service, writes } = setup();
    expect(await service.updateSpace({ spaceId: SPACE_ID, expectedUpdatedAt: NOW, name: " Renamed ", idempotencyKey: KEY })).toMatchObject({ id: SPACE_ID, name: "Renamed" });
    expect(writes).toMatchObject([{ operationId: KEY, entity: "space", entityId: SPACE_ID, action: "update", baseRevision: 7, payload: { name: "Renamed" } }]);
  });

  it("creates once and replays the same result even across request-scoped services", async () => {
    const { service, context, state, writes } = setup();
    const input = { name: "New space", color: "#123456", idempotencyKey: KEY };
    const created = await service.createSpace(input);
    expect(created).toMatchObject({ name: "New space", position: 1, user_id: USER });
    expect(await service.createSpace(input)).toEqual(created);
    expect(await new WorkspaceCommandService(context).createSpace(input)).toEqual(created);
    expect(writes).toHaveLength(1);
    expect(state().spaces).toHaveLength(2);
  });

  it("rejects different input reusing a durable idempotency key", async () => {
    const { service, context, writes } = setup();
    await service.createSpace({ name: "New", color: "#123456", idempotencyKey: KEY });
    await expect(new WorkspaceCommandService(context).createSpace({ name: "Different", color: "#123456", idempotencyKey: KEY })).rejects.toMatchObject({ code: "conflict" });
    expect(writes).toHaveLength(1);
  });

  it("replays a successful update without treating its original timestamp as stale", async () => {
    const { service, context, writes } = setup();
    const input = { spaceId: SPACE_ID, expectedUpdatedAt: NOW, name: "Renamed", idempotencyKey: KEY };
    const result = await service.updateSpace(input);
    expect(await new WorkspaceCommandService(context).updateSpace(input)).toEqual(result);
    expect(writes).toHaveLength(1);
  });

  it("creates a collection under the owned destination", async () => {
    const { service } = setup();
    expect(await service.createCollection({ spaceId: SPACE_ID, name: "New collection", idempotencyKey: KEY })).toMatchObject({ space_id: SPACE_ID, name: "New collection", position: 1 });
  });

  it("updates a collection by ID", async () => {
    const { service } = setup();
    expect(await service.updateCollection({ collectionId: COLLECTION_ID, name: "Renamed", expectedUpdatedAt: NOW, idempotencyKey: KEY })).toMatchObject({ id: COLLECTION_ID, name: "Renamed" });
  });

  it("creates and edits http links with strict editable fields", async () => {
    const { service } = setup();
    expect(await service.createCollectionItem({ collectionId: COLLECTION_ID, title: "New link", url: "http://example.org", idempotencyKey: KEY })).toMatchObject({ collection_id: COLLECTION_ID, title: "New link", description: "", favicon_url: null, position: 1 });
    expect(await service.updateCollectionItem({ itemId: ITEM_ID, expectedUpdatedAt: NOW, title: "Updated", description: " Notes ", url: "https://example.org", idempotencyKey: OTHER_ITEM_ID })).toMatchObject({ id: ITEM_ID, title: "Updated", description: "Notes", url: "https://example.org" });
  });

  it.each(["javascript:alert(1)", "file:///private", "chrome://bookmarks", "ftp://example.com"])("rejects unsafe URL %s before querying", async (url) => {
    const { service, rpc } = setup();
    await expect(service.createCollectionItem({ collectionId: COLLECTION_ID, title: "New", url, idempotencyKey: KEY })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.updateCollectionItem({ itemId: ITEM_ID, expectedUpdatedAt: NOW, url, idempotencyKey: KEY })).rejects.toMatchObject({ code: "validation_failed" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { itemId: "not-an-id", expectedUpdatedAt: NOW, title: "New" },
    { itemId: ITEM_ID, expectedUpdatedAt: "yesterday", title: "New" },
    { itemId: ITEM_ID, expectedUpdatedAt: NOW },
    { itemId: ITEM_ID, expectedUpdatedAt: NOW, user_id: KEY, title: "New" },
    { itemId: ITEM_ID, expectedUpdatedAt: NOW, title: " " },
  ])("rejects malformed or non-editable update input %#", async (input) => {
    const { service, rpc } = setup();
    await expect(service.updateCollectionItem({ ...input, idempotencyKey: KEY })).rejects.toMatchObject({ code: "validation_failed" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("preserves read-only metadata and rejects bookmark mutations", async () => {
    const { service, writes } = setup({ ...INITIAL, links: [{ ...LINK, origin: "browser-bookmark", read_only: true }] });
    expect(await service.listCollectionItems({ collectionId: COLLECTION_ID })).toEqual([]);
    await expect(service.updateCollectionItem({ itemId: ITEM_ID, expectedUpdatedAt: NOW, title: "Changed", idempotencyKey: KEY })).rejects.toMatchObject({ code: "read_only" });
    expect(writes).toEqual([]);
  });

  it("moves an item between owned writable collections", async () => {
    const { service, state } = setup({ ...INITIAL, collections: [COLLECTION, { ...COLLECTION, id: DESTINATION_ID, name: "Destination" }] });
    expect(await service.moveCollectionItem({ itemId: ITEM_ID, destinationCollectionId: DESTINATION_ID, expectedUpdatedAt: NOW, idempotencyKey: KEY })).toMatchObject({ id: ITEM_ID, collection_id: DESTINATION_ID });
    expect(state().links).toHaveLength(1);
  });

  it.each(["missing", "foreign", "read_only"])("rejects a %s move destination", async (kind) => {
    const destination = { ...COLLECTION, id: DESTINATION_ID, user_id: kind === "foreign" ? KEY : USER, read_only: kind === "read_only" };
    const { service, writes } = setup({ ...INITIAL, collections: kind === "missing" ? [COLLECTION] : [COLLECTION, destination] });
    await expect(service.moveCollectionItem({ itemId: ITEM_ID, destinationCollectionId: DESTINATION_ID, expectedUpdatedAt: NOW, idempotencyKey: KEY })).rejects.toMatchObject({ code: kind === "read_only" ? "read_only" : "not_found" });
    expect(writes).toEqual([]);
  });

  it("reorders exactly the current membership at the expected revision", async () => {
    const { service } = setup({ ...INITIAL, links: [LINK, { ...LINK, id: OTHER_ITEM_ID, position: 1 }] });
    expect(await service.reorderCollectionItems({ collectionId: COLLECTION_ID, orderedIds: [OTHER_ITEM_ID, ITEM_ID], expectedRevision: 7, idempotencyKey: KEY })).toMatchObject([{ id: OTHER_ITEM_ID, position: 0 }, { id: ITEM_ID, position: 1 }]);
  });

  it.each([{ orderedIds: [ITEM_ID] }, { orderedIds: [ITEM_ID, ITEM_ID] }, { orderedIds: [ITEM_ID, KEY] }])("rejects invalid reorder membership $orderedIds", async ({ orderedIds }) => {
    const { service, writes } = setup({ ...INITIAL, links: [LINK, { ...LINK, id: OTHER_ITEM_ID, position: 1 }] });
    await expect(service.reorderCollectionItems({ collectionId: COLLECTION_ID, orderedIds, expectedRevision: 7, idempotencyKey: KEY })).rejects.toMatchObject({ code: "validation_failed" });
    expect(writes).toEqual([]);
  });

  it("revalidates and retries once after an unrelated revision change", async () => {
    const { service, concurrentChange, rpc } = setup();
    concurrentChange((state) => { state.links[0].title = "Concurrent link edit"; });
    expect(await service.updateSpace({ spaceId: SPACE_ID, expectedUpdatedAt: NOW, name: "Renamed", idempotencyKey: KEY })).toMatchObject({ name: "Renamed" });
    expect(rpc.mock.calls.filter(([name]) => name === "apply_workspace_operations").map(([, args]) => args?.expected_revision)).toEqual([7, 8]);
  });

  it("rejects an edit when the target changes during a revision retry", async () => {
    const { service, concurrentChange, writes } = setup();
    concurrentChange((state) => { state.spaces[0].name = "Other edit"; state.spaces[0].updated_at = LATER; });
    await expect(service.updateSpace({ spaceId: SPACE_ID, expectedUpdatedAt: NOW, name: "Renamed", idempotencyKey: KEY })).rejects.toMatchObject({ code: "conflict", details: { updatedAt: LATER } });
    expect(writes).toEqual([]);
  });

  it("rejects stale reorder revisions even if record membership is unchanged", async () => {
    const { service, concurrentChange, writes } = setup();
    concurrentChange(() => {});
    await expect(service.reorderCollectionItems({ collectionId: COLLECTION_ID, orderedIds: [ITEM_ID], expectedRevision: 7, idempotencyKey: KEY })).rejects.toMatchObject({ code: "conflict" });
    expect(writes).toEqual([]);
  });

  it("serializes concurrent create replays across independent requests", async () => {
    const { context, writes, state } = setup();
    const input = { name: "Concurrent", color: "#123456", idempotencyKey: KEY };
    const [first, second] = await Promise.all([
      new WorkspaceCommandService(context).createSpace(input),
      new WorkspaceCommandService(context).createSpace(input),
    ]);
    expect(first).toEqual(second);
    expect(state().spaces).toHaveLength(2);
    expect(writes).toHaveLength(1);
  });

  it("preserves microsecond timestamp precision when rejecting stale edits", async () => {
    const { service, writes } = setup({ ...INITIAL, spaces: [{ ...SPACE, updated_at: "2026-09-10T00:00:00.000002Z" }] });
    await expect(service.updateSpace({ spaceId: SPACE_ID, expectedUpdatedAt: "2026-09-10T00:00:00.000001Z", name: "Stale", idempotencyKey: KEY })).rejects.toMatchObject({ code: "conflict" });
    expect(writes).toEqual([]);
  });

  it("rejects mutation below a read-only parent", async () => {
    const { service, writes } = setup({ ...INITIAL, spaces: [{ ...SPACE, read_only: true }] });
    expect(await service.searchWorkspace({ query: "Tabloom" })).toEqual([]);
    await expect(service.updateCollectionItem({ itemId: ITEM_ID, expectedUpdatedAt: NOW, title: "Changed", idempotencyKey: KEY })).rejects.toMatchObject({ code: "read_only" });
    await expect(service.createCollection({ spaceId: SPACE_ID, name: "New", idempotencyKey: KEY })).rejects.toMatchObject({ code: "read_only" });
    expect(writes).toEqual([]);
  });

  it("rejects create destinations outside the current workspace", async () => {
    const { service, writes } = setup();
    await expect(service.createCollection({ spaceId: DESTINATION_ID, name: "New", idempotencyKey: KEY })).rejects.toMatchObject({ code: "not_found" });
    await expect(service.createCollectionItem({ collectionId: DESTINATION_ID, title: "New", url: "https://example.org", idempotencyKey: KEY })).rejects.toMatchObject({ code: "not_found" });
    expect(writes).toEqual([]);
  });

  it("rejects reordering when one current member is read-only", async () => {
    const { service, writes } = setup({ ...INITIAL, links: [{ ...LINK, read_only: true }] });
    await expect(service.reorderCollectionItems({ collectionId: COLLECTION_ID, orderedIds: [ITEM_ID], expectedRevision: 7, idempotencyKey: KEY })).rejects.toMatchObject({ code: "read_only" });
    expect(writes).toEqual([]);
  });

  it("returns a stable error for malformed synchronized data", async () => {
    const { service, rpc } = setup();
    rpc.mockResolvedValueOnce({ data: { revision: -1, snapshot: INITIAL }, error: null });
    await expect(service.getWorkspace()).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("retries a write revision conflict at most once", async () => {
    const { service, rpc, writes } = setup();
    const implementation = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => name === "apply_workspace_operations"
      ? { data: null, error: { code: "40001", message: "concurrent edit" } }
      : implementation(name, args));
    await expect(service.updateSpace({ spaceId: SPACE_ID, expectedUpdatedAt: NOW, name: "Renamed", idempotencyKey: KEY })).rejects.toMatchObject({ code: "conflict" });
    expect(rpc.mock.calls.filter(([name]) => name === "apply_workspace_operations")).toHaveLength(2);
    expect(writes).toEqual([]);
  });

  it.each([
    ["P0002", "not_found"], ["23503", "not_found"], ["42501", "not_found"],
    ["40001", "conflict"], ["22023", "validation_failed"], ["23505", "conflict"], ["XX000", "validation_failed"],
  ])("maps database error %s without leaking SQL or secrets", async (code, expectedCode) => {
    const { service, failWith } = setup();
    failWith({ code, message: "private SQL with access_token=secret" });
    const error = await service.listSpaces().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: expectedCode });
    expect(String(error)).not.toContain("private SQL");
    expect(String(error)).not.toContain("secret");
  });

  it("sanitizes already-classified repository errors and excludes private details", () => {
    const error = mapWorkspaceCommandError(new WorkspaceCommandError("conflict", "SQL with token=secret", { id: ITEM_ID, updatedAt: NOW, access_token: "secret" }));
    expect(error).toMatchObject({ code: "conflict", details: { id: ITEM_ID, updatedAt: NOW } });
    expect(error.message).not.toContain("secret");
    expect(error.details).not.toHaveProperty("access_token");
  });
});
