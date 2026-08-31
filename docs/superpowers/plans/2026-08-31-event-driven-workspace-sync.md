# Event-Driven Workspace Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace continuous Tabloom workspace synchronization with local-first optimistic writes, finite focus reads, explicit ordered retry, and one cross-tab network request at a time.

**Architecture:** Keep `LocalFirstWorkspaceRepository` responsible for constructing domain operations and atomically committing the optimistic snapshot plus durable queue entries. Introduce a `WorkspaceSyncCoordinator` as the sole owner of remote read/write policy, ordered failure handling, bounded conflict reconciliation, and status. All network work runs through a user-scoped cross-tab lock; other Tabloom pages render storage notifications without recursively starting sync.

**Tech Stack:** TypeScript, React 19, Vitest, Testing Library, WebExtension APIs, Web Locks API, Supabase JS/RPC, Chromium/Firefox/Safari extension builds.

**Spec:** `docs/superpowers/specs/2026-08-31-event-driven-workspace-sync-design.md`

## Global Constraints

- Preserve every existing optimistic snapshot and operation ID during migration.
- Do not add timers, polling, realtime subscriptions, automatic retry, or follow-up sync cycles.
- A focus transition may perform one revision check and at most one conditional canonical load; it never flushes queued writes.
- A user mutation is locally durable before its one immediate remote attempt begins.
- The first failed operation blocks every later operation until explicit Retry.
- Only runtime request state may be `inflight`; never persist `syncing` as resumable work.
- All remote work for one account must hold the same cross-tab exclusive lock across request, rebase, and persistence.
- Storage change events update rendered state only and never call the transport.
- Keep behavior shared across Chromium, Firefox, and Safari; browser-specific code belongs only in adapters.
- Preserve local data on authentication failure, logout, page close, and transport failure.
- Do not modify Supabase RPC behavior or add a server migration for this client redesign.

## File and Responsibility Map

| File | Responsibility |
| --- | --- |
| `extension/local-first-storage.ts` | Versioned queue persistence, migration, interrupted-attempt normalization, account-key subscriptions |
| `extension/local-first-repository.ts` | Optimistic domain mutation, atomic queue append, awaitable mutation submission callback |
| `extension/workspace-sync-errors.ts` | Typed coordinator errors and display-safe messages |
| `extension/workspace-sync-lock.ts` | Web Locks implementation and browser-storage lease fallback |
| `extension/workspace-sync-coordinator.ts` | Finite initial/focus reads, immediate ordered writes, retry, bounded conflict handling, status |
| `extension/workspace-sync-lifecycle.ts` | Coalesced genuine focus transitions only |
| `extension/browser/types.ts` | Typed WebExtension storage-change API and adapter subscription contract |
| `extension/browser/webextension.ts` | `storage.onChanged` normalization for Chromium, Firefox, and Safari |
| `extension/src.tsx` | Coordinator construction, repository handoff, snapshot/status subscriptions, toast errors |
| `extension/SyncLoginPrompt.tsx` | Synced/Syncing/Failed/Offline presentation and explicit Retry control |
| `extension/style.css` | Green/yellow/red account-sync visual states |
| `tests/local-first-storage.test.ts` | Queue v2 migration and interrupted-attempt persistence tests |
| `tests/local-first-repository.test.ts` | Atomic optimistic commit and submission rejection tests |
| `tests/workspace-sync-lock.test.ts` | Cross-tab Web Lock and lease mutual exclusion/recovery tests |
| `tests/workspace-sync-coordinator.test.ts` | Coordinator read, write, failure, retry, conflict, and cross-tab behavior |
| `tests/workspace-sync-lifecycle.test.ts` | Focus/visibility coalescing tests |
| `tests/browser-adapter.test.ts` | Storage-change adapter normalization tests |
| `tests/sync-login-prompt.test.tsx` | Status colors, counts, errors, and Retry interaction tests |
| `tests/e2e/visual-consistency.spec.ts` | Cross-browser account-menu status regression coverage |

---

### Task 1: Version and Migrate the Durable Operation Queue

