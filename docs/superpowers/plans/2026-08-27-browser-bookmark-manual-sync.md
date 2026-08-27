# Manual Browser Bookmark Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manually synchronized, multi-device `Browser Bookmarks` system space to the Tabloom Chrome extension and web app without allowing Tabloom to mutate Chrome bookmarks.

**Architecture:** Chrome tree reading and permission handling live behind an extension-only adapter. A staged Supabase snapshot protocol stores one active generation per browser installation; shared domain code merges active generations into deterministic read-only organizer records, and a composite repository appends them to the normal workspace. Existing mutation repositories remain authoritative for normal Tabloom data.

**Tech Stack:** TypeScript 5.9, React 19, Vinext, Vite 8, Chrome Manifest V3 APIs, Supabase JS 2, PostgreSQL migrations/RPCs/RLS, Vitest, Testing Library, pgTAP/Supabase CLI, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-08-27-browser-bookmark-manual-sync-design.md`

## Global Constraints

- Synchronization is manual and can only be initiated from the Chrome extension.
- `bookmarks` must remain an optional Chrome permission requested directly from the sync action with `chrome.permissions.request()`.
- Upload only `http:` and `https:` bookmarks; report unsupported entries without failing valid entries.
- Strip the visible `Bookmarks bar` and `Other bookmarks` path prefixes; direct children use `Unfiled bookmarks`.
- Keep Chrome bookmarks authoritative and bookmark-origin organizer records read-only.
- Keep existing `spaces`, `collections`, and `links` persistence unchanged.
- Preserve the previous active generation and local cache after every failed or conflicting sync.
- Enforce `auth.uid() = user_id` RLS and composite ownership constraints on all new tables.
- Never ship a service-role key, OAuth client secret, or authenticated test session.
- Use Poppins and the existing Tabloom dark/light design system; do not add Toby trademarks or assets.

## File Structure

### New files

- `supabase/migrations/202608270001_browser_bookmark_sync.sql` — bookmark source/run/entry tables, RLS, indexes, and staged-sync RPCs.
- `supabase/tests/browser_bookmark_sync.test.sql` — pgTAP ownership, isolation, activation, concurrency, and source-forgetting tests.
- `shared/bookmarks.ts` — bookmark types, normalization, merge rules, deterministic IDs, and virtual workspace conversion.
- `shared/bookmark-repository.ts` — Supabase RPC/query adapter and composite workspace repository.
- `extension/bookmarks-api.ts` — optional permission request and Chrome bookmark-tree flattening.
- `extension/bookmark-sync.ts` — device identity, staged batch orchestration, result summaries, and cache-safe retry behavior.
- `extension/BrowserBookmarksPanel.tsx` — manual sync, device naming/management, status, and errors.
- `tests/bookmarks-domain.test.ts` — normalization, merge, identity, provenance, and ordering tests.
- `tests/bookmarks-api.test.ts` — permission and Chrome tree-flattening tests.
- `tests/bookmark-repository.test.ts` — RPC adapter and combined-repository tests.
- `tests/bookmark-sync.test.ts` — batching, failure preservation, conflicts, and device identity tests.
- `tests/browser-bookmarks-panel.test.tsx` — extension sync UI tests.
- `tests/e2e/browser-bookmarks.spec.ts` — built-extension/web synchronization smoke coverage.
- `tests/e2e/fixtures/bookmarks.ts` — deterministic Chrome bookmark fixtures.
- `docs/bookmark-sync-setup.md` — migration, OAuth, permission, local test, and manual acceptance setup.

### Modified files

- `shared/domain.ts` — organizer origin/capability metadata and bookmark-aware search.
- `shared/repository.ts` — normal-repository adapter compatibility and safe bookmark copy helper.
- `extension/storage.ts` — versioned cache envelope and persistent random device identity.
- `extension/public/manifest.json` — optional `bookmarks` permission and version bump.
- `extension/src.tsx` — composite loading, system-space navigation, sync panel, and bookmark copy flow.
- `extension/CollectionRows.tsx` — read-only capabilities and bookmark-card drag sources.
- `extension/style.css` — bookmark labels, sync controls, locked collections, and status layout.
- `app/app/WorkspaceBootstrap.tsx` — construct the composite repository for signed-in users.
- `app/app/WorkspaceClient.tsx` — render bookmark system records, block mutations, and support bookmark-to-normal copying.
- `app/globals.css` — web bookmark badges, locked controls, and drop feedback.
- `app/privacy/page.tsx` — disclose manually uploaded bookmark metadata and device sources.
- `.env.example` — document local Supabase/E2E variables without secrets.
- `README.md` — link bookmark setup and test instructions.
- `package.json` / `package-lock.json` — Supabase integration and Playwright scripts/dependency.

---

### Task 1: Staged bookmark persistence and ownership security

**Files:**
- Create: `supabase/migrations/202608270001_browser_bookmark_sync.sql`
- Create: `supabase/tests/browser_bookmark_sync.test.sql`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: authenticated Supabase user identity through `auth.uid()`.
- Produces: RPCs `begin_bookmark_sync(text,text,integer)`, `append_bookmark_sync_batch(uuid,jsonb)`, `finalize_bookmark_sync(uuid)`, `rename_bookmark_source(uuid,text)`, `forget_bookmark_source(uuid)`, and operator-only `cleanup_bookmark_sync_runs(interval)`; active rows readable from `bookmark_sources`, `bookmark_sync_runs`, and `bookmark_entries`.

- [ ] **Step 1: Write failing pgTAP coverage for ownership and atomic activation**

```sql
begin;
select plan(12);

