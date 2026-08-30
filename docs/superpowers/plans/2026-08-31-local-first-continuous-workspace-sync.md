# Tabloom Local-First Continuous Workspace Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the signed-in Tabloom extension read and write an account-scoped local cache immediately, synchronize durable operations with Supabase in the background, expose accessible account-menu status, and suppress Chrome address autofill in global search.

**Architecture:** A discriminated operation domain feeds an atomic browser-storage cache/outbox. `LocalFirstWorkspaceRepository` implements the existing organizer repository contract without network calls, while a single-flight `WorkspaceSyncEngine` uses a typed Supabase transport for revision checks, incremental patches, full conflict recovery, and first-sync handoff. Browser-bookmark records stay in the combined cache but remain outside saved-workspace operation batches.

**Tech Stack:** TypeScript, React 19, Vitest, Testing Library, Supabase/PostgreSQL/pgTAP, Chrome/Firefox/Safari browser adapters, Vite/Vinext, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-31-local-first-continuous-workspace-sync-design.md`

## Global Constraints

- Run every shell command through `rtk` as required by `/Users/nickvu/.codex/RTK.md`.
- Preserve signed-out storage at `tabloom-local-workspace-v2` and isolate signed-in data by Supabase user ID.
- Use a 500 ms mutation debounce, a 30-second focus freshness interval, no periodic polling, and no Supabase Realtime subscription.
- Only `http:` and `https:` links may enter saved workspace operations.
- Stable UUIDs are record identity; continuous synchronization must not deduplicate different IDs by URL.
- Keep browser-bookmark import manual and exclude read-only bookmark records from saved-workspace pushes.
- Never place OAuth tokens, provider tokens, service-role keys, or caller-supplied user IDs in operation payloads.
- Routine synchronization must not create a success toast or long status banner.
- Chromium, Firefox, and Safari use the same operation, cache, repository, transport, and engine implementation.
- Preserve all unrelated dirty-worktree changes and stage only files owned by the current task.

---

## File Structure

### New files

- `shared/workspace-operations.ts` — operation unions, coalescing, patch/tombstone application, saved/bookmark snapshot composition, and pure tombstone-aware rebase helpers.
- `extension/local-first-storage.ts` — account-scoped keys, schema guards, migration, device identity, monotonic sequence, and atomic cache/outbox persistence.
- `extension/local-first-repository.ts` — local-only `WorkspaceRepository` implementation that records operations.
- `extension/workspace-sync-transport.ts` — typed Supabase RPC adapter for revisions, operation batches, and canonical snapshots.
- `extension/workspace-sync-engine.ts` — trigger scheduling, debounce, single-flight synchronization, conflict recovery, status publication, and lifecycle cleanup.
- `supabase/migrations/202608310001_local_first_workspace_sync.sql` — applied-operation/tombstone tables plus revision and incremental-operation RPCs.
- `supabase/tests/local_first_workspace_sync.test.sql` — pgTAP isolation, idempotency, validation, tombstone, reorder, and revision tests.
- `tests/workspace-operations.test.ts` — pure operation/coalescing/rebase tests.
- `tests/local-first-storage.test.ts` — account isolation, migration, atomic persistence, and device-sequence tests.
- `tests/local-first-repository.test.ts` — immediate local mutation and outbox tests.
- `tests/workspace-sync-transport.test.ts` — RPC request/response parsing and typed error tests.
- `tests/workspace-sync-engine.test.ts` — timers, triggers, retry, pull, rebase, and lifecycle tests.

### Modified files

- `extension/GlobalSearch.tsx` and `tests/global-search.test.tsx` — browser autofill suppression.
- `extension/workspace-cache.ts` and `tests/workspace-cache.test.ts` — v1-to-v2 compatibility delegated to the new atomic storage.
- `extension/first-sync.ts` and `tests/first-sync.test.ts` — activate a canonical snapshot callback instead of a direct cloud repository.
- `extension/src.tsx` and `tests/extension-first-sync.test.ts` — local-first bootstrap, account switching, engine lifecycle, focus/online triggers, and removal of heading sync copy.
- `extension/SyncLoginPrompt.tsx`, `tests/sync-login-prompt.test.tsx`, and `extension/style.css` — green/yellow/red status row and `Sync now` control.
- `shared/workspace-sync-repository.ts` and `tests/workspace-sync-repository.test.ts` — share error parsing and keep first-sync RPC behavior compatible.
- `package.json` — only if a focused verification script is needed; do not add runtime dependencies.

---

### Task 1: Suppress Browser Address Autofill in Global Search

**Files:**
- Modify: `extension/GlobalSearch.tsx:96-105`
- Test: `tests/global-search.test.tsx`

**Interfaces:**
- Consumes: existing `GlobalSearch({ snapshot, onOpen })`.
- Produces: the same component with a search-specific name and explicit browser text-input hints.

- [ ] **Step 1: Write the failing DOM-attribute test**

Add this assertion after opening the search dialog:

```tsx
const input = screen.getByRole("searchbox", {
  name: "Search all spaces and collections",
});
expect(input).toHaveAttribute("name", "tabloom-global-search");
expect(input).toHaveAttribute("autocomplete", "off");
expect(input).toHaveAttribute("autocorrect", "off");
expect(input).toHaveAttribute("autocapitalize", "none");
expect(input).toHaveAttribute("spellcheck", "false");
```

- [ ] **Step 2: Run the focused test and confirm the missing attributes fail**

Run: `rtk npx vitest run tests/global-search.test.tsx`

Expected: FAIL because the rendered searchbox lacks at least `name`, `autocomplete`, `autocorrect`, and `autocapitalize`.

- [ ] **Step 3: Add the explicit search-input attributes**

Update the existing input without changing focus or keyboard behavior:

```tsx
<input
  aria-label="Search all spaces and collections"
  autoCapitalize="none"
  autoComplete="off"
  autoCorrect="off"
  name="tabloom-global-search"
  onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
  onKeyDown={handleSearchKeyDown}
  placeholder="Search all spaces and collections"
  ref={inputRef}
  spellCheck={false}
  type="search"
  value={query}
