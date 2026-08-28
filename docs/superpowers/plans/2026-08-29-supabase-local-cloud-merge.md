# Tabloom Supabase Local-to-Cloud Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Tabloom to Supabase without risking locally saved tabs, using UUID-first merge/deduplication, an explicit confirmation when both sides contain meaningful data, and an atomic server-authoritative merge.

**Architecture:** Keep the extension local-first and place browser persistence, pure merge planning, Supabase transport, and UI orchestration behind separate modules. The browser computes a preview from versioned local and cloud snapshots, but the database RPC validates and recomputes the merge inside one transaction. Repository authority changes from local to cloud only after the RPC returns a canonical cloud snapshot and that snapshot is cached successfully.

**Tech Stack:** TypeScript 5.9, React 19, Vitest/Testing Library, Supabase JS 2, PostgreSQL/PLpgSQL, pgTAP, Chrome/Firefox/Safari extension adapters, Vite/Vinext.

**Spec:** [2026-08-29-supabase-local-cloud-merge-design.md](../specs/2026-08-29-supabase-local-cloud-merge-design.md)

## Global Constraints

- Preserve the existing local-first behavior when Supabase is absent, unavailable, or the user is signed out.
- Never delete or overwrite the local snapshot before a successful, canonical cloud reload and cache write.
- Treat a card UUID as primary identity. Use normalized URL only as a fallback within the same matched space and collection.
- Keep equal URLs in different collections or spaces as distinct cards.
- Never ship a service-role key, OAuth client secret, authenticated session, or dashboard credential.
- Apply each task to the existing dirty worktree without reverting unrelated local-first UI work.
- Run every shell command through `rtk`; use `rtk proxy` for commands that do not have a dedicated RTK wrapper.

---

## File Map

### New files

- `shared/workspace-merge.ts` — pure normalization, meaningful-empty detection, matching, preview, and merge types.
- `shared/workspace-sync-repository.ts` — versioned cloud load and atomic merge RPC client.
- `extension/workspace-cache.ts` — separated local/cloud/sync-state keys and one-time legacy migration.
- `extension/first-sync.ts` — first-sign-in state machine and repository authority transition rules.
- `extension/WorkspaceSyncPrompt.tsx` — destructive-safe confirmation dialog for a meaningful two-sided merge.
- `supabase/migrations/202608290001_workspace_merge.sql` — sync revision table, revision triggers, versioned load RPC, transactional merge RPC.
- `supabase/tests/workspace_merge.test.sql` — pgTAP coverage for isolation, conflicts, rollback, and idempotency.
- `tests/workspace-merge.test.ts` — pure merge rules.
- `tests/workspace-cache.test.ts` — key separation, legacy migration, cross-tab mutation safety.
- `tests/workspace-sync-repository.test.ts` — Supabase RPC adapter contract.
- `tests/first-sync.test.ts` — coordinator decisions and authority switching.
- `tests/workspace-sync-prompt.test.tsx` — confirmation and pending/error UI.
- `tests/extension-first-sync.test.tsx` — signed-in startup and login integration behavior.

### Modified files

- `extension/storage.ts` — use the new storage primitives and serialize mutations against the newest persisted snapshot.
- `extension/src.tsx` — replace immediate cloud swap with the first-sync coordinator and prompt.
- `extension/SyncLoginPrompt.tsx` — report sync-in-progress/pending status without claiming local data is already synced.
- `extension/style.css` — sync prompt and non-blocking status styles.
- `shared/repository.ts` — expose canonical row decoding/helper construction used by versioned cloud loads.
- `package.json` — run every Supabase SQL test and add focused verification commands.
- `.env.example` — document public Supabase browser variables only.
- `README.md` — setup, OAuth callbacks, migration, local-first, merge, and recovery instructions.

---

## Task 1: Add the Pure Workspace Merge Domain

**Files:**

- Create: `shared/workspace-merge.ts`
- Create: `tests/workspace-merge.test.ts`
- Reference: `shared/domain.ts`

**Consumes:** `WorkspaceSnapshot`, `Space`, `Collection`, `SavedLink`, `isSaveableUrl`, and `normalizeUrlForDuplicate` from `shared/domain.ts`.

**Produces:** deterministic merge types/functions usable by browser preview tests and the Supabase adapter.

