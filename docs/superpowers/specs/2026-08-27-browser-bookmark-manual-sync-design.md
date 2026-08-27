# Manual Browser Bookmark Sync Design

**Status:** Awaiting written-spec review  
**Date:** 2026-08-27  
**Product:** Tabloom web workspace and Chrome extension

## Summary

Tabloom will provide a protected, read-only `Browser Bookmarks` system space populated by an explicit manual sync from the Chrome extension. Each browser installation uploads an independent snapshot. Tabloom merges those snapshots for display while retaining device provenance, preventing one device from destructively replacing another device's bookmarks.

Chrome bookmarks remain authoritative. Users can copy bookmark cards into normal Tabloom collections, but Tabloom does not edit Chrome bookmarks or continuously watch for bookmark changes.

## Goals

- Let a signed-in extension user manually import all visible Chrome bookmarks.
- Represent each Chrome folder as a separate collection in a protected system space.
- Merge account-synced bookmarks across devices while clearly labeling device-only or uncertain entries.
- Preserve the last complete snapshot if permission, browser reads, networking, or database writes fail.
- Let users search and open imported bookmarks and copy them into normal collections.
- Keep bookmark data isolated by Supabase row-level security and composite ownership constraints.

## Non-goals

- Editing, moving, or deleting Chrome bookmarks from Tabloom.
- Automatic or event-driven synchronization.
- Exporting Tabloom links back into Chrome bookmarks.
- Combining bookmark data with the existing `spaces`, `collections`, and `links` persistence tables.
- Representing Chrome's nested folder hierarchy as nested Tabloom collections.
- Automatically deleting devices that have not synced recently.
- Supporting browsers other than Chrome in this version.

## Product Decisions

- Sync is manual and can only be initiated from the Chrome extension.
- The `bookmarks` permission is optional and requested directly with `chrome.permissions.request()` when the user clicks sync. There is no explanation modal.
- `Bookmarks bar` and `Other bookmarks` are omitted from displayed collection paths.
- A remaining nested path is preserved, for example `Bookmarks bar / Work / Design` becomes `Work / Design`.
- Bookmarks directly inside an omitted root appear in `Unfiled bookmarks`.
- Empty folders are not displayed.
- Browser installations are separate sources. Their latest complete snapshots are merged into one system space.
- Account-synced entries merge across devices by normalized URL and displayed folder path.
- Device-only and uncertain entries remain source-specific and are visibly labeled with their device.
- The same URL in different folders remains separate.
- Bookmark collections and cards are read-only, but cards can be dragged or copied into normal Tabloom collections.

## User Experience

### First sync

1. The user clicks **Sync browser bookmarks** in the extension.
2. The extension calls `chrome.permissions.request({ permissions: ["bookmarks"] })`.
3. If permission is denied, the extension makes no data changes and shows a concise retryable message.
4. If permission is granted, the extension creates or loads a random installation identifier from `chrome.storage.local`.
5. The extension suggests a device name such as `Chrome on macOS`; the user can accept or edit it.
6. The extension reads and flattens the Chrome bookmark tree, filters unsupported URLs, and uploads a staged snapshot.
7. After the server activates the complete snapshot, the workspace reloads and reports collection, bookmark, device-only, and skipped-URL counts.

### Subsequent syncs

- The `Browser Bookmarks` header shows **Sync now** and the current device's last successful sync time in the extension.
- The web app displays the latest uploaded state but cannot initiate a browser read.
- A device-management surface lists each source's name and last successful sync time and supports renaming or forgetting a source.
- Forgetting a device requires confirmation and removes only that source and its bookmark snapshots.
- Stale sources remain until explicitly forgotten.

### Bookmark workspace behavior

- The organizer exposes a stable, protected `Browser Bookmarks` system space.
- Folder paths are presented as collections; `Unfiled bookmarks` is used for entries directly under an omitted Chrome root.
- Search and **Open all** operate on bookmark collections.
- Bookmark spaces, collections, and cards cannot be renamed, reordered, edited, or deleted in Tabloom.
- A bookmark card can be dragged into a normal collection. This creates a normal saved link and leaves the Chrome bookmark unchanged.
- Normal saved-link cards cannot be dropped into bookmark collections.
- Existing duplicate-link handling applies when a bookmark is copied into a normal collection.
- When offline, the extension displays the most recently cached merged bookmark view and its last-sync status.