insert into auth.users(id, email)
values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

select lives_ok(
  $$ select public.begin_bookmark_sync('device-a', 'Chrome on macOS', 1) $$,
  'owner can begin a sync'
);
reset role;
select throws_ok(
  $$ insert into public.bookmark_sync_runs(user_id, source_id, generation, status, expected_entry_count)
     values (
       '00000000-0000-0000-0000-00000000000b',
       (select id from public.bookmark_sources where device_key = 'device-a'),
       9, 'staging', 0
     ) $$,
  '23503', null, 'cross-owner source reference is rejected'
);
-- Append/finalize generation 1, fail generation 2 at count mismatch, then prove
-- bookmark_sources.active_run_id still points to generation 1.
select is(
  (select generation from public.bookmark_sync_runs r join public.bookmark_sources s on s.active_run_id = r.id where s.device_key = 'device-a'),
  1::bigint,
  'failed finalization preserves the previous active generation'
);
select * from finish();
rollback;
```

- [ ] **Step 2: Run the database test to verify it fails**

Run: `supabase db reset && supabase test db supabase/tests/browser_bookmark_sync.test.sql`

Expected: FAIL because the bookmark tables and RPCs do not exist.

- [ ] **Step 3: Create the tables, constraints, indexes, RLS, and RPCs**

```sql
create table public.bookmark_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_key text not null check (char_length(device_key) between 16 and 200),
  device_name text not null check (char_length(device_name) between 1 and 80),
  next_generation bigint not null default 0 check (next_generation >= 0),
  active_run_id uuid,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, device_key),
  unique (user_id, id)
);

create table public.bookmark_sync_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null,
  generation bigint not null check (generation > 0),
  status text not null check (status in ('staging','active','superseded','failed','abandoned')),
  expected_entry_count integer not null check (expected_entry_count >= 0),
  entry_count integer not null default 0 check (entry_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, source_id, id),
  unique (source_id, generation),
  foreign key (user_id, source_id) references public.bookmark_sources(user_id, id) on delete cascade
);

create table public.bookmark_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null,
  run_id uuid not null,
  chrome_bookmark_id text not null,
  url text not null check (url ~ '^https?://'),
  normalized_url text not null check (normalized_url ~ '^https?://'),
  title text not null check (char_length(title) between 1 and 300),
  folder_path text not null check (char_length(folder_path) between 1 and 1000),
  syncing boolean,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  unique (run_id, chrome_bookmark_id),
  foreign key (user_id, source_id) references public.bookmark_sources(user_id, id) on delete cascade,
  foreign key (user_id, source_id, run_id) references public.bookmark_sync_runs(user_id, source_id, id) on delete cascade
);

alter table public.bookmark_sources add constraint bookmark_sources_active_run_fk
  foreign key (user_id, id, active_run_id)
  references public.bookmark_sync_runs(user_id, source_id, id)
  on delete set null (active_run_id) deferrable initially deferred;
```

Enable RLS and add `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)` policies to all three tables. Define `begin_bookmark_sync` as `returns table(run_id uuid, source_id uuid, generation bigint)`. In it, upsert `(auth.uid(), device_key)`, `select ... for update` the source, mark its prior `staging` runs `abandoned`, increment `next_generation`, and insert the new staging run. Make batch insertion idempotent with `on conflict (run_id, chrome_bookmark_id) do update`. In `finalize_bookmark_sync`, count unique entries, raise SQLSTATE `22000` on a count mismatch, raise `40001` when the run generation is not newer than the active generation, then supersede the old run and switch `active_run_id` in one transaction. Add `cleanup_bookmark_sync_runs(retention interval default interval '7 days')` to delete only unreferenced `superseded`, `failed`, or `abandoned` runs older than the retention period; revoke it from `anon` and `authenticated`.

- [ ] **Step 4: Add the remaining named pgTAP cases and run them passing**

Add assertions for two-user SELECT isolation, batch ownership, unsupported URL rejection, count mismatch, empty snapshot activation, newer-run precedence, source rename, source forgetting, prior-staging abandonment, and cleanup excluding active runs.

Run: `supabase db reset && supabase test db supabase/tests/browser_bookmark_sync.test.sql`

Expected: 12 tests pass with no migration errors.

- [ ] **Step 5: Add the database test script and commit**

```json
{
  "scripts": {
    "test:supabase": "supabase db reset && supabase test db supabase/tests/browser_bookmark_sync.test.sql"
  }
}
```

Run: `npm run test:supabase`

Expected: PASS.

```bash
git add supabase/migrations/202608270001_browser_bookmark_sync.sql supabase/tests/browser_bookmark_sync.test.sql package.json package-lock.json
git commit -m "feat: add staged bookmark snapshot storage"
```

### Task 2: Shared bookmark domain and deterministic merged view

**Files:**
- Create: `shared/bookmarks.ts`
- Create: `tests/bookmarks-domain.test.ts`
- Modify: `shared/domain.ts`
- Modify: `shared/repository.ts`
- Modify: `tests/domain.test.ts`

**Interfaces:**
- Consumes: active bookmark rows shaped as `BookmarkEntryRecord` plus `BookmarkSource`.
- Produces: `normalizeBookmarkUrl(url): string`, `mergeBookmarkEntries(sources, entries): MergedBookmark[]`, `toBookmarkWorkspace(userId, merged): WorkspaceSnapshot`, and organizer fields `origin`/`read_only`/`device_label`.

- [ ] **Step 1: Write failing tests for normalization, merge identity, provenance, and stable ordering**

```ts
it("merges account-synced copies but keeps device-only copies distinct", () => {
  const merged = mergeBookmarkEntries(sources, [
    entry({ source_id: "mac", chrome_bookmark_id: "1", url: "https://EXAMPLE.com:443/docs#top", folder_path: "Work", syncing: true }),
    entry({ source_id: "pc", chrome_bookmark_id: "8", url: "https://example.com/docs#other", folder_path: "Work", syncing: true }),
    entry({ source_id: "mac", chrome_bookmark_id: "2", url: "https://example.com/docs", folder_path: "Personal", syncing: false }),
    entry({ source_id: "pc", chrome_bookmark_id: "9", url: "https://example.com/docs", folder_path: "Personal", syncing: false }),
  ]);
  expect(merged).toHaveLength(3);
  expect(merged[0].source_ids).toEqual(["mac", "pc"]);
  expect(merged.filter((item) => item.device_label?.startsWith("Only on"))).toHaveLength(2);
});