**Files:**
- Modify: `extension/local-first-storage.ts`
- Modify: `tests/local-first-storage.test.ts`

- [ ] **Step 1: Write failing queue-v2 migration tests**

Add tests proving that v1 operations are retained in sequence order, the first becomes failed, later entries become waiting, optimistic snapshot data remains unchanged, and persisted `syncing` normalizes to a retryable non-active state.

```ts
it("migrates a v1 outbox without discarding optimistic data", async () => {
  values[accountWorkspaceKey(USER_ID)] = workspaceEnvelope(optimisticSnapshot, 7);
  values[accountOutboxKey(USER_ID)] = { version: 1, outbox: [operation, laterOperation], nextSequence: 3 };
  values[accountSyncStateKey(USER_ID)] = { version: 2, phase: "syncing", revision: 7 };

  const loaded = await new LocalFirstStorage(memoryArea(values), USER_ID).loadOrThrow();

  expect(loaded.snapshot).toEqual(optimisticSnapshot);
  expect(loaded.queue).toEqual([
    expect.objectContaining({ operation, state: "failed", error: expect.stringContaining("Retry") }),
    { operation: laterOperation, state: "waiting" },
  ]);
  expect(loaded.sync.phase).toBe("failed");
});
```

- [ ] **Step 2: Run the focused test and confirm the type/runtime failure**

Run: `npm run test:unit -- tests/local-first-storage.test.ts`

Expected: FAIL because `AccountWorkspaceState` has `outbox`, not `queue`, and v2 validation/migration does not exist.

- [ ] **Step 3: Add the v2 queue and persisted status types**

Replace the persisted model with these concrete types:

```ts
export type QueuedWorkspaceOperation = {
  operation: WorkspaceOperation;
  state: "waiting" | "failed";
  attemptedAt?: string;
  error?: string;
};

export type PersistedSyncState = {
  phase: "synced" | "failed" | "offline";
  lastSyncedAt?: string;
  lastRevisionCheckAt?: string;
  error?: string;
};

export type AccountWorkspaceState = {
  snapshot: WorkspaceSnapshot;
  revision: number;
  cachedAt: string;
  queue: QueuedWorkspaceOperation[];
  nextSequence: number;
  sync: PersistedSyncState;
};

type QueueEnvelope = {
  version: 2;
  queue: QueuedWorkspaceOperation[];
  nextSequence: number;
};
```

Keep reading `tabloom-sync-outbox-v1:<userId>` for migration, but write `tabloom-sync-queue-v2:<userId>`. Validate strictly increasing `operation.sequence`, valid timestamps, and `error` only on failed entries. Normalize a stored attempted waiting entry to failed on load with `"The previous sync was interrupted. Retry to continue."`.

- [ ] **Step 4: Make `load`, `save`, `update`, `saveCanonical`, and `migrateV1` preserve queue v2**

Implement one `normalizeAccountState(raw)` path so every load applies the same migration. Save workspace, queue, and persisted status together with one `area.set` call. Remove the legacy outbox key only after the v2 queue has been written successfully when `remove` is supported.

- [ ] **Step 5: Run storage tests**

Run: `npm run test:unit -- tests/local-first-storage.test.ts`

Expected: PASS, including corruption recovery and legacy workspace migration tests.

- [ ] **Step 6: Commit the storage schema change**

```bash
git add extension/local-first-storage.ts tests/local-first-storage.test.ts
git commit -m "refactor: version workspace sync queue"
```

---

### Task 2: Add Typed Cross-Tab Storage Observation

**Files:**
- Modify: `extension/browser/types.ts`
- Modify: `extension/browser/webextension.ts`
- Modify: `extension/local-first-storage.ts`
- Modify: `tests/browser-adapter.test.ts`
- Modify: `tests/local-first-storage.test.ts`

- [ ] **Step 1: Write failing adapter and account-filter tests**

Test that local-area changes are emitted, unrelated areas are ignored, unsubscribe removes the listener, and `LocalFirstStorage.subscribe` fires only for its account workspace/queue/status keys.

