# Event-Driven Local-First Workspace Sync

**Status:** Approved design

## Objective

Replace Tabloom's continuously retriggered workspace synchronization with an event-driven local-first model:

- Read remote state once when Tabloom first opens and once whenever a Tabloom tab becomes focused again.
- Apply every user mutation to the local cache immediately.
- Attempt the corresponding remote write immediately when no earlier failed operation blocks it.
- Keep failed optimistic changes visible locally, show their failure, and retry only after explicit user action.
- Coordinate every Tabloom tab so only one browser context accesses the workspace synchronization endpoints at a time.

There are no intervals, background polling loops, or automatic retry loops.

## Scope

This design covers spaces, collections, saved links, ordering, cross-collection movement, imports, and any other workspace mutation represented by a `WorkspaceOperation`.

It preserves:

- Supabase as the canonical synchronized store.
- Browser storage as the immediate local source of truth.
- Stable operation IDs and server-side idempotency.
- Offline use and optimistic interaction.
- Shared behavior across Chromium, Firefox, and Safari.

Bookmark refresh behavior and live collaboration remain separate from workspace synchronization.

## Architecture

### WorkspaceSyncCoordinator

`WorkspaceSyncCoordinator` becomes the single deep module that owns synchronization policy. Its external interface is intentionally small:

```ts
interface WorkspaceSyncCoordinator {
  start(): Promise<void>;
  refreshOnFocus(): Promise<void>;
  submit(operation: WorkspaceOperation): Promise<void>;
  retryFailed(): Promise<void>;
  stop(): void;
}
```

Callers do not manage revisions, queue ordering, retries, cross-tab locks, canonical rebases, or status transitions. Those concerns remain inside the module.

The coordinator depends on internal adapters for:

- Local workspace and queue persistence.
- Supabase workspace synchronization transport.
- Cross-tab exclusive execution.
- Cross-tab storage-change observation.
- Time and generated instance identity for deterministic tests.

### Cross-tab exclusive execution

Every remote synchronization action runs through a user-scoped lock named for the synchronized account. The preferred adapter uses the Web Locks API. A browser-storage lease with an owner ID and expiry provides the fallback for targets without Web Locks.

The lock covers the complete read or write transaction, including canonical rebase and local persistence. It prevents separate new-tab pages from issuing competing requests against the same Supabase revision row.

Tabs that do not own the lock do not make remote requests. They observe browser-storage changes and render the updated snapshot, queue, and status. A tab with a new user mutation waits for the current finite lock holder, then makes its one eligible write attempt. Lock acquisition itself never creates a polling loop.

### Cross-tab cache observation

The typed browser storage adapter gains a subscription interface backed by the WebExtension storage change event. Each active Tabloom page subscribes to the account's workspace, outbox, and sync-state keys.

Storage notifications update visible state only. They do not trigger remote reads or writes. This distinction prevents synchronization writes from recursively scheduling more synchronization.

## Persistent operation queue

The current outbox evolves from an array of operations into ordered entries:

```ts
type QueuedWorkspaceOperation = {
  operation: WorkspaceOperation;
  state: "waiting" | "failed";
  attemptedAt?: string;
  error?: string;
};
```

`inflight` is deliberately not persisted. Before a write, an entry remains durable as `waiting` and receives `attemptedAt`. If the page closes during the request, startup recognizes an interrupted attempt and converts it to `failed` with a retryable interruption message.

Queue ordering follows `WorkspaceOperation.sequence`. A failed entry blocks every later entry. Later operations remain `waiting` and are not transmitted out of order.

The queue persistence format receives a new version. Migration rules are:

- Existing operations from the old outbox remain locally applied.
- Existing operations become a failed first entry followed by waiting entries so they require one explicit Retry after upgrade.
- A persisted `syncing` status never resumes as active. It becomes a retryable failed or offline state according to the queue and stored error.
- No queued operation or optimistic local data is discarded during migration.

## Read synchronization

### Initial open

`start()` performs these steps:

1. Load and render local workspace state immediately.
2. Normalize any interrupted or legacy queue state.
3. Acquire the cross-tab synchronization lock.
4. Request the remote revision once.
5. If the revision differs, load the canonical snapshot and tombstones once.
6. Rebase failed and waiting local operations over the canonical snapshot.
7. Persist the merged local snapshot and release the lock.

Initial open never flushes failed or waiting writes.

### Focus refresh

`refreshOnFocus()` runs once for each genuine transition back to a focused Tabloom page. Visibility and focus events for the same transition are coalesced into one call. If a read is already active, additional focus events are ignored rather than scheduled as follow-up work.

The refresh performs the same revision-check and conditional canonical merge as initial open. It never submits queued writes and never retries a failure.

If the read fails, Tabloom keeps the local snapshot and reports Offline. The next focus transition may make one new read attempt, or the user may use Retry.

### Canonical merge

Remote state is applied before local queued operations are replayed. Failed and waiting local operations therefore remain visible without silently overwriting changes synchronized by another device.