- [ ] Write failing tests for Unicode/case/whitespace name matching, default-only local emptiness, truly empty cloud detection, UUID matching, scoped URL fallback, UUID collision remapping, metadata precedence, and stable append ordering.

```ts
import { describe, expect, it } from "vitest";
import {
  isEffectivelyEmptyLocalWorkspace,
  normalizeWorkspaceName,
  planWorkspaceMerge,
} from "../shared/workspace-merge";

it("matches UUIDs before scoped normalized URLs", () => {
  const plan = planWorkspaceMerge(localSnapshot, cloudSnapshot, 7);
  expect(plan.summary.matchedLinksById).toBe(1);
  expect(plan.summary.matchedLinksByUrl).toBe(1);
  expect(plan.merged.links).toHaveLength(2);
});

it("does not deduplicate the same URL across collections", () => {
  const plan = planWorkspaceMerge(localAcrossCollections, emptyCloud, 0);
  expect(plan.merged.links).toHaveLength(2);
});
```

- [ ] Run the focused test and confirm it fails because the module does not exist.

```bash
rtk npm test -- --run tests/workspace-merge.test.ts
```

- [ ] Implement the exported contract and keep all functions pure.

```ts
export type VersionedWorkspaceSnapshot = {
  snapshot: WorkspaceSnapshot;
  revision: number;
};

export type WorkspaceIdentityMap = {
  spaces: Record<string, string>;
  collections: Record<string, string>;
  links: Record<string, string>;
};

export type WorkspaceMergeSummary = {
  addedSpaces: number;
  addedCollections: number;
  addedLinks: number;
  matchedSpaces: number;
  matchedCollections: number;
  matchedLinksById: number;
  matchedLinksByUrl: number;
  remappedIds: number;
};

export type WorkspaceMergePlan = {
  expectedRevision: number;
  merged: WorkspaceSnapshot;
  identityMap: WorkspaceIdentityMap;
  summary: WorkspaceMergeSummary;
};

export function normalizeWorkspaceName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function isEffectivelyEmptyLocalWorkspace(snapshot: WorkspaceSnapshot): boolean;
export function isEmptyCloudWorkspace(snapshot: WorkspaceSnapshot): boolean;
export function planWorkspaceMerge(
  local: WorkspaceSnapshot,
  cloud: WorkspaceSnapshot,
  expectedRevision: number,
): WorkspaceMergePlan;
```

Implementation rules inside `planWorkspaceMerge`:

1. Match spaces by UUID, then normalized name.
2. Match collections by UUID, then normalized name within the matched space.
3. Match links by UUID, then normalized URL within the matched collection.
4. Preserve a local UUID when it is valid and unused; generate a UUID only for a collision.
5. Keep the cloud row and cloud position for matches; fill only blank cloud title/description/favicon fields from local data.
6. Append local-only rows after cloud rows, preserving their stable `(position, createdAt, id)` order.
7. Reject non-HTTP(S) local links from the plan and count them in a `skippedUnsupportedLinks` summary field.

- [ ] Run the focused test until green, then the existing domain/repository tests.

```bash
rtk npm test -- --run tests/workspace-merge.test.ts tests/domain.test.ts tests/repository.test.ts
```

- [ ] Commit only this task.

```bash
rtk git add shared/workspace-merge.ts tests/workspace-merge.test.ts
rtk git commit -m "feat: add deterministic workspace merge planner"
```

---

## Task 2: Separate Local, Cloud, and Sync-State Storage

**Files:**

- Create: `extension/workspace-cache.ts`
- Create: `tests/workspace-cache.test.ts`
- Modify: `extension/storage.ts`
- Modify: `tests/local-workspace.test.ts`

**Consumes:** `WorkspaceSnapshot`, current browser storage adapter, and `MemoryWorkspaceRepository`.

**Produces:** explicit local/cloud/sync-state stores and mutation serialization that prevents stale new-tab pages from overwriting one another.

- [ ] Write failing tests for the three key namespaces, one-time legacy migration, sample/demo rejection, per-user cloud caches, lock/reload/mutate/save behavior, and a two-repository stale-write race.

```ts
expect(localKey).toBe("tabloom-local-workspace-v2");
expect(cloudKey("user-a")).toBe("tabloom-cloud-workspace-v1:user-a");
expect(syncStateKey("user-a")).toBe("tabloom-sync-state-v1:user-a");

await Promise.all([
  repositoryA.createCollection(inputA),
  repositoryB.createCollection(inputB),
]);
expect((await repositoryA.load()).collections).toEqual(
  expect.arrayContaining([expect.objectContaining(inputA), expect.objectContaining(inputB)]),
);
```