## Data Model

Bookmark synchronization uses separate tables so existing personal workspace records and their CRUD behavior remain unchanged.

### `bookmark_sources`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | Primary key |
| `user_id` | `uuid` | Required owner |
| `device_key` | `text` | Random installation key stored locally |
| `device_name` | `text` | User-editable display name |
| `next_generation` | `bigint` | Server-controlled generation counter |
| `active_run_id` | `uuid`, nullable | Latest fully activated snapshot |
| `last_synced_at` | `timestamptz`, nullable | Set only after activation |
| `created_at` | `timestamptz` | Server default |
| `updated_at` | `timestamptz` | Server maintained |

Constraints:

- Unique `(user_id, device_key)`.
- Unique `(user_id, id)` to support composite ownership references.
- A deferred composite foreign key from `(user_id, id, active_run_id)` to `(user_id, source_id, id)` ensures an active run belongs to the same user and source. It is added after both tables exist.

### `bookmark_sync_runs`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | Primary key |
| `user_id` | `uuid` | Required owner |
| `source_id` | `uuid` | Owning browser source |
| `generation` | `bigint` | Monotonically increasing within the source |
| `status` | `text` with check constraint | `staging`, `active`, `superseded`, `failed`, or `abandoned` |
| `expected_entry_count` | `integer` | Valid entries the client intends to upload |
| `entry_count` | `integer` | Validated activated count |
| `created_at` | `timestamptz` | Start time |
| `completed_at` | `timestamptz`, nullable | Successful activation time |

Constraints:

- Composite foreign key `(user_id, source_id)` to `bookmark_sources(user_id, id)`.
- Unique `(user_id, source_id, id)` for ownership-safe entry references.
- Unique `(source_id, generation)`.
- Only one run referenced by a source can be active for display.

### `bookmark_entries`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | Primary key |
| `user_id` | `uuid` | Required owner |
| `source_id` | `uuid` | Browser installation |
| `run_id` | `uuid` | Snapshot generation |
| `chrome_bookmark_id` | `text` | Chrome's node identifier |
| `url` | `text` | Original supported URL |
| `normalized_url` | `text` | Deterministic merge key component |
| `title` | `text` | Chrome bookmark title |
| `folder_path` | `text` | Display path after root stripping |
| `syncing` | `boolean`, nullable | Account-sync state; null means uncertain |
| `position` | `integer` | Order within the flattened folder |
| `created_at` | `timestamptz` | Server default |

Constraints:

- Unique `(run_id, chrome_bookmark_id)`; repeated batches upsert this identity idempotently.
- Composite foreign keys ensure the run and source belong to the same `user_id`.
- URLs must be `http:` or `https:`.
- Positions must be non-negative.
- Deleting a source cascades to its runs and entries; deleting an individual active run is rejected while it is referenced.

### Security

- Row-level security is enabled on every bookmark table.
- Select, insert, update, and delete policies require `auth.uid() = user_id`.
- RPCs run as security invoker where possible. Any security-definer function performs explicit `auth.uid()` ownership checks and sets a restricted search path.
- Only the public Supabase URL and anonymous key are shipped to clients.
- Cross-owner source, run, and entry references are rejected by composite foreign keys, independent of application checks.

## Chrome Bookmark Adapter

The Chrome API is isolated behind a browser adapter so the domain and repository layers do not depend directly on extension globals.

### Permission behavior

- Add `bookmarks` under `optional_permissions`, not required permissions.
- Request it only in direct response to the user's sync action.
- A denied or revoked permission produces a retryable state without deleting the active server snapshot or local cache.

### Tree flattening

The adapter reads `chrome.bookmarks.getTree()` and traverses all visible URL nodes.