```ts
const unsubscribe = adapter.storageChanges.subscribe(listener);
onChanged.emit({ [accountWorkspaceKey(USER_ID)]: { newValue: {} } }, "local");
expect(listener).toHaveBeenCalledWith([accountWorkspaceKey(USER_ID)]);
onChanged.emit({ unrelated: { newValue: true } }, "sync");
expect(listener).toHaveBeenCalledTimes(1);
unsubscribe();
```

- [ ] **Step 2: Run the focused tests and confirm missing subscription APIs**

Run: `npm run test:unit -- tests/browser-adapter.test.ts tests/local-first-storage.test.ts`

Expected: FAIL because `WebExtensionNamespace.storage.onChanged`, `BrowserAdapter.storageChanges`, and `LocalFirstStorage.subscribe` are absent.

- [ ] **Step 3: Extend the browser adapter contract**

Add:

```ts
export type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

// WebExtensionNamespace.storage
onChanged?: {
  addListener(listener: (changes: StorageChanges, areaName: string) => void): void;
  removeListener(listener: (changes: StorageChanges, areaName: string) => void): void;
};

// BrowserAdapter
readonly storageChanges: {
  subscribe(listener: (changedKeys: string[]) => void): () => void;
};
```

Normalize `api.storage.onChanged` in `createWebExtensionAdapter`; Safari continues to inherit this shared implementation.

- [ ] **Step 4: Add account-scoped storage subscription**

Accept the adapter subscription in `LocalFirstStorage` options and expose:

```ts
subscribe(listener: (state: AccountWorkspaceState) => void): () => void {
  return this.subscribeToChanges(async (keys) => {
    if (!keys.some((key) => this.accountKeys.has(key))) return;
    const state = await this.load();
    if (state) listener(state);
  });
}
```

This callback only reads storage. It must not call the coordinator or transport.

- [ ] **Step 5: Run adapter and storage tests**

Run: `npm run test:unit -- tests/browser-adapter.test.ts tests/local-first-storage.test.ts`

Expected: PASS for Chromium-style and Safari adapter fixtures.

- [ ] **Step 6: Commit storage observation**

```bash
git add extension/browser/types.ts extension/browser/webextension.ts extension/local-first-storage.ts tests/browser-adapter.test.ts tests/local-first-storage.test.ts
git commit -m "feat: observe cross-tab workspace cache changes"
```

---

### Task 3: Implement User-Scoped Cross-Tab Exclusive Execution

**Files:**
- Create: `extension/workspace-sync-lock.ts`
- Create: `tests/workspace-sync-lock.test.ts`

- [ ] **Step 1: Write failing Web Locks mutual-exclusion tests**

Create two lock instances for one user and hold the first callback open. Assert the second callback does not begin until the first resolves, while a different user lock may proceed.

```ts
const first = lock.runExclusive(USER_ID, async () => {
  calls.push("first:start");
  await firstGate;
  calls.push("first:end");
});
const second = lock.runExclusive(USER_ID, async () => calls.push("second"));
await Promise.resolve();
expect(calls).toEqual(["first:start"]);
releaseFirst();
await Promise.all([first, second]);
expect(calls).toEqual(["first:start", "first:end", "second"]);
```

- [ ] **Step 2: Write failing lease fallback tests**

Use a shared in-memory storage area and deterministic clock. Test lease acquisition, owner-checked release, bounded waiting on a live lease, and recovery once `expiresAt <= now()`.

- [ ] **Step 3: Run the new tests and confirm the module is missing**

Run: `npm run test:unit -- tests/workspace-sync-lock.test.ts`

Expected: FAIL because `WorkspaceSyncLock` does not exist.

- [ ] **Step 4: Implement the lock adapter**

Expose:

```ts
export interface WorkspaceSyncExclusiveRunner {
  runExclusive<T>(userId: string, task: () => Promise<T>): Promise<T>;
}

export class WorkspaceSyncLock implements WorkspaceSyncExclusiveRunner {
  constructor(input: {
    area: StorageArea;
    locks?: LockManagerLike;
    ownerId?: string;
    now?: () => number;
    leaseMs?: number;
    waitForLeaseChange?: (key: string, expiresAt: number) => Promise<void>;
  });
}
```