- [ ] Run the focused tests and confirm the stale-write/new-module failures.

```bash
rtk npm test -- --run tests/workspace-cache.test.ts tests/local-workspace.test.ts
```

- [ ] Implement the storage contract.

```ts
export const LOCAL_WORKSPACE_KEY = "tabloom-local-workspace-v2";
export const LEGACY_WORKSPACE_KEY = "tabloom-workspace-snapshot";
export const cloudWorkspaceKey = (userId: string) =>
  `tabloom-cloud-workspace-v1:${userId}`;
export const syncStateKey = (userId: string) =>
  `tabloom-sync-state-v1:${userId}`;

export type CachedSyncState = {
  status: "local" | "pending" | "synced" | "error";
  revision: number;
  lastSyncedAt?: string;
  error?: string;
};

export interface WorkspaceCache {
  loadLocal(): Promise<WorkspaceSnapshot | null>;
  saveLocal(snapshot: WorkspaceSnapshot): Promise<void>;
  loadCloud(userId: string): Promise<VersionedWorkspaceSnapshot | null>;
  saveCloud(userId: string, value: VersionedWorkspaceSnapshot): Promise<void>;
  loadSyncState(userId: string): Promise<CachedSyncState | null>;
  saveSyncState(userId: string, state: CachedSyncState): Promise<void>;
  migrateLegacyOnce(): Promise<void>;
}
```

Use `navigator.locks.request("tabloom-local-workspace", ...)` when available. Provide an injectable in-process lock fallback for Vitest and browsers without Web Locks. Every local mutation must acquire the lock, reload `LOCAL_WORKSPACE_KEY`, apply one mutation to a fresh `MemoryWorkspaceRepository`, persist the result, and replace the instance snapshot.

The legacy migration must copy only user-created content. It must not promote the known historical sample/demo snapshot; an unchanged bootstrap containing only `My Space` / `My Collection` remains valid local bootstrap data.

- [ ] Run focused and extension storage tests.

```bash
rtk npm test -- --run tests/workspace-cache.test.ts tests/local-workspace.test.ts tests/extension.test.ts
```

- [ ] Commit only the storage files.

```bash
rtk git add extension/workspace-cache.ts extension/storage.ts tests/workspace-cache.test.ts tests/local-workspace.test.ts
rtk git commit -m "feat: make local workspace storage sync-safe"
```

---

## Task 3: Add Revisioned, Transactional Supabase Merge RPCs

**Files:**

- Create: `supabase/migrations/202608290001_workspace_merge.sql`
- Create: `supabase/tests/workspace_merge.test.sql`
- Modify: `package.json`

**Consumes:** existing `spaces`, `collections`, `links`, composite ownership constraints, and RLS from `202608190001_initial_workspace.sql`.

**Produces:** per-user revisions, versioned loading, and one authenticated transaction that validates and applies a merge.

- [ ] Write pgTAP tests first for revision zero, revision bumps, user isolation, stale expected revision, malformed UUIDs, unsupported URLs, cross-owner references, rollback on any invalid row, idempotent retry, and canonical ordering.

```sql
select plan(14);

select lives_ok(
  $$ select public.merge_workspace_snapshot(valid_payload(), 0) $$,
  'first merge succeeds at revision zero'
);

select throws_ok(
  $$ select public.merge_workspace_snapshot(valid_payload(), 0) $$,
  '40001',
  'workspace revision conflict',
  'stale preview is rejected'
);
```

- [ ] Run the database test and confirm it fails before the migration exists.

```bash
rtk npx supabase db reset
rtk npx supabase test db supabase/tests/workspace_merge.test.sql
```

- [ ] Add the revision table and trigger function.

```sql
create table public.workspace_sync_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

alter table public.workspace_sync_state enable row level security;

create policy "users read own workspace revision"
on public.workspace_sync_state for select
using (auth.uid() = user_id);

create or replace function public.bump_workspace_revision()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.workspace_sync_state(user_id, revision, updated_at)
  values (coalesce(new.user_id, old.user_id), 1, now())
  on conflict (user_id) do update
    set revision = workspace_sync_state.revision + 1,
        updated_at = now();
  return coalesce(new, old);
end;
$$;
```

