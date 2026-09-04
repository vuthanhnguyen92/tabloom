# Tabloom Live Collection Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in Tabloom owner publish one revocable, live, read-only URL for a saved-link collection while keeping owner identity and all other workspace data private.

**Architecture:** Add a narrowly scoped Supabase sharing contract beside the existing owner-only workspace tables. Owner controls in `/app` and every extension build use one shared repository and dialog; the public `/s/[token]` route reads only the approved snapshot through an anonymous RPC and is rendered without caching, tracking, or owner context.

**Tech Stack:** TypeScript 5.9, React 19, Next.js 16/Vinext, Supabase/Postgres with RLS and pgTAP, Vitest + Testing Library, Playwright, Vite Manifest V3 extension builds.

**Spec:** `docs/superpowers/specs/2026-09-04-live-collection-sharing-design.md`

## Global Constraints

- Preserve all existing owner-only RLS policies for `spaces`, `collections`, and `links`; anonymous access is allowed only through `load_shared_collection`.
- Never ship or introduce a Supabase service-role key. Both the public loader and browser clients use the anonymous key; authenticated management relies on the user's access token and `auth.uid()`.
- Never expose owner name, email, avatar, space name, device metadata, workspace revision, sync status, or another collection through a share response.
- Treat the URL token as a bearer secret: do not log it, include it in analytics, put it in page metadata, or send it as a referrer.
- Share only ordinary saved-link collections that already exist remotely. Browser-bookmark collections and local-only/failed-sync collections remain unshareable.
- Keep one active token per collection. Enable is idempotent; regenerate invalidates the previous URL; disable and collection deletion revoke access.
- Public pages fetch on navigation/manual reload only. Do not add Realtime, polling, background refresh, or recipient authentication.
- Reuse one owner dialog and repository across `/app`, Chromium, Firefox, and Safari. Do not fork feature logic by browser.
- Follow local-first behavior for workspace content, but do not guess or cache authoritative share state while offline.
- Prefix repository shell commands with `rtk` as required by the project instructions.

---

## File Structure

### Create

- `supabase/migrations/202609040001_live_collection_sharing.sql` — share table, ownership constraints, RLS, token generation, management RPCs, and anonymous snapshot RPC.
- `supabase/tests/live_collection_sharing.test.sql` — two-owner and anonymous-role security/invalidation tests.
- `shared/collection-sharing.ts` — shared types, URL builder, row mapping, repository contract, and authenticated Supabase implementation.
- `shared/CollectionShareDialog.tsx` — internal source-shared owner dialog used directly by web and extension, not exported from the domain-only workspace package.
- `tests/collection-sharing.test.ts` — repository and URL-builder unit tests.
- `tests/collection-share-dialog.test.tsx` — dialog state, confirmation, copy, and error tests.
- `app/lib/shared-collection.ts` — server-only anonymous public snapshot loader.
- `app/s/[token]/page.tsx` — noindex public route and generic unavailable boundary.
- `app/s/[token]/SharedCollectionView.tsx` — recipient cards and Open all behavior.
- `tests/shared-collection-loader.test.ts` — no-store RPC loader and response-validation tests.
- `tests/shared-collection-page.test.tsx` — public page rendering, privacy, and Open all tests.
- `tests/e2e/collection-sharing.spec.ts` — browser acceptance flow against the local Supabase stack.

### Modify

- `shared/package.json` — export only the new `./collection-sharing` domain module; keep UI out of package exports.
- `tests/shared-workspace-package.test.ts` and `tests/mcp/service-config.test.ts` — accept the new domain export while retaining the no-UI package boundary.
- `extension/CollectionRows.tsx` — add Share action for eligible saved collections and launch the shared dialog.
- `extension/src.tsx` — construct/provide the sharing repository, site URL, auth state, and sync eligibility.
- `extension/style.css` — owner dialog and share-action styles shared visually across extension targets.
- `tests/extension-collection-rows.test.tsx` — eligible/ineligible Share action behavior.
- `tests/extension-bootstrap-integration.test.tsx` — signed-in repository wiring and sign-in fallback.
- `app/app/WorkspaceBootstrap.tsx` — create authenticated sharing repository after session bootstrap.
- `app/app/WorkspaceClient.tsx` — expose Share from collection headers and host the shared dialog.
- `app/globals.css` — web owner-dialog and public-page styling with automatic light/dark variables.
- `tests/workspace.test.tsx` — `/app` sharing controls and sync-gating tests.
- `next.config.ts` — response headers for `/s/:path*`.
- `app/privacy/page.tsx` — disclose opt-in bearer-link sharing and revocation semantics.
- `tests/site-metadata.test.ts` and `tests/rendered-html.test.mjs` — shared-route robots/header/privacy assertions.
- `README.md` — document the migration, public URL contract, and release verification.