Use lock name `tabloom-workspace-sync:<userId>`. Prefer `navigator.locks.request`. The fallback stores `{ ownerId, expiresAt }` at `tabloom-workspace-sync-lease-v1:<userId>`, verifies ownership after writing, renews before expiry only while the finite task is active, and removes only a lease still owned by the caller. Waiting is driven by storage-change notification or the current lease expiry; it must not start any sync work itself.

- [ ] **Step 5: Run lock tests**

Run: `npm run test:unit -- tests/workspace-sync-lock.test.ts`

Expected: PASS with no overlapping critical sections and successful expired-lease recovery.

- [ ] **Step 6: Commit the lock module**

```bash
git add extension/workspace-sync-lock.ts tests/workspace-sync-lock.test.ts
git commit -m "feat: serialize workspace sync across tabs"
```

---

### Task 4: Build the Finite Read-Only Coordinator Path

**Files:**
- Create: `extension/workspace-sync-errors.ts`
- Create: `extension/workspace-sync-coordinator.ts`
- Create: `tests/workspace-sync-coordinator.test.ts`

- [ ] **Step 1: Write failing initial-open and focus-read tests**

Cover: local status publishes immediately, one revision call, no canonical call when equal, one canonical call when different, queue replay over canonical, no `applyOperations`, overlapping reads are ignored, and storage notifications publish state without transport calls.

```ts
await coordinator.start();
expect(transport.getRevision).toHaveBeenCalledOnce();
expect(transport.applyOperations).not.toHaveBeenCalled();

const active = coordinator.refreshOnFocus();
const ignored = coordinator.refreshOnFocus();
await Promise.all([active, ignored]);
expect(transport.getRevision).toHaveBeenCalledTimes(2); // start + one focus read
```

- [ ] **Step 2: Run the coordinator tests and confirm the module is missing**

Run: `npm run test:unit -- tests/workspace-sync-coordinator.test.ts`

Expected: FAIL because the coordinator and typed errors do not exist.

- [ ] **Step 3: Add typed errors and public coordinator types**

```ts
export type WorkspaceSyncState =
  | { phase: "synced"; revision: number; failed: 0; waiting: 0; lastSyncedAt?: string }
  | { phase: "syncing"; activity: "read" | "write"; revision: number; failed: number; waiting: number }
  | { phase: "failed"; revision: number; failed: number; waiting: number; error: string }
  | { phase: "offline"; revision: number; failed: number; waiting: number; error: string };

export interface WorkspaceSyncCoordinatorContract {
  start(): Promise<void>;
  refreshOnFocus(): Promise<void>;
  submit(operation: WorkspaceOperation): Promise<void>;
  retryFailed(): Promise<void>;
  stop(): void;
}
```

Implement the five approved error classes with `operationId?: string` and display-safe `message` fields.

- [ ] **Step 4: Implement finite `start` and `refreshOnFocus`**

Inside `WorkspaceSyncCoordinator`, use one `activeRead` promise. If it exists, return without setting a follow-up flag. Capture the local `lastRevisionCheckAt` before waiting for the lock; after acquiring it, reload storage and skip the network call when another tab has already advanced that timestamp. Otherwise call `getRevision` once, load canonical only when revision differs, call `rebaseWorkspaceOperations` for queue entries in sequence order, persist the merged snapshot/queue/revision, and release the lock. Never call `applyOperations` from this path. Concurrent starts for one account must therefore produce one total revision request, not merely two serialized requests.

- [ ] **Step 5: Implement storage-only observation and stop**

Subscribe during `start`; publish snapshot/status changes through `onSnapshotCommitted` and state listeners. `stop()` unsubscribes, marks the instance stopped, and clears listeners. A storage event must execute zero transport calls.

- [ ] **Step 6: Run coordinator read tests**

Run: `npm run test:unit -- tests/workspace-sync-coordinator.test.ts`

Expected: PASS for initial/focus/coalescing/storage-observation tests.

- [ ] **Step 7: Commit the finite read path**

