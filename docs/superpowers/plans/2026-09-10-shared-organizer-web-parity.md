# Shared Organizer and Web Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `https://tabloom.nickvu.dev/app` use the extension's organizer design and behavior through one shared component implementation, while retaining browser-only extension capabilities and adding Trash/Undo UI.

**Architecture:** Extract platform-neutral organizer components and controller contracts into `shared/organizer`, with explicit capability and persistence adapters. The extension continues to own Current Tabs, browser bookmarks, native tab actions, OAuth, and local-first synchronization; the web app becomes a thin authenticated composition using Supabase and web navigation.

**Tech Stack:** React, TypeScript, Next.js, Vite, Lucide React, CSS custom properties, Supabase, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-shared-web-workspace-safe-mcp-mutations-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-10-safe-trash-mcp-mutations.md` Tasks 1–3.

## Global Constraints

- The web app excludes Current Tabs, live browser bookmarks, native tab closing, and native tab grouping.
- The extension retains all existing browser-specific behavior.
- Browser-bookmark spaces, collections, and links remain read-only.
- Selected space, collapsed sidebar state, and collapsed collection states initialize from local persistence without first-frame flicker.
- Saved-link and collection drag operations show insertion targets and shifting previews and have keyboard alternatives.
- Web mutations are optimistic and roll back on authoritative failure.
- Extension mutations retain local-first pending, failed-sync, and Retry semantics.
- Space and collection deletion keeps human confirmation; saved-link deletion is immediate with Undo.
- Notifications are compact, accessible, and visible for three seconds unless persistent action is required.
- Dark and light themes follow the browser preference.

---

### Task 1: Define organizer capabilities and preference adapters

**Files:**
- Create: `shared/organizer/capabilities.ts`
- Create: `shared/organizer/preferences.ts`
- Create: `shared/organizer/index.ts`
- Move/modify: `extension/selected-space-preference.ts`
- Move/modify: `extension/collection-collapse-preference.ts`
- Test: `tests/organizer-preferences.test.ts`
- Modify: `tests/selected-space-preference.test.ts`
- Modify: `tests/collection-collapse-preference.test.ts`

**Interfaces:**
- Consumes: browser storage adapters and DOM `Storage`-compatible web storage.
- Produces `OrganizerCapabilities`, `OrganizerPreferenceStore`, `SelectedSpacePreference`, and `CollectionCollapsePreference` usable by both web and extension.

- [ ] **Step 1: Write failing adapter tests**

```ts
it("loads selected space before rendering a workspace", async () => {
  const store = memoryPreferenceStore({ "tabloom:selected-space:account": SPACE_2 });
  const preference = new SelectedSpacePreference(store);
  await expect(preference.load("account", [SPACE_1, SPACE_2])).resolves.toBe(SPACE_2);
});