### Generated by Existing Build Script

- `dist-extension/chromium/**`
- `dist-extension/firefox/**`
- `dist-extension/safari/**`
- `public/downloads/tabloom-chromium.zip`
- `public/downloads/tabloom-firefox.zip`
- `public/downloads/tabloom-safari.zip`

Do not hand-edit generated build output; regenerate it with `npm run build:extension` after source tests pass.

---

## Task 1: Add the Database Sharing Boundary

**Files:**

- Create: `supabase/tests/live_collection_sharing.test.sql`
- Create: `supabase/migrations/202609040001_live_collection_sharing.sql`

- [ ] **Step 1: Write the failing pgTAP contract tests**

Create two users, one space and collection per user, and ordered links. Assert all of the following in one transaction:

```sql
select plan(25);

-- Owner A can enable and read only A's share.
-- Owner B cannot enable, regenerate, disable, or select A's share.
-- anon cannot select collection_shares, collections, or links directly.
-- enable is idempotent and returns the same token.
-- token matches 43-character base64url for 32 random bytes.
-- public loader returns only name + approved ordered link fields.
-- malformed and unknown tokens both return null.
-- regeneration invalidates the old token.
-- disable is idempotent and invalidates the current token.
-- collection deletion cascades and invalidates the URL.

select * from finish();
rollback;
```

Use `set_config('request.jwt.claim.sub', <user-id>, true)` and `set local role authenticated` for owners, then `set local role anon` for public checks. Inspect response keys with `jsonb_object_keys` so an accidental owner/private field fails the test.

- [ ] **Step 2: Run the new test and confirm it fails because the contract does not exist**

Run:

```bash
rtk npm run test:supabase
```

Expected: failure mentioning missing relation `public.collection_shares` or missing function `public.enable_collection_share`.

- [ ] **Step 3: Implement the additive migration**

Create the table with a composite ownership reference and one row per owned collection:

```sql
create table public.collection_shares (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  collection_id uuid not null,
  token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collection_shares_collection_owner_unique unique (collection_id, user_id),
  constraint collection_shares_collection_owner_fkey
    foreign key (collection_id, user_id)
    references public.collections(id, user_id)
    on delete cascade,
  constraint collection_shares_token_shape
    check (token ~ '^[A-Za-z0-9_-]{43}$')
);
```

Enable RLS and add only an owner-select policy. Revoke table privileges from `anon`; grant authenticated owners only the minimum read access needed by `get`.

Generate tokens inside Postgres from 32 cryptographically random bytes, base64url-encode them, and strip padding. Implement the management functions as `security definer` with `set search_path = pg_catalog, public, extensions`, explicit `auth.uid()` ownership checks, and stable typed return columns:

```sql
public.enable_collection_share(target_collection_id uuid)
public.regenerate_collection_share(target_collection_id uuid)
public.disable_collection_share(target_collection_id uuid)
```

For concurrent enable, use `insert ... on conflict (collection_id, user_id) do update set collection_id = excluded.collection_id returning ...` so both callers converge on the active row without rotating the token.

Implement `public.load_shared_collection(share_token text) returns jsonb` as a `security definer`, stable, fixed-search-path function. Reject a malformed token before lookup. Build exactly:

```json
{
  "name": "Collection name",
  "links": [
    {
      "id": "uuid",
      "title": "Title",
      "description": "Optional subtitle",
      "url": "https://example.com",
      "favicon_url": "https://example.com/favicon.ico",
      "position": 0
    }
  ]
}
```

Order links by `position, created_at, id`. Return SQL `null` for every unavailable case. Revoke function execution from `public`, then grant management functions to `authenticated` and the loader to `anon, authenticated` only.

- [ ] **Step 4: Reset the local database and run all pgTAP tests**

Run:

```bash
rtk npm run test:supabase
```

