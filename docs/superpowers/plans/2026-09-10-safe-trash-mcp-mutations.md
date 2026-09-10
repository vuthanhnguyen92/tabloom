# Safe Trash and MCP Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authenticated, recoverable MCP CRUD for Tabloom spaces, collections, and saved links, with server-enforced confirmation for space and collection deletion.

**Architecture:** Supabase owns the authoritative Trash ledger, confirmation intents, atomic delete/restore functions, workspace revision changes, and RLS. A focused MCP command service uses the request-scoped user Supabase client and exposes typed tools; mutations are ID-based, idempotent, concurrency-aware, and feature-flagged.

**Tech Stack:** TypeScript, Next.js route handlers, `mcp-handler`, MCP TypeScript SDK, Zod, Supabase/PostgreSQL, Vitest, pgTAP.

**Spec:** `docs/superpowers/specs/2026-09-10-shared-web-workspace-safe-mcp-mutations-design.md`

## Global Constraints

- Space and collection deletion requires a fresh, single-use, 10-minute confirmation intent.
- Saved-link deletion is immediate but creates a recoverable 30-day Trash entry.
- Every supported deletion source creates a Trash entry; direct authenticated table deletes are removed after callers migrate.
- Restore preserves stable IDs and ordering, or returns `destination_required` when the original parent no longer exists.
- Only `http:` and `https:` links are writable.
- Browser-bookmark records are read-only.
- MCP sees only synchronized Supabase data and always runs with the authenticated user's token; no user mutation uses the service-role key.
- RLS and composite ownership constraints remain authoritative.
- MCP mutation release is controlled by `TABLOOM_MCP_MUTATIONS_ENABLED`.

---

### Task 1: Define Trash and mutation result contracts

**Files:**
- Create: `shared/trash.ts`
- Test: `tests/trash.test.ts`

**Interfaces:**
- Consumes: `Space`, `Collection`, `SavedLink`, and `WorkspaceSnapshot` from `shared/domain.ts`.
- Produces: `TrashRootType`, `TrashSource`, `WorkspaceTrashEntry`, `TrashSnapshot`, `DeleteReceipt`, `DeleteIntent`, `RestoreDestination`, `WorkspaceCommandError`, and strict decoder functions.

- [ ] **Step 1: Write failing decoder and error tests**

```ts
import { describe, expect, it } from "vitest";
import {
  decodeDeleteIntent,
  decodeDeleteReceipt,
  decodeTrashEntry,
  WorkspaceCommandError,
} from "../shared/trash";

describe("workspace trash contracts", () => {
  it("decodes a recoverable deletion receipt", () => {
    expect(decodeDeleteReceipt({
      operationId: "4e5d908c-bfa2-4fe6-98c8-b178a7780209",
      trashId: "3b6319a8-72fd-4450-aa0c-ff84672b72d5",
      rootType: "link",
      rootId: "ab689af8-7d93-4aab-9f56-a0c3b4a5b133",
      restoreUntil: "2026-10-10T00:00:00.000Z",
    })).toMatchObject({ rootType: "link" });
  });

  it("rejects malformed or expired intent payloads", () => {
    expect(() => decodeDeleteIntent({ intentId: "bad" })).toThrow("invalid delete intent");
  });

  it("rejects snapshots without a versioned root", () => {
    expect(() => decodeTrashEntry({ id: crypto.randomUUID(), snapshot: {} }))
      .toThrow("invalid trash entry");
  });

  it("carries stable machine-readable command errors", () => {
    const error = new WorkspaceCommandError("conflict", "The record changed.", { currentUpdatedAt: "2026-09-10T00:00:00Z" });
    expect(error.code).toBe("conflict");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run tests/trash.test.ts`

Expected: FAIL because `shared/trash.ts` does not exist.

- [ ] **Step 3: Implement strict shared contracts**