```bash
git add extension/workspace-sync-errors.ts extension/workspace-sync-coordinator.ts tests/workspace-sync-coordinator.test.ts
git commit -m "feat: add finite workspace sync coordinator reads"
```

---

### Task 5: Add Immediate Ordered Writes, Failure Blocking, and Explicit Retry

**Files:**
- Modify: `extension/workspace-sync-coordinator.ts`
- Modify: `extension/workspace-sync-errors.ts`
- Modify: `tests/workspace-sync-coordinator.test.ts`

- [ ] **Step 1: Write failing optimistic write and failure-ordering tests**

Test one immediate `applyOperations` call, durable `attemptedAt`, acknowledgement removal, failed first entry preservation, later waiting entries blocked, and no automatic retry after timers or focus reads.

```ts
await expect(coordinator.submit(operation)).rejects.toBeInstanceOf(WorkspaceWriteFailedError);
expect(read().snapshot.spaces).toContainEqual(expect.objectContaining({ id: SPACE_ID }));
expect(read().queue).toEqual([
  expect.objectContaining({ operation, state: "failed", error: "Network unavailable" }),
  expect.objectContaining({ operation: laterOperation, state: "waiting" }),
]);
expect(transport.applyOperations).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Write failing explicit-retry and bounded-conflict tests**

Assert Retry changes the first failed entry to waiting, flushes in strict sequence, stops at the next failure, handles `already_applied`, and performs at most one canonical rebase plus one retry after `WorkspaceRevisionConflictError`.

- [ ] **Step 3: Run coordinator tests and confirm write behavior is absent**

Run: `npm run test:unit -- tests/workspace-sync-coordinator.test.ts`

Expected: FAIL in submit/retry/conflict cases.

- [ ] **Step 4: Implement idempotent `submit`**

`submit(operation)` first uses `storage.update` to append/apply the operation only when its ID is not already queued. This supports the repository's atomic prequeue handoff without double application. If an earlier failed entry exists, reject with `WorkspaceWriteBlockedError`. Otherwise, under the exclusive runner, send only the ordered eligible prefix ending at the submitted operation's sequence. This boundary prevents the first callback in a multi-operation repository mutation from acknowledging later operations before their own `submit` calls. Mark attempted entries immediately before the request.

- [ ] **Step 5: Implement validated acknowledgement and failure persistence**

Accept only outcomes whose IDs were sent. Apply patches/tombstones, store the returned revision, remove applied/already-applied entries, and rebase remaining entries over the server result. Remove impossible operations rejected by tombstones from the retry queue, persist an action-required conflict record, and reject with `WorkspaceConflictActionRequiredError` rather than resurrecting deleted parents. On any other non-conflict error, atomically mark the first submitted entry failed and persist its error before rejecting with the matching typed error.

- [ ] **Step 6: Implement one bounded conflict reconciliation**

On the first revision conflict only: load canonical once, rebase queued entries, persist, and retry once. A second conflict or transport failure marks the first eligible entry failed. Delete the old recursive `rebaseAndRetry` pattern rather than calling the write method recursively.

- [ ] **Step 7: Implement explicit ordered `retryFailed`**

Change the first failed entry to waiting, then loop only over the finite queue snapshot that existed when Retry began. Await each ordered attempt; stop immediately on a failure. Operations appended during Retry remain waiting for their own mutation-triggered attempt and cannot extend the retry loop indefinitely.

- [ ] **Step 8: Run coordinator tests**

Run: `npm run test:unit -- tests/workspace-sync-coordinator.test.ts`

Expected: PASS, including lost-response idempotency, action-required tombstone, and no-auto-retry assertions.

- [ ] **Step 9: Commit coordinator writes**

```bash
git add extension/workspace-sync-coordinator.ts extension/workspace-sync-errors.ts tests/workspace-sync-coordinator.test.ts
git commit -m "feat: sync optimistic mutations with explicit retry"
```

---

### Task 6: Connect Repository Mutations Without Losing Atomicity

**Files:**
- Modify: `extension/local-first-repository.ts`
- Modify: `tests/local-first-repository.test.ts`

- [ ] **Step 1: Write failing submission handoff tests**

Assert the callback receives the exact generated operations after storage commit, multiple created links remain one atomic local change, the method waits for submission, and callback rejection leaves snapshot/queue intact while rejecting the repository method.

```ts
const submit = vi.fn(async (_operations: WorkspaceOperation[]) => {
  expect((await storage.loadOrThrow()).snapshot.spaces).toHaveLength(1);
  throw new WorkspaceWriteFailedError("Could not sync", OPERATION_ID);
});
const repository = await LocalFirstWorkspaceRepository.create({ userId: USER_ID, storage, onMutation: submit });