- Inherit a top-level folder's `syncing` value to descendants when child nodes do not expose it.
- Remove only the recognized root labels `Bookmarks bar` and `Other bookmarks` from the displayed path.
- Map a now-empty path to the reserved `Unfiled bookmarks` collection.
- Preserve all remaining segments joined by ` / `.
- Omit empty folders.
- Retain sibling order as `position`.
- Include only `http:` and `https:` URLs; count and report all skipped entries.
- Treat missing or unreliable sync state as unknown and label it by device rather than claiming it is account-synced.

The omitted root name is not uploaded because it is not part of the displayed collection identity.

### URL normalization

Normalization is deterministic and conservative:

- Lowercase the scheme and hostname.
- Remove a default port (`:80` for HTTP, `:443` for HTTPS).
- Remove the URL fragment.
- Preserve path, query string, and meaningful trailing-slash differences.

Normalization is used only for merged identity. The original URL is retained for opening and copying.

## Snapshot Sync Protocol

Large bookmark libraries use staged generations rather than a destructive replace.

1. `begin_bookmark_sync(device_key, device_name, expected_entry_count)` upserts the owned source, locks it while incrementing `next_generation`, and creates a `staging` run, returning its ID and generation. The expected count is calculated after unsupported URLs are filtered.
2. `append_bookmark_sync_batch(run_id, entries)` accepts bounded batches and validates ownership, URL schemes, paths, positions, and uniqueness.
3. `finalize_bookmark_sync(run_id)` verifies that the stored unique-entry count equals `expected_entry_count`, validates the complete run, and atomically:
   - marks the run completed/active,
   - changes the source's `active_run_id`,
   - updates `last_synced_at`, and
   - marks the source's previous active run `superseded`.
4. The client reloads the canonical merged read model and refreshes its local cache.

If any stage fails, the previous `active_run_id` remains unchanged. The failure is retryable, and original Chrome bookmarks are never changed.

### Concurrency

- Each run receives a source-local generation allocated atomically by the server.
- Finalization rejects a run older than the source's newest successfully activated run.
- Multiple extension windows may upload concurrently, but an older run cannot overwrite a newer completed snapshot.
- Abandoned staging and superseded generations can be cleaned by a scheduled maintenance operation after a retention period; active runs are never cleaned.

### Repository operations

The bookmark repository exposes:

- begin a source sync,
- append a batch,
- finalize a run,
- load the merged bookmark workspace,
- list and rename owned sources, and
- forget an owned source.

No bookmark entry mutation methods are exposed to organizer components.

## Merged Read Model

Only entries belonging to each source's `active_run_id` participate in the merged view.

### Identity rules

- Account-synced entry: `normalized_url + folder_path`.
- Device-only or unknown entry: `source_id + chrome_bookmark_id`.
- The same normalized URL in different folder paths remains separate.
- An account-synced entry remains visible while at least one active source reports it.

### Conflict rules

- When multiple account sources report the same identity, the most recently synced source supplies the displayed title, URL, and position.
- Equal timestamps are resolved deterministically by source ID, then Chrome bookmark ID.
- Device provenance is retained so the UI can explain which sources report a merged entry.
- Device-only and unknown entries display a device badge such as `Only on Chrome on macOS` or `Sync status unknown · Chrome on macOS`.

### Stable organizer representation

- System space ID: `system:browser-bookmarks`.
- Collection IDs are deterministic hashes of the displayed folder path.
- Bookmark-card IDs are deterministic hashes of the merged identity.
- `Unfiled bookmarks` sorts first; remaining collections sort by path using a stable locale-independent comparison.
- Cards use the winning source position, then title and stable ID as tie-breakers.

The repository adapts this view into shared organizer models using an origin discriminant such as `origin: "saved" | "browser-bookmark"` and a `readOnly` capability. It does not persist virtual bookmark collections into the normal collection tables.

## UI Integration

