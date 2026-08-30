# Tabloom Local-First Continuous Workspace Sync Design

**Status:** Awaiting written-spec review  
**Date:** 2026-08-31  
**Product:** Tabloom cross-browser extension  
**Supabase project:** `tctjlsvfufzxhauhywsm`

## Summary

Tabloom will make the signed-in extension local-first after the existing first-account merge. The organizer will render and mutate an account-scoped browser cache without waiting for Supabase. A background sync engine will batch persistent local operations, upload them transactionally, and check for newer workspace revisions created by other devices.

Supabase remains the cross-device authority, but it is no longer the extension's normal read path. Startup, search, navigation, and organizer mutations use the local snapshot. Network reads occur only for first synchronization, lightweight revision checks, conflict recovery, explicit refresh, or downloading a revision newer than the local cache.

This design also suppresses browser address autofill in global search and moves routine synchronization status into the account dropdown.

## Relationship to the First-Sync Design

This specification extends and partially supersedes [Supabase Local-to-Cloud Merge Design](./2026-08-29-supabase-local-cloud-merge-design.md).

The existing first-sync confirmation, UUID-first identity, scoped URL deduplication, account isolation, and transactional merge remain unchanged. After first sync succeeds, this specification replaces the earlier decision that the UI should directly use `SupabaseWorkspaceRepository`. The active signed-in extension repository becomes an account-scoped local-first repository backed by a continuous sync engine.

The web application may continue using its cloud repository in this version. The outbox and browser cache are extension-specific, while the server synchronization protocol remains reusable by future web-local clients.

## Goals

- Render the latest cached signed-in workspace immediately without a blocking API load.
- Apply creates, edits, deletes, moves, captures, copies, and reorders locally before network work.
- Persist pending operations so closing the new-tab page or browser cannot lose them.
- Synchronize automatically after mutations, startup, focus recovery, reconnection, and manual refresh.
- Avoid full workspace downloads when the server revision has not changed.
- Merge changes from multiple devices by stable record IDs.
- Prevent stale offline devices from resurrecting deleted records.
- Keep retries idempotent and preserve operation order where order matters.
- Keep routine synchronization silent while exposing useful account-level status.
- Preserve local-only operation when Supabase is absent, signed out, or temporarily unavailable.

## Non-goals

- Real-time collaborative editing or persistent Supabase Realtime subscriptions.
- Continuous polling while the extension is idle.
- Team workspaces, invitations, comments, or user-facing conflict editors.
- Changing manual browser-bookmark import into automatic browser-bookmark synchronization.
- Making the browser cache a second independent cloud authority.
- Replacing the existing first-sign-in merge confirmation.
- Implementing local-first persistence for the hosted web application in this version.

## Product Decisions

- Signed-out use continues to use the existing local workspace key and local user identity.
- Signed-in use has a separate cache, outbox, tombstone view, and sync state for each Supabase user ID.
- The UI reads only the active local repository, whether signed in or signed out.
- A successful local mutation means **saved locally**, not necessarily synchronized.
- Routine sync success produces no toast or banner.
- Sync status appears inside the account dropdown below user information and above **Switch account**.
- Status uses text and icons in addition to color:
  - green: **Synced**;
  - yellow: **Syncing**;
  - red: **Offline**.
- When operations are pending, the offline row includes secondary text such as **3 changes waiting to sync**.
- The synchronization row includes an icon-only **Sync now** button with an accessible label and tooltip.
- The workspace heading does not display routine `Syncing`, `Synced`, or `Offline` messages.
- Retryable sync failures use one compact three-second error toast and keep the outbox intact.

## High-Level Architecture

### `LocalFirstWorkspaceRepository`

The organizer receives one repository implementing the existing `WorkspaceRepository` contract. It owns only local reads and local atomic mutations.

Each mutation:

1. acquires the existing browser-storage workspace lock;
2. reloads the latest account-scoped snapshot and outbox;
3. validates and applies the mutation to a fresh in-memory repository;
4. appends or coalesces a typed sync operation;
5. persists snapshot and outbox atomically;
6. releases the lock and returns the local result; and
7. signals the sync engine without awaiting network completion.

The repository never calls Supabase from `load()`.

### `WorkspaceSyncEngine`

The engine owns network synchronization and has no rendering responsibilities. It exposes an observable state and these commands:

```ts
type WorkspaceSyncEngine = {
  start(): Promise<void>;
  requestSync(reason: SyncReason): void;
  refresh(): Promise<void>;
  stop(): void;
  subscribe(listener: (state: SyncEngineState) => void): () => void;
};

type SyncReason =
  | "mutation"
  | "startup"
  | "focus"
  | "online"
  | "manual";
```

Only one push/pull cycle may run for an account at a time. Additional requests set a follow-up flag rather than starting overlapping calls.

### `WorkspaceSyncTransport`

The transport is the typed boundary to Supabase RPCs. It supports:

- a lightweight revision check;
- an incremental batch push with an expected revision;
- canonical patches and tombstones for records affected by a successful push;
- a canonical snapshot pull when the remote revision is newer; and
- existing first-sync versioned load and merge operations.

Browser targets share this transport. Browser-specific code remains limited to storage, focus/online events, authentication, bookmarks, and tabs.

## Local Storage Model

Use account-scoped keys:

```text
tabloom-cloud-workspace-v2:<user-id>
tabloom-sync-outbox-v1:<user-id>
tabloom-sync-state-v2:<user-id>
tabloom-device-id-v1
```

### Cached workspace

```ts
type CachedWorkspace = {
  snapshot: WorkspaceSnapshot;
  revision: number;
  cachedAt: string;
};
```

### Persistent operation

```ts
type WorkspaceOperation = {
  operationId: string;
  deviceId: string;
  sequence: number;
  entity: "space" | "collection" | "link";
  entityId: string;
  action: "create" | "update" | "delete" | "reorder";
  payload: unknown;
  createdAt: string;
  baseRevision: number;
};
```

Operation IDs are UUIDs and never change during retry. `sequence` is monotonically increasing per device and preserves local intent. Payloads contain only validated domain fields; they never accept a caller-supplied user ID.

### Cached sync state

```ts
type SyncEngineState =
  | { phase: "synced"; revision: number; lastSyncedAt: string }
  | { phase: "syncing"; revision: number; pending: number }
  | { phase: "offline"; revision: number; pending: number; error?: string };
```

The Supabase user ID is part of every key. Switching accounts stops the old engine before loading or starting another account. Signing out returns to the independent signed-out local workspace.

## Mutation and Coalescing Rules

- Create, update, delete, move, tab capture, and bookmark copy append operations immediately.
- Ordinary mutations request a sync cycle after a 500 ms debounce.
- Reorder operations are created only after drag completion or accessible move completion.
- A newer unsent update for the same entity may replace an older unsent update.
- A create followed by unsent updates is coalesced into one create with final fields.
- A create followed by delete before either is uploaded removes both operations and the local record.
- Multiple unsent reorders for the same parent collapse into the latest complete ordered-ID list.
- Operations already included in an in-flight batch are immutable; later edits create subsequent operations.

The local snapshot and outbox are persisted in one storage call while holding the account-scoped lock. A failed storage write changes neither one.

## Synchronization Triggers

### Mutation

Any persisted local operation schedules a debounced push. Rapid edits and drag changes become one batch where coalescing rules allow it.

### Startup

The extension renders cached data first, then starts the engine. The engine pushes pending operations before checking for remote changes.

### Focus recovery

When the document becomes visible after being hidden, Tabloom requests synchronization if the last revision check is older than 30 seconds. Repeated focus events within the interval cause no API request.

### Connectivity recovery

The browser `online` event requests synchronization. The engine treats this as a hint; network failure remains authoritative.