/>
```

- [ ] **Step 4: Run the focused test**

Run: `rtk npx vitest run tests/global-search.test.tsx`

Expected: PASS, including existing shortcut, navigation, result-opening, and backdrop tests.

- [ ] **Step 5: Commit the regression fix**

```bash
rtk git add extension/GlobalSearch.tsx tests/global-search.test.tsx
rtk git commit -m "fix: suppress global search autofill"
```

---

### Task 2: Define the Durable Workspace Operation Domain

**Files:**
- Create: `shared/workspace-operations.ts`
- Test: `tests/workspace-operations.test.ts`

**Interfaces:**
- Consumes: `WorkspaceSnapshot`, `Space`, `Collection`, and `SavedLink` from `shared/domain.ts`.
- Produces:

```ts
export type WorkspaceEntity = "space" | "collection" | "link";
export type WorkspaceOperation =
  | WorkspaceCreateOperation
  | WorkspaceUpdateOperation
  | WorkspaceDeleteOperation
  | WorkspaceReorderOperation;
export type WorkspaceTombstone = {
  entity: WorkspaceEntity;
  entityId: string;
  deletedRevision: number;
  deletedAt: string;
};
export type WorkspacePatchSet = {
  spaces: Space[];
  collections: Collection[];
  links: SavedLink[];
  tombstones: WorkspaceTombstone[];
};
export function coalesceWorkspaceOperations(
  existing: WorkspaceOperation[],
  incoming: WorkspaceOperation,
  immutableOperationIds?: ReadonlySet<string>,
): WorkspaceOperation[];
export function applyWorkspacePatch(
  cached: WorkspaceSnapshot,
  patch: WorkspacePatchSet,
): WorkspaceSnapshot;
export function replaceSavedWorkspace(
  cached: WorkspaceSnapshot,
  canonicalSaved: WorkspaceSnapshot,
): WorkspaceSnapshot;
export type WorkspaceRebaseResult = {
  snapshot: WorkspaceSnapshot;
  pending: WorkspaceOperation[];
  rejected: Array<{ operationId: string; code: "deleted" | "deleted_parent" }>;
};
export function rebaseWorkspaceOperations(
  canonical: WorkspaceSnapshot,
  tombstones: WorkspaceTombstone[],
  pending: WorkspaceOperation[],
): WorkspaceRebaseResult;
```

- [ ] **Step 1: Write failing tests for the exact discriminated operation shapes**

Use fixed UUIDs and assert that creates carry complete saved records, updates carry only mutable fields, deletes carry only entity identity, and reorders carry a parent and complete ordered ID list:

```ts
const create: WorkspaceOperation = {
  operationId: OPERATION_ID,
  deviceId: DEVICE_ID,
  sequence: 1,
  entity: "link",
  entityId: LINK_ID,
  action: "create",
  payload: {
    id: LINK_ID,
    collection_id: COLLECTION_ID,
    url: "https://example.com/",
    title: "Example",
    description: "",
    favicon_url: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
  },
  createdAt: NOW,
  baseRevision: 4,
};
expect(create.payload).not.toHaveProperty("access_token");
expect(create.payload).not.toHaveProperty("user_id");
```

- [ ] **Step 2: Write failing coalescing tests**

Cover these exact cases:

```ts
expect(coalesceWorkspaceOperations([create], update)).toEqual([
  expect.objectContaining({
    action: "create",
    payload: expect.objectContaining({ id: LINK_ID, title: "Final" }),
  }),
]);
expect(coalesceWorkspaceOperations([create], remove)).toEqual([]);
expect(coalesceWorkspaceOperations([firstReorder], secondReorder)).toEqual([secondReorder]);
expect(coalesceWorkspaceOperations([inFlightUpdate], laterUpdate)).toHaveLength(2);
```

Mark an operation in-flight by passing its ID in an optional `immutableOperationIds: ReadonlySet<string>` third argument; only unsent operations may coalesce.

- [ ] **Step 3: Write failing patch, bookmark-preservation, and replay tests**

Assert all of the following:

```ts
expect(applyWorkspacePatch(cached, patch).links).not.toContainEqual(
  expect.objectContaining({ id: TOMBSTONED_LINK_ID }),
);
expect(replaceSavedWorkspace(cachedWithBookmarks, canonical).links).toContainEqual(
  expect.objectContaining({ origin: "browser-bookmark" }),
);
expect(rebaseWorkspaceOperations(canonical, [], pending).snapshot.links).toContainEqual(
  expect.objectContaining({ id: LOCAL_LINK_ID, title: "Offline edit" }),
);
expect(rebaseWorkspaceOperations(canonical, tombstones, pending)).toMatchObject({
  pending: [],
  rejected: [{ operationId: UPDATE_DELETED_LINK_ID, code: "deleted" }],
});
```

- [ ] **Step 4: Run the new test and confirm the module is missing**

Run: `rtk npx vitest run tests/workspace-operations.test.ts`

Expected: FAIL because `shared/workspace-operations.ts` does not exist.

- [ ] **Step 5: Implement the discriminated unions and pure helpers**

Use these payload rules in the implementation:

```ts
type SpaceCreatePayload = Pick<Space,
  "id" | "name" | "color" | "position" | "created_at" | "updated_at"
>;
type CollectionCreatePayload = Pick<Collection,
  "id" | "space_id" | "name" | "position" | "created_at" | "updated_at"
>;
type LinkCreatePayload = Pick<SavedLink,
  "id" | "collection_id" | "url" | "title" | "description" |
  "favicon_url" | "position" | "created_at" | "updated_at"
>;
type WorkspaceCreateOperation = OperationMeta & {
  action: "create";
  payload: SpaceCreatePayload | CollectionCreatePayload | LinkCreatePayload;
};
type WorkspaceUpdateOperation = OperationMeta & {
  action: "update";
  payload: Record<string, string | null>;
};
type WorkspaceDeleteOperation = OperationMeta & {
  action: "delete";
  payload: Record<string, never>;
};
type WorkspaceReorderOperation = OperationMeta & {
  action: "reorder";
  payload: { parentId: string; orderedIds: string[] };
};
```

Reject read-only or `browser-bookmark` records in operation creation. Strip `user_id`, `origin`, and `read_only` from every outgoing payload; the server derives ownership and canonical metadata. Apply tombstones before upserting patches. During rebase, remove operations targeting tombstoned records or tombstoned parents and return their typed rejection. Normalize positions after patch/rebase. Preserve bookmark-origin arrays when replacing the saved canonical portion.

- [ ] **Step 6: Run the domain suites**

Run: `rtk npx vitest run tests/workspace-operations.test.ts tests/domain.test.ts tests/workspace-merge.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the operation domain**

```bash
rtk git add shared/workspace-operations.ts tests/workspace-operations.test.ts
rtk git commit -m "feat: define workspace sync operations"
```