```ts
export type TrashRootType = "space" | "collection" | "link";
export type TrashSource = "web" | "extension" | "mcp";
export type WorkspaceCommandErrorCode =
  | "not_found" | "read_only" | "conflict" | "confirmation_required"
  | "confirmation_expired" | "destination_required" | "validation_failed";

export type TrashSnapshot = {
  version: 1;
  rootType: TrashRootType;
  spaces: Space[];
  collections: Collection[];
  links: SavedLink[];
};

export type WorkspaceTrashEntry = {
  id: string;
  rootType: TrashRootType;
  rootId: string;
  rootName: string;
  source: TrashSource;
  deletedAt: string;
  expiresAt: string;
  restoredAt: string | null;
  snapshot: TrashSnapshot;
};

export type DeleteReceipt = {
  operationId: string;
  trashId: string;
  rootType: TrashRootType;
  rootId: string;
  restoreUntil: string;
};

export type DeleteIntent = {
  intentId: string;
  targetType: "space" | "collection";
  targetId: string;
  targetName: string;
  collectionCount: number;
  linkCount: number;
  expiresAt: string;
};

export class WorkspaceCommandError extends Error {
  constructor(
    readonly code: WorkspaceCommandErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) { super(message); }
}
```

Implement decoders with exact-key checks, UUID validation, finite timestamps, supported enum validation, and recursive `TrashSnapshot` validation using the existing domain decoders rather than type assertions.

- [ ] **Step 4: Run contract tests**

Run: `npx vitest run tests/trash.test.ts tests/domain.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contracts**

```bash
git add shared/trash.ts tests/trash.test.ts
git commit -m "feat: define recoverable workspace deletion contracts"
```

### Task 2: Add the authoritative Trash schema and RPCs

**Files:**
- Create: `supabase/migrations/202609100001_workspace_trash.sql`
- Create: `supabase/tests/workspace_trash.test.sql`

**Interfaces:**
- Consumes: existing `spaces`, `collections`, `links`, `workspace_sync_state`, `workspace_tombstones`, and ownership constraints.
- Produces RPCs `list_workspace_trash()`, `prepare_workspace_delete(text, uuid)`, `trash_workspace_entity(text, uuid, text, uuid, uuid)`, `restore_workspace_trash(uuid, uuid)`, and `purge_expired_workspace_trash(integer)`.

- [ ] **Step 1: Write failing pgTAP coverage**

Create two users and assert:

```sql
select plan(18);
select has_table('public', 'workspace_trash');
select has_table('public', 'workspace_delete_intents');
select has_function('public', 'prepare_workspace_delete', array['text', 'uuid']);
select has_function('public', 'trash_workspace_entity', array['text', 'uuid', 'text', 'uuid', 'uuid']);
select has_function('public', 'restore_workspace_trash', array['uuid', 'uuid']);

select set_config('request.jwt.claim.sub', :'owner_id', true);
select lives_ok(
  $$select public.prepare_workspace_delete('collection', :'collection_id'::uuid)$$,
  'owner can prepare collection deletion'
);
select throws_ok(
  $$select public.prepare_workspace_delete('collection', :'other_collection_id'::uuid)$$,
  'P0002', 'workspace collection not found',
  'cross-owner target is indistinguishable from a missing target'
);
```

Cover full space-tree snapshots, single-use intent consumption, 10-minute expiry, target timestamp changes, idempotent operation IDs, link deletion without an intent, alternative restore destinations, stable restored IDs, revision increments, read-only rejection, expired rows, and cross-user isolation. End with `select * from finish();`.

- [ ] **Step 2: Run the database test and verify RED**

Run: `supabase db reset && supabase test db supabase/tests/workspace_trash.test.sql`

Expected: FAIL because the tables and functions do not exist.

- [ ] **Step 3: Create tables, policies, and indexes**

```sql
create table public.workspace_trash (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  root_type text not null check (root_type in ('space', 'collection', 'link')),
  root_id uuid not null,
  root_name text not null,
  snapshot jsonb not null check ((snapshot->>'version')::integer = 1),
  source text not null check (source in ('web', 'extension', 'mcp')),
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  restored_at timestamptz,
  created_operation_id uuid,
  unique (user_id, created_operation_id)
);