If a tombstone or missing parent makes a local operation impossible, the coordinator removes it from the retryable sequence and records an action-required conflict. The user may dismiss the local change or restore it as a new valid operation. The coordinator never retries an impossible operation forever and never resurrects a remote deletion implicitly.

## Write synchronization

### Optimistic mutation

`submit(operation)` performs these steps:

1. Apply the operation to the local snapshot.
2. Append a durable waiting queue entry in the same local storage transaction.
3. Notify all open Tabloom tabs through the storage change event.
4. If an earlier failed entry exists, keep the new entry waiting and return a blocked-sync error to the caller.
5. Otherwise acquire the cross-tab synchronization lock and make one immediate write attempt for the eligible ordered queue prefix.

The interface resolves only after the immediate attempt succeeds. It rejects on failure so the initiating UI can show an error toast, while the optimistic local result remains visible.

### Successful write

The coordinator validates server outcomes against the submitted operation IDs, applies returned patches and tombstones, stores the returned revision, removes acknowledged entries, and reports Synced when the queue is empty.

Stable operation IDs make a lost response safe. A later explicit retry receives an `already_applied` outcome and clears the corresponding local entry.

### Failed write

Network, timeout, authentication, permission, validation, and unexpected server failures all stop the finite write attempt. The first affected entry becomes `failed`, retains the human-readable error, and blocks later entries.

No timer or status update automatically retries it. The optimistic local snapshot remains intact.

### Revision conflict

A revision conflict receives one bounded reconciliation within the same user-initiated attempt:

1. Load canonical state and tombstones once.
2. Rebase the eligible local operations.
3. Retry the rebased write once.

If reconciliation or the second write fails, the first affected entry becomes failed. There is no recursive or unbounded conflict retry.

### Explicit retry

`retryFailed()` is the only general write-retry entry point. It changes the first failed entry to waiting and makes one ordered flush attempt. After that operation succeeds, the coordinator continues through operations that were waiting behind it in the same finite flush.

If any operation fails, flushing stops immediately and the queue returns to failed/waiting state.

## Status and user feedback

The account dropdown shows the authoritative synchronization state:

- **Synced** in green when no operation is queued and no request is active.
- **Syncing** in yellow only while one finite read or write is active.
- **Failed to sync** in red with failed and waiting counts plus Retry.
- **Offline** in red when the last remote read failed and local data remains available.

Examples include `1 failed · 3 waiting` and the stored failure message. Mutation failures also produce a three-second error toast. Successful operations do not produce banners or success toasts.

Status changes are persisted only when meaningful. An application restart cannot remain permanently in Syncing because active request state is not durable.

## Error interface

The coordinator returns typed errors so the UI can distinguish:

- `WorkspaceWriteFailedError`
- `WorkspaceWriteBlockedError`
- `WorkspaceAuthenticationError`
- `WorkspaceConflictActionRequiredError`
- `WorkspaceOfflineError`

Typed errors carry a display message and operation ID when applicable. Raw Supabase errors remain internal to the transport adapter.

## Server behavior

The existing operation RPC and idempotent-deletion migration remain authoritative. The client continues to send expected revisions and stable operation IDs.

This redesign does not require continuous server subscriptions or realtime channels. Server calls remain atomic, owner-scoped, and protected by existing row-level security.

## Testing

### Coordinator unit tests

- Initial open reads once and never flushes the queue.
- Refocus reads at most once per focus transition.
- Duplicate visibility and focus events are coalesced.
- No interval, follow-up loop, or automatic retry is scheduled.
- A mutation updates local state before transport settlement.
- A mutation makes one immediate write attempt.
- Failure preserves the optimistic snapshot and marks the first operation failed.
- Later operations wait behind a failed operation.
- Explicit Retry preserves order and performs one finite flush.
- One bounded conflict reconciliation is allowed; a second failure stops.
- Lost-response retries clear through operation ID idempotency.
- Tombstones convert impossible operations into action-required conflicts.
- Legacy outbox and persisted Syncing state migrate without data loss.

### Cross-tab tests

- Multiple coordinators for one account produce one remote request.
- Non-owner tabs update from storage events without calling transport.
- A mutation waits for a finite active read, then writes once.
- Lease expiry allows recovery after an owning tab disappears.
- Storage notifications never trigger remote synchronization.

### Integration and browser tests

- Chromium, Firefox, and Safari use the same coordinator behavior.
- Opening multiple Tabloom new tabs does not create Supabase lock contention.
- A mutation appears immediately, fails visibly, and succeeds after Retry.
- Refocusing after another device changes data merges remote and local state.
- Restarting during a write produces a retryable failed entry rather than permanent Syncing.
- Supabase operation and tombstone isolation tests continue to pass.

## Acceptance criteria

- With several Tabloom tabs open, the database observes at most one workspace synchronization request at a time for the account.
- Tabloom makes no synchronization request without initial open, a genuine focus transition, a user mutation, or explicit Retry.
- Every eligible user mutation receives an immediate single write attempt.
- Failed optimistic changes remain visible and retryable.
- Newer changes never bypass an earlier failed operation.
- Remote changes merge on initial open and focus without discarding queued local work.
- Syncing cannot persist after a request settles, fails, or is interrupted by restart.