Expected: all existing and new pgTAP suites pass; the reset applies `202609040001_live_collection_sharing.sql` without warnings.

- [ ] **Step 5: Commit the database contract**

```bash
rtk git add supabase/migrations/202609040001_live_collection_sharing.sql supabase/tests/live_collection_sharing.test.sql
rtk git commit -m "feat: add live collection share database contract"
```

---

## Task 2: Add the Shared Sharing Domain and Repository

**Files:**

- Create: `shared/collection-sharing.ts`
- Create: `tests/collection-sharing.test.ts`
- Modify: `shared/package.json`
- Modify: `tests/shared-workspace-package.test.ts`
- Modify: `tests/mcp/service-config.test.ts`

- [ ] **Step 1: Write failing repository and mapping tests**

Cover URL construction, snake-case row mapping, idempotent `get`, all three RPC calls, null reads, and surfaced Supabase errors. Use a small fake client rather than a live network:

```ts
expect(collectionShareUrl("https://tabloom.nickvu.dev/", "abc_123"))
  .toBe("https://tabloom.nickvu.dev/s/abc_123");

await expect(repository.enable(collectionId)).resolves.toEqual({
  collectionId,
  token,
  createdAt,
  updatedAt,
});
```

Assert that the repository calls RPCs with exactly `target_collection_id`, never accepts an arbitrary `user_id`, and never swallows an error.

- [ ] **Step 2: Run the focused test and confirm the module is missing**

Run:

```bash
rtk npx vitest run tests/collection-sharing.test.ts
```

Expected: failure resolving `../shared/collection-sharing`.

- [ ] **Step 3: Implement the types, helpers, and repository**

Define the approved public shapes and a minimal Supabase-like dependency so the shared package does not own auth bootstrap:

```ts
export type CollectionShare = {
  collectionId: string;
  token: string;
  createdAt: string;
  updatedAt: string;
};

export type SharedCollectionSnapshot = {
  name: string;
  links: Array<Pick<SavedLink,
    "id" | "title" | "description" | "url" | "favicon_url" | "position"
  >>;
};

export interface CollectionShareRepository {
  get(collectionId: string): Promise<CollectionShare | null>;
  enable(collectionId: string): Promise<CollectionShare>;
  regenerate(collectionId: string): Promise<CollectionShare>;
  disable(collectionId: string): Promise<void>;
}
```

`get` selects the current authenticated owner's row through RLS. Mutations call only the three management RPCs. Validate returned rows before exposing them to UI. `collectionShareUrl` must preserve the canonical origin and encode the token as one path segment.

Export `./collection-sharing` from `shared/package.json` and update both exact-export assertions. Do not export `CollectionShareDialog` or add React to the domain package dependencies; the two front ends import that source-shared component directly, matching the existing `shared/TabloomMark.tsx` pattern.

- [ ] **Step 4: Run focused and shared-package tests**

Run:

```bash
rtk npx vitest run tests/collection-sharing.test.ts tests/shared-workspace-package.test.ts
```

Expected: both files pass.

- [ ] **Step 5: Commit the shared repository**

```bash
rtk git add shared/collection-sharing.ts shared/package.json tests/collection-sharing.test.ts tests/shared-workspace-package.test.ts tests/mcp/service-config.test.ts
rtk git commit -m "feat: add shared collection sharing repository"
```

---

## Task 3: Build the Reusable Owner Share Dialog

**Files:**

- Create: `shared/CollectionShareDialog.tsx`
- Create: `tests/collection-share-dialog.test.tsx`

- [ ] **Step 1: Write failing component tests for every owner state**

Render the dialog with a fake repository and assert:

- initial loading then unshared state
- Enable sharing transitions to shared state and exposes the derived URL
- Copy link writes through `navigator.clipboard` and calls `onToast` once
- Regenerate opens a confirmation, replaces the URL only after success, and leaves the old URL on failure
- Disable opens a confirmation and returns to unshared only after success
- Escape and Cancel close nested confirmations without mutating
- offline, unauthenticated, local-only, pending-sync, and failed-sync states do not call share RPCs
- failed mutations stay in the dialog with a retryable error
- focus starts inside the dialog and returns to the invoking control on close

Use explicit props instead of importing extension/web auth globals:

