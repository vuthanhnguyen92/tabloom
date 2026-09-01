# Idempotent Workspace Deletions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cross-browser workspace deletions converge even when a record was already removed without a tombstone, while refreshing remote changes when a browser window regains focus.

**Architecture:** Supabase remains authoritative and records recovery tombstones for missing delete targets. The local rebase layer treats a delete of an entity already absent from the canonical snapshot as completed, providing a safe fallback for legacy servers or data. The extension requests a freshness-limited revision check on both visibility and window focus.

**Tech Stack:** TypeScript, React, Vitest, Supabase PostgreSQL/PLpgSQL, pgTAP, Chrome/Firefox/Safari WebExtensions.

**Spec:** User-approved recommendation in the active Tabloom task.

## Global Constraints

- Preserve local-first storage and never discard create or update operations merely because their target is absent.
- Keep deletion authorization scoped to `auth.uid()` and retain row-level ownership checks.
- Preserve pending operations on network, authentication, timeout, or unexpected server failures.
- Apply the behavior uniformly to spaces, collections, and links.

---

### Task 1: Client stale-delete recovery

**Files:**
- Modify: `shared/workspace-operations.ts`
- Test: `tests/workspace-operations.test.ts`

**Interfaces:**
- Consumes: `rebaseWorkspaceOperations(canonical, tombstones, pending, userId)`
- Produces: a pending list with already-satisfied deletes removed when their target is absent from canonical state.

- [x] Add a failing test proving an absent collection delete is removed from the pending outbox without affecting unrelated operations.
- [x] Run `npx vitest run tests/workspace-operations.test.ts` and confirm the new assertion fails.
- [x] Add an entity-existence check that applies only to `action === "delete"`.
- [x] Run the focused test and confirm it passes.

### Task 2: Server idempotent deletion and recovery tombstones

**Files:**
- Create: `supabase/migrations/202608310002_idempotent_workspace_deletions.sql`
- Modify: `supabase/tests/local_first_workspace_sync.test.sql`

**Interfaces:**
- Consumes: `public.apply_workspace_operations(operations jsonb, expected_revision bigint)`
- Produces: `deleted` outcomes and owner-scoped tombstones for already-missing delete targets.

- [x] Add pgTAP cases for a legacy-missing collection, a mixed missing/existing delete batch, revision changes, tombstones, and user isolation.
- [ ] Run the Supabase test and confirm the legacy-missing delete fails against the current function. Blocked: the local Supabase database container times out during startup.
- [x] Replace the RPC in a forward migration with an early delete-recovery branch after operation validation and existing-tombstone handling.
- [ ] Run the Supabase test and confirm all cases pass. Blocked: the local Supabase database container times out during startup and the CLI has no remote access token.

### Task 3: Browser focus refresh

**Files:**
- Modify: `extension/src.tsx`
- Test: `tests/workspace-sync-lifecycle.test.ts`

**Interfaces:**
- Consumes: `WorkspaceSyncEngine.requestSync("focus")`
- Produces: one freshness-limited revision request when the window regains focus.

- [x] Add a failing lifecycle test that dispatches a window focus event and observes the sync request.
- [x] Register and clean up the `window.focus` listener beside the existing visibility and online listeners.
- [x] Run the focused lifecycle test and confirm it passes.

### Task 4: Verification and packages

**Files:**
- Verify: all files above plus generated `dist-extension/*` builds.

- [x] Run workspace operation, sync engine, transport, and lifecycle unit tests.
- [ ] Run the Supabase pgTAP suite when the local Supabase runtime is available.
- [x] Run cross-browser visual tests and TypeScript checks.
- [x] Build Chromium, Firefox, and Safari extension packages.
- [x] Run `git diff --check` and report any unrelated pre-existing failures separately.