### Manual synchronization

The icon-only **Sync now** button in the account dropdown bypasses debounce and freshness intervals. It pushes pending operations, checks the server revision, and pulls a canonical snapshot only when remote changes require one. If synchronization is already running, the button schedules one follow-up cycle instead of starting a concurrent request.

### No polling

Tabloom does not run periodic background polling or maintain a Realtime connection in v1.

## Server Data Model

Retain the existing `workspace_sync_state` revision row and add:

### Applied operations

```text
workspace_operations(
  user_id uuid,
  operation_id uuid,
  device_id uuid,
  sequence bigint,
  applied_revision bigint,
  applied_at timestamptz,
  primary key(user_id, operation_id)
)
```

This table makes retries idempotent. Rows are protected by `auth.uid() = user_id`. Operation payloads do not need to be retained after application.

### Tombstones

```text
workspace_tombstones(
  user_id uuid,
  entity_type text,
  entity_id uuid,
  deleted_revision bigint,
  deleted_at timestamptz,
  primary key(user_id, entity_type, entity_id)
)
```

Tombstones are retained until explicit account deletion. They are small, contain no link metadata, and prevent an old offline operation from restoring a deleted ID.

### Revision discipline

Each accepted batch is one transaction and increments the workspace revision exactly once. Ordinary legacy CRUD triggers and first-sync merge operations continue incrementing revisions. The incremental RPC suppresses intermediate trigger bumps and writes one final revision.

## Sync Protocol

### Lightweight revision check

`get_workspace_revision()` returns only the authenticated user's current revision and server timestamp. A missing state row is revision `0`.

If the returned revision equals the cached revision and the outbox is empty, synchronization ends without downloading workspace records.

### Incremental push

`apply_workspace_operations(operations jsonb, expected_revision bigint)`:

1. requires `auth.uid()` and locks the user's revision row;
2. validates batch size, operation shape, UUIDs, device sequence, supported URLs, ownership, and parent references;
3. recognizes already-applied operation IDs as successful retries;
4. resolves the batch against the current canonical records and tombstones;
5. applies valid operations transactionally;
6. normalizes affected ordering;
7. records operation IDs;
8. increments the revision once when the batch changes data; and
9. returns the resulting revision, per-operation outcomes, canonical patches for affected records, relevant tombstones, and any conflicts.

The expected revision guards normal operation. If it is stale, the server returns a typed revision conflict without partially applying new operations.

### Conflict recovery

After a revision conflict:

1. pull the canonical versioned snapshot and tombstones relevant to pending IDs;
2. replay pending local operations in device sequence over that snapshot using the same pure conflict rules;
3. persist the rebased snapshot and unchanged operation IDs locally; and
4. retry once against the new revision.

Further conflicts wait for the next trigger with bounded exponential backoff. The engine never loops indefinitely in one new-tab page.

### Pull without pending operations

When revision check reports newer remote data and the outbox is empty, load the canonical snapshot, validate it, and atomically replace the account cache.

### Push response

A successful incremental push does not download the full workspace. The client applies returned canonical record patches and tombstones to its cached snapshot, writes the resulting snapshot and outbox atomically, and removes only acknowledged operations. If the local write fails, acknowledged operations remain for an idempotent retry.

A full canonical snapshot is downloaded only for first synchronization, a missing or invalid account cache, a newer remote revision that cannot be represented by the current response, or conflict recovery and rebase.

## Conflict Rules

- Stable UUID is the identity for all normal synchronization.
- URL deduplication is limited to first-sync/import behavior and explicit duplicate UX; background sync does not collapse unrelated IDs.
- Changes to different IDs merge independently.
- For the same record, the newest server-accepted update becomes canonical and receives server `updated_at`.
- A stale update against an existing tombstone is rejected as deleted.
- A record can be restored only through a future explicit restore feature, not an ordinary update.
- The latest accepted complete reorder operation for a parent wins.
- Deleting a space or collection produces tombstones for cascade-deleted descendants in the same transaction.
- A pending operation whose parent was remotely deleted is rejected with a typed deleted-parent outcome and removed only after the rebased cache reflects that deletion.