await expect(repository.createSpace({ name: "Research", color: "#7357e6" }))
  .rejects.toBeInstanceOf(WorkspaceWriteFailedError);
expect((await storage.loadOrThrow()).snapshot.spaces[0].name).toBe("Research");
expect((await storage.loadOrThrow()).queue).toHaveLength(1);
```

- [ ] **Step 2: Run repository tests and confirm the callback contract fails**

Run: `npm run test:unit -- tests/local-first-repository.test.ts`

Expected: FAIL because `LocalMutationListener` is synchronous and receives no operations.

- [ ] **Step 3: Change the callback and queue append contract**

```ts
export type LocalMutationListener = (operations: WorkspaceOperation[]) => Promise<void>;
```

Within `mutate`, return `{ value, operations }` from the single `storage.update`, store operations as `{ operation, state: "waiting" }`, then `await this.onMutation(operations)` after the transaction. For each operation, the application callback calls `await coordinator.submit(operation)` sequentially. Do not roll back storage if submission rejects.

- [ ] **Step 4: Preserve in-flight coalescing safety**

Replace `immutableOperationIds` coupling with queue entry IDs captured by each finite coordinator attempt. Keep `coalesceWorkspaceOperations` from altering entries already captured for a request, and never reorder across sequence numbers.

- [ ] **Step 5: Run repository and coordinator tests together**

Run: `npm run test:unit -- tests/local-first-repository.test.ts tests/workspace-sync-coordinator.test.ts`

Expected: PASS with optimistic state visible before transport settlement and rejection propagated to callers.

- [ ] **Step 6: Commit repository integration**

```bash
git add extension/local-first-repository.ts tests/local-first-repository.test.ts
git commit -m "refactor: hand optimistic mutations to sync coordinator"
```

---

### Task 7: Coalesce Genuine Focus Transitions and Wire the Extension

**Files:**
- Modify: `extension/workspace-sync-lifecycle.ts`
- Modify: `extension/src.tsx`
- Delete: `extension/workspace-sync-engine.ts`
- Modify: `tests/workspace-sync-lifecycle.test.ts`
- Delete: `tests/workspace-sync-engine.test.ts`

- [ ] **Step 1: Write failing lifecycle coalescing tests**

Cover hidden-to-visible plus window-focus as one transition, repeated focus while already focused as zero additional calls, blur/hidden then focus as one new call, and cleanup.

```ts
documentTarget.visibilityState = "visible";
documentTarget.dispatchEvent(new Event("visibilitychange"));
windowTarget.dispatchEvent(new Event("focus"));
expect(refreshOnFocus).toHaveBeenCalledTimes(1);

