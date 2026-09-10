# Save Shared Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let visitors save a shared collection as a private, editable copy in their own Tabloom account.

**Architecture:** Keep anonymous rendering intact and add an authenticated client action backed by Supabase RPCs. A single database transaction resolves the active share, creates the recipient-owned collection and links, and records the source-to-copy relationship for idempotency. Existing workspace revision triggers make the result visible to extension sync.

**Tech Stack:** Existing React 19, Next.js/vinext, TypeScript, Supabase/PostgreSQL, Vitest, Testing Library, pgTAP, and Playwright; Node >=22.13.0.

**Spec:** The approved behavior from this conversation, reproduced in “Product contract” below. Existing sharing constraints are documented in `docs/superpowers/specs/2026-09-04-live-collection-sharing-design.md`.

## Global constraints

- Save an independent copy; original edits and revocation do not alter an existing copy.
- Primary label: “Save to my collections”. Explanation: “Save a copy to your account. Changes to the original won’t update your copy.”
- Preserve collection name, link titles, URLs, descriptions, and visible link order; allocate fresh IDs and timestamps. Keep favicon URLs null, matching the public sharing contract.
- New copies are ordinary editable saved collections and are private until their recipient explicitly enables sharing.
- Use the existing Google/Supabase browser authentication, without requiring the extension.
- Browsing public shares and “Open all” continue to work without authentication.
- Use authenticated RPCs with `auth.uid()`; never trust a client-supplied owner ID or copy payload.
- Do not expose original owner IDs, private space names, share-management data, or source identifiers through the public snapshot.
- Preserve existing uncommitted changes in `supabase/config.toml` and `tests/extension-auth-config.test.ts` found during planning.
- Prefix shell commands with `rtk`. Use the codebase knowledge graph for code discovery.

## Product contract

1. Put Save beside Open all, with Save primary and Open all secondary. Stack actions on narrow screens.
2. Signed-in visitors save in one click. Show “Saving…” while pending, then “Saved to your collections” and “View collection”; remain on the shared page.
3. Signed-out visitors get a small sign-in dialog explaining the copy behavior. After successful sign-in, return to this share and automatically finish the explicit save request.
4. Before a new click, a signed-in visitor who already has a copy sees “View saved collection”. The source owner sees “Open my collection”. Both resolve to the current location of that collection.
5. Planning default for the previously unspecified destination: choose the first ordinary space ordered by `(position, created_at, id)`. If none exists, create “My collections” with color `#f56f72`. Append the collection; users can organize it afterward. No destination picker in v1.
6. Allow saving an empty collection. If the copy or its containing space is deleted, an explicit subsequent save creates a fresh copy. Never recreate it merely by viewing a page.
7. Deduplicate by recipient plus original collection ID, not share token or collection title. Regenerating or disabling/re-enabling a share does not produce another copy.
8. Validate sharing again when saving. If it was revoked or the source deleted, show “This shared collection is no longer available.” No partial copy. A source change between page load and save copies the current server snapshot.
9. A failed request shows “Couldn’t save this collection. Try again.” Preserve the intent for an explicit retry after an uncertain response; do not show success before server confirmation.
10. Out of scope: following live updates, collaborative editing, merging into an existing collection, copy refresh, analytics, and extension-specific save UI.

## Existing integration points

- `app/s/[token]/page.tsx`: resolves the public snapshot; pass the route token into the view.
- `app/s/[token]/SharedCollectionView.tsx`: public heading/actions, empty state, Open all.
- `app/lib/supabase-browser.ts`: shared browser Supabase singleton.
- `app/app/WorkspaceBootstrap.tsx`: existing Google OAuth and session subscription patterns.
- `app/app/WorkspaceClient.tsx`: loads workspace and defaults to the first space; has no collection deep-link selection yet.
- `shared/collection-sharing.ts`: existing typed RPC adapter and token validation pattern.
- `supabase/migrations/202609040001_live_collection_sharing.sql`: active-token lookup and intentionally restricted public fields.
- `supabase/migrations/202608290001_workspace_merge.sql`: row triggers increment workspace revision for changes to spaces, collections, and links.
- `supabase/migrations/202608310001_local_first_workspace_sync.sql`: sync serializes against `workspace_sync_state` rows.

## Task 1: Atomic, private, idempotent database save

**Files**
- Create `supabase/migrations/202609090001_save_shared_collection.sql`.
- Create `supabase/tests/save_shared_collection.test.sql`.
- Create `tests/integration/save-shared-collection-concurrency.test.ts` for a gated local database concurrency check.

**Interfaces**