Routine conflicts resolve silently. A compact error toast appears only when user action is required or retries cannot progress.

## Browser Bookmarks

Manual browser-bookmark synchronization remains unchanged. The resulting bookmark workspace is included in the combined account cache after manual sync.

- Browser bookmark reads occur only during the existing explicit bookmark sync action.
- Copying a bookmark into a saved collection is a normal local link-create operation and enters the outbox.
- Safari keeps previously synchronized bookmark collections in its cache without attempting unsupported local bookmark access.

## Account Dropdown Status

The account dropdown owns routine sync visibility.

Order inside the menu:

1. user name and email;
2. synchronization status row with an icon-only **Sync now** button;
3. **Switch account**.

Status presentation:

- **Synced:** green icon and text; optional secondary `Synced just now` timestamp.
- **Syncing:** yellow animated icon and text; secondary pending count when non-zero.
- **Offline:** red offline icon and text; secondary `N changes waiting to sync` when non-zero.

Color is never the only indicator. The status text is a readout, while the adjacent **Sync now** button is interactive and carries an accessible label and tooltip. Routine status does not produce banners.

## Global Search Autofill Suppression

The global search input is not an address, authentication, or personal-data field. It will use:

```tsx
<input
  type="search"
  autoComplete="off"
  autoCorrect="off"
  autoCapitalize="none"
  spellCheck={false}
/>
```

The field keeps its existing accessible label, focus management, full-screen portal, and keyboard navigation. Tests verify the DOM attributes so browser address suggestions do not cover Tabloom results.

## Startup and Authority Transition

### Signed out

Load the signed-out local repository exactly as today. No Supabase workspace call occurs.

### Existing signed-in session

1. load the account-scoped cached snapshot;
2. render it and activate `LocalFirstWorkspaceRepository`;
3. start the account sync engine;
4. push any outbox operations; and
5. revision-check and pull only if remote data is newer.

If no account cache exists, perform one versioned cloud load, cache it, and activate the local-first repository. This is the only normal signed-in startup that requires a full workspace download.

### First sign-in

Run the existing first-sync coordinator and confirmation rules. After the canonical first-sync result is cached, activate the local-first repository instead of the direct cloud repository.

## Error Handling and Recovery

- **Offline at startup with cache:** render cache, mark **Offline**, and retain pending operations.
- **Offline at startup without account cache:** keep the signed-out local workspace active and expose retry; never display an empty account workspace as canonical.
- **Mutation storage failure:** reject the mutation and show a compact error toast; do not claim it was saved.
- **Upload failure:** keep local result and outbox, mark **Offline**, and retry on the next trigger.
- **Authentication expired:** stop network retries, preserve cache/outbox, mark **Offline**, and request sign-in when the user attempts retry or account action.
- **Revision conflict:** rebase and retry once; never discard pending operations silently.
- **Validation rejection:** keep the original operation, show an actionable error, and do not retry continuously.
- **Uncertain response:** retain operations and retry their immutable IDs.
- **Corrupt cache:** quarantine the invalid value, attempt canonical reload when online, and preserve the outbox separately.
- **Account switch:** stop and dispose the previous engine before rendering the new account cache.

## Security and Privacy

- Only the public Supabase URL and anonymous key remain in browser builds.
- All sync RPCs require an authenticated user and derive ownership from `auth.uid()`.
- RLS covers revision, applied-operation, and tombstone tables.
- Security-definer helpers set a restricted search path and reject caller-supplied ownership.
- Batch size and JSON payload depth are bounded.
- Cache and outbox keys include user IDs and are removed only by explicit account-data cleanup, not ordinary sign-out.
- Outbox payloads contain only workspace mutation data; provider tokens and OAuth metadata never enter workspace cache.