```ts
type CollectionShareDialogProps = {
  collection: Collection;
  repository: CollectionShareRepository | null;
  siteUrl: string;
  availability: "ready" | "sign-in-required" | "sync-required" | "offline";
  onRequestSignIn(): void;
  onRequestSyncRetry(): void;
  onToast(message: string): void;
  onClose(): void;
};
```

- [ ] **Step 2: Run the focused component test and confirm the component is missing**

Run:

```bash
rtk npx vitest run tests/collection-share-dialog.test.tsx
```

Expected: failure resolving `../shared/CollectionShareDialog`.

- [ ] **Step 3: Implement the dialog state machine**

Use an actual `<dialog>` or the project's accessible modal pattern. Keep the state explicit:

```ts
type ShareDialogState =
  | { status: "loading" }
  | { status: "unshared" }
  | { status: "shared"; share: CollectionShare }
  | { status: "confirm-regenerate"; share: CollectionShare }
  | { status: "confirm-disable"; share: CollectionShare }
  | { status: "error"; previous: CollectionShare | null; message: string };
```

Disable mutation buttons while a request is in flight. Do not optimistically rotate or disable bearer URLs. Keep the last known working URL visible after failures, and retry the exact failed action. Render sign-in and sync-retry calls to action from `availability`; do not query browser APIs inside the shared component.

- [ ] **Step 4: Run dialog accessibility and behavior tests**

Run:

```bash
rtk npx vitest run tests/collection-share-dialog.test.tsx tests/toast-region.test.tsx tests/sync-login-prompt.test.tsx
```

Expected: all tests pass without React act warnings.

- [ ] **Step 5: Commit the reusable dialog**

```bash
rtk git add shared/CollectionShareDialog.tsx tests/collection-share-dialog.test.tsx
rtk git commit -m "feat: add collection share owner dialog"
```

---

## Task 4: Integrate Sharing into Every Extension Build

**Files:**

- Modify: `extension/CollectionRows.tsx`
- Modify: `extension/src.tsx`
- Modify: `extension/style.css`
- Modify: `tests/extension-collection-rows.test.tsx`
- Modify: `tests/extension-bootstrap-integration.test.tsx`

- [ ] **Step 1: Add failing extension tests**

Extend the collection-row tests to prove:

- an editable saved-link collection has an icon-only Share button with an accessible name
- browser-bookmark/read-only collections do not have Share
- Share controls stop click and drag propagation
- clicking Share opens the shared dialog without collapsing, renaming, moving, or deleting the collection
- a local-only user is routed to the existing sign-in modal
- a signed-in collection with pending/failed synchronization gets the existing Retry path and no management RPC call
- ready signed-in state constructs the repository from the authenticated Supabase client

- [ ] **Step 2: Run the focused tests and confirm the new assertions fail**

Run:

```bash
rtk npx vitest run tests/extension-collection-rows.test.tsx tests/extension-bootstrap-integration.test.tsx
```

Expected: failures because no Share action/dialog wiring exists.

- [ ] **Step 3: Add eligibility and dialog wiring**

Add a narrowly typed share integration to `CollectionRowsProps`, for example:

```ts
share?: {
  repository: CollectionShareRepository | null;
  siteUrl: string;
  availabilityFor(collection: Collection): ShareAvailability;
  onRequestSignIn(): void;
  onRequestSyncRetry(): void;
  onToast(message: string): void;
};
```

Place the Lucide Share icon in the existing absolutely positioned collection action group so it does not consume header-title width. Set `draggable={false}` on the control and stop pointer/click propagation. The extension root obtains `VITE_TABLOOM_WEB_URL`, reuses the current authenticated Supabase client, and passes `null` until a valid session exists.

Use the sync coordinator's current pending/failed state to compute availability. Do not create a share row until the collection exists in the authoritative remote workspace.

- [ ] **Step 4: Add styles and verify all browser targets use the same source**

Style the dialog with the current Poppins tokens, automatic light/dark variables, minimum 44px controls, opaque surfaces, visible focus rings, and the existing three-second toast. Add no target-specific UI CSS.

Run:

```bash
rtk npx vitest run tests/extension-collection-rows.test.tsx tests/extension-bootstrap-integration.test.tsx tests/extension-style-consistency.test.tsx tests/browser-manifests.test.ts
```

Expected: all focused extension tests pass.

- [ ] **Step 5: Commit extension integration**

