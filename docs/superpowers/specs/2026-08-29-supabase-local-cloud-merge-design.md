# Supabase Local-to-Cloud Merge Design

**Status:** Awaiting written-spec review  
**Date:** 2026-08-29  
**Product:** Tabloom web workspace and cross-browser extension  
**Supabase project:** `tctjlsvfufzxhauhywsm`

## Summary

Tabloom will connect the existing local-first extension to the user's Supabase project without replacing or silently discarding local data. Google sign-in will load local and cloud snapshots independently, calculate a deterministic merge plan, and either import automatically into an empty destination or ask the user to confirm a non-empty merge.

Card UUIDs are the primary identity. A normalized URL is a fallback duplicate identity only when two cards have different UUIDs and resolve to the same destination space and collection. The same URL remains valid in different spaces or collections.

The confirmed merge executes as one database transaction, validates that the cloud workspace has not changed since preview, returns the canonical result and summary, and switches the extension to cloud synchronization only after success.

## Goals

- Connect the web app and extension to Supabase using public client credentials.
- Configure Google OAuth for the hosted web callback and each supported extension callback.
- Preserve all meaningful local spaces, collections, cards, metadata, and ordering on first sign-in.
- Prevent sign-in from replacing the local snapshot with an empty or stale cloud snapshot.
- Deduplicate independently created cards only within the same matched space and collection.
- Make merge effects visible before writing when both workspaces contain meaningful data.
- Make the merge atomic, retryable, idempotent, and safe under concurrent cloud changes.
- Keep local use fully functional when Supabase is unavailable or the user declines synchronization.

## Non-goals

- Continuous bidirectional reconciliation between two permanently independent local and cloud authorities.
- Team workspaces, invitations, public sharing, comments, or collaborative conflict resolution.
- Automatically importing the Toby JSON export as part of sign-in. Toby conversion can feed the same merge engine in a later feature.
- Deduplicating cards across different spaces or collections.
- Deleting duplicate browser tabs or browser bookmarks during workspace merge.
- Shipping a service-role key, Google client secret, authenticated session, or private database credential.

## Product Decisions

- Before sign-in, extension storage is authoritative.
- After a successful import or confirmed merge, Supabase is authoritative for the signed-in workspace.
- A cancelled merge leaves local storage authoritative and exposes a persistent **Sync pending** action.
- Signing out returns to the untouched local workspace; it does not copy cloud-only changes back into local storage automatically.
- Cloud and local caches use separate keys. A cloud read or write never overwrites the authoritative local snapshot.
- Existing cloud ordering and non-empty metadata win conflicts. Local-only records are appended in their existing relative order.
- Empty bootstrap structures such as `My Space` containing an empty `My Collection` are not uploaded when they contain no user content or customization.

## Connection and Authentication

### Public configuration