windowTarget.dispatchEvent(new Event("blur"));
windowTarget.dispatchEvent(new Event("focus"));
expect(refreshOnFocus).toHaveBeenCalledTimes(2);
```

- [ ] **Step 2: Run lifecycle tests and confirm duplicate focus behavior**

Run: `npm run test:unit -- tests/workspace-sync-lifecycle.test.ts`

Expected: FAIL because lifecycle calls `requestSync("focus")` for raw events.

- [ ] **Step 3: Implement focus-transition state**

Change the dependency to `Pick<WorkspaceSyncCoordinatorContract, "refreshOnFocus">`. Track whether the page is currently active from `document.visibilityState` and `document.hasFocus()`. Call once only on inactive-to-active transition. Ignore promise rejection here because the coordinator publishes Offline and the existing toast callback handles actionable errors.

- [ ] **Step 4: Replace engine construction in `ExtensionApp`**

Create `LocalFirstStorage` with `browserAdapter.storageChanges.subscribe`, create `WorkspaceSyncLock`, then create `WorkspaceSyncCoordinator`. Wire repository mutation submission as:

```ts
onMutation: async (operations) => {
  const coordinator = coordinatorRef.current;
  if (!coordinator) throw new WorkspaceOfflineError("Workspace sync is unavailable.");
  for (const operation of operations) await coordinator.submit(operation);
},
```

Subscribe to coordinator state and local snapshots, register lifecycle, call `start()`, and expose `retryFailed()` to the account menu. Remove `requestSync`, mutation debounce, online retry, `refresh`, `followUp`, and immutable-operation-set wiring.

- [ ] **Step 5: Ensure UI mutation handlers surface three-second errors**

Let rejected repository promises reach existing `onError`/`setError` paths and `ToastRegion`. Do not replace optimistic snapshot state with an older repository reload after a typed sync rejection; load from `LocalFirstStorage` so the failed local mutation remains visible.

- [ ] **Step 6: Run lifecycle and extension component tests**

Run: `npm run test:unit -- tests/workspace-sync-lifecycle.test.ts tests/local-first-repository.test.ts tests/extension-collection-rows.test.tsx tests/current-tabs-sheet.test.tsx`

Expected: PASS with one focus refresh and preserved optimistic errors.

- [ ] **Step 7: Remove the old engine and commit application wiring**

```bash
git add extension/src.tsx extension/workspace-sync-lifecycle.ts tests/workspace-sync-lifecycle.test.ts
git rm extension/workspace-sync-engine.ts tests/workspace-sync-engine.test.ts
git commit -m "refactor: wire event-driven workspace synchronization"
```

---

### Task 8: Present Synced, Syncing, Failed, and Offline States

**Files:**
- Modify: `extension/SyncLoginPrompt.tsx`
- Modify: `extension/style.css`
- Modify: `tests/sync-login-prompt.test.tsx`
- Modify: `tests/e2e/visual-consistency.spec.ts`

- [ ] **Step 1: Write failing status and Retry component tests**

Test exact labels, counts, color classes, stored failure message, Retry visibility only for failed state, one callback invocation, and yellow subtitle during a finite request.

```tsx
render(<SyncLoginPrompt
  {...signedInProps}
  syncState={{ phase: "failed", revision: 8, failed: 1, waiting: 3, error: "Request timed out" }}
  onRetrySync={onRetrySync}
/>);
await userEvent.click(screen.getByRole("button", { name: "Open account menu" }));
expect(screen.getByText("Failed to sync").closest(".account-sync-status")).toHaveClass("sync-state-failed");
expect(screen.getByText("1 failed · 3 waiting")).toBeInTheDocument();
expect(screen.getByText("Request timed out")).toBeInTheDocument();
await userEvent.click(screen.getByRole("button", { name: "Retry sync" }));
expect(onRetrySync).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Run component tests and confirm the old offline-only UI fails**

Run: `npm run test:unit -- tests/sync-login-prompt.test.tsx`

Expected: FAIL because failed status/counts and `onRetrySync` are absent.

- [ ] **Step 3: Update account-menu rendering**

Replace `SyncEngineState` with `WorkspaceSyncState`. Use `CheckCircle2` for Synced, `LoaderCircle` for Syncing, an error icon for Failed, and `WifiOff` for Offline. Rename `onSyncNow` to `onRetrySync`; do not provide a manual refresh action in Synced or Syncing states.

- [ ] **Step 4: Apply exact status colors**

Set both title and subtitle/message colors from the state container:

```css
.sync-state-synced { color: #26c281; }
.sync-state-syncing { color: #e5ad35; }
.sync-state-failed,
.sync-state-offline { color: #f06b6b; }
.account-sync-status small { color: inherit; }
```

Retain opaque dropdown background, focus visibility, and reduced-motion handling.

- [ ] **Step 5: Add a cross-browser visual assertion**

Update the existing visual-consistency fixture so Chromium, Firefox, and WebKit render the same failed state menu and Retry control; do not introduce browser-specific CSS.