Attach statement-safe triggers to `spaces`, `collections`, and `links`. The merge RPC must suppress intermediate trigger bumps with a transaction-local flag and increment exactly once after a successful merge.

- [ ] Add `load_workspace_snapshot()` returning this stable JSON contract:

```json
{
  "revision": 3,
  "snapshot": {
    "spaces": [],
    "collections": [],
    "links": []
  }
}
```

- [ ] Add `merge_workspace_snapshot(local_snapshot jsonb, expected_revision bigint)` as `security invoker`, with `set search_path = public, pg_temp`. It must:

1. Require `auth.uid()`.
2. Insert the caller's missing state row at revision `0`.
3. Lock that row with `FOR UPDATE` and compare `expected_revision`.
4. Validate top-level arrays, required fields, UUIDs, ownership, and every link protocol before any write.
5. Recompute the same UUID-first/scoped-URL merge rules server-side.
6. Upsert local-only rows, fill only blank cloud metadata, and preserve canonical cloud order.
7. Increment revision once.
8. Return `{ snapshot, revision, identityMap, summary }` from persisted rows.
9. On retry, recognize already-present IDs/URLs and produce no duplicate rows.

- [ ] Revoke public execution and grant only authenticated execution.

```sql
revoke all on function public.load_workspace_snapshot() from public, anon;
revoke all on function public.merge_workspace_snapshot(jsonb, bigint) from public, anon;
grant execute on function public.load_workspace_snapshot() to authenticated;
grant execute on function public.merge_workspace_snapshot(jsonb, bigint) to authenticated;
```

- [ ] Update the Supabase script so both SQL test files run.

```json
"test:supabase": "supabase db reset && supabase test db supabase/tests/*.test.sql"
```

- [ ] Run all database tests twice to verify reset repeatability.

```bash
rtk npm run test:supabase
rtk npm run test:supabase
```

- [ ] Commit the migration and database tests.

```bash
rtk git add supabase/migrations/202608290001_workspace_merge.sql supabase/tests/workspace_merge.test.sql package.json
rtk git commit -m "feat: add transactional workspace merge rpc"
```

---

## Task 4: Add the Versioned Supabase Repository

**Files:**

- Create: `shared/workspace-sync-repository.ts`
- Create: `tests/workspace-sync-repository.test.ts`
- Modify: `shared/repository.ts`

**Consumes:** authenticated Supabase client and database RPC JSON contracts.

**Produces:** a typed boundary that translates RPC errors/results without coupling UI code to PostgREST payloads.

- [ ] Write failing adapter tests for versioned load, merge serialization, canonical decoding, conflict classification (`40001`), authentication expiry, invalid payload, and network failure.

```ts
export type WorkspaceMergeResult = WorkspaceMergePlan & {
  revision: number;
};

export class WorkspaceRevisionConflictError extends Error {}
export class WorkspaceAuthenticationError extends Error {}

export interface WorkspaceSyncRepository {
  loadVersioned(): Promise<VersionedWorkspaceSnapshot>;
  mergeLocal(
    local: WorkspaceSnapshot,
    expectedRevision: number,
  ): Promise<WorkspaceMergeResult>;
}
```

- [ ] Run and confirm red.

```bash
rtk npm test -- --run tests/workspace-sync-repository.test.ts
```

- [ ] Implement `SupabaseWorkspaceSyncRepository` using only `rpc("load_workspace_snapshot")` and `rpc("merge_workspace_snapshot", ...)`. Reuse exported row decoders from `shared/repository.ts`; do not duplicate snake_case conversion.

- [ ] Run repository tests.

```bash
rtk npm test -- --run tests/workspace-sync-repository.test.ts tests/repository.test.ts
```

- [ ] Commit the adapter.

```bash
rtk git add shared/workspace-sync-repository.ts shared/repository.ts tests/workspace-sync-repository.test.ts
rtk git commit -m "feat: add versioned Supabase workspace repository"
```

---

## Task 5: Implement the First-Sign-In Coordinator

**Files:**

- Create: `extension/first-sync.ts`
- Create: `tests/first-sync.test.ts`

**Consumes:** local repository/cache, `WorkspaceSyncRepository`, merge planner, user ID.