```ts
// JSON returned by the new authenticated RPCs.
type SharedCollectionSaveState =
  | { status: "available" }
  | { status: "unavailable" }
  | { status: "owned" | "saved"; collectionId: string; spaceId: string };
type SharedCollectionSaveResult = {
  status: "created" | "saved" | "owned";
  collectionId: string;
  spaceId: string;
};
// get_shared_collection_save_state(share_token text) -> jsonb
// save_shared_collection(share_token text) -> jsonb
```

- [ ] Add pgTAP fixtures with original owner, recipient with a space, recipient without a space, ordered links (including tied positions), and an empty source. Follow the role/JWT setup in `supabase/tests/live_collection_sharing.test.sql`.
- [ ] Assert missing RPCs fail before implementing. Initial contract assertion:

```sql
select has_function('public', 'save_shared_collection', array['text'],
  'authenticated save RPC exists');
select has_function('public', 'get_shared_collection_save_state', array['text'],
  'recipient save status RPC exists');
```

- [ ] Create the provenance table with RLS, owner-only SELECT, and no direct client INSERT/UPDATE/DELETE grants:

```sql
create table public.collection_saved_copies (
  user_id uuid not null references auth.users(id) on delete cascade,
  source_collection_id uuid not null,
  saved_collection_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, source_collection_id),
  unique (saved_collection_id),
  foreign key (saved_collection_id, user_id)
    references public.collections(id, user_id) on delete cascade
);
```

Do not add a source foreign key: source deletion must not delete a saved collection or invalidate its ownership. Deleting the recipient collection cascades only its provenance row. Provenance rows contain no active share tokens and are not part of public snapshots.

- [ ] Implement both functions with `security definer`, fixed `search_path = pg_catalog, public`, explicit authentication checks, PUBLIC/anon execute revoked, and authenticated execute granted. The read RPC returns unavailable for invalid/missing tokens, owned for source owners, saved for an existing mapping joined to its current recipient collection, otherwise available. It writes nothing.
- [ ] Implement the mutation in this order:
  1. Require `auth.uid()`; initialize and lock that recipient’s `workspace_sync_state` row with `FOR UPDATE`, matching existing sync serialization.
  2. Resolve an active token to its collection, checking the owner join. Lock the share row `FOR SHARE` to serialize revocation/regeneration. Return own collection without creating a mapping when the caller owns it.
  3. Look up provenance by `(auth.uid(), source_collection_id)`. Return the current copy and its current space if present; no mutation/revision increase for a repeat.
  4. Capture name and ordered links in one SQL statement into an internal JSON snapshot, using the same fields and `(position, created_at, id)` ordering as `load_shared_collection`. This avoids mixing a name from one committed version with links from another.
  5. Choose the first `public.spaces` row belonging to the recipient, or insert the default space. Browser-bookmark pseudo-spaces are stored separately and are not destinations.
  6. Insert a fresh collection at `coalesce(max(position) + 1, 0)`, then fresh links with positions `0..n-1`. Insert provenance and return created with destination IDs. Do not copy any `collection_shares` row.
  7. Keep normal revision triggers enabled; do not toggle `tabloom.merge_in_progress`. Multiple revision increments in one transaction are acceptable; the requirement is a committed revision change, not exactly +1.

Example link insertion shape (internal snapshot uses the public field names):

```sql
insert into public.links(user_id, collection_id, url, title, description,
                         favicon_url, position)
select recipient_id, copied_collection_id,
       item->>'url', item->>'title', item->>'description', null,
       (ordinality - 1)::integer
from jsonb_array_elements(captured_snapshot->'links')
  with ordinality as entries(item, ordinality);
```

Use `28000` for missing authentication and `P0002` with “shared collection unavailable” for invalid/revoked/deleted sources. Transaction rollback must cover space, collection, links, and provenance. Do not catch and swallow database failures.

- [ ] Test exact copied content/order, fresh IDs, private defaults, owner shortcut, repeated calls, empty source, default space, changed tokens, source edits/deletion, copy deletion/resave, moved copy lookup, no other-user reads/writes, and absent anon execute privileges. Assert the recipient revision increases on create and stays unchanged on repeat; verify `load_workspace_snapshot()` contains the copy.
- [ ] Add a gated local integration test making two simultaneous RPC requests as one recipient and assert equal result IDs and one mapping. Add a two-session revocation/save race and require a complete copy or an unavailable error, never partial data. Use an explicitly local Supabase URL and dedicated test identities; skip with an explanation when unavailable.
- [ ] Run `rtk npx supabase test db supabase/tests/save_shared_collection.test.sql` after applying migrations to a disposable local database. Do not reset a remote or valuable database. Run the concurrency test with `rtk npx vitest run tests/integration/save-shared-collection-concurrency.test.ts` and record whether it ran or skipped.
- [ ] Commit the migration and its tests as `feat: save shared collections atomically`.