---

### Task 3: Add Account-Scoped Atomic Cache and Outbox Storage

**Files:**
- Create: `extension/local-first-storage.ts`
- Modify: `extension/workspace-cache.ts`
- Test: `tests/local-first-storage.test.ts`
- Test: `tests/workspace-cache.test.ts`

**Interfaces:**
- Consumes: `WorkspaceOperation` and `WorkspaceSnapshot`.
- Produces:

```ts
export type AccountWorkspaceState = {
  snapshot: WorkspaceSnapshot;
  revision: number;
  cachedAt: string;
  outbox: WorkspaceOperation[];
  nextSequence: number;
  sync: {
    phase: "synced" | "syncing" | "offline";
    lastSyncedAt?: string;
    lastRevisionCheckAt?: string;
    error?: string;
  };
};
export const accountWorkspaceKey: (userId: string) => string;
export const accountOutboxKey: (userId: string) => string;
export const accountSyncStateKey: (userId: string) => string;
export const legacyCloudWorkspaceKey: (userId: string) => string;
export const corruptWorkspaceKey: (userId: string, timestamp: number) => string;
export const deviceIdKey = "tabloom-device-id-v1";
export class LocalFirstStorage {
  constructor(area: StorageArea, userId: string);
  load(): Promise<AccountWorkspaceState | null>;
  loadOrThrow(): Promise<AccountWorkspaceState>;
  save(state: AccountWorkspaceState): Promise<void>;
  saveCanonical(snapshot: WorkspaceSnapshot, revision: number): Promise<void>;
  update<T>(mutator: (state: AccountWorkspaceState) => Promise<[AccountWorkspaceState, T]>): Promise<T>;
  getOrCreateDeviceId(): Promise<string>;
  migrateV1(): Promise<AccountWorkspaceState | null>;
}
```

- [ ] **Step 1: Write failing key-isolation and schema-validation tests**

Assert exact keys:

```ts
expect(accountWorkspaceKey("user-a")).toBe("tabloom-cloud-workspace-v2:user-a");
expect(accountOutboxKey("user-a")).toBe("tabloom-sync-outbox-v1:user-a");
expect(accountSyncStateKey("user-a")).toBe("tabloom-sync-state-v2:user-a");
expect(accountWorkspaceKey("user-b")).not.toBe(accountWorkspaceKey("user-a"));
expect(await new LocalFirstStorage(area, "user-a").load()).toBeNull();
```

Seed malformed arrays, negative revisions, and operations with mismatched types; `load()` must return `null` without overwriting the stored value.

- [ ] **Step 2: Write failing atomic update and sequence tests**

Use the in-memory `StorageArea` pattern from `tests/workspace-cache.test.ts` and assert one `area.set` writes the complete state after a mutation:

```ts
await storage.update(async (state) => [{
  ...state,
  outbox: [...state.outbox, operation],
  nextSequence: state.nextSequence + 1,
}, operation]);
expect(area.set).toHaveBeenLastCalledWith({
  [accountWorkspaceKey(USER_ID)]: expect.objectContaining({ snapshot: expect.any(Object) }),
  [accountOutboxKey(USER_ID)]: expect.objectContaining({
    outbox: [operation],
    nextSequence: 2,
  }),
  [accountSyncStateKey(USER_ID)]: expect.objectContaining({ phase: expect.any(String) }),
});
```

- [ ] **Step 3: Write failing migration and device-ID tests**

Seed `tabloom-cloud-workspace-v1:<user-id>` with `{ snapshot, revision: 7 }`. Assert migration writes the v2 workspace, v1 outbox, and v2 sync-state keys in one `area.set`, keeps the legacy key untouched, and reuses one valid UUID from `tabloom-device-id-v1` across accounts. Seed malformed v2 data and assert it is copied to `tabloom-corrupt-workspace:<user-id>:<timestamp>` before online recovery, while a valid outbox remains available.

- [ ] **Step 4: Run the storage tests and confirm the module is missing**

Run: `rtk npx vitest run tests/local-first-storage.test.ts tests/workspace-cache.test.ts`

Expected: FAIL because `LocalFirstStorage` and v2 key helpers do not exist.

- [ ] **Step 5: Implement storage guards, migration, and atomic update**

Use the existing `withLocalWorkspaceLock` behavior, but move it to an exported account-aware lock key:

```ts
const lockKey = `tabloom-workspace-lock:${userId}`;
return withWorkspaceLock(lockKey, async () => {
  const current = await this.loadOrCreate();
  const [next, result] = await mutator(structuredClone(current));
  await this.area.set({
    [accountWorkspaceKey(this.userId)]: {
      version: 2,
      snapshot: next.snapshot,
      revision: next.revision,
      cachedAt: next.cachedAt,
    },
    [accountOutboxKey(this.userId)]: {
      version: 1,
      outbox: next.outbox,
      nextSequence: next.nextSequence,
    },
    [accountSyncStateKey(this.userId)]: {
      version: 2,
      revision: next.revision,
      ...next.sync,
    },
  });
  return result;
});
```

`saveCanonical(snapshot, revision)` must preserve bookmark-origin records already in the cache, the existing outbox, `nextSequence`, and sync timestamps while replacing only saved-origin records. Keep `BrowserWorkspaceCache.loadCloud/saveCloud` compatible for first sync by routing them through the v2 state.

- [ ] **Step 6: Run storage and first-sync cache tests**

Run: `rtk npx vitest run tests/local-first-storage.test.ts tests/workspace-cache.test.ts tests/first-sync.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit atomic account storage**

```bash
rtk git add extension/local-first-storage.ts extension/workspace-cache.ts tests/local-first-storage.test.ts tests/workspace-cache.test.ts
rtk git commit -m "feat: persist account sync outboxes"
```

---

### Task 4: Implement the Local-First Workspace Repository

**Files:**
- Create: `extension/local-first-repository.ts`
- Test: `tests/local-first-repository.test.ts`
- Modify: `extension/storage.ts`

**Interfaces:**
- Consumes: `WorkspaceRepository`, `MemoryWorkspaceRepository`, `LocalFirstStorage`, `coalesceWorkspaceOperations`.
- Produces:

```ts
export type LocalMutationListener = () => void;
export class LocalFirstWorkspaceRepository implements WorkspaceRepository {
  static create(input: {
    userId: string;
    storage: LocalFirstStorage;
    onMutation: LocalMutationListener;
  }): Promise<LocalFirstWorkspaceRepository>;
  load(): Promise<WorkspaceSnapshot>;
  // all existing WorkspaceRepository mutation signatures remain unchanged
}
```

- [ ] **Step 1: Write a failing immediate-create test**

Create a repository with revision `4`, call `createLink`, and assert:

```ts
const created = await repository.createLink(input);
expect((await repository.load()).links).toContainEqual(created);
expect((await storage.load())?.outbox).toContainEqual(expect.objectContaining({
  action: "create",
  entity: "link",
  entityId: created.id,
  baseRevision: 4,
}));
expect(onMutation).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Write failing tests for every mutation family**