**Produces:** an explicit decision and execution state machine; it is the only module allowed to switch active repository authority.

- [ ] Write failing tests for all decision branches:

```ts
export type FirstSyncDecision =
  | { kind: "adopt-cloud"; cloud: VersionedWorkspaceSnapshot }
  | { kind: "auto-import"; preview: WorkspaceMergePlan }
  | { kind: "confirm"; preview: WorkspaceMergePlan };

export type FirstSyncStatus =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "awaiting-confirmation"; preview: WorkspaceMergePlan }
  | { phase: "merging"; preview: WorkspaceMergePlan }
  | { phase: "synced"; revision: number }
  | { phase: "pending"; message: string };
```

Required cases:

- local bootstrap only + populated cloud → adopt cloud without confirmation;
- meaningful local + empty cloud → auto-import without confirmation;
- meaningful local + meaningful cloud → confirmation;
- cancellation → local remains active and sync state becomes pending;
- conflict → reload cloud, recompute preview, and ask again;
- network/auth error → local remains active;
- merge success → cache canonical cloud, mark synced, then switch repository.

- [ ] Run and confirm red.

```bash
rtk npm test -- --run tests/first-sync.test.ts
```

- [ ] Implement a dependency-injected coordinator.

```ts
export class FirstSyncCoordinator {
  constructor(private readonly dependencies: {
    userId: string;
    localRepository: WorkspaceRepository;
    cloudRepository: WorkspaceRepository;
    syncRepository: WorkspaceSyncRepository;
    cache: WorkspaceCache;
    activateCloud: (
      repository: WorkspaceRepository,
      snapshot: WorkspaceSnapshot,
    ) => Promise<void>;
  }) {}

  inspect(): Promise<FirstSyncDecision>;
  confirm(preview: WorkspaceMergePlan): Promise<WorkspaceMergeResult>;
  cancel(): Promise<void>;
}
```

The successful sequence must be exactly: RPC merge → canonical result validation → cloud cache write → sync-state write → active repository switch. Any failure before the final step leaves the local repository active and writes a retryable pending/error state.

- [ ] Run focused tests.

```bash
rtk npm test -- --run tests/first-sync.test.ts tests/local-workspace.test.ts
```

- [ ] Commit the coordinator.

```bash
rtk git add extension/first-sync.ts tests/first-sync.test.ts
rtk git commit -m "feat: coordinate safe first workspace sync"
```

---

## Task 6: Build the Merge Confirmation UI

**Files:**

- Create: `extension/WorkspaceSyncPrompt.tsx`
- Create: `tests/workspace-sync-prompt.test.tsx`
- Modify: `extension/style.css`

**Consumes:** `WorkspaceMergePlan`, confirm/cancel callbacks, busy/error state.

**Produces:** one accessible portal dialog shown only when local and cloud both contain meaningful data.

- [ ] Write failing component tests for summary counts, accessible title/description, confirm, cancel, busy state, error/retry state, Escape behavior, and focus restoration.

```tsx
<WorkspaceSyncPrompt
  plan={plan}
  busy={false}
  error={null}
  onConfirm={onConfirm}
  onCancel={onCancel}
/>
```

Expected copy:

- Title: `Combine local and synced tabs?`
- Body: `Tabloom found saved tabs in this browser and in your synced workspace.`
- Summary: added/matched spaces, collections, links, and skipped unsupported links.
- Primary: `Combine and sync`
- Secondary: `Keep using local`

- [ ] Run and confirm red.

```bash
rtk npm test -- --run tests/workspace-sync-prompt.test.tsx
```

- [ ] Implement the portal dialog with `role="dialog"`, `aria-modal="true"`, initial focus on the safe secondary action, disabled actions while merging, and an inline retryable error. Follow the existing `CreateCollectionPrompt` modal/button geometry.

- [ ] Run prompt and modal regression tests.

```bash
rtk npm test -- --run tests/workspace-sync-prompt.test.tsx tests/create-collection-prompt.test.tsx tests/sync-login-prompt.test.tsx
```

- [ ] Commit the UI.

```bash
rtk git add extension/WorkspaceSyncPrompt.tsx extension/style.css tests/workspace-sync-prompt.test.tsx
rtk git commit -m "feat: confirm two-sided workspace sync"
```

---

## Task 7: Integrate Safe Sync into Extension Startup and Login

**Files:**