create table public.workspace_delete_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('space', 'collection')),
  target_id uuid not null,
  target_updated_at timestamptz not null,
  target_summary jsonb not null,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  consumed_at timestamptz
);
```

Enable RLS. Grant owners SELECT on unexpired Trash rows and their own delete intents. Do not add client INSERT, UPDATE, or DELETE policies. Grant authenticated users only EXECUTE on the public RPCs. Every security-definer function must use `set search_path = public, pg_temp` and derive ownership from `auth.uid()`.

- [ ] **Step 4: Implement atomic delete and restore RPCs**

Use one transaction per function. Build versioned snapshots with `jsonb_build_object`, lock targets with `FOR UPDATE`, validate the optional intent, insert the Trash row with `ON CONFLICT (user_id, created_operation_id)`, create existing tombstones for every deleted descendant, delete the root, increment `workspace_sync_state.revision`, and return camel-case JSON matching `DeleteReceipt`.

Restore by locking the Trash row, validating its expiry and destination, inserting records parent-first with original IDs, removing matching tombstones, normalizing sibling positions, marking `restored_at`, and advancing the revision. Return `destination_required` JSON without mutation when the original parent is missing.

- [ ] **Step 5: Run database tests**

Run: `supabase db reset && supabase test db supabase/tests/workspace_trash.test.sql`

Expected: 18 tests pass.

- [ ] **Step 6: Commit the migration**

```bash
git add supabase/migrations/202609100001_workspace_trash.sql supabase/tests/workspace_trash.test.sql
git commit -m "feat: add transactional workspace trash"
```

### Task 3: Route synchronized and web deletions through Trash

**Files:**
- Create: `supabase/migrations/202609100002_workspace_trash_sync.sql`
- Create: `supabase/operations/workspace_trash_privilege_cutover.sql` (operator-run, outside automatic migrations)
- Modify: `shared/repository.ts`
- Create: `shared/trash-repository.ts`
- Modify: `shared/workspace-sync-repository.ts`
- Modify: `extension/workspace-sync-transport.ts`
- Test: `supabase/tests/local_first_workspace_sync.test.sql`
- Test: `tests/repository.test.ts`
- Test: `tests/workspace-sync-transport.test.ts`

**Interfaces:**
- Consumes: Task 2 RPCs and existing workspace operation envelopes.
- Produces `WorkspaceTrashRepository` and ensures delete operations include Trash receipts while retaining tombstone behavior.

- [ ] **Step 1: Add failing repository and synchronization tests**

```ts
it("deletes a saved link through the recoverable RPC", async () => {
  const { client, calls } = clientWithRpcResult({
    operationId: OPERATION_ID,
    trashId: TRASH_ID,
    rootType: "link",
    rootId: LINK_ID,
    restoreUntil: "2026-10-10T00:00:00Z",
  });
  const repository = new SupabaseTrashRepository(client);
  await expect(repository.deleteEntity("link", LINK_ID, "web", OPERATION_ID))
    .resolves.toMatchObject({ trashId: TRASH_ID });
  expect(calls[0]).toEqual(["trash_workspace_entity", {
    entity_type: "link",
    entity_id: LINK_ID,
    deletion_source: "web",
    operation_id: OPERATION_ID,
    confirmation_intent_id: null,
  }]);
});
```

Add a pgTAP assertion that a delete passed through `apply_workspace_operations` creates one `workspace_trash` row with source `extension`, while an operation retry creates no duplicate.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/repository.test.ts tests/workspace-sync-transport.test.ts && supabase test db supabase/tests/local_first_workspace_sync.test.sql`

Expected: FAIL because `SupabaseTrashRepository` and Trash-aware sync responses do not exist.

