# Shared Web Workspace and Safe MCP Mutations Design

**Date:** 2026-09-10

## Summary

Tabloom will make `https://tabloom.nickvu.dev/app` use the same organizer design and core interactions as the browser extension while keeping browser-only capabilities isolated to extension builds. The Tabloom MCP service will gain authenticated workspace discovery and mutation tools for spaces, collections, and saved links.

All human and agent deletions will use a shared 30-day Trash system. Deleting a space or collection through MCP requires a server-enforced, two-step chat confirmation. Deleting a saved link through MCP is immediate but recoverable. Stable record IDs, Supabase row-level security, atomic database functions, idempotency, and optimistic concurrency protect user data.

## Goals

- Give `/app` the extension's space rail, collection rows, saved-link cards, global search, dialogs, drag-and-drop behavior, motion, and responsive visual language.
- Maintain one shared organizer implementation for extension and web surfaces.
- Keep Current Tabs, browser bookmark access, tab closing, tab grouping, and other browser APIs exclusive to extensions.
- Let authenticated MCP clients read and search a user's synchronized workspace.
- Let MCP clients add, edit, delete, move, and reorder supported workspace records.
- Require explicit chat confirmation before an MCP client can delete a space or collection.
- Make deletions from MCP, web, and extension recoverable for 30 days.
- Preserve existing extension local-first and failed-sync/retry behavior.

## Non-goals

- Exposing unsynchronized device-local extension data to MCP clients.
- Giving the web application access to Current Tabs or native browser bookmark APIs.
- Allowing agents to mutate browser-bookmark spaces, collections, or links.
- Guaranteeing native browser tab grouping from the web application.
- Team workspaces, granular sharing permissions, or administrative recovery outside the signed-in user's workspace.
- Permanent version history for every edit. Recovery covers deletion, not arbitrary field changes.

## Architecture

### Shared organizer

Extract the organizer presentation and interaction state from the extension into `shared/organizer`. The shared module will contain focused components and a platform-neutral controller:

```text
shared/organizer/
  WorkspaceShell
  SpaceRail
  WorkspaceHeader
  CollectionList
  CollectionSection
  SavedLinkCard
  GlobalSearch
  WorkspaceDialogs
  ToastRegion
  useWorkspaceController
  capabilities.ts
```

The shared controller owns:

- Workspace snapshot state and selected-space state.
- Persisted collection collapse state.
- Search, keyboard navigation, and modal state.
- Space, collection, and saved-link commands.
- Collection and saved-link drag-and-drop state, insertion targets, and shifting previews.
- Optimistic rendering, errors, Undo actions, and three-second notifications.

The controller depends on the existing `WorkspaceRepository` contract plus an explicit capability object. It must not import Chrome, Firefox, Safari, or DOM extension globals.

The extension composes Current Tabs, browser bookmarks, tab actions, grouping, and browser identity around the shared organizer. The web app supplies only web-safe navigation, authenticated Supabase repositories, and account actions. An unavailable capability is omitted rather than rendered disabled.

The existing `app/app/WorkspaceClient.tsx` becomes a thin web composition boundary. Its current organizer rendering and mutation logic moves into shared components and hooks. Browser-specific extension components remain in `extension/` and render around or into documented extension slots.

### Server-side workspace commands

Create a server-side workspace command service for MCP tools. It owns input validation, record lookup, ownership-safe repository calls, optimistic concurrency, idempotency, delete-intent issuance, and Trash restoration. MCP route handlers translate protocol input into command calls and translate command results into structured MCP content.

The service shares domain types and validation rules with the organizer, but it does not import React components or client-side repositories. It operates with the authenticated user's Supabase access token so database RLS remains authoritative.

## Web workspace experience

`/app` will match the extension in these areas:

- Collapsed space rail by default, expandable to show names and inline space actions.
- Locally remembered selected space, rail state, and collection collapse states.
- Header actions for New collection, full-screen global search, and account menu.
- Horizontal saved-link cards with favicons, fallback initials, pointer cursors, drag indicators, and hover/focus actions.
- Collapsible collection rows with link counts, Open all, editing, deletion, sharing, ordering, visible drop targets, and smooth shifting previews.
- Global search across all spaces and collections, with space and collection context shown for every result.
- Accessible dialogs, keyboard alternatives to pointer drag-and-drop, responsive layouts, motion preferences, and three-second mini toasts.

Web-specific behavior:

- Current Tabs, live bookmarks, native tab closing, and native tab grouping are absent.
- Saved links use normal web navigation semantics.
- Open all opens separate tabs after the existing large-collection warning, but does not promise native grouping.
- Authentication and account controls remain web-specific.

The account dropdown gains a Trash action. Trash opens a modal showing the deleted entity type, original name, deletion source, deletion time, remaining recovery period, and Restore. Space and collection deletion initiated by a human keeps a confirmation dialog. Saved-link deletion is immediate and displays an Undo toast.

## Trash data model

### `workspace_trash`

Add a user-owned Trash table with:

- `id uuid primary key`
- `user_id uuid not null`
- `root_type text not null` constrained to `space`, `collection`, or `link`
- `root_id uuid not null`
- `root_name text not null`
- `snapshot jsonb not null`
- `source text not null` constrained to `web`, `extension`, or `mcp`
- `deleted_at timestamptz not null`
- `expires_at timestamptz not null`
- `restored_at timestamptz null`
- `created_operation_id uuid null` for retry correlation

The JSON snapshot is versioned and contains the root record plus all descendants required for restoration. A collection snapshot contains its links. A space snapshot contains the space, its collections, and their links. A link snapshot contains the link and its original collection ID.

RLS permits authenticated users to list and restore only their own unexpired entries. Client code cannot insert arbitrary snapshots. Security-definer database functions create and restore entries after validating `auth.uid()`, and their executable privileges are limited to authenticated users.

### `workspace_delete_intents`

Add a short-lived intent table with:

- `id uuid primary key`
- `user_id uuid not null`
- `target_type text not null` constrained to `space` or `collection`
- `target_id uuid not null`
- `target_updated_at timestamptz not null`
- `target_summary jsonb not null`
- `expires_at timestamptz not null`
- `consumed_at timestamptz null`

An intent is bound to the authenticated user, exact target ID, and the target's last-seen update timestamp. It expires after 10 minutes, is consumed once, and is rejected if the target changed after preparation.

## Atomic deletion and restoration

Database functions will atomically:

1. Lock and validate the target and its ownership.
2. Capture the versioned root-and-descendant snapshot.
3. Insert the Trash entry idempotently using the operation ID.
4. Delete the live records using existing cascade behavior.
5. Advance the user's workspace revision and record the deletion operation.
6. Return the Trash ID and recovery deadline.

All deletions from web, extension synchronization, and MCP route through these functions. An extension deletion made while offline remains an optimistic local operation; the remote Trash entry is created when synchronization succeeds. Existing failed-sync and Retry behavior remains unchanged.

Restoration recreates records with their original stable IDs and relative ordering. If an original parent no longer exists, restoration returns a structured `destination_required` result. A deleted link can then be restored into a chosen writable collection, and a deleted collection into a chosen writable space. A complete space snapshot is self-contained.

Restoration rejects cross-owner destinations, read-only bookmark destinations, expired entries, already-restored entries, and ID conflicts. It advances the workspace revision so restored data synchronizes to other devices.

Expired entries are excluded from all user-facing reads immediately. Normal Trash access invokes a bounded opportunistic purge of expired rows, avoiding a hard dependency on an external scheduler. A later scheduled purge may be added without changing the public contract.

## MCP tools

### Discovery tools

- `get_workspace`
- `list_spaces`
- `list_collections`
- `list_collection_items`
- `search_workspace`
- `list_trash`

These tools are read-only and return stable IDs, parent IDs, positions, timestamps, read-only state, and concise names needed for subsequent commands.

### Space tools

- `create_space`
- `update_space`
- `prepare_delete_space`
- `confirm_delete_space`

### Collection tools

- `create_collection`
- `update_collection`
- `prepare_delete_collection`
- `confirm_delete_collection`

### Saved-link tools

- `create_collection_item`
- `update_collection_item`
- `delete_collection_item`
- `move_collection_item`
- `reorder_collection_items`

### Recovery tools

- `restore_trash_item`

The public MCP vocabulary uses “collection item,” while the internal domain model continues to use `SavedLink` and `link` where already established.

## MCP mutation rules

- Mutations identify existing records by stable ID, never by a potentially ambiguous name.
- Creating records accepts an idempotency key. Replaying the same request returns the original result rather than creating a duplicate.
- Updating, moving, and reordering require last-seen timestamps or an equivalent expected revision. A stale request returns `conflict` with current record metadata and makes no change.
- URLs accept only `http:` and `https:` schemes.
- Browser-bookmark records and other read-only records cannot be mutated.
- Every successful result contains structured JSON plus a concise user-facing summary.
- Every failure uses a stable error code such as `not_found`, `read_only`, `conflict`, `confirmation_required`, `confirmation_expired`, `destination_required`, or `validation_failed`.

`prepare_delete_space` and `prepare_delete_collection` return the target name, descendant counts, consequences, expiry, and a single-use confirmation token. The token expires after 10 minutes. Only after the user explicitly confirms in chat may an agent call the corresponding `confirm_delete_*` tool. The confirmation tool validates the token and target fingerprint before deletion. This two-step server contract enforces confirmation even when an MCP host ignores tool annotations.

`delete_collection_item` does not require prior confirmation. It immediately moves the link to Trash and returns `trash_id`, `restore_until`, and a recovery message suitable for chat. `restore_trash_item` restores by Trash ID and accepts an optional destination ID when the original parent is gone.

MCP annotations accurately mark read-only, destructive, idempotent, and closed-world behavior. Only synchronized Supabase records are visible; MCP cannot inspect device-local pending data.

## Optimistic behavior and synchronization

The web organizer updates its in-memory snapshot before awaiting the authoritative write. If the write fails, it restores the previous snapshot and shows a concise error toast. A successful response reconciles IDs, timestamps, positions, and revisions returned by the server.