Cover space create/update/delete, collection create/update/delete, link create/create-many/update/delete, collection reorder, link reorder, and cross-collection link movement. Verify cascade deletes create tombstone-producing delete operations only for the explicit parent; the server generates descendant tombstones transactionally.

- [ ] **Step 3: Write failing durability and validation tests**

Assert a second repository instance reads the first instance's persisted mutation, failed `StorageArea.set` rejects without calling `onMutation`, unsupported URLs reject before persistence, and bookmark-origin records cannot be edited or deleted through this repository.

- [ ] **Step 4: Run the focused tests and confirm the class is missing**

Run: `rtk npx vitest run tests/local-first-repository.test.ts tests/local-workspace.test.ts`

Expected: FAIL because `LocalFirstWorkspaceRepository` does not exist.

- [ ] **Step 5: Implement one atomic mutation pipeline**

All methods delegate to this exact flow:

```ts
private async mutate<T>(
  apply: (memory: MemoryWorkspaceRepository) => Promise<T>,
  makeOperations: (before: WorkspaceSnapshot, after: WorkspaceSnapshot, result: T) => WorkspaceOperation[],
): Promise<T> {
  const result = await this.storage.update(async (state) => {
    const before = structuredClone(state.snapshot);
    const memory = new MemoryWorkspaceRepository(this.userId, before);
    const value = await apply(memory);
    const after = await memory.load();
    const operations = makeOperations(before, after, value);
    return [{
      ...state,
      snapshot: after,
      outbox: operations.reduce(
        (outbox, operation) => coalesceWorkspaceOperations(outbox, operation),
        state.outbox,
      ),
      nextSequence: state.nextSequence + operations.length,
      cachedAt: new Date().toISOString(),
    }, value];
  });
  this.onMutation();
  return result;
}
```

Generate immutable operation IDs once, use the persisted device ID and sequence, and do not call Supabase from `load()` or any mutation.

- [ ] **Step 6: Run repository regression suites**

Run: `rtk npx vitest run tests/local-first-repository.test.ts tests/local-workspace.test.ts tests/repository.test.ts tests/dropped-tab.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the local repository**

```bash
rtk git add extension/local-first-repository.ts extension/storage.ts tests/local-first-repository.test.ts
rtk git commit -m "feat: add local-first workspace repository"
```

---

### Task 5: Add the Transactional Supabase Incremental Sync Protocol

**Files:**
- Create: `supabase/migrations/202608310001_local_first_workspace_sync.sql`
- Create: `supabase/tests/local_first_workspace_sync.test.sql`

**Interfaces:**
- Consumes: existing `spaces`, `collections`, `links`, `workspace_sync_state`, `workspace_snapshot_json`, and `bump_workspace_revision`.
- Produces these authenticated RPCs:

```sql
public.get_workspace_revision() returns jsonb
public.apply_workspace_operations(
  operations jsonb,
  expected_revision bigint
) returns jsonb
public.load_workspace_snapshot() returns jsonb
```

The apply response has this exact shape:

```json
{
  "revision": 8,
  "outcomes": [{"operationId":"40000000-0000-4000-8000-000000000001","status":"applied"}],
  "patches": {"spaces":[],"collections":[],"links":[]},
  "tombstones": [],
  "conflicts": []
}
```

- [ ] **Step 1: Write the failing pgTAP table, policy, and RPC existence tests**

Assert `workspace_operations` and `workspace_tombstones` exist, RLS is enabled, owner policies exist, and both RPC signatures exist. Start the test with `select plan(30);` and keep the file at exactly 30 pgTAP assertions.

- [ ] **Step 2: Write failing transaction and revision tests**

As user A, apply a valid space/collection/link create batch against revision `0`. Assert all rows exist, revision becomes `1` exactly once, outcomes are `applied`, and response patches contain the three canonical rows.

- [ ] **Step 3: Write failing idempotency and stale-revision tests**

Replay identical operation IDs and assert no new rows and no revision bump. Send a new operation with stale `expected_revision` and assert SQLSTATE `40001` with no partial write.

- [ ] **Step 4: Write failing ownership, validation, tombstone, and reorder tests**

Cover these exact cases:

```sql
-- unsupported chrome:// URL -> 22023 and whole batch rollback
-- collection referencing another user's space -> 23503/typed validation rejection
-- delete collection -> collection and descendant link tombstones in one revision
-- stale update for tombstoned link -> outcome status 'deleted'
-- complete reorder -> positions 0..n-1 and response patches for affected rows
-- user B cannot select user A operation or tombstone rows
```

Assert `load_workspace_snapshot()` now includes an owner-scoped `tombstones` array alongside `revision` and `snapshot`; the existing first-sync client may ignore this additive field.

- [ ] **Step 5: Run the new database test and confirm the migration is absent**

Run: `rtk supabase db reset && rtk supabase test db supabase/tests/local_first_workspace_sync.test.sql`

Expected: FAIL on missing tables/functions.

- [ ] **Step 6: Implement tables, RLS, grants, and revision RPC**

Create:

```sql
create table public.workspace_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  device_id uuid not null,
  sequence bigint not null check (sequence > 0),
  applied_revision bigint not null check (applied_revision >= 0),
  applied_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);

create table public.workspace_tombstones (
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('space','collection','link')),
  entity_id uuid not null,
  deleted_revision bigint not null check (deleted_revision >= 0),
  deleted_at timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);