- Shared organizer components render normal and bookmark-origin models through the same visual card system.
- Capability flags hide or disable rename, reorder, edit, delete, and drop-target behavior for bookmark collections.
- Bookmark cards remain valid drag sources when the destination is a normal collection.
- Copying uses the existing normal-link creation flow, URL validation, duplicate warning, optimistic state, and canonical refetch behavior.
- Search indexes bookmark title, URL, folder path, and device label alongside normal workspace data.
- `Open all` uses the folder path as the requested Chrome tab-group name when tab-group permission is available and retains the current ungrouped fallback otherwise.
- The extension cache stores the latest merged bookmark view, source metadata, and successful-sync timestamp for fast and offline startup. Supabase remains authoritative.

## Error and Status States

- **Permission denied/revoked:** keep the previous snapshot and cache; show a permission-required retry action.
- **Chrome read failure:** upload nothing; keep the previous snapshot.
- **Offline before upload:** keep the prior cache and offer retry.
- **Partial batch failure:** do not finalize; keep the previous active generation.
- **Finalization conflict:** discard/refetch the canonical active snapshot and invite a fresh sync.
- **Authentication expired:** keep local read-only data visible, require sign-in before retrying writes.
- **Unsupported URLs:** skip them, complete the sync for valid entries, and report the count.
- **Empty library:** activate an empty snapshot for that source only; entries from other sources remain visible.

## Privacy

- The privacy page states that manual sync uploads bookmark titles, URLs, folder paths, ordering, sync classification, device name, and sync timestamps to the user's Tabloom account.
- The extension does not request bookmark access until the user explicitly initiates sync.
- Device keys are random installation identifiers and contain no hardware identifier.
- Reinstalling the extension creates a new source unless local extension storage is restored by Chrome.
- Forgetting a source deletes its server-side snapshots but does not alter Chrome bookmarks.

## Testing Strategy

### Unit tests

- Tree flattening for recognized roots, nested paths, direct-root `Unfiled bookmarks`, empty folders, and unsupported URLs.
- Sync-state inheritance and unknown-state fallback.
- URL normalization and identity construction.
- Account-entry merging, device provenance, title/order conflicts, stale sources, and same-URL/different-folder behavior.
- Deterministic collection/card IDs and ordering.
- Cache loading and invalidation after successful activation.

### Extension component and API tests

- Permission grant, denial, and revocation.
- Device naming and persistent random device identity.
- Bounded batch upload, append failure, finalization failure, retry, and canonical reload.
- Prior active snapshot and local cache remain intact after every failure mode.
- Read-only controls and drag-copy into a normal collection.
- Duplicate warning when copying an already-saved URL.

### Supabase integration tests

- Two-user row-level isolation for sources, runs, entries, and RPCs.
- Cross-owner composite foreign-key rejection.
- Atomic activation and previous-generation preservation.
- Concurrent runs cannot allow an older generation to replace a newer active generation.
- Forgetting a source removes only that user's selected source and its dependent runs/entries.

### End-to-end tests

- Extension requests permission, uploads a snapshot, and displays it in the new-tab workspace.
- The hosted `/app` sees the same merged view after synchronization.
- Two simulated devices merge account-synced entries and retain distinct device-only entries.
- Root stripping and `Unfiled bookmarks` render correctly.
- A bookmark copies into a normal collection without changing the bookmark view.
- Offline startup displays cached bookmarks and a reliable last-sync status.

## Acceptance Criteria

A signed-in user can manually sync bookmarks on two Chrome installations. Both devices and the web app show one `Browser Bookmarks` system space. Account-synced duplicates are merged by URL and folder, device-only or uncertain entries are clearly labeled, and each Chrome folder is represented as a read-only collection without the `Bookmarks bar` or `Other bookmarks` prefixes. A bookmark can be copied into a normal collection. Denied permission or any interrupted upload leaves the prior complete snapshot available.

## Delivery Sequence

1. Add Supabase migration, ownership constraints, RLS policies, and staged-sync RPCs.
2. Add shared bookmark domain types, normalization, flattening, merge logic, and repository contracts with unit tests.
3. Add the Chrome bookmarks adapter, optional permission, source identity, batching, cache updates, and extension sync UI.
4. Add the protected bookmark space, device labels/management, read-only capabilities, search, open-all, and drag-copy behavior to shared organizer components.
5. Add integration and end-to-end coverage, privacy disclosure, setup documentation, and a versioned extension build.