The repository consumes the following build-time variables:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_TABLOOM_WEB_URL
```

The URL points to project `tctjlsvfufzxhauhywsm`. The anonymous or publishable key is intentionally client-visible and relies on row-level security. Values are stored in `.env.local` and the hosting provider's secret/configuration interface; `.env.local` remains ignored by Git.

### Google OAuth

- Google Cloud contains an OAuth 2.0 web client.
- Supabase **Authentication → Providers → Google** stores the Google client ID and client secret.
- Google receives the provider callback URL displayed by Supabase.
- Supabase's redirect allow list contains local and production `/app` URLs plus exact browser-extension callback URLs.
- Chromium and Firefox obtain their exact callback through the browser identity adapter using `getRedirectURL("auth-callback")`.
- Safari uses the target-specific `auth-callback.html` path already exposed by its adapter.
- The extension launches an interactive identity flow and exchanges the callback authorization code for a Supabase session.

Cancelling or failing OAuth leaves the local workspace active and unchanged.

## Storage Boundaries

Local authoritative data and cloud cache data must not share a storage key.

```text
tabloom-local-workspace-v2
tabloom-cloud-workspace-v1:<supabase-user-id>
tabloom-sync-state-v1:<supabase-user-id>
```

- `tabloom-local-workspace-v2` is writable while the extension is operating locally.
- The per-user cloud key is an offline cache of the latest canonical Supabase snapshot, never an independent write authority.
- Sync state records `local`, `pending`, `merging`, `synced`, or `error`, plus the last confirmed merge summary.
- Legacy local storage is migrated once into the v2 local key. Known sample/demo snapshots are not promoted as user data.
- Multiple new-tab pages mutate local storage through a storage-backed transaction or lock that reloads the latest snapshot immediately before applying each mutation, preventing stale in-memory snapshots from overwriting each other.

When an authenticated cloud load fails, the extension continues to show and edit the local workspace until cloud authority has been established. After cloud authority is established, an offline write reports a retryable error and does not pretend to have synchronized.

## Meaningful-Workspace Detection

The merge engine classifies each side before deciding whether confirmation is needed.

### Cloud workspace is empty

Cloud is empty only when it contains zero owned spaces, zero owned collections, and zero owned cards. Local meaningful data imports automatically without confirmation.

### Local workspace is effectively empty

Local is effectively empty when it contains no cards and contains only Tabloom's unchanged generated bootstrap records:

- one `My Space`, and
- at most one empty `My Collection`.

An empty space or collection with a user-changed name, color, or structure is meaningful and participates in the merge.

If local is effectively empty and cloud contains data, Tabloom switches to cloud mode without confirmation. If both sides are empty, Tabloom switches to cloud mode and may create the default cloud structure lazily on the first mutation.

## Merge Identity

### Name identity

Space and collection fallback identity is a normalized name:

1. Unicode-normalize to NFC.
2. Trim leading and trailing whitespace.
3. Collapse internal whitespace runs to one space.
4. Compare with locale-independent lowercase casing.

Collections are matched only inside their matched destination space. A same-named collection in another space remains separate.

### Card identity

Cards are compared in this order:

1. **Same UUID:** the records represent the same card. The cloud record remains canonical even if the local card appears in another collection.
2. **Different UUID, same normalized URL, same matched space and collection:** the records are independent duplicates and collapse to one canonical cloud card.
3. **Same URL but different destination space or collection:** preserve both cards.

URL fallback uses the existing `normalizeUrlForDuplicate` behavior: accept only `http:` and `https:` URLs and compare the canonical `URL.href`. Unsupported URLs are skipped and reported.

### UUID preservation

- A local-only card keeps its local UUID when that UUID is valid and unused in the cloud database.
- If a UUID collides with another database record, the server assigns a new UUID and returns the identity mapping.
- Cards collapsed by URL keep the existing cloud UUID.
- After the first successful merge, normal synchronization compares canonical cloud UUIDs directly; URL comparison remains a fallback for independently created duplicates.

## Conflict and Ordering Rules

### Spaces

- Existing cloud ID, position, name, and color remain canonical.
- A local-only space is appended after existing cloud spaces.
- Local-only spaces preserve their relative order.

### Collections

- Existing cloud ID, position, and non-empty name remain canonical.
- A local-only collection is appended within its destination space.
- Local-only collections preserve their relative order.

### Cards

- Existing cloud ID, collection, position, URL, and non-empty metadata remain canonical.
- Empty cloud title, description, or favicon fields may be enriched from a matching local card.
- A local-only card is appended after cloud cards in the destination collection.
- Local-only cards preserve their relative order.
- When multiple local cards collapse onto one cloud card, the earliest local position is used only to order metadata candidates; non-empty values are selected deterministically in source order.

The merge never silently moves a cloud card based on a stale local copy. A same-ID cloud card's current cloud collection remains authoritative.

## Preview and Confirmation UX

After OAuth succeeds, Tabloom loads both snapshots and computes a merge preview before changing repository authority.

### No confirmation

- **Cloud empty, local meaningful:** automatically import local data.
- **Local effectively empty, cloud meaningful:** automatically adopt cloud data.
- **Both empty:** adopt cloud mode without writing bootstrap noise.

### Confirmation required

When both sides contain meaningful data, a modal displays:

- matched spaces and collections,
- spaces, collections, and cards to add,
- cards matched by UUID,
- URL duplicates to collapse within the same space and collection,
- metadata fields to enrich,
- unsupported URLs to skip, and
- a statement that different collections retain the same URL independently.

Actions:

- **Cancel:** write nothing, keep the local repository active, and show **Sync pending**.
- **Merge and sync:** submit the preview's expected cloud revision and local payload, disable duplicate submissions, and show progress until the canonical snapshot reloads.

The pending action can reopen the preview without repeating OAuth while the session is valid. Closing the modal is equivalent to cancelling, not approving.

## Transactional Merge Protocol

### Workspace revision

Add an owned `workspace_sync_state` table:

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | `uuid` | Primary key and owner |
| `revision` | `bigint` | Monotonically increasing workspace revision |
| `updated_at` | `timestamptz` | Server-maintained timestamp |

Triggers on `spaces`, `collections`, and `links` create the state row when necessary and increment the owning user's revision after successful mutations. Row-level security requires `auth.uid() = user_id`.

A missing state row represents revision `0`. The first versioned load or merge upserts that row before locking it, so a brand-new account follows the same concurrency protocol as an established account.

### Preview

The cloud repository loads `spaces`, `collections`, `links`, and the current workspace revision. The client-side pure merge planner produces a human-readable preview and the expected payload. No database changes occur during preview.

### Apply

`merge_workspace_snapshot(local_snapshot jsonb, expected_revision bigint)` performs the following in one transaction:

1. Require an authenticated `auth.uid()`.
2. Lock the caller's `workspace_sync_state` row.
3. Reject with a conflict if the revision differs from the preview revision.
4. Validate payload size, record ownership, UUID syntax, positions, names, and supported URL schemes.
5. Recompute identity and conflict decisions server-side rather than trusting client-provided counts.
6. Insert local-only spaces, collections, and cards; enrich only permitted empty metadata fields.
7. Normalize positions for affected destinations.
8. Return the canonical snapshot, ID mappings, actual merge summary, and final revision.

The RPC is idempotent: retrying the same payload after an uncertain response finds matching UUIDs or scoped normalized URLs and does not create another copy.

If a revision conflict occurs, the extension reloads cloud state, recomputes the preview, and requires confirmation again if both sides remain meaningful. It never applies a materially changed plan under an earlier confirmation.

### Security

- Prefer a security-invoker function. Any security-definer helper explicitly validates `auth.uid()`, sets a restricted search path, and accepts no caller-supplied `user_id`.
- Composite ownership constraints remain authoritative for collection-to-space and card-to-collection references.
- Row-level security remains enabled on every table.
- Merge payload limits prevent unbounded JSON input and denial-of-service behavior.
- The service-role key and Google client secret never enter the client build or repository.

## Repository and Application Integration

Introduce shared types:

- `VersionedWorkspaceSnapshot`
- `WorkspaceMergePlan`
- `WorkspaceMergeSummary`
- `WorkspaceIdentityMap`
- `WorkspaceSyncStatus`

Introduce pure domain operations for:

- effective-empty detection,
- normalized space and collection names,
- scoped card identity,
- deterministic preview planning, and
- summary generation.

The cloud repository adds operations to load a versioned snapshot and apply a local merge. The local repository remains independent. A first-sign-in coordinator owns the authority transition so UI components never switch repositories prematurely.

The web app uses the same cloud repository but normally has no browser-local workspace to merge. If a future web-local source exists, it can reuse the coordinator and merge planner.

## Error Handling

- **OAuth cancelled or failed:** remain local; show a retryable sign-in error.
- **Cloud load failed:** remain local; do not show a misleading empty cloud preview.
- **Preview failed:** remain local and preserve the session for retry.
- **Merge validation failed:** write nothing; display the actionable validation summary.
- **Revision conflict:** refetch, recompute, and request confirmation again when required.
- **Network outcome uncertain:** refetch canonical cloud state before retrying the idempotent RPC.
- **Session expired:** remain local and require sign-in before another merge attempt.
- **Unsupported URL:** skip it, include it in the preview and final summary, and preserve it in local storage.
- **Partial database error:** transaction rolls back completely; local authority and data remain unchanged.
- **Cloud cache write failed after server success:** cloud remains authoritative; report a cache warning and retry the cache separately.

## Testing

### Unit tests

- Effective-empty detection for true empty, generated defaults, renamed defaults, empty custom collections, and populated workspaces.
- Name normalization with casing, Unicode, and whitespace variants.
- UUID-first identity and scoped URL fallback.
- Same URL retained across different collections and spaces.
- Cloud-wins conflict rules and metadata enrichment.
- Stable append ordering and deterministic summaries.
- Invalid URL skipping and counts.
- Retry planning against a previously merged snapshot produces no extra records.

### Repository and database tests

- Two users cannot read or merge each other's rows.
- Cross-owner collection and card references are rejected.
- Empty-cloud import preserves eligible local UUIDs.
- Scoped duplicates collapse; cross-collection duplicates remain.
- Revision conflicts reject the entire transaction.
- Validation failure rolls back every insert and update.
- Repeating the same merge payload is idempotent.
- Triggers increment revisions for ordinary CRUD and merge operations.

### Component tests

- Both-meaningful state opens the confirmation modal with accurate counts.
- Empty cloud imports without rendering confirmation.
- Effective-empty local adopts cloud without confirmation.
- Cancel keeps local authority and exposes **Sync pending**.
- Merge disables repeated submission and switches only after canonical reload.
- Conflict reopens an updated preview.
- OAuth, offline, expired-session, validation, and uncertain-outcome errors retain local data.

### End-to-end tests

- Create local content, sign in to an empty account, and verify automatic import on web and extension.
- Create overlapping local and cloud content, confirm merge, and verify ID and URL deduplication rules.
- Cancel merge and confirm no Supabase rows changed.
- Modify cloud data between preview and confirmation and verify conflict handling.
- Sign out and verify the original local workspace remains available.
- Reload another extension instance and verify canonical cloud IDs and order.

## Delivery and Operations

1. Configure the Supabase project and Google provider without committing secrets.
2. Apply migrations and run two-user database isolation tests.
3. Add local/cloud storage separation and legacy local migration.
4. Implement and test the pure merge planner.
5. Implement the transactional RPC and versioned repository.
6. Add first-sign-in confirmation and authority-transition UI.
7. Build Chromium, Firefox, and Safari targets.
8. Run a real-account acceptance test with a disposable local fixture before merging the user's actual workspace.

The Toby export remains unchanged in Downloads until a separately approved import maps its 54 collections and 661 cards into a Tabloom snapshot and submits it through this same merge path.