it("uses explicit capability absence for browser-only features", () => {
  const web = webOrganizerCapabilities({ openUrl: vi.fn() });
  expect(web.currentTabs).toBeUndefined();
  expect(web.bookmarks).toBeUndefined();
  expect(web.openCollection).toBeTypeOf("function");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/organizer-preferences.test.ts tests/selected-space-preference.test.ts tests/collection-collapse-preference.test.ts`

Expected: FAIL because shared organizer adapters do not exist.

- [ ] **Step 3: Implement the contracts**

```ts
export type OrganizerCapabilities = {
  openLink(input: { url: string; newTab: boolean }): Promise<void>;
  openCollection(name: string, urls: string[]): Promise<void>;
  resolveFavicon(url: string, source?: string | null): Promise<string | null>;
  currentTabs?: CurrentTabsCapability;
  bookmarks?: BookmarkCapability;
};

export type BrowserTabSummary = {
  id?: number;
  title?: string;
  url?: string;
  favIconUrl?: string;
};

export type CurrentTabsCapability = {
  list(): Promise<BrowserTabSummary[]>;
  activate(tabId: number): Promise<void>;
};

export type BookmarkCapability = {
  supported: true;
};

export interface OrganizerPreferenceStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
```

Move preference logic without changing storage keys. Add a web adapter around `window.localStorage` and retain the extension adapter around `chrome.storage.local`/browser storage.

- [ ] **Step 4: Run preference tests**

Run: `npx vitest run tests/organizer-preferences.test.ts tests/selected-space-preference.test.ts tests/collection-collapse-preference.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit capability contracts**

```bash
git add shared/organizer extension/selected-space-preference.ts extension/collection-collapse-preference.ts tests/organizer-preferences.test.ts tests/selected-space-preference.test.ts tests/collection-collapse-preference.test.ts
git commit -m "refactor: share organizer capabilities and preferences"
```

### Task 2: Extract the shared shell, space rail, header, and notifications

**Files:**
- Create: `shared/organizer/WorkspaceShell.tsx`
- Create: `shared/organizer/SpaceRail.tsx`
- Create: `shared/organizer/WorkspaceHeader.tsx`
- Create: `shared/organizer/ToastRegion.tsx`
- Create: `shared/organizer/organizer.css`
- Modify: `extension/SpaceSidebar.tsx`
- Modify: `extension/ToastRegion.tsx`
- Modify: `extension/style.css`
- Modify: `app/globals.css`
- Test: `tests/organizer-shell.test.tsx`
- Modify: `tests/space-sidebar.test.tsx`
- Modify: `tests/toast-region.test.tsx`

**Interfaces:**
- Consumes: Task 1 capabilities/preferences plus `Space[]` and selected-space ID.
- Produces platform-neutral shell components with slots for header actions, main content, and extension-only side content.

- [ ] **Step 1: Write failing shell tests**

```tsx
it("renders the same collapsed space rail for web and extension", () => {
  render(<SpaceRail spaces={[SPACE]} activeSpaceId={SPACE.id} collapsed onSelect={onSelect} actions={actions} />);
  expect(screen.getByRole("button", { name: `Open ${SPACE.name}` })).toBeVisible();
  expect(screen.queryByText(SPACE.name)).not.toBeVisible();
});

it("does not reserve space for unavailable actions", () => {
  render(<WorkspaceHeader title="My Space" actions={[]} />);
  expect(screen.queryByTestId("empty-header-action")).not.toBeInTheDocument();
});

it("dismisses transient notifications after three seconds", async () => {
  vi.useFakeTimers();
  render(<ToastRegion toasts={[toast("Saved")]} onDismiss={onDismiss} />);
  await vi.advanceTimersByTimeAsync(3000);
  expect(onDismiss).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run shell tests and verify RED**

Run: `npx vitest run tests/organizer-shell.test.tsx tests/space-sidebar.test.tsx tests/toast-region.test.tsx`

Expected: FAIL because shared components do not exist.

- [ ] **Step 3: Implement shared shell components**

Use semantic `aside`, `header`, `nav`, and `main` elements. Keep rail controls keyboard reachable, place edit/delete actions as overlays so hidden controls consume no layout width, and use `aria-expanded` for the rail toggle. `WorkspaceShell` accepts extension-only content through an optional `sidePanel` slot rather than importing Current Tabs.

- [ ] **Step 4: Move organizer CSS tokens into one file**

Define shared color, spacing, typography, elevation, focus, motion, light-theme, dark-theme, and reduced-motion rules in `organizer.css`. Import it from both extension and web entry styles; leave browser-panel styles in `extension/style.css` and marketing styles in `app/globals.css`.

- [ ] **Step 5: Convert extension wrappers to re-exports or thin adapters**

Keep existing extension import paths temporarily:

```tsx
export { SpaceRail as SpaceSidebar } from "../shared/organizer/SpaceRail";
export { ToastRegion } from "../shared/organizer/ToastRegion";
```

Where props differ, map existing prop names in a wrapper and add a deprecation comment with the removal task number.

- [ ] **Step 6: Run shell tests and extension snapshots**

Run: `npx vitest run tests/organizer-shell.test.tsx tests/space-sidebar.test.tsx tests/toast-region.test.tsx tests/extension-style-consistency.test.tsx`

Expected: PASS with no intended extension visual change.

- [ ] **Step 7: Commit shell extraction**

```bash
git add shared/organizer extension/SpaceSidebar.tsx extension/ToastRegion.tsx extension/style.css app/globals.css tests/organizer-shell.test.tsx tests/space-sidebar.test.tsx tests/toast-region.test.tsx
git commit -m "refactor: share organizer shell and navigation"
```

### Task 3: Extract collection rows and saved-link cards

**Files:**
- Create: `shared/organizer/CollectionList.tsx`
- Create: `shared/organizer/CollectionSection.tsx`
- Create: `shared/organizer/SavedLinkCard.tsx`
- Create: `shared/organizer/drag-model.ts`
- Modify: `extension/CollectionRows.tsx`
- Test: `tests/organizer-collections.test.tsx`
- Modify: `tests/extension-collection-rows.test.tsx`

**Interfaces:**
- Consumes: writable saved collections/links, read-only metadata, favicon resolver, repository commands, sharing capability, and browser-tab/bookmark drop callbacks supplied only by the extension.
- Produces shared collection and card rendering plus `OrganizerDragState` and deterministic reorder helpers.

- [ ] **Step 1: Write failing collection/card tests**

```tsx
it("renders a saved-link card with pointer click behavior and a separate drag handle", () => {
  render(<SavedLinkCard link={LINK} writable actions={actions} favicon={null} />);
  expect(screen.getByRole("link", { name: LINK.title })).toHaveStyle({ cursor: "pointer" });
  expect(screen.getByLabelText(`Drag ${LINK.title}`)).toHaveAttribute("draggable", "true");
});

it("shows the insertion slot and shifted order while dragging", () => {
  const preview = previewLinkDrop([LINK_A, LINK_B, LINK_C], LINK_C.id, 1);
  expect(preview.map((link) => link.id)).toEqual([LINK_A.id, LINK_C.id, LINK_B.id]);
});

it("hides write controls for browser bookmarks", () => {
  render(<CollectionSection collection={BOOKMARK_COLLECTION} links={[BOOKMARK_LINK]} writable={false} />);
  expect(screen.queryByLabelText(/delete/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run collection tests and verify RED**

Run: `npx vitest run tests/organizer-collections.test.tsx tests/extension-collection-rows.test.tsx`

Expected: FAIL because shared collection components and preview helpers do not exist.

- [ ] **Step 3: Implement deterministic drag state**

```ts
export type OrganizerDragState =
  | { kind: "collection"; id: string; overIndex: number }
  | { kind: "saved-link"; id: string; sourceCollectionId: string; targetCollectionId: string; overIndex: number }
  | { kind: "browser-tab"; tab: BrowserTabSummary; targetCollectionId?: string; overIndex?: number }
  | { kind: "browser-bookmark"; link: SavedLink; targetCollectionId?: string; overIndex?: number }
  | null;
```

Implement pure preview helpers that remove the dragged entity before calculating insertion, normalize positions, and never mutate input arrays. The UI renders a visible insertion marker and applies transform transitions to shifted siblings.

- [ ] **Step 4: Implement collection and card components**

Keep title/subtitle editing, deletion, sharing, collection collapse, Open all, favicon fallback, hover/focus actions, keyboard movement, and read-only rendering. Click targets stop propagation only for action buttons and drag handles; normal and modifier-assisted link navigation remains native.

- [ ] **Step 5: Convert `extension/CollectionRows.tsx` into an extension adapter**

The wrapper supplies browser-tab and bookmark callbacks, extension collapse preferences, native Open all, and sharing. Shared components receive no browser globals.

- [ ] **Step 6: Run component regression tests**

Run: `npx vitest run tests/organizer-collections.test.tsx tests/extension-collection-rows.test.tsx tests/favicon-tile.test.tsx tests/open-collection.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit collection extraction**

```bash
git add shared/organizer extension/CollectionRows.tsx tests/organizer-collections.test.tsx tests/extension-collection-rows.test.tsx
git commit -m "refactor: share organizer collections and link cards"
```

### Task 4: Extract global search and dialogs

**Files:**
- Create: `shared/organizer/GlobalSearch.tsx`
- Create: `shared/organizer/WorkspaceDialogs.tsx`
- Modify: `extension/GlobalSearch.tsx`
- Test: `tests/organizer-search.test.tsx`
- Modify: `tests/global-search.test.tsx`

**Interfaces:**
- Consumes: `WorkspaceSnapshot`, optional Current Tabs search provider, navigation capability, and dialog command callbacks.
- Produces full-screen cross-space search and accessible organizer forms/confirmations shared by web and extension.

- [ ] **Step 1: Write failing web and extension search tests**

```tsx
it("searches all spaces and includes collection context", async () => {
  render(<GlobalSearch snapshot={SNAPSHOT} capabilities={WEB_CAPABILITIES} open />);
  await userEvent.type(screen.getByRole("searchbox"), "testing");
  expect(screen.getByText("My Space · NTUC stuff")).toBeVisible();
});

it("omits Current Tabs results without the capability", () => {
  render(<GlobalSearch snapshot={SNAPSHOT} capabilities={WEB_CAPABILITIES} open />);
  expect(screen.queryByText("Current tabs")).not.toBeInTheDocument();
});

it("keeps Current Tabs results in the extension composition", async () => {
  render(<GlobalSearch snapshot={SNAPSHOT} capabilities={EXTENSION_CAPABILITIES} open />);
  await userEvent.type(screen.getByRole("searchbox"), "docs");
  expect(await screen.findByText("Current tabs")).toBeVisible();
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/organizer-search.test.tsx tests/global-search.test.tsx`

Expected: FAIL because shared search and dialogs do not exist.

- [ ] **Step 3: Implement shared full-screen search**

Reuse `searchWorkspace`. Accept an optional Current Tabs provider and merge those results only when present. Keep full-screen backdrop, focus trapping, Escape, arrow navigation, Enter activation, result context, and browser-autofill suppression. Opening the web result uses normal web navigation; opening an extension Current Tab activates the existing tab.

- [ ] **Step 4: Implement accessible shared dialogs**

Support create/edit space, create/edit collection, create/edit saved link, large Open all confirmation, duplicate-link handling, and human space/collection deletion confirmation. Inputs retain existing length and URL constraints and support Enter/Escape.

- [ ] **Step 5: Run search/dialog tests**

Run: `npx vitest run tests/organizer-search.test.tsx tests/global-search.test.tsx tests/extension-collection-rows.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit search extraction**

```bash
git add shared/organizer extension/GlobalSearch.tsx tests/organizer-search.test.tsx tests/global-search.test.tsx tests/extension-collection-rows.test.tsx
git commit -m "refactor: share organizer search and dialogs"
```

### Task 5: Add the shared organizer controller and optimistic mutation policy

**Files:**
- Create: `shared/organizer/useWorkspaceController.ts`
- Create: `shared/organizer/mutation-policy.ts`
- Create: `shared/organizer/WorkspaceOrganizer.tsx`
- Test: `tests/workspace-controller.test.tsx`

**Interfaces:**
- Consumes: `WorkspaceRepository`, `WorkspaceTrashRepository`, Task 1 preference store, capabilities, optional sharing, and mutation policy.
- Produces `WorkspaceOrganizer` and policies `rollbackOnFailure` for web and `preserveLocalOnFailure` for extension.

- [ ] **Step 1: Write failing controller tests**

```tsx
it("applies a web edit optimistically and rolls it back on failure", async () => {
  const repository = failingRepository(SNAPSHOT);
  render(<ControllerHarness repository={repository} mutationPolicy="rollbackOnFailure" />);
  await userEvent.click(screen.getByRole("button", { name: `Edit ${LINK.title}` }));
  await userEvent.clear(screen.getByLabelText("Title"));
  await userEvent.type(screen.getByLabelText("Title"), "Optimistic title");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByText("Optimistic title")).toBeVisible();
  expect(await screen.findByText(LINK.title)).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("could not be saved");
});

it("preserves extension local state when remote sync fails", async () => {
  const result = applyMutationFailure("preserveLocalOnFailure", SNAPSHOT, OPTIMISTIC_SNAPSHOT);
  expect(result.snapshot).toEqual(OPTIMISTIC_SNAPSHOT);
  expect(result.retryRequired).toBe(true);
});
```

- [ ] **Step 2: Run controller tests and verify RED**

Run: `npx vitest run tests/workspace-controller.test.tsx`

Expected: FAIL because the controller and policy do not exist.

- [ ] **Step 3: Implement the controller**

Load preferences and the initial snapshot before setting `ready=true`; render `WorkspaceBootBoundary` until both resolve. Centralize selected-space reconciliation, collection collapse, dialogs, search, drag previews, mutation dispatch, canonical reloads, and toast state.

Use immutable snapshot reducers for optimistic create, update, delete, move, reorder, and restore. Web rollback restores the captured pre-mutation snapshot. Extension failure preserves the optimistic local snapshot and invokes its existing Retry path.

- [ ] **Step 4: Compose `WorkspaceOrganizer`**

`WorkspaceOrganizer` renders Task 2–4 components and accepts slots for account controls and extension-only Current Tabs. It must not inspect `window.chrome` or browser target identifiers.

- [ ] **Step 5: Run controller and shared component tests**

Run: `npx vitest run tests/workspace-controller.test.tsx tests/organizer-shell.test.tsx tests/organizer-collections.test.tsx tests/organizer-search.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the controller**

```bash
git add shared/organizer tests/workspace-controller.test.tsx
git commit -m "feat: add shared organizer controller"
```

### Task 6: Migrate the extension to the shared organizer

**Files:**
- Modify: `extension/src.tsx`
- Modify: `extension/CollectionRows.tsx`
- Modify: `extension/SpaceSidebar.tsx`
- Modify: `extension/GlobalSearch.tsx`
- Modify: `extension/ToastRegion.tsx`
- Modify: `extension/style.css`
- Test: `tests/extension-bootstrap-integration.test.tsx`
- Test: `tests/extension.test.ts`
- Test: `tests/current-tabs-sheet.test.tsx`
- Test: `tests/browser-bookmarks-panel.test.tsx`

**Interfaces:**
- Consumes: `WorkspaceOrganizer`, extension capabilities, local-first repository, Current Tabs sheet, bookmarks panel, sharing repository, OAuth/account UI, and sync coordinator.
- Produces the existing extension experience with shared organizer rendering.

- [ ] **Step 1: Add a failing integration assertion**

```tsx
it("composes browser-only panels around the shared organizer", async () => {
  renderExtension();
  expect(await screen.findByTestId("shared-workspace-organizer")).toBeVisible();
  expect(screen.getByRole("complementary", { name: "Current tabs" })).toBeVisible();
  expect(screen.getByRole("button", { name: /sync bookmarks/i })).toBeVisible();
});
```

- [ ] **Step 2: Run extension integration tests and verify RED**

Run: `npx vitest run tests/extension-bootstrap-integration.test.tsx tests/extension.test.ts`

Expected: FAIL because `ExtensionApp` still renders the organizer directly.

- [ ] **Step 3: Replace direct organizer rendering**

Keep bootstrapping, OAuth, local-first sync, account menu, Current Tabs state, browser bookmark synchronization, dropped-tab confirmation, duplicate handling, and browser adapters in `extension/src.tsx`. Pass only organizer state and documented capabilities into `WorkspaceOrganizer`.

- [ ] **Step 4: Remove temporary extension wrappers**

After all imports point to `shared/organizer`, delete thin re-export wrappers that have no browser-specific mapping. Retain adapters that translate browser-tab or bookmark behavior.

- [ ] **Step 5: Run the full extension unit suite and builds**

Run: `npx vitest run tests/extension*.test.ts tests/extension*.test.tsx tests/current-tabs-sheet.test.tsx tests/browser-bookmarks-panel.test.tsx tests/global-search.test.tsx tests/space-sidebar.test.tsx && npm run build:extension`

Expected: PASS and successful Chromium, Firefox, and Safari outputs.

- [ ] **Step 6: Commit extension migration**

```bash
git add extension/src.tsx extension/CollectionRows.tsx extension/SpaceSidebar.tsx extension/GlobalSearch.tsx extension/ToastRegion.tsx extension/style.css shared/organizer tests/extension-bootstrap-integration.test.tsx tests/extension.test.ts tests/current-tabs-sheet.test.tsx tests/browser-bookmarks-panel.test.tsx
git commit -m "refactor: run extension on shared organizer"
```

### Task 7: Migrate `/app` to the shared organizer

**Files:**
- Modify: `app/app/WorkspaceBootstrap.tsx`
- Replace: `app/app/WorkspaceClient.tsx`
- Create: `app/app/web-organizer-capabilities.ts`
- Modify: `app/globals.css`
- Modify: `tests/workspace.test.tsx`
- Modify: `tests/workspace-bootstrap.test.ts`
- Create: `tests/web-organizer-parity.test.tsx`

**Interfaces:**
- Consumes: shared organizer, Supabase workspace and Trash repositories, web preferences, sharing, and authenticated account actions.
- Produces web-safe `/app` composition with extension parity and no browser-only controls.

- [ ] **Step 1: Write failing web parity tests**

```tsx
it("renders the shared organizer without browser-only controls", async () => {
  renderWebWorkspace();
  expect(await screen.findByTestId("shared-workspace-organizer")).toBeVisible();
  expect(screen.queryByText("Current tabs")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /sync bookmarks/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Search" })).toBeVisible();
});

it("uses native web navigation semantics for saved links", () => {
  renderWebWorkspace();
  const link = screen.getByRole("link", { name: LINK.title });
  expect(link).toHaveAttribute("href", LINK.url);
  expect(link).not.toHaveAttribute("target", "_blank");
});
```

- [ ] **Step 2: Run web tests and verify RED**

Run: `npx vitest run tests/web-organizer-parity.test.tsx tests/workspace.test.tsx tests/workspace-bootstrap.test.ts`

Expected: FAIL because `/app` still uses its independent organizer.

- [ ] **Step 3: Implement web capabilities**

```ts
export const webOrganizerCapabilities: OrganizerCapabilities = {
  async openLink({ url, newTab }) {
    if (newTab) window.open(url, "_blank", "noopener,noreferrer");
    else window.location.assign(url);
  },
  async openCollection(_name, urls) {
    for (const url of urls) window.open(url, "_blank", "noopener,noreferrer");
  },
  async resolveFavicon(_url, source) { return source ?? null; },
};
```

Do not provide Current Tabs or bookmarks capabilities. Keep normal anchor behavior for saved-link cards so Command-click/Control-click works natively.

- [ ] **Step 4: Reduce web composition files**

`WorkspaceBootstrap` remains responsible for Supabase session state and repository creation. `WorkspaceClient` wires account actions, sharing, web preferences, mutation rollback policy, and `WorkspaceOrganizer`; delete its duplicated collection/card/search/dialog JSX.

- [ ] **Step 5: Run web tests and production build**

Run: `npx vitest run tests/web-organizer-parity.test.tsx tests/workspace.test.tsx tests/workspace-bootstrap.test.ts tests/collection-share-dialog.test.tsx && npm run build:vercel`

Expected: PASS with `/`, `/app`, `/privacy`, and `/s/:token` included in the build.

- [ ] **Step 6: Commit web migration**

```bash
git add app/app app/globals.css tests/web-organizer-parity.test.tsx tests/workspace.test.tsx tests/workspace-bootstrap.test.ts tests/collection-share-dialog.test.tsx
git commit -m "feat: bring shared organizer design to web app"
```

### Task 8: Add Trash, Restore, and Undo UI

**Files:**
- Create: `shared/organizer/TrashDialog.tsx`
- Create: `shared/organizer/useTrash.ts`
- Create: `extension/local-trash-repository.ts`
- Modify: `shared/organizer/WorkspaceOrganizer.tsx`
- Modify: `shared/organizer/WorkspaceHeader.tsx`
- Modify: `shared/organizer/organizer.css`
- Modify: `extension/src.tsx`
- Modify: `app/app/WorkspaceClient.tsx`
- Create: `tests/trash-dialog.test.tsx`
- Create: `tests/local-trash-repository.test.ts`
- Modify: `tests/workspace-controller.test.tsx`

**Interfaces:**
- Consumes: `WorkspaceTrashRepository`, local extension Trash adapter, web Supabase Trash adapter, and `DeleteReceipt`.
- Produces account-menu Trash action, list/restore/destination flows, and three-second Undo toast for link deletion.
- Produces `LocalTrashRepository`, which implements `WorkspaceTrashRepository` using browser-local storage and reconciles remote receipts by operation ID.

- [ ] **Step 1: Write failing Trash UI tests**

```tsx
it("lists recoverable entries with source and expiry", async () => {
  render(<TrashDialog repository={trashRepository([TRASH_LINK])} open onClose={vi.fn()} />);
  expect(await screen.findByText(TRASH_LINK.rootName)).toBeVisible();
  expect(screen.getByText("Deleted by MCP")).toBeVisible();
  expect(screen.getByRole("button", { name: `Restore ${TRASH_LINK.rootName}` })).toBeVisible();
});

it("offers Undo after immediate link deletion", async () => {
  renderOrganizer();
  await userEvent.click(screen.getByRole("button", { name: `Delete ${LINK.title}` }));
  expect(screen.getByRole("status")).toHaveTextContent("Moved to Trash");
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByText(LINK.title)).toBeVisible();
});

it("requests an alternate destination when the original parent is gone", async () => {
  restore.mockResolvedValueOnce({ code: "destination_required", allowedType: "collection" });
  renderTrashDialog();
  await userEvent.click(screen.getByRole("button", { name: /restore/i }));
  expect(await screen.findByRole("combobox", { name: "Restore into" })).toBeVisible();
});

it("reconciles an offline local trash entry with its remote receipt", async () => {
  const repository = new LocalTrashRepository(storage);
  await repository.saveLocal(LOCAL_TRASH_ENTRY);
  await repository.reconcileRemote(LOCAL_TRASH_ENTRY.operationId, REMOTE_RECEIPT);
  await expect(repository.list()).resolves.toEqual([
    expect.objectContaining({ id: REMOTE_RECEIPT.trashId, operationId: LOCAL_TRASH_ENTRY.operationId }),
  ]);
});
```

- [ ] **Step 2: Run Trash UI tests and verify RED**

Run: `npx vitest run tests/trash-dialog.test.tsx tests/local-trash-repository.test.ts tests/workspace-controller.test.tsx`

Expected: FAIL because Trash UI does not exist.

- [ ] **Step 3: Implement Trash UI and focus behavior**

Add Trash to the account dropdown. Render type, name, source, deletion time, and recovery deadline. Trap focus while open, restore focus on close, support Escape, and keep destination selection inside the same dialog.

- [ ] **Step 4: Implement local extension Trash storage**

Store immediate local snapshots keyed by deletion operation ID so signed-out and offline deletions are recoverable on the device. When remote sync returns a Trash receipt, reconcile the local entry to the remote Trash ID rather than duplicating it. Expire local entries after 30 days during bounded Trash reads.

- [ ] **Step 5: Implement Undo and optimistic restoration**

Link deletion displays an Undo action for three seconds. Undo restores immediately through the active Trash repository, updates the organizer snapshot optimistically, and rolls back or marks Retry according to the active mutation policy.

- [ ] **Step 6: Run Trash and regression tests**

Run: `npx vitest run tests/trash-dialog.test.tsx tests/local-trash-repository.test.ts tests/workspace-controller.test.tsx tests/local-first-repository.test.ts tests/repository.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Trash UI**

```bash
git add shared/organizer/TrashDialog.tsx shared/organizer/useTrash.ts shared/organizer/WorkspaceOrganizer.tsx shared/organizer/WorkspaceHeader.tsx shared/organizer/organizer.css extension/local-trash-repository.ts extension/src.tsx app/app/WorkspaceClient.tsx tests/trash-dialog.test.tsx tests/local-trash-repository.test.ts tests/workspace-controller.test.tsx tests/local-first-repository.test.ts tests/repository.test.ts
git commit -m "feat: add workspace trash and undo UI"
```

### Task 9: Visual, accessibility, cross-browser, and release verification

**Files:**
- Modify: `tests/e2e/visual-consistency.spec.ts`
- Create: `tests/e2e/web-extension-parity.spec.ts`
- Create: `tests/e2e/workspace-trash.spec.ts`
- Update: `tests/e2e/__screenshots__/visual-consistency.spec.ts/*` only after reviewed intentional changes.
- Modify: `README.md`

**Interfaces:**
- Consumes: completed shared organizer on extension and web plus Trash-enabled repositories.
- Produces release evidence and updated browser packages.

- [ ] **Step 1: Add parity and recovery E2E scenarios**

Test matching rail/header/collection/card geometry in web and extension viewports, automatic light/dark theming, global search, drag previews, keyboard movement, human delete confirmation, link Undo, Trash restore, and alternate destinations. Assert web lacks Current Tabs and bookmark controls while extension retains them.

- [ ] **Step 2: Run focused E2E tests and verify failures before baseline updates**

Run: `npx playwright test tests/e2e/web-extension-parity.spec.ts tests/e2e/workspace-trash.spec.ts --project=chromium`

Expected: new scenarios identify any remaining parity or recovery gaps; fix product code rather than weakening assertions.

- [ ] **Step 3: Run complete verification**

Run: `npm run lint && npx tsc --noEmit && npm run test:unit && npm run test:supabase && npm run build:all && npm run test:e2e:visual`

Expected: all unit, database, production, extension, and visual tests pass with no console errors.

- [ ] **Step 4: Review and commit intentional screenshot changes**

Inspect every changed screenshot for layout drift, clipped names, transparent menus, hidden action gaps, focus outlines, favicon fallback, and light/dark contrast before staging.

```bash
git add tests/e2e README.md
git commit -m "test: verify shared organizer across surfaces"
```

- [ ] **Step 5: Deploy and package**

Deploy `tabloom.nickvu.dev`, verify `/app` with a real synchronized account, build all extension targets, and replace website download artifacts only after package smoke tests pass. Confirm Chromium, Firefox, and Safari builds retain OAuth callbacks and browser-only integrations.