- [ ] **Step 3: Add the repository adapter**

```ts
export interface WorkspaceTrashRepository {
  list(): Promise<WorkspaceTrashEntry[]>;
  deleteEntity(
    rootType: TrashRootType,
    rootId: string,
    source: TrashSource,
    operationId: string,
    confirmationIntentId?: string,
  ): Promise<DeleteReceipt>;
  restore(trashId: string, destinationId?: string): Promise<WorkspaceSnapshot>;
}
```

Implement `SupabaseTrashRepository` by calling Task 2 RPCs and decoding every response with Task 1 decoders. Web controllers must call `WorkspaceTrashRepository.deleteEntity` directly so the returned `DeleteReceipt` is explicit and immediately available for Undo. Keep the existing `WorkspaceRepository.deleteSpace`, `deleteCollection`, and `deleteLink` methods only for local/in-memory implementations during migration; do not route authenticated Supabase web deletion through those void-returning methods. Add a regression test proving the web-facing Supabase composition exposes no direct-delete path.

- [ ] **Step 4: Make workspace sync snapshot before strict deletion**

Redefine the public `apply_workspace_operations` wrapper. Before delegating to `apply_workspace_operations_strict`, iterate unapplied root delete operations and create exactly one Trash snapshot per operation ID. The strict function remains responsible for tombstones, deletion, operation recording, and revision advancement, so a failure rolls back both the snapshot and deletion.

Return optional `trashId` and `restoreUntil` fields in delete outcomes. Extend `ApplyOperationsResult` parsing without changing behavior for servers that omit those optional fields during deployment compatibility.

- [ ] **Step 5: Remove direct authenticated delete access**

Keep automatic migrations compatible with the deployed web client. After all synchronized and web clients that call Trash RPCs are deployed and acceptance-tested, run the separate operator cutover SQL to revoke direct table DELETE from `authenticated` and replace permissive delete policies with SELECT/INSERT/UPDATE ownership policies. Require explicit client-readiness attestation and schema/grant preconditions; verify final privileges and rollback the statement on any failed postcheck. Verify creates and updates still use their existing RLS policies, and verify accidental calls to the legacy Supabase delete methods fail closed after cutover. See `docs/mcp-setup.md` for exact commands, stale-client refresh, and compatible rollback targets.

- [ ] **Step 6: Run focused and database tests**

Run: `npx vitest run tests/repository.test.ts tests/workspace-sync-transport.test.ts tests/local-first-repository.test.ts && npm run test:supabase`

Expected: PASS.

- [ ] **Step 7: Commit synchronization integration**

```bash
git add supabase/migrations/202609100002_workspace_trash_sync.sql supabase/tests/local_first_workspace_sync.test.sql shared/repository.ts shared/trash-repository.ts shared/workspace-sync-repository.ts extension/workspace-sync-transport.ts tests/repository.test.ts tests/workspace-sync-transport.test.ts
git commit -m "feat: route workspace deletions through trash"
```

### Task 4: Build the request-scoped MCP workspace command service

**Files:**
- Create: `services/tabloom-mcp/src/workspace/schemas.ts`
- Create: `services/tabloom-mcp/src/workspace/errors.ts`
- Create: `services/tabloom-mcp/src/workspace/repository.ts`
- Create: `services/tabloom-mcp/src/workspace/command-service.ts`
- Test: `tests/mcp/workspace-command-service.test.ts`

**Interfaces:**
- Consumes: `TabloomRequestContext`, shared domain validation, workspace sync RPCs, and Trash RPCs.
- Produces `WorkspaceCommandService` with discovery, create, update, move, reorder, delete-intent, delete, Trash, and restore methods.

- [ ] **Step 1: Write failing discovery and mutation tests**