it("creates stable virtual IDs and puts Unfiled first", () => {
  const snapshot = toBookmarkWorkspace("user-1", mergedFixture());
  expect(snapshot.spaces[0]).toMatchObject({ id: "system:browser-bookmarks", origin: "browser-bookmark", read_only: true });
  expect(snapshot.collections.map((item) => item.name)).toEqual(["Unfiled bookmarks", "Work", "Work / Design"]);
});
```

- [ ] **Step 2: Run the domain test to verify it fails**

Run: `npm run test:unit -- tests/bookmarks-domain.test.ts tests/domain.test.ts`

Expected: FAIL because bookmark domain exports and organizer capability fields do not exist.

- [ ] **Step 3: Add exact domain types and pure merge functions**

```ts
export type WorkspaceOrigin = "saved" | "browser-bookmark";
export type WorkspaceCapabilities = { rename: boolean; reorder: boolean; edit: boolean; delete: boolean; acceptDrop: boolean };

export type BookmarkSource = {
  id: string; device_name: string; last_synced_at: string | null;
};

export type BookmarkEntryRecord = {
  id: string; source_id: string; chrome_bookmark_id: string; url: string;
  normalized_url: string; title: string; folder_path: string;
  syncing: boolean | null; position: number;
};

export type BookmarkUploadEntry = Omit<BookmarkEntryRecord, "id" | "source_id">;

export type BookmarkSyncSummary = {
  sourceId: string; generation: number; bookmarkCount: number;
  collectionCount: number; syncedAt: string;
};

export function normalizeBookmarkUrl(raw: string): string {
  const url = new URL(raw);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
  return url.toString();
}
```

Use `normalized_url + "\u0000" + folder_path` for synced identity and `source_id + "\u0000" + chrome_bookmark_id` for device/unknown identity. Select the newest source by `last_synced_at`, then source ID and Chrome ID. Build deterministic FNV-1a IDs prefixed with `bookmark:collection:` and `bookmark:link:`. Add required `origin: "saved" | "browser-bookmark"`, `read_only`, and optional `device_label` to workspace record types. Update `createDemoSnapshot`, `MemoryWorkspaceRepository`, and `SupabaseWorkspaceRepository.load()` so every normal record receives `origin: "saved"` and `read_only: false` before this task is committed.

- [ ] **Step 4: Make search include folder/device metadata and run tests**

```ts
return [link.title, link.url, link.description, link.device_label, collection?.name, space?.name]
  .some((value) => value?.toLocaleLowerCase().includes(query));
```

Run: `npm run test:unit -- tests/bookmarks-domain.test.ts tests/domain.test.ts tests/repository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the shared domain**

```bash
git add shared/bookmarks.ts shared/domain.ts shared/repository.ts tests/bookmarks-domain.test.ts tests/domain.test.ts tests/repository.test.ts
git commit -m "feat: add merged bookmark workspace domain"
```

### Task 3: Supabase bookmark repository and composite workspace loading

**Files:**
- Create: `shared/bookmark-repository.ts`
- Create: `tests/bookmark-repository.test.ts`
- Modify: `shared/repository.ts`

**Interfaces:**
- Consumes: Task 1 RPCs and Task 2 `toBookmarkWorkspace`.
- Produces: `BookmarkRepository`, `SupabaseBookmarkRepository`, `CombinedWorkspaceRepository`, and `copyBookmarkToCollection`.

- [ ] **Step 1: Write failing repository-contract tests**

```ts
it("loads only active generations and appends the virtual system space", async () => {
  const bookmarkRepository = fakeBookmarkRepository({ sources, entries });
  const combined = new CombinedWorkspaceRepository(normalRepository, bookmarkRepository);
  const snapshot = await combined.load();
  expect(snapshot.spaces.at(-1)?.id).toBe("system:browser-bookmarks");
  expect(snapshot.links.at(-1)?.origin).toBe("browser-bookmark");
});

it("delegates normal mutations and copies bookmark metadata", async () => {
  await copyBookmarkToCollection(normalRepository, bookmarkLink, "collection-a");
  expect(normalRepository.createLink).toHaveBeenCalledWith({
    collection_id: "collection-a", title: bookmarkLink.title, url: bookmarkLink.url,
    description: "", favicon_url: bookmarkLink.favicon_url,
  });
});
```

- [ ] **Step 2: Run the repository tests to verify they fail**

Run: `npm run test:unit -- tests/bookmark-repository.test.ts`

Expected: FAIL because the repository classes are absent.

- [ ] **Step 3: Implement the repository contracts and exact RPC payloads**