```bash
rtk git add extension/CollectionRows.tsx extension/src.tsx extension/style.css tests/extension-collection-rows.test.tsx tests/extension-bootstrap-integration.test.tsx
rtk git commit -m "feat: add collection sharing to extension"
```

---

## Task 5: Integrate Sharing into the Web Workspace

**Files:**

- Modify: `app/app/WorkspaceBootstrap.tsx`
- Modify: `app/app/WorkspaceClient.tsx`
- Modify: `app/globals.css`
- Modify: `tests/workspace.test.tsx`

- [ ] **Step 1: Write failing `/app` interaction tests**

Add test cases for the Share icon, dialog opening, authenticated repository wiring, Copy, Regenerate confirmation, Disable confirmation, and mutation errors. Also prove that the control is absent for read-only representations and disabled behind the sync-required state when the selected collection has pending/failed local operations.

- [ ] **Step 2: Run the workspace test and confirm failure**

Run:

```bash
rtk npx vitest run tests/workspace.test.tsx
```

Expected: assertions fail because collection headers do not expose Share.

- [ ] **Step 3: Wire the same repository and dialog into `/app`**

Create `SupabaseCollectionShareRepository` only after `WorkspaceBootstrap` has a valid authenticated client/session. Pass it to `WorkspaceClient` instead of creating another browser client inside a collection row. Reuse `CollectionShareDialog`; only the host adapters for toast, sign-in, and sync retry differ from the extension.

Keep the collection label editable and preserve existing collapse/reorder/delete action layout. The Share button must not reduce the available collection-name width when hidden.

- [ ] **Step 4: Run web workspace and style tests**

Run:

```bash
rtk npx vitest run tests/workspace.test.tsx tests/collection-share-dialog.test.tsx tests/marketing-styles.test.ts
```

Expected: all tests pass in light and dark DOM setups.

- [ ] **Step 5: Commit web owner controls**

```bash
rtk git add app/app/WorkspaceBootstrap.tsx app/app/WorkspaceClient.tsx app/globals.css tests/workspace.test.tsx
rtk git commit -m "feat: add collection sharing to web workspace"
```

---

## Task 6: Add the Server-Only Public Snapshot Loader

**Files:**

- Create: `app/lib/shared-collection.ts`
- Create: `tests/shared-collection-loader.test.ts`

- [ ] **Step 1: Write failing loader tests**

Inject a fetch/client boundary and assert:

- the loader calls only `load_shared_collection` with `share_token`
- it uses `NEXT_PUBLIC_SUPABASE_URL` plus the anonymous key, never a service-role environment variable
- the request is `POST` and `cache: "no-store"`
- valid response data is parsed into `SharedCollectionSnapshot`
- unknown/malformed token `null` is preserved as unavailable
- non-2xx, malformed JSON, extra private fields, invalid URLs, and invalid link rows throw one generic `SharedCollectionUnavailableError`
- thrown errors never contain the supplied token

- [ ] **Step 2: Run the focused loader test and confirm the module is missing**

Run:

```bash
rtk npx vitest run tests/shared-collection-loader.test.ts
```

Expected: failure resolving `../app/lib/shared-collection`.

- [ ] **Step 3: Implement the defensive no-store loader**

Use a server-only function with an injectable fetcher:

```ts
export async function loadSharedCollection(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<SharedCollectionSnapshot | null>;
```

Reject tokens not matching `^[A-Za-z0-9_-]{43}$` before making a request. Call `/rest/v1/rpc/load_shared_collection` with the anonymous `apikey`, JSON body `{ share_token: token }`, and `cache: "no-store"`. Parse an allow-list schema by constructing a new object rather than spreading the response. Reuse the existing `http:`/`https:` URL rule and stable position ordering.

Never log the response, token, or request body. Convert network and parse failures into a token-free generic error for the route.

- [ ] **Step 4: Run loader and URL-domain tests**

Run:

```bash
rtk npx vitest run tests/shared-collection-loader.test.ts tests/domain.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit the public loader**

```bash
rtk git add app/lib/shared-collection.ts tests/shared-collection-loader.test.ts
rtk git commit -m "feat: add public shared collection loader"
```

---

## Task 7: Build the Public Shared Collection Page and Security Headers

**Files:**

- Create: `app/s/[token]/page.tsx`
- Create: `app/s/[token]/SharedCollectionView.tsx`
- Create: `tests/shared-collection-page.test.tsx`
- Modify: `app/globals.css`
- Modify: `next.config.ts`
- Modify: `tests/site-metadata.test.ts`
- Modify: `tests/rendered-html.test.mjs`

- [ ] **Step 1: Write failing public-page and header tests**

Test populated, empty, revoked (`null`), and transient-error rendering. Assert the page contains collection name, count, ordered cards, description-or-hostname subtitle, and no owner/space/sync data. Test that:

- card anchors use their original URL and `rel="noreferrer noopener"`
- Open all opens every safe URL in order
- the existing large-collection threshold asks for confirmation before opening
- cancelled confirmation opens nothing
- metadata is `noindex, nofollow` and omits token/name from Open Graph output
- `/s/:path*` receives `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`
- light and dark rendering is controlled by `prefers-color-scheme`

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
rtk npx vitest run tests/shared-collection-page.test.tsx tests/site-metadata.test.ts
```

Expected: route/component imports fail and shared-route headers are absent.

- [ ] **Step 3: Implement the server route and generic unavailable state**

In `page.tsx`, force dynamic/no-store behavior and use constant metadata:

```ts
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Shared collection | Tabloom",
  robots: { index: false, follow: false },
};
```

Load the token from route params, catch loader failures at the route boundary, and render the same generic unavailable panel for invalid, unknown, revoked, deleted, and transient-failure cases. Do not call `notFound()` because platform error pages may use different caching or metadata.

- [ ] **Step 4: Implement the recipient view and Open all**

Render the Tabloom mark, collection name, count, and existing card visual language without edit/delete/drag/share controls. Use a client-only `SharedCollectionView` for Open all. Extract or reuse the existing unusually-large collection threshold rather than duplicating a different number.

Open all uses `window.open(url, "_blank", "noopener,noreferrer")` after confirmation. It does not request extension permissions and does not attempt tab grouping on the public web page.

- [ ] **Step 5: Add route-scoped security headers and responsive theme styles**

In `next.config.ts`, add headers only for `/s/:path*`:

```ts
{
  source: "/s/:path*",
  headers: [
    { key: "Cache-Control", value: "private, no-store" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Robots-Tag", value: "noindex, nofollow" },
  ],
}
```

Use the established Poppins/font and automatic palette variables in `app/globals.css`. Ensure cards and Open all remain keyboard accessible at mobile widths.

- [ ] **Step 6: Run public-page, metadata, and production-render tests**

Run:

```bash
rtk npx vitest run tests/shared-collection-page.test.tsx tests/site-metadata.test.ts
rtk npm run build:vercel
rtk node --test tests/rendered-html.test.mjs
```

Expected: tests pass, build emits `/s/[token]` as a dynamic route, and rendered HTML contains no private metadata.

- [ ] **Step 7: Commit the recipient experience**

```bash
rtk git add app/s app/globals.css next.config.ts tests/shared-collection-page.test.tsx tests/site-metadata.test.ts tests/rendered-html.test.mjs
rtk git commit -m "feat: add public shared collection page"
```

---

## Task 8: Document Privacy, Add Acceptance Coverage, and Rebuild Packages

**Files:**

- Create: `tests/e2e/collection-sharing.spec.ts`
- Modify: `app/privacy/page.tsx`
- Modify: `README.md`
- Modify: generated extension packages through `npm run build:extension`

- [ ] **Step 1: Write the failing acceptance test**

Using the local Supabase test users and browser context, cover this sequence:

1. Owner enables sharing from the extension.
2. A signed-out context opens the returned `/s/<token>` URL.
3. Owner renames the collection and adds, edits, reorders, and deletes cards.
4. Recipient's unchanged page remains stable; manual reload shows the new canonical state.
5. Open all opens the remaining safe URLs and confirms the large-list warning when applicable.
6. Regeneration makes the original URL unavailable and the replacement work.
7. Disable makes the replacement unavailable.
8. No response or page output contains owner identity, space, device, or sync fields.

- [ ] **Step 2: Run the acceptance test and confirm it fails before final wiring/docs**

Run:

```bash
rtk npx playwright test tests/e2e/collection-sharing.spec.ts --project=chromium
```

Expected: the new scenario initially fails on missing local setup or an incomplete end-to-end transition; fix product code rather than weakening assertions.

- [ ] **Step 3: Update privacy and operator documentation**