```ts
it("lists only records returned by the request-scoped RLS client", async () => {
  const service = serviceWith({ spaces: [SPACE], collections: [COLLECTION], links: [LINK] });
  await expect(service.listCollections({ spaceId: SPACE.id }))
    .resolves.toEqual([COLLECTION]);
});

it("rejects stale updates before writing", async () => {
  const service = serviceWith({ spaces: [{ ...SPACE, updated_at: CURRENT_TIME }] });
  await expect(service.updateSpace({
    spaceId: SPACE.id,
    expectedUpdatedAt: OLD_TIME,
    name: "Renamed",
  })).rejects.toMatchObject({ code: "conflict" });
});

it("replays a create idempotency key without duplicating", async () => {
  const service = serviceWithIdempotentResult(SPACE);
  expect(await service.createSpace(CREATE_SPACE)).toEqual(SPACE);
  expect(await service.createSpace(CREATE_SPACE)).toEqual(SPACE);
  expect(workspaceOperationCalls()).toHaveLength(1);
});
```

Cover stable-ID reads, global search, ownership-safe not-found responses, URL validation, read-only rejection, create idempotency, expected timestamps, collection moves, and exact reorder membership.

- [ ] **Step 2: Run command tests and verify RED**

Run: `npx vitest run tests/mcp/workspace-command-service.test.ts`

Expected: FAIL because the workspace command modules do not exist.

- [ ] **Step 3: Implement Zod input schemas and error mapping**

```ts
export const updateCollectionItemSchema = z.object({
  itemId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime(),
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(1000).optional(),
  url: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)).optional(),
}).refine((value) => value.title !== undefined || value.description !== undefined || value.url !== undefined, {
  message: "At least one editable field is required.",
});
```

Define equally strict schemas for every tool. Map Postgres not-found, serialization, RLS, validation, and destination errors into `WorkspaceCommandError` without exposing raw SQL or tokens.

- [ ] **Step 4: Implement request-scoped repository commands**

Use `context.supabase` for every query. Read commands select only required fields and filter browser-bookmark/read-only records. Mutations validate `updated_at`, translate commands into existing workspace operations with the caller's idempotency UUID as `operationId`, and call `apply_workspace_operations` against the current revision. On a revision conflict, reload once, revalidate the record timestamp, and either retry or return `conflict`.

- [ ] **Step 5: Run command-service tests**

Run: `npx vitest run tests/mcp/workspace-command-service.test.ts tests/mcp/request-context.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the command service**

```bash
git add services/tabloom-mcp/src/workspace tests/mcp/workspace-command-service.test.ts
git commit -m "feat: add authenticated MCP workspace commands"
```

### Task 5: Enforce destructive confirmation and recovery in commands

**Files:**
- Modify: `services/tabloom-mcp/src/workspace/command-service.ts`
- Modify: `services/tabloom-mcp/src/workspace/repository.ts`
- Test: `tests/mcp/workspace-command-service.test.ts`

**Interfaces:**
- Consumes: Task 2 confirmation and Trash RPCs.
- Produces `prepareDeleteSpace`, `confirmDeleteSpace`, `prepareDeleteCollection`, `confirmDeleteCollection`, `deleteCollectionItem`, `listTrash`, and `restoreTrashItem`.

- [ ] **Step 1: Add failing confirmation and recovery tests**

```ts
it("requires a prepared intent before deleting a collection", async () => {
  const service = serviceWithCollectionTree(COLLECTION, [LINK]);
  const intent = await service.prepareDeleteCollection({ collectionId: COLLECTION.id });
  expect(intent).toMatchObject({ targetName: COLLECTION.name, linkCount: 1 });
  await expect(service.confirmDeleteCollection({ intentId: intent.intentId }))
    .resolves.toMatchObject({ rootType: "collection", rootId: COLLECTION.id });
});

it("deletes a link immediately and returns recovery metadata", async () => {
  await expect(service.deleteCollectionItem({ itemId: LINK.id, expectedUpdatedAt: LINK.updated_at }))
    .resolves.toMatchObject({ rootType: "link", trashId: expect.any(String) });
});