```ts
export interface BookmarkRepository {
  beginSync(deviceKey: string, deviceName: string, expectedEntryCount: number): Promise<{ runId: string; generation: number }>;
  appendBatch(runId: string, entries: BookmarkUploadEntry[]): Promise<void>;
  finalizeSync(runId: string): Promise<BookmarkSyncSummary>;
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  listSources(): Promise<BookmarkSource[]>;
  renameSource(sourceId: string, deviceName: string): Promise<void>;
  forgetSource(sourceId: string): Promise<void>;
}

export class CombinedWorkspaceRepository implements WorkspaceRepository {
  constructor(private normal: WorkspaceRepository, private bookmarks: BookmarkRepository) {}
  async load() {
    const [normal, bookmark] = await Promise.all([this.normal.load(), this.bookmarks.loadWorkspace()]);
    return { spaces: [...normal.spaces, ...bookmark.spaces], collections: [...normal.collections, ...bookmark.collections], links: [...normal.links, ...bookmark.links] };
  }
  createSpace(input: CreateSpaceInput) { return this.normal.createSpace(input); }
  updateSpace(id: string, input: Partial<Pick<Space, "name" | "color">>) { return this.normal.updateSpace(id, input); }
  deleteSpace(id: string) { return this.normal.deleteSpace(id); }
  createCollection(input: CreateCollectionInput) { return this.normal.createCollection(input); }
  updateCollection(id: string, input: Partial<Pick<Collection, "name">>) { return this.normal.updateCollection(id, input); }
  deleteCollection(id: string) { return this.normal.deleteCollection(id); }
  createLink(input: CreateLinkInput) { return this.normal.createLink(input); }
  createLinks(input: CreateLinkInput[]) { return this.normal.createLinks(input); }
  updateLink(id: string, input: Partial<CreateLinkInput>) { return this.normal.updateLink(id, input); }
  deleteLink(id: string) { return this.normal.deleteLink(id); }
  reorderCollections(spaceId: string, orderedIds: string[]) { return this.normal.reorderCollections(spaceId, orderedIds); }
  reorderLinks(collectionId: string, orderedIds: string[]) { return this.normal.reorderLinks(collectionId, orderedIds); }
}

export function copyBookmarkToCollection(repository: WorkspaceRepository, link: SavedLink, collectionId: string) {
  if (link.origin !== "browser-bookmark") throw new Error("Only browser bookmarks can be copied with this action.");
  return repository.createLink({
    collection_id: collectionId,
    title: link.title,
    url: link.url,
    description: "",
    favicon_url: link.favicon_url,
  });
}
```

`SupabaseBookmarkRepository.loadWorkspace()` must select sources and entries through a query/RPC that joins only `bookmark_sources.active_run_id`; never fetch staging or superseded entries into the client merge.

- [ ] **Step 4: Run repository and existing workspace tests**

Run: `npm run test:unit -- tests/bookmark-repository.test.ts tests/repository.test.ts tests/workspace.test.tsx`

Expected: PASS and normal workspace CRUD remains unchanged.

- [ ] **Step 5: Commit the repository layer**

```bash
git add shared/bookmark-repository.ts shared/repository.ts tests/bookmark-repository.test.ts
git commit -m "feat: add bookmark repository adapters"
```

### Task 4: Optional permission and Chrome tree adapter

**Files:**
- Create: `extension/bookmarks-api.ts`
- Create: `tests/bookmarks-api.test.ts`
- Modify: `extension/public/manifest.json`
- Modify: `tests/extension.test.ts`

**Interfaces:**
- Consumes: `chrome.permissions` and `chrome.bookmarks` minimal interfaces.
- Produces: `FlattenResult`, `requestBookmarksPermission(api): Promise<boolean>`, and `readBrowserBookmarks(api): Promise<FlattenResult>`.

- [ ] **Step 1: Write failing permission and flattening tests**

```ts
it("requests bookmarks only at runtime", async () => {
  const request = vi.fn(async () => true);
  await expect(requestBookmarksPermission({ request })).resolves.toBe(true);
  expect(request).toHaveBeenCalledWith({ permissions: ["bookmarks"] });
});

it("strips Chrome roots and preserves nested paths", async () => {
  const result = await readBrowserBookmarks(fakeBookmarksApi(bookmarkTree));
  expect(result.entries.map((item) => item.folder_path)).toEqual([
    "Unfiled bookmarks", "Work / Design", "Unfiled bookmarks",
  ]);
  expect(result.entries.every((item) => /^https?:/.test(item.url))).toBe(true);
  expect(result.skipped).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test:unit -- tests/bookmarks-api.test.ts tests/extension.test.ts`

Expected: FAIL because the adapter is absent and `bookmarks` is not optional.

- [ ] **Step 3: Implement injected Chrome interfaces and recursive flattening**

```ts
export type BookmarkNode = {
  id: string; title: string; url?: string; index?: number;
  syncing?: boolean; folderType?: string; children?: BookmarkNode[];
};

export type FlattenResult = {
  entries: BookmarkUploadEntry[];
  skipped: number;
  collectionCount: number;
  deviceOnlyCount: number;
};

export async function requestBookmarksPermission(api = chrome.permissions) {
  return api.request({ permissions: ["bookmarks"] });
}

function visit(node: BookmarkNode, path: string[], inheritedSyncing: boolean | null, output: FlattenResult) {
  const syncing = typeof node.syncing === "boolean" ? node.syncing : inheritedSyncing;
  if (node.url) {
    if (!isSaveableUrl(node.url)) { output.skipped += 1; return; }
    output.entries.push({ chrome_bookmark_id: node.id, url: node.url, normalized_url: normalizeBookmarkUrl(node.url), title: node.title || node.url, folder_path: visiblePath(path), syncing, position: node.index ?? output.entries.length });
    return;
  }
  const nextPath = isHiddenRoot(node.folderType, node.title) ? path : [...path, node.title].filter(Boolean);
  node.children?.forEach((child) => visit(child, nextPath, syncing, output));
}
```