- Modify: `extension/src.tsx`
- Modify: `extension/SyncLoginPrompt.tsx`
- Modify: `extension/style.css`
- Create: `tests/extension-first-sync.test.tsx`
- Modify: `tests/sync-login-prompt.test.tsx`

**Consumes:** Supabase session, local repository, cache, sync repository, coordinator, confirmation prompt.

**Produces:** signed-out local use, signed-in safe first sync, retry/pending feedback, and no immediate destructive repository swap.

- [ ] Write failing integration tests for startup with no Supabase config, signed-out startup, cached signed-in startup, the three first-sync decisions, cancellation, merge failure, conflict refresh, and successful authority switch.

- [ ] Run and confirm the existing immediate-cloud-swap behavior fails the new expectations.

```bash
rtk npm test -- --run tests/extension-first-sync.test.tsx tests/sync-login-prompt.test.tsx
```

- [ ] Refactor `extension/src.tsx` so initial rendering always uses the local snapshot first. After session discovery or Google login:

```ts
const decision = await coordinator.inspect();
if (decision.kind === "adopt-cloud") {
  await activateCloudFromCacheAndCanonicalSnapshot(decision.cloud);
} else if (decision.kind === "auto-import") {
  await coordinator.confirm(decision.preview);
} else {
  setWorkspaceSyncPrompt(decision.preview);
}
```

Do not call `setRepository(new SupabaseWorkspaceRepository(...))` before the coordinator completes. Keep every organizer mutation enabled against local storage while sync is pending. The sign-in prompt must say that sign-in enables sync, not that data is already cloud-backed.

- [ ] Add a compact header status/action for `Sync pending` and `Retry sync`; do not block tab saving when sync is unavailable.

- [ ] Run extension component tests and builds for all browser targets.

```bash
rtk npm test -- --run tests/extension-first-sync.test.tsx tests/extension.test.ts tests/current-tabs-sheet.test.tsx tests/extension-collection-rows.test.tsx
rtk npm run build:extension
```

- [ ] Commit the integration.

```bash
rtk git add extension/src.tsx extension/SyncLoginPrompt.tsx extension/style.css tests/extension-first-sync.test.tsx tests/sync-login-prompt.test.tsx
rtk git commit -m "feat: integrate safe local-to-cloud sync"
```

---

## Task 8: Document and Configure the Supabase Project

**Files:**

- Modify: `.env.example`
- Modify: `README.md`
- Reference: `extension/supabase.ts`
- Reference: `app/lib/supabase-browser.ts`
- Reference: `extension/manifests/*.json`

**Consumes:** Supabase project reference `tctjlsvfufzxhauhywsm` and browser-specific redirect URLs produced at runtime.

**Produces:** reproducible local setup without committing secrets.

- [ ] Verify `.gitignore` excludes `.env.local`, extension env files, authenticated Supabase sessions, and generated builds.