The extension preserves its existing local-first semantics: local mutations remain visible, remote synchronization starts immediately when signed in, and failed changes remain local with the existing Failed to sync and Retry state. Moving shared rendering into `shared/organizer` must not replace this repository behavior.

MCP commands are server-authoritative and return only after the transaction commits. They never report a partial mutation as successful.

## Authentication and authorization

- MCP tools continue using the existing Tabloom OAuth flow and audience.
- The MCP service constructs a Supabase client using the user's verified bearer token.
- User workspace mutations never use a service-role key.
- Existing RLS ownership constraints remain the final authorization boundary.
- Trash and delete-intent policies enforce `auth.uid() = user_id`.
- Security-definer functions set a safe search path, validate ownership internally, and expose only the minimum authenticated execute grants.
- Mutation logs contain IDs, action types, outcomes, and correlation IDs, but not access tokens, raw authorization headers, or private snapshot contents.

## Error handling

- Validation errors identify the invalid field without echoing sensitive credentials.
- Concurrency conflicts preserve both the user's current data and the agent's attempted input in the tool result.
- Expired or consumed confirmations require a new prepare call and renewed user confirmation.
- Failed deletion transactions leave both live data and Trash unchanged.
- Failed restoration leaves the Trash entry recoverable until its original expiry.
- UI errors use accessible three-second toasts except when persistent action is required, such as Retry or destination selection.
- MCP responses include a correlation ID for unexpected server failures.

## Rollout

1. Deploy additive Trash and delete-intent schema, RLS, transactional functions, and integration tests.
2. Add the server-side workspace command service and read-only MCP discovery tools.
3. Add MCP mutations behind `TABLOOM_MCP_MUTATIONS_ENABLED=false`.
4. Validate two-user RLS isolation, idempotency, concurrency, confirmation, deletion, and restoration in production-like staging.
5. Enable MCP mutations.
6. Extract shared organizer components and migrate the extension with no intended visual or behavioral changes.
7. Move `/app` to the shared organizer, add Trash and Undo, and remove its duplicate organizer implementation.
8. Build and regression-test the web app and Chromium, Firefox, and Safari extension targets.
9. Deploy the web and MCP services, run live OAuth and MCP acceptance checks, and then publish updated downloadable extension packages.

Database changes are additive during the compatibility portion of the rollout. After the updated clients and synchronization RPC use Trash functions, direct table-delete privileges are removed so supported clients cannot bypass recovery. Rollback disables new deletion entry points rather than restoring unsafe direct hard deletes. Disabling `TABLOOM_MCP_MUTATIONS_ENABLED` immediately removes agent mutation access without affecting read tools or human workspace access.

## Testing

### Database and repository tests

- Two authenticated users cannot read, delete, restore, or target each other's records.
- Space and collection snapshots include every descendant exactly once.
- Delete and restore update the workspace revision atomically.
- Operation retry creates only one Trash entry.
- Expired and restored entries cannot be restored again.
- Missing parents produce `destination_required`; valid alternate destinations restore successfully.
- Browser-bookmark records and destinations remain read-only.

### MCP tests

- Every read tool returns stable IDs and ownership-scoped results.
- Create retries are idempotent.
- Stale edits and reorders return `conflict` without overwriting data.
- Space and collection confirmation tokens expire, are single-use, and fail after target changes.
- Confirmation tools cannot be called successfully with fabricated or cross-user tokens.
- Saved-link deletion returns recovery metadata without a confirmation round trip.
- Tool annotations and structured result schemas match actual behavior.
- Feature-flagged mutation tools are unavailable while read tools remain usable.

### Shared organizer and web tests

- Shared components render equivalently in extension and web compositions.
- `/app` omits every browser-only control.
- Selected space and collapsed states initialize from local persistence without visual flicker.
- Search returns results across spaces and collections with full context.
- Drag insertion indicators, shifting previews, keyboard movement, and ordering persist correctly.
- Optimistic web mutations roll back on failure.
- Space and collection deletions require confirmation; link deletion offers Undo.
- Trash lists, restores, destination selection, expiry messaging, focus management, and keyboard operation are accessible.

### Regression and acceptance tests

- Chromium, Firefox, and Safari production builds succeed.
- Extension Current Tabs, bookmarks, tab actions, grouping, OAuth, local-first sync, and failed-sync Retry behavior do not regress.
- The web production build and MCP production build succeed without console errors.
- A user can modify data through MCP and see it after web or extension synchronization.
- A user can confirm a collection deletion in chat, restore it from Trash, and recover its links with stable IDs and ordering.

## Acceptance criteria

- `/app` presents the extension's organizer design without browser-only features.
- Extension and web organizer changes are implemented once in shared components.
- Authenticated agents can discover and mutate writable spaces, collections, and saved links.
- MCP space and collection deletion cannot complete without a fresh explicit confirmation round trip.
- MCP saved-link deletion is immediate and recoverable.
- All supported deletion sources create 30-day Trash entries.
- Restored records synchronize to other signed-in devices.
- Cross-user access, duplicate retries, stale overwrites, and read-only bookmark mutation are prevented.