Treat `folderType` values for the bookmarks bar and other-bookmarks roots as authoritative, with exact English-title fallback for older Chrome types. Do not hide Mobile or managed roots. Derive `collectionCount` from unique non-empty paths and `deviceOnlyCount` from `syncing !== true`.

- [ ] **Step 4: Add optional permission and run tests**

```json
{
  "permissions": ["tabs", "storage", "identity"],
  "optional_permissions": ["tabGroups", "bookmarks"]
}
```

Run: `npm run test:unit -- tests/bookmarks-api.test.ts tests/extension.test.ts`

Expected: PASS, including a manifest assertion that `bookmarks` is optional and not required.

- [ ] **Step 5: Commit the browser adapter**

```bash
git add extension/bookmarks-api.ts extension/public/manifest.json tests/bookmarks-api.test.ts tests/extension.test.ts
git commit -m "feat: read browser bookmarks on demand"
```

### Task 5: Device identity, batching, activation, and cache safety

**Files:**
- Create: `extension/bookmark-sync.ts`
- Create: `tests/bookmark-sync.test.ts`
- Modify: `extension/storage.ts`
- Modify: `tests/extension.test.ts`

**Interfaces:**
- Consumes: Task 3 `BookmarkRepository`, Task 4 flattened entries, and `chrome.storage.local`.
- Produces: `getOrCreateBookmarkDevice(area): Promise<BookmarkDevice>`, `syncBrowserBookmarks(input): Promise<BookmarkSyncResult>`, and versioned `ChromeSnapshotCache` envelopes.

- [ ] **Step 1: Write failing orchestration and cache-preservation tests**

```ts
it("uploads bounded batches and writes cache only after finalization", async () => {
  const result = await syncBrowserBookmarks({ repository, cache, device, read: async () => fixture(450), batchSize: 200 });
  expect(repository.appendBatch.mock.calls.map((call) => call[1].length)).toEqual([200, 200, 50]);
  expect(repository.finalizeSync).toHaveBeenCalledOnce();
  expect(cache.write).toHaveBeenCalledAfter(repository.finalizeSync);
  expect(result.bookmarkCount).toBe(450);
});

it("leaves the prior cache untouched when finalization fails", async () => {
  repository.finalizeSync.mockRejectedValue(new Error("generation conflict"));
  await expect(syncBrowserBookmarks(input)).rejects.toThrow("generation conflict");
  expect(cache.write).not.toHaveBeenCalled();
  expect(await cache.read()).toEqual(previousEnvelope);
});
```

- [ ] **Step 2: Run sync tests to verify failure**

Run: `npm run test:unit -- tests/bookmark-sync.test.ts tests/extension.test.ts`

Expected: FAIL because device and sync orchestration exports do not exist.

- [ ] **Step 3: Add the versioned cache envelope and persistent random device**

```ts
export type WorkspaceCacheEnvelope = {
  version: 2;
  snapshot: WorkspaceSnapshot;
  bookmarkSources: BookmarkSource[];
  cachedAt: string;
};

export type BookmarkDevice = { key: string; name: string };
export type BookmarkSyncResult = BookmarkSyncSummary & { skipped: number; deviceOnlyCount: number };
export type SyncBrowserBookmarksInput = {
  repository: BookmarkRepository;
  workspace: WorkspaceRepository;
  cache: ChromeSnapshotCache;
  device: BookmarkDevice;
  read: () => Promise<FlattenResult>;
  batchSize: number;
};

export async function getOrCreateBookmarkDevice(area: StorageArea): Promise<BookmarkDevice> {
  const stored = (await area.get(BOOKMARK_DEVICE_KEY))[BOOKMARK_DEVICE_KEY] as BookmarkDevice | undefined;
  if (stored) return stored;
  const device = { key: crypto.randomUUID(), name: suggestedDeviceName(navigator.platform) };
  await area.set({ [BOOKMARK_DEVICE_KEY]: device });
  return device;
}
```

Read legacy snapshot-only cache values and migrate them in memory so existing extension users do not lose offline startup.

Change `ChromeSnapshotCache.read()` to return `WorkspaceCacheEnvelope | null` and `write()` to accept `WorkspaceCacheEnvelope`. Update extension startup reads to use `cached.snapshot`; preserve the envelope's `bookmarkSources` and `cachedAt` for offline status text.

- [ ] **Step 4: Implement staged orchestration and result summaries**