- [ ] **Step 6: Run UI tests**

Run: `npm run test:unit -- tests/sync-login-prompt.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit status UI**

```bash
git add extension/SyncLoginPrompt.tsx extension/style.css tests/sync-login-prompt.test.tsx tests/e2e/visual-consistency.spec.ts
git commit -m "feat: show retryable workspace sync failures"
```

---

### Task 9: Prove Cross-Tab Behavior and Complete Regression Verification

**Files:**
- Modify: `tests/workspace-sync-coordinator.test.ts`
- Modify: `tests/browser-adapter.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add the two-coordinator acceptance test**

Create two coordinators sharing one storage area and lock adapter. Start both concurrently and assert exactly one total revision request and one active transport request at a time. Mutate through one coordinator and assert the other receives the updated snapshot from storage without making a transport call.

```ts
expect(maxConcurrentRequests).toBe(1);
expect(totalRevisionRequests).toBe(1);
expect(transportB.applyOperations).not.toHaveBeenCalled();
expect(snapshotB.spaces).toContainEqual(expect.objectContaining({ id: SPACE_ID }));
```

- [ ] **Step 2: Add request-trigger boundary assertions**

With fake timers, advance one hour after start and assert request counts do not change. Emit storage notifications and online events and assert no request. Then perform exactly one focus transition, one mutation, and one Retry, asserting only those actions change counts.

- [ ] **Step 3: Run the complete sync unit suite**

Run: `npm run test:unit -- tests/local-first-storage.test.ts tests/local-first-repository.test.ts tests/workspace-sync-lock.test.ts tests/workspace-sync-coordinator.test.ts tests/workspace-sync-lifecycle.test.ts tests/browser-adapter.test.ts tests/sync-login-prompt.test.tsx`

Expected: PASS with no unhandled rejections or pending timers.

- [ ] **Step 4: Document the event-driven behavior**

Update README extension sync documentation to state: local-first optimistic storage, initial/focus remote reads, immediate mutation writes, explicit Retry after failure, no polling, and cross-tab serialization.

- [ ] **Step 5: Run static and production verification**

Run:

```bash
npm run lint
npm run test:unit
npm run build
npm run build:extension
```

Expected: all commands exit 0; Chromium, Firefox, and Safari distributions build without console/type errors.

- [ ] **Step 6: Run Supabase regression tests when local Supabase is available**

Run: `npm run test:supabase`

Expected: PASS for operation idempotency, tombstones, ownership isolation, and idempotent deletions. If local Docker/Supabase is unavailable, record the environmental reason and run the existing remote RPC smoke check without exposing session tokens.

- [ ] **Step 7: Run cross-browser visual verification**

Run: `npm run test:e2e:visual`

Expected: PASS for Chromium, Firefox, and WebKit visual projects.

- [ ] **Step 8: Commit verification coverage and documentation**

```bash
git add tests/workspace-sync-coordinator.test.ts tests/browser-adapter.test.ts README.md
git commit -m "test: verify event-driven cross-tab workspace sync"
```

## Final Self-Review Gates

- [ ] **Spec coverage:** Check every acceptance criterion in `docs/superpowers/specs/2026-08-31-event-driven-workspace-sync-design.md` against at least one named automated test.
- [ ] **Placeholder scan:** Run `rg -n "TO[D]O|TB[D]|FIXM[E]|placeholde[r]" extension/workspace-sync-*.ts tests/workspace-sync-*.test.ts docs/superpowers/plans/2026-08-31-event-driven-workspace-sync.md` and resolve every newly introduced marker.
- [ ] **Type consistency:** Run `npx tsc --noEmit` if the repository TypeScript configuration supports it; otherwise rely on the production web and all extension target builds and record that result.
- [ ] **Old behavior removal:** Run `rg -n "requestSync|mutationDebounceMs|focusFreshnessMs|followUp|setInterval|onOnline|Sync now" extension tests` and verify no continuous workspace-sync path remains.
- [ ] **Dirty-worktree safety:** Review `git status --short` and `git diff --stat`; ensure commits include only files listed by their task and do not overwrite unrelated user changes.