## Task 2: Typed save adapter and durable sign-in intent

**Files**
- Create `shared/collection-saving.ts` and `tests/collection-saving.test.ts`.
- Create `app/lib/shared-save-intent.ts` and `tests/shared-save-intent.test.ts`.

**Interfaces**

```ts
export interface CollectionSaveRepository {
  getState(token: string): Promise<SharedCollectionSaveState>;
  save(token: string): Promise<SharedCollectionSaveResult>;
}
export class SupabaseCollectionSaveRepository implements CollectionSaveRepository {
  // Constructor accepts Pick<CollectionShareClient, "rpc">.
}
export type PendingSharedSave = {
  token: string;
  nonce: string;
  createdAt: number;
};
export function writePendingSharedSave(storage: Storage, intent: PendingSharedSave): void;
export function readPendingSharedSave(storage: Storage, now: number): PendingSharedSave | null;
export function clearPendingSharedSave(storage: Storage): void;
```

- [ ] Write adapter tests for RPC name/args, every status, malformed data, unauthorized errors, and unavailable errors. Use a mock `rpc` returning `{data, error}`; the core request assertion is:

```ts
expect(rpc).toHaveBeenCalledWith("save_shared_collection", { share_token: token });
expect(result).toEqual({ status: "created", collectionId, spaceId });
```

- [ ] Implement runtime result decoding using the existing `CollectionShareClient` shape. Require valid destination UUIDs for owned/saved/created results; reject unknown statuses. Export the result types defined in Task 1. Add `CollectionSaveError` with code `"auth-required" | "unavailable" | "failed"`, mapping Postgres error codes without showing raw database messages.
- [ ] Write intent tests: round trip, invalid token, invalid nonce, malformed JSON, future timestamp, age over 30 minutes, removal, and storage failure. Use a namespaced sessionStorage key `tabloom:pending-shared-save:v1`; generate the nonce with `crypto.randomUUID()` at the initiating click. Never put session tokens in this record.
- [ ] Implement the intent functions with a 30-minute expiry. Invalid stored records return null and are removed. Storage access failure must be surfaced so UI can explain it cannot continue the automatic return flow; it must not silently claim to have saved.
- [ ] Run `rtk npx vitest run tests/collection-saving.test.ts tests/shared-save-intent.test.ts` before and after implementation; commit as `feat: add shared collection save client and intent`.

## Task 3: OAuth return and safe resume

**Files**
- Create `app/auth/shared-save/page.tsx` and `app/auth/shared-save/SharedSaveReturn.tsx`.
- Create `tests/shared-save-return.test.tsx`.
- Modify `supabase/config.toml` only to add the new callback paths while preserving current edits.
- Modify `tests/extension-auth-config.test.ts` only if its redirect assertions require the new web callback, preserving current edits.

**Interfaces**

```ts
// Save action from Task 4 persists intent before starting OAuth:
await client.auth.signInWithOAuth({
  provider: "google",
  options: { redirectTo: `${window.location.origin}/auth/shared-save` },
});
// Callback resolves the existing client session, then navigates:
const path = `/s/${encodeURIComponent(intent.token)}?resumeSave=${encodeURIComponent(intent.nonce)}`;
```

- [ ] Test session loading, authenticated return, auth error/cancellation, missing/expired intent, and unmount cleanup. Mock the existing browser client; do not call real Google login in unit tests.
- [ ] Implement a client callback component using `getSupabaseBrowserClient()`, `getSession()`, and `onAuthStateChange()`. Allow Supabase to process the OAuth response before navigating; do not introduce a second authentication implementation. A completed session plus valid pending intent returns to the derived path using replace navigation. A token refresh alone must not initiate a save.
- [ ] On OAuth error, clear the pending intent and show “Sign-in wasn’t completed. Your collection hasn’t been saved.” Link back to the validated share when available. Missing/expired intent shows a workspace link; never derive redirects from an arbitrary `next` URL.
- [ ] Add exact `/auth/shared-save` callbacks for the existing local web origins and production web origin. Document that hosted Supabase Auth must have the matching allowlist entry before rollout; changing the repository config alone does not configure hosted Auth.
- [ ] Run `rtk npx vitest run tests/shared-save-return.test.tsx tests/extension-auth-config.test.ts` and commit as `feat: return shared collection saves after sign-in`.

## Task 4: Shared page action and status states