```ts
export async function syncBrowserBookmarks(input: SyncBrowserBookmarksInput): Promise<BookmarkSyncResult> {
  const flattened = await input.read();
  const run = await input.repository.beginSync(input.device.key, input.device.name, flattened.entries.length);
  for (let offset = 0; offset < flattened.entries.length; offset += input.batchSize) {
    await input.repository.appendBatch(run.runId, flattened.entries.slice(offset, offset + input.batchSize));
  }
  const summary = await input.repository.finalizeSync(run.runId);
  const [snapshot, sources] = await Promise.all([input.workspace.load(), input.repository.listSources()]);
  await input.cache.write({ version: 2, snapshot, bookmarkSources: sources, cachedAt: new Date().toISOString() });
  return { ...summary, skipped: flattened.skipped, deviceOnlyCount: flattened.deviceOnlyCount };
}
```

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:unit -- tests/bookmark-sync.test.ts tests/extension.test.ts`

Expected: PASS for 0, 1, 200, 201, and 450-entry batches, Chrome-read failure, begin/append/finalize failure, concurrent-generation conflict, and legacy-cache migration.

```bash
git add extension/bookmark-sync.ts extension/storage.ts tests/bookmark-sync.test.ts tests/extension.test.ts
git commit -m "feat: orchestrate atomic bookmark sync"
```

### Task 6: Read-only organizer capabilities and bookmark drag-copy

**Files:**
- Modify: `extension/CollectionRows.tsx`
- Modify: `tests/extension-collection-rows.test.tsx`
- Modify: `extension/style.css`

**Interfaces:**
- Consumes: bookmark-origin `Space`, `Collection`, and `SavedLink` records from Task 2.
- Produces: `onBookmarkDrop(link: SavedLink, collectionId: string): void | Promise<void>` and locked bookmark collection/card rendering.

- [ ] **Step 1: Write failing component tests for capability boundaries**

```tsx
it("renders bookmarks as drag sources but never as drop targets", async () => {
  renderRows({ collections: [normalCollection, bookmarkCollection], links: [bookmarkLink] });
  expect(screen.getByText("Work / Design").closest("article")).toHaveClass("read-only");
  expect(screen.queryByLabelText("Delete Work / Design")).not.toBeInTheDocument();
  fireEvent.dragStart(screen.getByText(bookmarkLink.title));
  fireEvent.dragOver(screen.getByText(normalCollection.name).closest("article")!);
  expect(screen.getByText(normalCollection.name).closest("article")).toHaveClass("bookmark-drop-target");
  expect(screen.getByText(bookmarkCollection.name).closest("article")).not.toHaveClass("bookmark-drop-target");
});
```

- [ ] **Step 2: Run the component test to verify failure**

Run: `npm run test:unit -- tests/extension-collection-rows.test.tsx`

Expected: FAIL because bookmark drag payloads and read-only controls are not implemented.

- [ ] **Step 3: Add discriminated drag state and capability guards**

```ts
type DraggedItem =
  | { kind: "saved-link"; id: string }
  | { kind: "browser-bookmark"; link: SavedLink }
  | { kind: "collection"; id: string };

const canMutate = collection.origin !== "browser-bookmark" && !collection.read_only;
const canAcceptBookmark = canMutate && dragged?.kind === "browser-bookmark";
```

Add `onBookmarkDrop?: (link: SavedLink, collectionId: string) => void | Promise<void>` to `CollectionRowsProps`. On drop, await it, clear all preview state, and call `onReload`; if it rejects, clear preview state and let the parent display the mutation error.

Render bookmark title, hostname, and device badge at the existing 16px/14px card typography. Hide reorder/delete/edit controls for read-only records, suppress collection drag handles, and call `onBookmarkDrop` only for normal destinations.

- [ ] **Step 4: Run drag, current-tab, and open-all regression tests**

Run: `npm run test:unit -- tests/extension-collection-rows.test.tsx tests/current-tabs-sheet.test.tsx tests/open-collection.test.ts`

Expected: PASS; current-tab dragging continues to preview every normal saved-link destination.

- [ ] **Step 5: Commit organizer behavior**

```bash
git add extension/CollectionRows.tsx extension/style.css tests/extension-collection-rows.test.tsx
git commit -m "feat: add read-only bookmark cards"
```

### Task 7: Extension sync and device-management experience

**Files:**
- Create: `extension/BrowserBookmarksPanel.tsx`
- Create: `tests/browser-bookmarks-panel.test.tsx`
- Modify: `extension/src.tsx`
- Modify: `extension/style.css`

**Interfaces:**
- Consumes: `requestBookmarksPermission`, `syncBrowserBookmarks`, `BookmarkRepository`, device/source records, and composite workspace loading.
- Produces: user-triggered sync, device rename/forget, summary/error messages, and the protected system-space navigation entry.

- [ ] **Step 1: Write failing UI tests for permission, naming, summaries, and failures**

```tsx
it("requests permission directly and syncs after the user names the device", async () => {
  render(<BrowserBookmarksPanel {...props} />);
  await user.click(screen.getByRole("button", { name: "Sync browser bookmarks" }));
  expect(requestPermission).toHaveBeenCalledOnce();
  await user.clear(screen.getByLabelText("Device name"));
  await user.type(screen.getByLabelText("Device name"), "Work Mac");
  await user.click(screen.getByRole("button", { name: "Start sync" }));
  expect(sync).toHaveBeenCalledWith(expect.objectContaining({ device: { key: "device-1", name: "Work Mac" } }));
});