- [ ] Keep only public variables in `.env.example`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://tctjlsvfufzxhauhywsm.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=replace-with-project-anon-key
VITE_SUPABASE_URL=https://tctjlsvfufzxhauhywsm.supabase.co
VITE_SUPABASE_ANON_KEY=replace-with-project-anon-key
```

- [ ] Document dashboard setup:

1. Apply all migrations with `supabase db push` after linking project `tctjlsvfufzxhauhywsm`.
2. Enable Google provider and configure its client ID/secret only in Supabase Dashboard.
3. Add hosted callback URL and each unpacked extension's runtime `auth-callback` URL to Supabase redirect allow-list.
4. Copy only the public project URL and anonymous key into ignored local env files.
5. Explain local-only fallback, confirmation rules, `Sync pending`, retries, and how to recover from an auth-expired session.

- [ ] Run a secret-pattern and placeholder scan.

```bash
rtk proxy rg -n "service_role|client_secret|eyJ[A-Za-z0-9_-]{20,}|replace-with" --glob '!node_modules/**' --glob '!dist*/**'
```

The only permitted hit is the explicit `replace-with-project-anon-key` template/documentation text.

- [ ] Commit documentation/configuration.

```bash
rtk git add .env.example README.md
rtk git commit -m "docs: add Supabase sync setup"
```

---

## Task 9: Validate the Live Supabase Project and OAuth Flow

**Files:**

- No committed credential files.
- Generated/ignored: `.env.local`, extension local env, `dist-extension/*`.

**Consumes:** user-authorized Supabase Dashboard access and public anonymous key.

**Produces:** applied schema and a verified browser login/merge path against the real project.

- [ ] Open the project dashboard and verify project status, API URL, Google provider, redirect allow-list, and migration state. Do not expose keys in terminal output or screenshots.

- [ ] Link and push migrations only after the exact project reference is verified.

```bash
rtk npx supabase link --project-ref tctjlsvfufzxhauhywsm
rtk npx supabase db push
```

- [ ] Build Chromium and obtain its exact callback via `chrome.identity.getRedirectURL("auth-callback")`; add that full URL to the Supabase allow-list. Repeat for a Firefox temporary-install identifier if its redirect differs. Safari uses the adapter's configured HTTPS callback.

- [ ] Verify with two test identities:

1. User A cannot read or mutate User B's rows.
2. A meaningful local workspace plus empty cloud imports without a prompt.
3. Meaningful data on both sides shows the summary prompt.
4. Cancelling leaves local mutations working.
5. Confirming merges once and a retry creates no duplicates.
6. Refreshing a second extension window observes the canonical revision/order.

- [ ] Do not commit `.env.local`, access tokens, browser profiles, or Supabase CLI credentials.

---

## Task 10: Full Regression, Build, and Delivery Verification

**Files:** all changed files from Tasks 1–9.

- [ ] Refresh the codebase knowledge graph and inspect change impact.

```bash
# Use codebase-memory index_repository, then detect_changes against HEAD~1.
```

- [ ] Run formatting/lint/type/unit/database/build verification from a clean command invocation.

```bash
rtk npm run lint
rtk npx tsc --noEmit
rtk npm run test:unit
rtk npm run test:supabase
rtk npm run build
rtk npm run build:extension
```

- [ ] Run browser E2E coverage for local startup and bookmarks plus the new first-sync flow.

```bash
rtk npx playwright test tests/e2e/browser-bookmarks.spec.ts --project=chromium
```

- [ ] Verify generated manifests contain only the approved permissions/origins and that Chromium, Firefox, and Safari builds contain no secrets or demo copy.

```bash
rtk proxy rg -n "demo|service_role|client_secret" dist-extension
rtk proxy find dist-extension -maxdepth 2 -name manifest.json -print
```

- [ ] Self-review against every requirement in the design spec:

  - UUID-first and scoped URL fallback;
  - same URL allowed across collections;
  - cloud ordering/metadata precedence;
  - auto-import only when cloud is truly empty;
  - automatic cloud adoption only for default-only local state;
  - confirmation and cancellation behavior;
  - local safety on every failure;
  - revision conflict and canonical reload;
  - atomic transaction, RLS, cross-owner rejection, and idempotency;
  - separated caches and cross-tab-safe local mutations;
  - no committed secrets.

- [ ] Scan implementation files for placeholders and unfinished work.

```bash
rtk proxy rg -n "TODO|FIXME|HACK|placeholder|not implemented" shared extension supabase tests
```

- [ ] Inspect `rtk git status --short` and `rtk git diff --check`; ensure no unrelated user files were added to a task commit.

```bash
rtk git status --short
rtk git diff --check
```

- [ ] If all verification is green, commit final test-only adjustments to the files listed below and push only after the user requests or confirms the push.

```bash
rtk git add tests/workspace-merge.test.ts tests/workspace-cache.test.ts tests/workspace-sync-repository.test.ts tests/first-sync.test.ts tests/workspace-sync-prompt.test.tsx tests/extension-first-sync.test.tsx supabase/tests/workspace_merge.test.sql
rtk git commit -m "test: verify safe workspace synchronization"
```

## Acceptance Evidence

Implementation is complete only when the following evidence exists:

- Unit tests prove UUID-first merge identity, scoped deduplication, ordering, metadata, and empty-state rules.
- Storage tests prove two simultaneously open new-tab pages cannot overwrite one another's local mutations.
- pgTAP proves RLS isolation, cross-owner rejection, stale-revision rejection, rollback, and idempotency.
- Component/integration tests prove automatic import/adoption, confirmation, cancellation, retry, and authority switching.
- Real-project validation proves Google login, local-to-cloud import, two-sided confirmation, and synchronization across extension windows.
- Production web and all three extension builds succeed with no console errors, secrets, or demo copy.