**Files**
- Create `app/s/[token]/SaveSharedCollectionButton.tsx`.
- Modify `app/s/[token]/SharedCollectionView.tsx`, `app/s/[token]/page.tsx`, and `app/globals.css`.
- Create `tests/save-shared-collection-button.test.tsx`.
- Modify `tests/shared-collection-page.test.tsx` for the added token prop/action.

**Interfaces**

```tsx
<SharedCollectionView snapshot={snapshot} token={token} />
<SaveSharedCollectionButton token={token} />
// Destination URL contract consumed by Task 5:
const href = `/app?collection=${encodeURIComponent(result.collectionId)}`;
```

- [ ] Test signed-out prompt, signed-in save, initial status loading, already saved, source owner, empty collection, pending disable, success, revoked share, network error/retry, unconfigured client, and auth changes. Example interaction assertion:

```tsx
await user.click(screen.getByRole("button", { name: "Save to my collections" }));
await screen.findByText("Saved to your collections");
expect(screen.getByRole("link", { name: "View collection" }))
  .toHaveAttribute("href", `/app?collection=${collectionId}`);
```

- [ ] Implement isolated action state in the new component; use the browser singleton and Task 2 adapter. Subscribe/unsubscribe to auth changes. Reset recipient-specific state on sign-out/account switch and ignore late responses belonging to the previous user/token. Keep the public page usable while this state loads.
- [ ] Implement the explanatory sign-in dialog with keyboard dismissal, focus containment/return, and Google sign-in. Persist pending intent before OAuth; clear it if OAuth initiation fails. Display storage/config failures as actionable errors rather than entering demo mode.
- [ ] Resume only when a signed-in session, current route token, valid stored intent, and `resumeSave` nonce all match. A bare URL query must not trigger a write. Guard repeated effects in the component; rely on database idempotency across reloads/tabs. Clear intent and remove the resume query after confirmed success, owner shortcut, or confirmed unavailability. Retain it for explicit retry on uncertain network failure and avoid an automatic retry loop.
- [ ] For explicit save on an expired session, enter sign-in flow. For generic error expose Retry. For initial getState failure expose Retry status checking; do not mislabel as saved or unauthenticated.
- [ ] Render persistent inline success/status with `role="status"`; errors use `role="alert"`. Add primary Save/secondary Open all styling, visible focus, mobile stacking, and dark-theme coverage. Save remains available for empty collections.
- [ ] Run `rtk npx vitest run tests/save-shared-collection-button.test.tsx tests/shared-collection-page.test.tsx tests/shared-collection-loader.test.ts tests/site-metadata.test.ts`; commit as `feat: save shared collections from public pages`.

## Task 5: Open the saved collection in its current space

**Files**
- Modify `app/app/WorkspaceBootstrap.tsx` and `app/app/WorkspaceClient.tsx`.
- Create `app/app/workspace-collection-target.ts` and `tests/workspace-collection-target.test.ts`.
- Modify `tests/workspace.test.tsx`.

**Interfaces**

```ts
export function readCollectionTarget(search: string): string | null;
// WorkspaceClient receives optional initialCollectionId?: string.
// The visible article has id={`collection-${collection.id}`} and tabIndex={-1}.
```

- [ ] Test UUID query parsing, invalid input, a target in a non-first space, async snapshot loading, moved/deleted target, and no target. Assert selection only after the collection exists in the authenticated workspace snapshot.
- [ ] Read the target client-side during bootstrap and pass it to WorkspaceClient. Once loaded, find the collection in the snapshot, select its actual `space_id`, then scroll/focus its article once. Do not trust a supplied space ID or repeatedly force selection after the user navigates elsewhere.
- [ ] If the target is absent after a successful load, show “This collection is no longer in your workspace.” and allow normal workspace use. Do not treat a load failure as proof of deletion. Reset one-time handling when the repository/account changes.
- [ ] Preserve `/app?collection=...` on ordinary workspace sign-in as well, using a validated UUID to construct the current-origin redirect. This supports success links opened after session expiry without accepting arbitrary redirects.
- [ ] Run `rtk npx vitest run tests/workspace-collection-target.test.ts tests/workspace.test.tsx`; commit as `feat: open saved collection destinations`.

## Task 6: End-to-end acceptance and rollout notes

**Files**
- Create `tests/e2e/collection-saving.spec.ts`.
- Update `docs/superpowers/specs/2026-09-04-live-collection-sharing-design.md` with a short link to this plan and independent-copy behavior.
- Create `docs/shared-collection-saving.md` with behavior, callback configuration, and test setup.