it("does not open the naming dialog after permission denial", async () => {
  requestPermission.mockResolvedValue(false);
  render(<BrowserBookmarksPanel {...props} />);
  await user.click(screen.getByRole("button", { name: "Sync browser bookmarks" }));
  expect(screen.getByText("Bookmark permission was not granted.")).toBeVisible();
  expect(sync).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the panel test to verify failure**

Run: `npm run test:unit -- tests/browser-bookmarks-panel.test.tsx`

Expected: FAIL because the panel is absent.

- [ ] **Step 3: Implement the panel state machine**

```ts
type SyncState =
  | { kind: "idle" }
  | { kind: "naming"; device: BookmarkDevice }
  | { kind: "syncing" }
  | { kind: "success"; result: BookmarkSyncResult }
  | { kind: "error"; message: string };

async function begin() {
  if (!(await requestPermission())) return setState({ kind: "error", message: "Bookmark permission was not granted." });
  setState({ kind: "naming", device: await getDevice() });
}
```

Show counts for collections, bookmarks, device-only/unknown entries, and skipped URLs. Require confirmation for **Forget device**, update the current device name in `chrome.storage.local` after a successful rename, and never clear the current workspace on panel errors.

- [ ] **Step 4: Wire composite repositories and panel into `ExtensionApp`**

```ts
const normal = new SupabaseWorkspaceRepository(extensionSupabase, session.user.id);
const bookmarks = new SupabaseBookmarkRepository(extensionSupabase, session.user.id);
const combined = new CombinedWorkspaceRepository(normal, bookmarks);
setRepository(combined);
setBookmarkRepository(bookmarks);
```

Keep the bookmark repository separately for sync/source operations; use the combined repository's delegated `createLink` through `copyBookmarkToCollection` for copies. Add the `Browser Bookmarks` system space to the sidebar only when the merged snapshot contains it. Pass `onBookmarkDrop` to `CollectionRows`; detect duplicates against links whose `origin === "saved"`, reuse the current duplicate confirmation, then copy and reload.

- [ ] **Step 5: Run extension integration tests and commit**

Run: `npm run test:unit -- tests/browser-bookmarks-panel.test.tsx tests/extension-collection-rows.test.tsx tests/extension.test.ts tests/dropped-tab.test.ts`

Expected: PASS for granted, denied, revoked, offline, auth-expired, sync success, source rename, source forget, and duplicate-copy states.

```bash
git add extension/BrowserBookmarksPanel.tsx extension/src.tsx extension/style.css tests/browser-bookmarks-panel.test.tsx
git commit -m "feat: add manual bookmark sync controls"
```

### Task 8: Web workspace bookmark view and copy behavior

**Files:**
- Modify: `app/app/WorkspaceBootstrap.tsx`
- Modify: `app/app/WorkspaceClient.tsx`
- Modify: `app/globals.css`
- Modify: `tests/workspace.test.tsx`

**Interfaces:**
- Consumes: `CombinedWorkspaceRepository` and organizer capability metadata.
- Produces: read-only `Browser Bookmarks` web space with search, open-all, and bookmark-to-normal copy.

- [ ] **Step 1: Write failing web workspace tests**

```tsx
it("shows browser bookmarks without mutation controls", async () => {
  render(<WorkspaceClient repository={combinedRepository} mode="synced" initialSnapshot={combinedSnapshot} />);
  await user.click(screen.getByRole("button", { name: /Browser Bookmarks/ }));
  expect(screen.getByText("Only on Work Mac")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Delete Work/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /New collection/ })).not.toBeInTheDocument();
});

it("copies a bookmark into a normal collection without mutating its source", async () => {
  fireEvent.dragStart(screen.getByText("Chrome docs"));
  fireEvent.drop(screen.getByText("Research").closest("article")!);
  expect(normalRepository.createLink).toHaveBeenCalledWith(expect.objectContaining({ collection_id: "research", url: "https://developer.chrome.com/docs" }));
  expect(bookmarkRepository).not.toHaveProperty("deleteLink");
});
```

- [ ] **Step 2: Run workspace tests to verify failure**

Run: `npm run test:unit -- tests/workspace.test.tsx`

Expected: FAIL because the web bootstrap uses only the normal repository and mutation controls ignore capabilities.

- [ ] **Step 3: Construct the combined repository and guard all mutations**

```ts
const normal = new SupabaseWorkspaceRepository(client, session.user.id);
const bookmarks = new SupabaseBookmarkRepository(client, session.user.id);
setRepository(new CombinedWorkspaceRepository(normal, bookmarks));
```

In `WorkspaceClient`, calculate `const readOnlySpace = selectedSpace.origin === "browser-bookmark" || selectedSpace.read_only`. Hide space/collection mutation controls when true. Use discriminated drag state so saved links reorder while bookmark links copy through `copyBookmarkToCollection`. Reject every drop whose destination has `read_only: true`.

- [ ] **Step 4: Add visual locked/device states and run tests**

```css
.bookmark-badge { font-size: 12px; font-weight: 500; opacity: .78; }
.collection.read-only { border-color: color-mix(in srgb, var(--violet) 28%, var(--line)); }
.collection.bookmark-drop-target { outline: 2px solid var(--coral); outline-offset: 3px; }
```

Run: `npm run test:unit -- tests/workspace.test.tsx tests/domain.test.ts`

Expected: PASS for search by device/folder, open-all warning, read-only controls, normal CRUD, and copy behavior.

- [ ] **Step 5: Commit the web integration**

```bash
git add app/app/WorkspaceBootstrap.tsx app/app/WorkspaceClient.tsx app/globals.css tests/workspace.test.tsx
git commit -m "feat: show browser bookmarks on the web"
```

### Task 9: Privacy, setup, and operator documentation

**Files:**
- Create: `docs/bookmark-sync-setup.md`
- Modify: `app/privacy/page.tsx`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: finalized permission and storage behavior from Tasks 1–8.
- Produces: accurate user disclosure and reproducible local setup/testing instructions.

- [ ] **Step 1: Add failing rendered-page assertions for bookmark disclosure**

```js
assert.match(privacyHtml, /bookmark titles, URLs, folder paths, ordering/i);
assert.match(privacyHtml, /only when you choose to sync/i);
assert.match(privacyHtml, /device name and sync status/i);
```

- [ ] **Step 2: Run the rendered-page test to verify failure**

Run: `npm run build && node --test tests/rendered-html.test.mjs`

Expected: FAIL because the privacy page does not mention bookmark synchronization.

- [ ] **Step 3: Update privacy copy and write setup instructions**

```tsx
<section>
  <BookMarked />
  <div>
    <h2>Manual bookmark sync</h2>
    <p>Only when you choose to sync, Tabloom uploads bookmark titles, URLs, folder paths, ordering, sync status, your device name, and sync timestamps. Forgetting a device removes its uploaded snapshot and never changes Chrome bookmarks.</p>
  </div>
</section>
```

Document: `supabase db reset`, `npm run test:supabase`, Google OAuth callbacks, loading `dist-extension`, why the optional permission warning appears, device-source behavior, reinstall behavior, forgetting a device, and the exact two-device acceptance procedure. Keep `.env.example` values as placeholders such as `NEXT_PUBLIC_SUPABASE_URL=` and `VITE_SUPABASE_ANON_KEY=`.

- [ ] **Step 4: Run documentation-linked checks and commit**

Run: `npm run build && node --test tests/rendered-html.test.mjs`

Expected: PASS.

```bash
git add docs/bookmark-sync-setup.md app/privacy/page.tsx .env.example README.md tests/rendered-html.test.mjs
git commit -m "docs: explain manual bookmark synchronization"
```

### Task 10: Chromium end-to-end coverage and versioned delivery

**Files:**
- Create: `tests/e2e/browser-bookmarks.spec.ts`
- Create: `tests/e2e/fixtures/bookmarks.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `extension/public/manifest.json`

**Interfaces:**
- Consumes: production extension build, local web build, and local Supabase from prior tasks.
- Produces: `npm run test:e2e:bookmarks`, extension version `0.6.0`, and a verified unpacked build.

- [ ] **Step 1: Install Playwright and add a failing built-extension smoke test**

```ts
test("manual bookmark snapshot appears in extension and web workspace", async () => {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  await seedAuthenticatedSession(context, testUser);
  await installBookmarkFixture(context, twoDeviceFixture.mac);
  const newTab = await context.newPage();
  await newTab.goto("chrome://newtab");
  await newTab.getByRole("button", { name: "Sync browser bookmarks" }).click();
  await expect(newTab.getByText("Work / Design")).toBeVisible();
  const web = await context.newPage();
  await web.goto(`${webBaseUrl}/app`);
  await expect(web.getByText("Work / Design")).toBeVisible();
});
```

- [ ] **Step 2: Run E2E to verify the new harness or scenario fails**

Run: `npm run build:all && npm run test:e2e:bookmarks`

Expected: FAIL until fixture installation, authenticated local Supabase setup, and extension ID discovery are wired.

- [ ] **Step 3: Complete deterministic E2E fixtures and scripts**

```json
{
  "scripts": {
    "test:e2e:bookmarks": "playwright test tests/e2e/browser-bookmarks.spec.ts --project=chromium",
    "verify": "npm run lint && npx tsc --noEmit && npm run test:unit && npm run test:supabase && npm run build:all"
  },
  "devDependencies": {
    "@playwright/test": "^1.55.0"
  }
}
```

Cover cached offline startup, permission denial, an interrupted finalization preserving the old view, two-device synced merging, distinct device-only entries, and bookmark copy into a normal collection. Mark tests that require an interactive headed Chrome profile explicitly and keep credentials in environment variables.

- [ ] **Step 4: Bump, build, and run the full verification matrix**

Set `extension/public/manifest.json` version to `0.6.0`.

Run: `npm run lint && npx tsc --noEmit && npm run test:unit && npm run test:supabase && npm run build:all && npm run test:e2e:bookmarks`

Expected: all commands pass; browser console contains no errors; `dist-extension/manifest.json` declares optional `bookmarks` and version `0.6.0`.

- [ ] **Step 5: Package and commit the release changes**

Run: `cd dist-extension && zip -r ../outputs/tabloom-chrome-extension-v0.6.0.zip .`

Expected: `outputs/tabloom-chrome-extension-v0.6.0.zip` is installable as an unpacked build after extraction. Do not commit the archive if `outputs/` is ignored by the repository.

```bash
git add tests/e2e/browser-bookmarks.spec.ts tests/e2e/fixtures/bookmarks.ts package.json package-lock.json extension/public/manifest.json
git commit -m "test: verify browser bookmark synchronization"
```

## Final Acceptance Check

- [ ] Start local Supabase and the hosted app build using the documented environment templates.
- [ ] Install the versioned extension build on two separate Chrome profiles.
- [ ] Deny bookmark permission once and confirm no snapshot or cache is removed.
- [ ] Grant permission, sync each profile under distinct device names, and confirm hidden root labels never appear.
- [ ] Confirm account-synced copies merge while device-only/unknown entries retain device badges.
- [ ] Confirm `Unfiled bookmarks`, nested folder names, search, and **Open all** behave in both the extension and `/app`.
- [ ] Drag a bookmark into a normal collection, confirm duplicate handling, and confirm the Chrome bookmark remains unchanged.
- [ ] Interrupt one staged upload and verify the previous completed snapshot remains visible online and offline.
- [ ] Forget one device and verify only its source-specific entries disappear.
- [ ] Run `npm run verify` and `npm run test:e2e:bookmarks` with zero failures and no console errors.