## Migration and Compatibility

- Migrate `tabloom-cloud-workspace-v1:<user-id>` into v2 on first load, preserving its revision.
- Existing signed-out `tabloom-local-workspace-v2` remains independent.
- Existing first-sync state remains readable and upgrades to the v2 status shape.
- If migration cannot validate the old snapshot, retain the old key for recovery and perform a canonical online load.
- The same local-first modules and storage contracts are used by Chromium, Firefox, and Safari builds.

## Testing

### Domain and repository tests

- operation creation, sequence, and immutable IDs;
- create/update/delete/reorder coalescing;
- atomic snapshot-plus-outbox persistence;
- stable UUID merge and no background URL deduplication;
- same-record update resolution;
- tombstone rejection and cascade tombstones;
- reorder conflict behavior;
- account-scoped cache isolation;
- v1-to-v2 cache migration;
- global search autofill attributes.

### Sync-engine tests

- cached startup performs no full workspace API read when revisions match;
- startup pushes outbox before revision check;
- mutation debounce and batch consolidation;
- single-flight behavior and follow-up scheduling;
- focus freshness interval;
- online and manual synchronization triggers;
- no polling timer;
- idempotent uncertain-response retry;
- revision conflict rebase and one bounded retry;
- failed push retains outbox;
- successful canonical patch application and cache write precede acknowledgement removal;
- stop prevents account-switch leakage.

### Supabase integration tests

- two-user RLS isolation;
- transactional batch application and single revision bump;
- duplicate operation ID idempotency;
- stale expected revision rejection;
- malformed/cross-owner operation rollback;
- tombstone creation and stale update rejection;
- parent-delete descendant tombstones;
- canonical ordering after reorders;
- revision-only check contract.

### Component tests

- account dropdown green **Synced** row;
- yellow animated **Syncing** row;
- red **Offline** row and pending count;
- **Sync now** button label, tooltip, and single-flight follow-up behavior;
- routine sync success creates no toast/banner;
- cached workspace renders before background synchronization;
- manual synchronization triggers sync;
- autofill, autocorrect, capitalization, and spellcheck suppression.

### Browser end-to-end tests

- cached new-tab startup while offline;
- local mutation remains after closing and reopening the page;
- queued mutation uploads after reconnection;
- second browser/device change appears after focus recovery;
- unchanged remote revision avoids full workspace download;
- concurrent update, delete, and reorder scenarios;
- account switching isolates cache, status, and outbox;
- Chromium, Firefox, and Safari package behavior.

## Delivery Sequence

1. Add global-search autofill suppression and regression tests.
2. Add shared operation, outbox, sync-state, and conflict domain types.
3. Add account-scoped atomic cache/outbox storage and migration.
4. Add operation-producing local-first repository.
5. Add Supabase applied-operation/tombstone schema and incremental RPCs.
6. Add transport adapter and sync engine.
7. Change first-sync activation and signed-in startup to local-first authority.
8. Add focus, online, mutation, and manual triggers.
9. Move sync status into the account dropdown with approved colors and labels.
10. Run unit, database, component, extension E2E, visual, and all-browser build verification.

## Acceptance Criteria

- Opening a signed-in new tab renders a valid account cache without a full workspace API request.
- An unchanged server revision results in only a lightweight revision call.
- Every organizer mutation is visible and durable locally before synchronization completes.
- Pending operations survive page/browser restart and synchronize idempotently later.
- A change from another device appears after startup, eligible focus recovery, online recovery, or manual refresh.
- Conflicting updates, reorders, and deletes follow the documented rules without silent local data loss.
- Deleted records cannot be resurrected by stale offline operations.
- The account dropdown displays accessible green **Synced**, yellow **Syncing**, and red **Offline** states.
- Routine synchronization produces no success toast or long banner.
- Global search does not invite address autofill suggestions.
- Chromium, Firefox, and Safari builds pass with no secrets or elevated permissions.