it("restores into an alternate collection when the original parent is missing", async () => {
  await expect(service.restoreTrashItem({ trashId: TRASH_ID, destinationId: OTHER_COLLECTION.id }))
    .resolves.toMatchObject({ snapshot: { links: [expect.objectContaining({ collection_id: OTHER_COLLECTION.id })] } });
});
```

Also test expiry, replay, target modification, fabricated tokens, cross-owner tokens, restored entries, and missing destinations.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/mcp/workspace-command-service.test.ts`

Expected: FAIL on missing destructive command methods.

- [ ] **Step 3: Implement confirmation and recovery methods**

Preparation calls `prepare_workspace_delete` and returns the exact counts and expiry. Confirmation accepts only the intent ID and source `mcp`; the database validates user, target, expiry, consumption, and fingerprint. Link deletion calls `trash_workspace_entity` without an intent. List and restore decode Task 1 contracts and preserve `destination_required` as structured output.

- [ ] **Step 4: Run command tests**

Run: `npx vitest run tests/mcp/workspace-command-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit destructive command safety**

```bash
git add services/tabloom-mcp/src/workspace tests/mcp/workspace-command-service.test.ts
git commit -m "feat: enforce recoverable MCP deletion flow"
```

### Task 6: Register MCP tools and gate mutations

**Files:**
- Create: `services/tabloom-mcp/src/workspace/tool-result.ts`
- Create: `services/tabloom-mcp/src/workspace/register-tools.ts`
- Modify: `services/tabloom-mcp/src/auth/config.ts`
- Modify: `services/tabloom-mcp/app/api/mcp/route.ts`
- Modify: `.env.example`
- Create: `tests/mcp/workspace-tools.test.ts`
- Modify: `tests/mcp/service-config.test.ts`

**Interfaces:**
- Consumes: `ctx.http?.authInfo.extra.requestContext` and `WorkspaceCommandService`.
- Produces all discovery, mutation, confirmation, and recovery MCP tools with accurate annotations and structured results.

- [ ] **Step 1: Write failing tool registration tests**

```ts
it("always registers discovery tools and gates mutation tools", () => {
  const readOnly = registeredToolNames({ mutationsEnabled: false });
  expect(readOnly).toContain("search_workspace");
  expect(readOnly).not.toContain("create_space");

  const writable = registeredToolNames({ mutationsEnabled: true });
  expect(writable).toEqual(expect.arrayContaining([
    "create_space", "prepare_delete_space", "confirm_delete_space",
    "create_collection", "prepare_delete_collection", "confirm_delete_collection",
    "create_collection_item", "update_collection_item", "delete_collection_item",
    "move_collection_item", "reorder_collection_items", "restore_trash_item",
  ]));
});

it("marks confirmation and delete tools destructive", () => {
  expect(toolDefinition("prepare_delete_collection").annotations.destructiveHint).toBe(false);
  expect(toolDefinition("confirm_delete_collection").annotations.destructiveHint).toBe(true);
  expect(toolDefinition("delete_collection_item").annotations.destructiveHint).toBe(true);
});
```

- [ ] **Step 2: Run tool tests and verify RED**

Run: `npx vitest run tests/mcp/workspace-tools.test.ts tests/mcp/service-config.test.ts`

Expected: FAIL because tool registration and mutation configuration do not exist.

- [ ] **Step 3: Implement result and context helpers**

```ts
export function toolResult<T extends Record<string, unknown>>(summary: string, value: T) {
  return {
    content: [{ type: "text" as const, text: summary }],
    structuredContent: value,
  };
}