State plainly that sharing is off by default, anyone with an enabled URL can view the selected collection without signing in, future synced edits appear on reload, owner identity is not included, and disabling/regenerating revokes old access. Remove or revise the old privacy statement that v1 has no sharing.

Document:

- migration filename and `npm run test:supabase`
- canonical URL shape `https://tabloom.nickvu.dev/s/<token>`
- extension/web eligibility rules
- no-service-role requirement
- release order: database, web, extension packages
- production smoke checks for enable, anonymous read, regenerate, disable, and collection-delete cascade

- [ ] **Step 4: Run the complete verification matrix**

Run:

```bash
rtk npm run lint
rtk npx tsc --noEmit
rtk npm run test:unit
rtk npm run test:supabase
rtk npm run build:vercel
rtk npm run build:extension
rtk npx playwright test tests/e2e/collection-sharing.spec.ts --project=chromium
```

Expected: every command exits 0; Chromium, Firefox, and Safari builds are regenerated; the three public download archives have current timestamps and contain the new shared owner UI.

- [ ] **Step 5: Inspect generated packages without hand-editing them**

Run:

```bash
rtk git status --short
rtk unzip -l public/downloads/tabloom-chromium.zip
rtk unzip -l public/downloads/tabloom-firefox.zip
rtk unzip -l public/downloads/tabloom-safari.zip
```

Expected: only intended source/docs/tests plus build-generated package changes are present; each archive contains a manifest and built assets. Confirm no `.env`, access token, refresh token, service-role key, or authenticated session is present.

- [ ] **Step 6: Commit docs, acceptance coverage, and regenerated packages**

```bash
rtk git add app/privacy/page.tsx README.md tests/e2e/collection-sharing.spec.ts dist-extension public/downloads
rtk git commit -m "docs: finalize live collection sharing release"
```

---

## Task 9: Production Rollout and Smoke Verification

**Files:** None unless verification exposes a defect.

- [ ] **Step 1: Apply the migration before deploying UI**

Run the project's established linked-project workflow for Supabase and verify migration history shows `202609040001`. Do not expose Share in production before all four RPCs exist.

- [ ] **Step 2: Deploy the web application**

Deploy the commit containing `/s/[token]`, owner web controls, privacy text, and security headers to the Vercel project serving `https://tabloom.nickvu.dev`.

- [ ] **Step 3: Verify the production HTTP contract**

With a newly enabled test share, verify:

```bash
rtk curl -I "https://tabloom.nickvu.dev/s/${TABLOOM_SHARE_TOKEN}"
```

Expected headers include `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`. Do not paste the real token into committed logs or documentation.

- [ ] **Step 4: Run the production user flow**

Confirm a signed-in owner can enable and copy a share from `/app` and the Chromium extension; a signed-out browser can read it; a reload reflects a synced edit; regeneration and disabling invalidate the old URLs immediately; deleting a shared collection also revokes it.

- [ ] **Step 5: Publish the rebuilt extension downloads**

Confirm `tabloom.nickvu.dev` serves the current Chromium, Firefox, and Safari packages and the landing-page browser detection still selects the correct archive. Store/package submission remains outside this feature.

- [ ] **Step 6: Final repository check**

Run:

```bash
rtk git status --short --branch
rtk git log --oneline -10
```

Expected: clean worktree on the intended branch with the task commits visible. Push or merge only when explicitly requested.

---

## Plan Self-Review Checklist

- [ ] Every requirement in the approved design has an implementation step and a test.
- [ ] Database tests prove anonymous callers cannot bypass the snapshot RPC or infer another collection.
- [ ] Enable, regenerate, disable, deletion cascade, concurrency, and idempotency semantics are explicit.
- [ ] Public output is allow-listed and contains no owner, space, device, revision, or sync fields.
- [ ] Owner UX is shared across web and all extension targets, including sign-in/sync gating and retryable failures.
- [ ] Public routing specifies no-store, no-referrer, noindex/nofollow, safe links, generic failure, empty state, and Open all.
- [ ] No task introduces a service-role secret, token logging, polling, analytics, recipient login, or browser-specific fork.
- [ ] Release order prevents UI deployment before the database contract.
- [ ] Commands cover unit, component, pgTAP, E2E, web production, and all extension builds.
- [ ] The plan contains no unresolved markers, vague placeholders, or open product decisions.