- [ ] Extend the existing live sharing fixture approach to two dedicated users. Add `TABLOOM_E2E_RECIPIENT_EMAIL` and `TABLOOM_E2E_RECIPIENT_PASSWORD` alongside the existing documented `TABLOOM_E2E_*` variables. Authenticate through the test fixture; never put credentials/session values in output. Use a disposable local/staging database, unique fixtures, and cleanup for both users.
- [ ] Browser test: open a public share as recipient, save, verify status and destination, edit the new collection, reload the public share, confirm source unchanged. Change/revoke the source and verify the saved copy remains. Repeat Save and verify a single copy; regenerate a share and verify View saved collection. Check an empty-account recipient and source-owner shortcut.
- [ ] Browser test callback/resume with a controlled test session and pending intent; malformed/missing intent must not write. Separately manually validate the real Google sign-in round trip against the configured Auth allowlist. Do not claim the mocked callback proves the provider integration.
- [ ] Verify the extension’s normal sync cycle receives the copy and pending local changes remain intact. Database snapshot/revision tests prove server compatibility; a browser/extension check proves the end-user flow. No new extension protocol should be necessary.
- [ ] Run the focused browser test:

```sh
rtk npx playwright test tests/e2e/collection-saving.spec.ts --project=chromium
```

- [ ] Run `rtk npm run lint`, `rtk npx tsc --noEmit`, `rtk npm run test:unit`, the Supabase suite on a disposable local database, and `rtk npm run build:all`. `npm run test:supabase` performs a database reset: check the target first. Also run `rtk npm run build:vercel` because the new route must work in the deployed Next.js build. Report environment-blocked or skipped checks accurately.
- [ ] Manually inspect mobile/desktop and light/dark UI, keyboard-only sign-in dialog, and focus at the destination. Ensure public metadata remains unchanged and no auth-dependent content is cached into the public snapshot.
- [ ] Document rollout order: apply migration, configure hosted OAuth callback allowlist, deploy UI, run two-user smoke test. Rollback UI first if needed; saved collections remain ordinary data and must not be deleted by rollback.
- [ ] Commit acceptance coverage and documentation as `test: cover shared collection save journey`.

## Completion checklist

- [ ] Existing public share and Open all behavior still pass.
- [ ] Saved copies are independent, editable, private, correctly ordered, and visible in sync.
- [ ] Authentication returns to the original share and completes only a user-initiated save.
- [ ] Duplicate/retry/race handling is verified at the database boundary.
- [ ] Existing copies survive source revocation/deletion; deleted copies can be explicitly saved again.
- [ ] View collection selects the actual destination, including after a move.
- [ ] Hosted OAuth callback and actual Google round trip are verified before production completion.
- [ ] Validation results distinguish passed, failed, and skipped checks.

## Planning review

The plan covers every accepted behavior and adds explicit defaults for destination, empty collections, deleted copies, and auth resumption. The main implementation risks are concurrency with existing workspace writes and provider callback configuration; Tasks 1 and 3/6 carry direct validation for each. This document changes no application behavior and does not deploy or migrate a database.

## Execution record — 2026-09-09

Implemented on `feat/save-shared-collection`, isolated under `.worktrees/save-shared-collection`. The original checkout's uncommitted configuration/test changes were preserved. The checklist above records the original work breakdown; this execution record is the status summary.

- [x] Task 1: atomic copy/status RPCs, provenance, 53 save-specific SQL assertions, and two live HTTP concurrency tests.
- [x] Task 2: typed adapter, sanitized errors, and expiring validated sign-in intent.
- [x] Task 3: OAuth callback and local allowlist entries; callback success/error/intent tests.
- [x] Task 4: public save action, signed-out dialog, resume, duplicate/owner states, and responsive styling.
- [x] Task 5: destination selection/focus, missing-target behavior, and same-user auth-refresh stability.
- [x] Task 6: four passing live browser scenarios, local concurrency checks, visual/keyboard inspection, independent code reviews, and rollout documentation.
- [ ] Deployment-environment checks: configure hosted allowlist, real Google round trip, and extension pending-edit smoke test. These require the target environment and are documented in `docs/shared-collection-saving.md`; no production deployment was requested.

Implementation adjustments: preserve repository identity across same-user auth refreshes so a deep link does not override later navigation. Fix pre-existing hardcoded revision expectations in the sync SQL test (test only), confirmed failing both before the feature and on a clean tracked schema. Use normal revision triggers as planned; an import can advance the revision more than once in its single transaction.

Verification details and remaining deployment checks are in `docs/shared-collection-saving.md`. All temporary Supabase/app services created for verification were stopped; the existing local database was not reset or persistently migrated.