export function requireWorkspaceContext(authInfo: AuthInfo | undefined): TabloomRequestContext {
  const context = (authInfo as VerifiedFacadeAuthInfo | undefined)?.extra?.requestContext;
  if (!context) throw new WorkspaceCommandError("validation_failed", "Authentication context is unavailable.");
  return context;
}
```

Convert known command errors into non-secret structured tool errors. Attach a generated correlation ID to unexpected failures and log only action, target type, target ID, authenticated user ID, client ID, and outcome.

- [ ] **Step 4: Register the tools**

Register schemas from Task 4. Every callback obtains `ctx.http?.authInfo`, constructs a request-scoped command service, invokes one method, and returns a concise summary plus JSON. Prepare-delete summaries must explicitly instruct the host to ask for user confirmation before calling the confirmation tool.

Set annotations deliberately: discovery and prepare tools are non-destructive; confirmation and link deletion are destructive; retry-safe tools are idempotent; all workspace tools are closed-world.

- [ ] **Step 5: Add and parse the feature flag**

```env
TABLOOM_MCP_MUTATIONS_ENABLED=false
```

Parse only literal `true` as enabled. Keep `get_service_status` and discovery tools available when false. Add `mutationsEnabled` to service status without exposing configuration values.

- [ ] **Step 6: Run MCP tests and builds**

Run: `npx vitest run tests/mcp/workspace-tools.test.ts tests/mcp/service-config.test.ts tests/mcp/auth.test.ts && npm --prefix services/tabloom-mcp run type-check && npm --prefix services/tabloom-mcp run build`

Expected: PASS.

- [ ] **Step 7: Commit tool registration**

```bash
git add services/tabloom-mcp/src/workspace services/tabloom-mcp/src/auth/config.ts services/tabloom-mcp/app/api/mcp/route.ts .env.example tests/mcp/workspace-tools.test.ts tests/mcp/service-config.test.ts
git commit -m "feat: expose safe workspace mutations over MCP"
```

### Task 7: Document, verify, and deploy the MCP/data release

**Files:**
- Modify: `docs/mcp-setup.md`
- Create: `docs/mcp-workspace-tools.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed database and MCP contracts.
- Produces operator setup, tool examples, confirmation behavior, recovery guidance, and rollback instructions.

- [ ] **Step 1: Add documentation assertions**

Extend the existing documentation tests or add `tests/mcp/workspace-docs.test.ts` to assert that active docs contain `https://tabloom.nickvu.dev/mcp`, the mutation flag, the prepare/confirm sequence, 30-day recovery, and no retired MCP domain.

- [ ] **Step 2: Run the documentation test and verify RED**

Run: `npx vitest run tests/mcp/workspace-docs.test.ts`

Expected: FAIL until documentation is updated.

- [ ] **Step 3: Document exact operational flows**

Include JSON examples for creating a collection, updating with `expectedUpdatedAt`, preparing and confirming deletion, immediate link deletion, listing Trash, restoring to the original parent, and supplying an alternate destination. Document that device-local unsynced data is unavailable to MCP.

- [ ] **Step 4: Run full verification**

Run: `npm run lint && npx tsc --noEmit && npm run test:unit && npm run test:supabase && npm --prefix services/tabloom-mcp run build`

Expected: all commands pass with no console errors.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/mcp-setup.md docs/mcp-workspace-tools.md README.md tests/mcp/workspace-docs.test.ts
git commit -m "docs: document Tabloom workspace MCP tools"
```

- [ ] **Step 6: Deploy behind the disabled mutation flag**

Apply migrations to project `tctjlsvfufzxhauhywsm`, deploy the MCP service with `TABLOOM_MCP_MUTATIONS_ENABLED=false`, and run authenticated read-tool probes plus two-user RLS probes. Record no tokens or raw authorization headers.

- [ ] **Step 7: Enable mutations after acceptance**

Deploy the compatible web/MCP clients first, run the explicit operator privilege cutover and postchecks, then set `TABLOOM_MCP_MUTATIONS_ENABLED=true`, redeploy, and verify create, stale-update conflict, prepare/confirm collection deletion, link deletion, Trash listing, restore, and revocation through `https://tabloom.nickvu.dev/mcp`. Production execution remains deferred until the full release is approved.