```

Enable RLS, add owner-select policies, and grant only the operations required by authenticated RPC execution.

Replace `load_workspace_snapshot()` with an additive response that keeps the current first-sync fields and includes owner tombstones:

```sql
return jsonb_build_object(
  'revision', current_revision,
  'snapshot', public.workspace_snapshot_json(owner_id),
  'tombstones', coalesce((
    select jsonb_agg(jsonb_build_object(
      'entity', entity_type,
      'entityId', entity_id,
      'deletedRevision', deleted_revision,
      'deletedAt', deleted_at
    ))
    from public.workspace_tombstones
    where user_id = owner_id
  ), '[]'::jsonb)
);
```

- [ ] **Step 7: Implement `apply_workspace_operations` transactionally**

The function must authenticate with `auth.uid()`, bound arrays to 500 operations, lock the user's revision row, reject a stale expected revision before writes, set `tabloom.merge_in_progress = on`, and process operations in ascending `(sequence, operationId)` order. For each operation:

1. return `already_applied` when `(user_id, operation_id)` exists;
2. reject malformed UUIDs, fields, parent references, names longer than 80, descriptions longer than 1000, and unsupported URLs;
3. reject ordinary updates for an existing tombstone with outcome `deleted`;
4. derive `user_id` from `auth.uid()` for every insert/update;
5. cascade parent deletes through existing foreign keys and insert descendant tombstones before deletion;
6. normalize each affected parent's positions;
7. record accepted operation IDs at the resulting revision;
8. increment `workspace_sync_state.revision` once only if canonical data changed; and
9. return only affected canonical rows, new tombstones, operation outcomes, typed conflicts, and the resulting revision.

Use one PL/pgSQL transaction body with explicit temporary result tables so no partial response can escape:

```sql
create or replace function public.apply_workspace_operations(
  operations jsonb,
  expected_revision bigint
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  current_revision bigint;
  resulting_revision bigint;
  operation jsonb;
  changed boolean := false;
begin
  if owner_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if jsonb_typeof(operations) <> 'array'
     or jsonb_array_length(operations) > 500 then
    raise exception 'invalid workspace operations' using errcode = '22023';
  end if;
  insert into public.workspace_sync_state(user_id, revision)
  values (owner_id, 0) on conflict (user_id) do nothing;
  select revision into current_revision
  from public.workspace_sync_state
  where user_id = owner_id for update;
  if current_revision <> expected_revision then
    raise exception 'workspace revision conflict' using errcode = '40001';
  end if;
  create temporary table tabloom_operation_outcomes(
    operation_id uuid primary key,
    status text not null,
    message text
  ) on commit drop;
  perform set_config('tabloom.merge_in_progress', 'on', true);
  for operation in
    select value from jsonb_array_elements(operations) value
    order by (value->>'sequence')::bigint, value->>'operationId'
  loop
    case operation->>'entity'
      when 'space' then
        changed := public.apply_workspace_space_operation(
          owner_id, operation, current_revision + 1
        ) or changed;
      when 'collection' then
        changed := public.apply_workspace_collection_operation(
          owner_id, operation, current_revision + 1
        ) or changed;
      when 'link' then
        changed := public.apply_workspace_link_operation(
          owner_id, operation, current_revision + 1
        ) or changed;
      else
        raise exception 'invalid workspace entity' using errcode = '22023';
    end case;
  end loop;
  resulting_revision := current_revision + case when changed then 1 else 0 end;
  if changed then
    update public.workspace_sync_state
    set revision = resulting_revision, updated_at = now()
    where user_id = owner_id;
  end if;
  return jsonb_build_object(
    'revision', resulting_revision,
    'outcomes', (select coalesce(jsonb_agg(jsonb_build_object(
      'operationId', operation_id, 'status', status, 'message', message
    )), '[]'::jsonb) from tabloom_operation_outcomes),
    'patches', public.workspace_affected_patch_json(owner_id),
    'tombstones', public.workspace_affected_tombstone_json(owner_id),
    'conflicts', '[]'::jsonb
  );
end;
$$;
```

Implement the dispatch branches as non-granted SQL helpers with these exact signatures:

```sql
public.apply_workspace_space_operation(uuid, jsonb, bigint) returns boolean
public.apply_workspace_collection_operation(uuid, jsonb, bigint) returns boolean
public.apply_workspace_link_operation(uuid, jsonb, bigint) returns boolean
public.workspace_affected_patch_json(uuid) returns jsonb
public.workspace_affected_tombstone_json(uuid) returns jsonb
```

Each entity helper handles `create`, `update`, `delete`, and `reorder` when valid for that entity, appends one row to `tabloom_operation_outcomes`, records affected IDs in temporary tables, and returns whether canonical data changed. Revoke direct execution from `anon` and `authenticated`; the public RPC remains the only granted entry point.

- [ ] **Step 8: Run all Supabase tests**

Run: `rtk npm run test:supabase`

Expected: PASS for initial workspace, bookmarks, first merge, OAuth facade, and local-first sync.

- [ ] **Step 9: Commit the database protocol**

```bash
rtk git add supabase/migrations/202608310001_local_first_workspace_sync.sql supabase/tests/local_first_workspace_sync.test.sql
rtk git commit -m "feat: add incremental workspace sync rpc"
```

---

### Task 6: Implement the Typed Supabase Sync Transport

**Files:**
- Create: `extension/workspace-sync-transport.ts`
- Modify: `shared/workspace-sync-repository.ts`
- Test: `tests/workspace-sync-transport.test.ts`
- Test: `tests/workspace-sync-repository.test.ts`

**Interfaces:**
- Consumes: `SupabaseClient`, `WorkspaceOperation`, `WorkspacePatchSet`, `VersionedWorkspaceSnapshot`.
- Produces:

```ts
export type WorkspaceRevision = { revision: number; serverTime: string };
export type OperationOutcome = {
  operationId: string;
  status: "applied" | "already_applied" | "deleted" | "rejected";
  message?: string;
};
export type ApplyOperationsResult = {
  revision: number;
  outcomes: OperationOutcome[];
  patches: Omit<WorkspacePatchSet, "tombstones">;
  tombstones: WorkspaceTombstone[];
  conflicts: Array<{ operationId: string; code: string; message: string }>;
};
export type CanonicalWorkspaceState = VersionedWorkspaceSnapshot & {
  tombstones: WorkspaceTombstone[];
};
export interface WorkspaceSyncTransport {
  getRevision(): Promise<WorkspaceRevision>;
  applyOperations(operations: WorkspaceOperation[], expectedRevision: number): Promise<ApplyOperationsResult>;
  loadCanonical(): Promise<CanonicalWorkspaceState>;
}
export class SupabaseWorkspaceSyncTransport implements WorkspaceSyncTransport {}
```

- [ ] **Step 1: Write failing request-contract tests**

Assert exact RPC calls:

```ts
expect(rpc).toHaveBeenCalledWith("get_workspace_revision");
expect(rpc).toHaveBeenCalledWith("apply_workspace_operations", {
  operations,
  expected_revision: 7,
});
expect(rpc).toHaveBeenCalledWith("load_workspace_snapshot");
```

- [ ] **Step 2: Write failing response-validation tests**

Reject negative/non-integer revisions, malformed outcome IDs, unsupported statuses, patch arrays with invalid records, and malformed tombstones. Confirm decoded canonical rows receive `{ origin: "saved", read_only: false }`, and confirm `loadCanonical()` requires and returns the canonical tombstone array.

- [ ] **Step 3: Write failing typed-error tests**

Assert SQLSTATE `40001` becomes `WorkspaceRevisionConflictError`, authentication codes `28000`, `42501`, `PGRST301`, and `401` become `WorkspaceAuthenticationError`, and other RPC errors preserve their server message.

- [ ] **Step 4: Run focused tests and confirm the transport is missing**

Run: `rtk npx vitest run tests/workspace-sync-transport.test.ts tests/workspace-sync-repository.test.ts`

Expected: FAIL because the new transport does not exist.

- [ ] **Step 5: Export shared RPC error classification and implement strict parsers**

Move the existing private error classifier into:

```ts
export function throwWorkspaceSyncError(
  error: { code?: string; message: string } | null,
): void;
```

Use it from both first-sync repository and incremental transport. Parse all unknown RPC data with type guards before returning typed results.

- [ ] **Step 6: Run transport and first-sync tests**

Run: `rtk npx vitest run tests/workspace-sync-transport.test.ts tests/workspace-sync-repository.test.ts tests/first-sync.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the transport**

```bash
rtk git add extension/workspace-sync-transport.ts shared/workspace-sync-repository.ts tests/workspace-sync-transport.test.ts tests/workspace-sync-repository.test.ts
rtk git commit -m "feat: add workspace sync transport"
```

---

### Task 7: Implement the Single-Flight Workspace Sync Engine

**Files:**
- Create: `extension/workspace-sync-engine.ts`
- Test: `tests/workspace-sync-engine.test.ts`

**Interfaces:**
- Consumes: `LocalFirstStorage`, `WorkspaceSyncTransport`, `applyWorkspacePatch`, `replaceSavedWorkspace`, and `rebaseWorkspaceOperations`.
- Produces:

```ts
export type SyncReason = "mutation" | "startup" | "focus" | "online" | "manual";
export type SyncEngineState =
  | { phase: "synced"; revision: number; pending: 0; lastSyncedAt: string }
  | { phase: "syncing"; revision: number; pending: number }
  | { phase: "offline"; revision: number; pending: number; error?: string };
export class WorkspaceSyncEngine {
  constructor(input: {
    storage: LocalFirstStorage;
    transport: WorkspaceSyncTransport;
    mutationDebounceMs?: number;
    focusFreshnessMs?: number;
    now?: () => number;
    onActionRequired?: (message: string) => void;
  });
  start(): Promise<void>;
  requestSync(reason: SyncReason): void;
  refresh(): Promise<void>;
  stop(): void;
  subscribe(listener: (state: SyncEngineState) => void): () => void;
}
```

- [ ] **Step 1: Write failing fake-timer debounce and batching tests**

With `vi.useFakeTimers()`, request three mutation syncs inside 500 ms, advance time by 499 ms and assert no transport call, then advance one millisecond and assert one `applyOperations` call containing the persisted batch.

- [ ] **Step 2: Write failing startup and unchanged-revision tests**

Assert `start()` pushes an existing outbox before revision check. With an empty outbox and matching revision, assert `getRevision()` runs once and `loadCanonical()` never runs.

- [ ] **Step 3: Write failing single-flight and trigger tests**

Hold the first apply promise unresolved, call `refresh()` twice, and assert only one call is active. Resolve it and assert exactly one follow-up cycle. Verify online always requests sync and focus requests sync only when the last revision check is at least 30 seconds old.

- [ ] **Step 4: Write failing patch, pull, and acknowledgement tests**

Assert a successful push applies returned patches before removing acknowledged operations. A newer remote revision with no outbox calls `loadCanonical()` and preserves bookmark-origin records. A storage failure leaves the original outbox unchanged.

- [ ] **Step 5: Write failing conflict and offline tests**

On the first `WorkspaceRevisionConflictError`, load canonical snapshot plus tombstones, call `rebaseWorkspaceOperations`, persist its rebased snapshot and surviving pending operations, and retry once. Assert tombstoned-record and tombstoned-parent operations leave the outbox only after the rebased cache is written and produce one actionable error callback. A second conflict exits with offline state and pending operations. Network/authentication failures keep the outbox; authentication failure must not schedule continuous retry.

- [ ] **Step 6: Write failing lifecycle and status tests**

Assert subscription immediately receives current state, transitions `syncing -> synced`, reports pending count, reports `offline` on failure, and receives nothing after unsubscribe. `stop()` cancels debounce/focus work and prevents an account-switched engine from writing.

- [ ] **Step 7: Run the focused tests and confirm the engine is missing**

Run: `rtk npx vitest run tests/workspace-sync-engine.test.ts`

Expected: FAIL because `WorkspaceSyncEngine` does not exist.

- [ ] **Step 8: Implement scheduling and one cycle**

The cycle order is fixed:

```ts
private async synchronize(): Promise<void> {
  const local = await this.storage.loadOrThrow();
  this.publish({ phase: "syncing", revision: local.revision, pending: local.outbox.length });
  if (local.outbox.length) await this.push(local);
  const current = await this.storage.loadOrThrow();
  const remote = await this.transport.getRevision();
  if (remote.revision > current.revision && current.outbox.length === 0) {
    await this.pullCanonical(remote.revision);
  }
  await this.publishSynced();
}
```

Wrap this in a single-flight promise, set one boolean follow-up flag for overlapping requests, debounce only `mutation`, bypass freshness for `manual`, and cap one-cycle conflict retry at one.

- [ ] **Step 9: Run engine, storage, operation, and transport tests**

Run: `rtk npx vitest run tests/workspace-sync-engine.test.ts tests/local-first-storage.test.ts tests/workspace-operations.test.ts tests/workspace-sync-transport.test.ts`

Expected: PASS with no unhandled timer or promise warnings.

- [ ] **Step 10: Commit the engine**

```bash
rtk git add extension/workspace-sync-engine.ts tests/workspace-sync-engine.test.ts
rtk git commit -m "feat: synchronize local workspace operations"
```

---

### Task 8: Transition First Sync and Extension Bootstrap to Local Authority

**Files:**
- Modify: `extension/first-sync.ts`
- Modify: `extension/src.tsx`
- Test: `tests/first-sync.test.ts`
- Test: `tests/extension-first-sync.test.ts`
- Test: `tests/extension.test.ts`

**Interfaces:**
- Consumes: `LocalFirstStorage`, `LocalFirstWorkspaceRepository`, `WorkspaceSyncEngine`, `SupabaseWorkspaceSyncTransport`.
- Produces: signed-in bootstrap that activates local account storage and owns one engine per active user.

- [ ] **Step 1: Write failing first-sync activation tests**

Change the coordinator dependency from `activateCloud(repository, snapshot)` to:

```ts
activateCanonical(snapshot: WorkspaceSnapshot, revision: number): Promise<void>;
```

Assert cloud adoption and confirmed merge call `activateCanonical` with the exact canonical snapshot/revision and never call `cloudRepository.load()` a second time.

Remove the now-unused `cloudRepository` dependency from `FirstSyncCoordinator`; `syncRepository.loadVersioned()` is the canonical first-sync read and `cache.saveCloud()` remains the canonical write before activation.

- [ ] **Step 2: Write failing signed-in cached-startup tests**

Seed an account v2 cache and authenticated session. Assert the extension renders cached data before transport completion, installs `LocalFirstWorkspaceRepository`, starts one engine, and does not invoke the three-table `SupabaseWorkspaceRepository.load()` path.

- [ ] **Step 3: Write failing no-cache and first-sign-in tests**

With no account cache, assert the existing first-sync confirmation rules remain. After adoption/import/confirmation, assert canonical data is stored in v2 and local authority is activated. Signed-out startup must continue using `createLocalWorkspaceRepository()` with no Supabase workspace call.

- [ ] **Step 4: Write failing focus, online, mutation, and account-switch tests**

Assert:

```ts
repositoryMutation -> engine.requestSync("mutation")
document visibility recovery -> engine.requestSync("focus")
window online event -> engine.requestSync("online")
account switch -> oldEngine.stop() before new account cache renders
```

Also assert event listeners are removed on unmount and no old-account callback updates the new account UI.

Add a manual-bookmark-sync assertion: writing the combined bookmark envelope replaces only cached `browser-bookmark` records, preserves saved-origin records and the outbox, and creates no saved-workspace operation.

- [ ] **Step 5: Run the focused bootstrap tests and confirm they fail**

Run: `rtk npx vitest run tests/first-sync.test.ts tests/extension-first-sync.test.ts tests/extension.test.ts`

Expected: FAIL because activation still installs `CombinedWorkspaceRepository` and performs API-backed loads.

- [ ] **Step 6: Refactor first-sync activation**

Remove the direct-cloud repository from post-sync authority. Keep `SupabaseBookmarkRepository` only for manual bookmark synchronization. On canonical activation:

```ts
const localFirst = await LocalFirstWorkspaceRepository.create({
  userId,
  storage: localFirstStorage,
  onMutation: () => engineRef.current?.requestSync("mutation"),
});
setRepository(localFirst);
setSnapshot(await localFirst.load());
```

The coordinator has already persisted `snapshot` and `revision` through `cache.saveCloud()` before invoking this callback, so activation must not perform a second storage write.

- [ ] **Step 7: Wire engine lifecycle and remove API-first fallbacks**

Replace `cloudAuthorityRef` and direct cloud repository loading with account-cache reads. Subscribe once to engine status, register `visibilitychange` and `online`, and stop/unsubscribe before sign-out, switch-account, or unmount. Keep retryable mutation errors in `ToastRegion`; remove routine heading messages such as `SYNCED WORKSPACE`, `CHECKING WORKSPACE SYNC`, and `LOCAL WORKSPACE · SYNC PENDING`.

Use stable callbacks whose cleanup is explicit:

```tsx
useEffect(() => {
  const engine = engineRef.current;
  if (!engine) return;
  const onVisibility = () => {
    if (document.visibilityState === "visible") engine.requestSync("focus");
  };
  const onOnline = () => engine.requestSync("online");
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    engine.stop();
  };
}, [activeUserId]);
```

Route `BrowserBookmarksPanel` cache writes through `LocalFirstStorage.update`: retain saved-origin rows from the current snapshot, replace bookmark-origin rows with the synchronized envelope rows, and leave `outbox`, `nextSequence`, and revision unchanged.

- [ ] **Step 8: Run bootstrap plus organizer regression suites**

Run: `rtk npx vitest run tests/first-sync.test.ts tests/extension-first-sync.test.ts tests/extension.test.ts tests/current-tabs-sheet.test.tsx tests/extension-collection-rows.test.tsx tests/space-sidebar.test.tsx`

Expected: PASS.

- [ ] **Step 9: Commit the authority transition**

```bash
rtk git add extension/first-sync.ts extension/src.tsx tests/first-sync.test.ts tests/extension-first-sync.test.ts tests/extension.test.ts
rtk git commit -m "feat: activate signed-in local workspace authority"
```

---

### Task 9: Show Colored Sync Status and Manual Sync in the Account Menu

**Files:**
- Modify: `extension/SyncLoginPrompt.tsx`
- Modify: `extension/style.css`
- Modify: `extension/src.tsx`
- Test: `tests/sync-login-prompt.test.tsx`
- Test: `tests/extension-style-consistency.test.tsx`

**Interfaces:**
- Consumes: `SyncEngineState` and `WorkspaceSyncEngine.refresh()`.
- Produces new props:

```ts
type SyncLoginPromptProps = {
  callbackUrl: string;
  configured: boolean;
  onSignIn: () => Promise<void>;
  onSwitchAccount?: () => Promise<void>;
  target: BrowserTarget;
  user?: SyncUser | null;
  syncState?: SyncEngineState;
  onSyncNow?: () => Promise<void>;
};
```

- [ ] **Step 1: Write failing account-menu status tests**

Render each state and assert visible text plus semantic class:

```tsx
expect(screen.getByText("Synced")).toHaveClass("sync-state-synced");
expect(screen.getByText("Syncing")).toHaveClass("sync-state-syncing");
expect(screen.getByText("Offline")).toHaveClass("sync-state-offline");
expect(screen.getByText("3 changes waiting to sync")).toBeInTheDocument();
```

Assert menu order: profile, status row, then `Switch account`.

- [ ] **Step 2: Write failing `Sync now` interaction tests**

Assert the icon button has `aria-label="Sync now"`, `title="Sync now"`, calls `onSyncNow` once, stays available in all three states, and uses an animated refresh icon only while syncing.

- [ ] **Step 3: Write failing no-banner/no-success-toast integration assertions**

After a successful engine state transition, assert the workspace header does not contain `SYNCED WORKSPACE`, no `role="status"` toast says `Synced`, and the account menu does show `Synced`.

- [ ] **Step 4: Run component tests and confirm the new props/UI are absent**

Run: `rtk npx vitest run tests/sync-login-prompt.test.tsx tests/extension-style-consistency.test.tsx tests/extension.test.ts`

Expected: FAIL on missing status text and `Sync now` button.

- [ ] **Step 5: Implement status copy, icons, and manual action**

Render this structure between `.account-profile` and the switch-account button:

```tsx
<div className={`account-sync-status sync-state-${syncState.phase}`}>
  <StatusIcon aria-hidden="true" />
  <span>
    <strong>{label}</strong>
    {secondary && <small>{secondary}</small>}
  </span>
  <button aria-label="Sync now" title="Sync now" onClick={() => void onSyncNow?.()}>
    <RefreshCw className={syncState.phase === "syncing" ? "is-spinning" : undefined} />
  </button>
</div>
```

Use `Synced just now` when `lastSyncedAt` is recent, `N changes waiting to sync` for pending offline work, and `N changes pending` while syncing.

- [ ] **Step 6: Add opaque, theme-safe status styling**

Use existing account-menu surface variables and these status colors:

```css
.sync-state-synced { --sync-state-color: #36b37e; }
.sync-state-syncing { --sync-state-color: #e6b94a; }
.sync-state-offline { --sync-state-color: #ef646b; }
.account-sync-status { color: var(--sync-state-color); }
.account-sync-status small { color: var(--muted); }
```

Keep text/icon labels so color is not the only indicator. The `Sync now` target must be at least 36 by 36 CSS pixels.

- [ ] **Step 7: Run component, accessibility, and style tests**

Run: `rtk npx vitest run tests/sync-login-prompt.test.tsx tests/extension-style-consistency.test.tsx tests/extension.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit account sync status**

```bash
rtk git add extension/SyncLoginPrompt.tsx extension/style.css extension/src.tsx tests/sync-login-prompt.test.tsx tests/extension-style-consistency.test.tsx tests/extension.test.ts
rtk git commit -m "feat: show account workspace sync status"
```

---

### Task 10: Verify Local-First Behavior Across Database and Browser Builds

**Files:**
- Modify: `tests/e2e/visual-consistency.spec.ts`
- Modify: `tests/e2e/browser-bookmarks.spec.ts`
- Modify: `package.json` only if the existing scripts cannot address the focused suites
- Regenerate only intentionally changed files under `tests/e2e/__screenshots__/visual-consistency.spec.ts/`

**Interfaces:**
- Consumes: the completed local-first repository, sync protocol, engine, bootstrap, and account status UI.
- Produces: release-level evidence for cached startup, cross-device synchronization, offline durability, bookmark preservation, and all-browser packaging.

- [ ] **Step 1: Add browser-level cached-startup coverage**

Seed `tabloom-cloud-workspace-v2:<user-id>` before page load, block Supabase requests, open the extension, and assert the cached collection and link render. Restore network, trigger `online`, and assert the queued change synchronizes without a page reload.

- [ ] **Step 2: Add revision-efficiency and remote-change coverage**

Instrument RPC calls and assert unchanged startup calls `get_workspace_revision` but not `load_workspace_snapshot`. Simulate a newer remote revision, trigger eligible focus recovery, and assert the new remote card appears while the browser-bookmark space remains present.

- [ ] **Step 3: Add account-switch and notification coverage**

Switch from user A to user B and assert user A's cached title and pending count disappear before user B renders. After successful synchronization, assert no long success banner exists and the account menu shows green `Synced`.

- [ ] **Step 4: Update the visual account-menu fixture**

Capture the open account menu in Chromium, Firefox, and WebKit projects with the `Synced` status row. Review the diff to confirm opaque dropdown background, 36-pixel manual-sync target, consistent colors, and no layout overlap.

- [ ] **Step 5: Run focused unit and Supabase verification**

Run:

```bash
rtk npx vitest run \
  tests/global-search.test.tsx \
  tests/workspace-operations.test.ts \
  tests/local-first-storage.test.ts \
  tests/local-first-repository.test.ts \
  tests/workspace-sync-transport.test.ts \
  tests/workspace-sync-engine.test.ts \
  tests/first-sync.test.ts \
  tests/sync-login-prompt.test.tsx \
  tests/extension.test.ts
rtk npm run test:supabase
```

Expected: all focused Vitest and pgTAP tests pass.

- [ ] **Step 6: Run static and production-build verification**

Run:

```bash
rtk npm run lint
rtk npx tsc --noEmit
rtk npm run build:all
```

Expected: zero lint/type errors; hosted app and Chromium/Firefox/Safari extension builds complete.

- [ ] **Step 7: Run browser regression suites**

Run:

```bash
rtk npm run test:e2e:bookmarks
rtk npm run test:e2e:visual
```

Expected: cached startup, bookmark behavior, global search, account status, and cross-browser visual assertions pass with no console errors.

- [ ] **Step 8: Run the full project gate**

Run: `rtk npm run verify`

Expected: PASS for lint, TypeScript, all unit tests, Supabase tests, hosted build, and all extension builds.

- [ ] **Step 9: Inspect the final diff for secrets and scope**

Run:

```bash
rtk git diff --check
rtk rg -n "service_role|provider_token|access_token|refresh_token" extension shared supabase --glob '!*.test.*'
rtk git status --short
```

Expected: no whitespace errors, no committed secret values, and no unrelated files staged.

- [ ] **Step 10: Commit final E2E evidence**

```bash
rtk git add tests/e2e/visual-consistency.spec.ts tests/e2e/browser-bookmarks.spec.ts tests/e2e/__screenshots__/visual-consistency.spec.ts package.json
rtk git commit -m "test: verify local-first extension sync"
```

Only add screenshot files whose pixels intentionally changed, and omit `package.json` when no script change was necessary.
