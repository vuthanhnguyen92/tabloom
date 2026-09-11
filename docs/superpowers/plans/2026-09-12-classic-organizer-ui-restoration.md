# Classic Organizer UI Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the extension and `/app` to the classic `e09da72` organizer experience while preserving every current repository, sync, sharing, Trash, OAuth, MCP, and browser-adapter behavior.

**Architecture:** Keep `useWorkspaceController` and the existing repositories as the only state and mutation layer. Extract the current controller-backed collection renderer so it can be reused, add a classic presentation compositor around it, and switch the extension and web compositions together. Browser-only Current Tabs and bookmarks remain injected slots; web-only account routing remains supplied by `/app`.

**Tech Stack:** React 19, TypeScript, Next.js/Vinext, Vite extension builds, Vitest/Testing Library, Playwright, Supabase, Lucide, Poppins CSS.

**Spec:** [`docs/superpowers/specs/2026-09-12-classic-organizer-ui-restoration-design.md`](../specs/2026-09-12-classic-organizer-ui-restoration-design.md)

## Global Constraints

- Use commit `e09da72` as the visual and interaction reference only. Do not revert commits or restore its data-loading code.
- Do not change database schemas, RPC contracts, local-first synchronization, OAuth, MCP, sharing, or Trash semantics.
- All shared mutations continue through `WorkspaceController`; presentation components must not call Supabase or browser storage directly.
- Keep the current shared organizer renderer until both surfaces pass parity tests, then remove only code proven unreachable.
- The header contains New Collection, Search, and Account. Trash is available only inside the account menu.
- Every shell command in this repository must be prefixed with `rtk`.

---

## Task 1: Characterize and extract the controller-backed collection renderer

**Files:**
- Modify: `shared/organizer/WorkspaceOrganizer.tsx`
- Create: `shared/organizer/ControllerCollections.tsx`
- Modify: `shared/organizer/index.ts`
- Test: `tests/organizer-collections.test.tsx`

- [ ] Add a characterization test that renders the current organizer with a writable space, two collections, a saved link, sharing enabled, and Trash enabled. Assert that collection rename, share, add-link, delete, collapse, keyboard move, and link drag affordances are all present before extraction.

```tsx
expect(screen.getByRole("button", { name: "Rename Reading" })).toBeVisible();
expect(screen.getByRole("button", { name: "Share Reading" })).toBeVisible();
expect(screen.getByRole("button", { name: "Add link to Reading" })).toBeVisible();
expect(screen.getByRole("button", { name: "Delete Reading" })).toBeVisible();
expect(screen.getByRole("button", { name: "Collapse Reading" })).toHaveAttribute("aria-expanded", "true");
expect(screen.getByRole("button", { name: "Drag Example" })).toBeVisible();
```

- [ ] Run the focused characterization tests and confirm they pass before moving code.

```bash
rtk npm run test:unit -- tests/organizer-collections.test.tsx
```

- [ ] Move `ControllerCard` and `ControllerCollections` unchanged from `WorkspaceOrganizer.tsx` into `shared/organizer/ControllerCollections.tsx`. Export a typed component that accepts the existing `WorkspaceOrganizerProps` plus `WorkspaceController`.

```tsx
export type ControllerCollectionsProps = WorkspaceOrganizerProps & {
  controller: WorkspaceController;
};
```

- [ ] Re-import the extracted renderer in `WorkspaceOrganizer.tsx`; export it from `shared/organizer/index.ts` for the classic compositor. Do not change accessible labels or controller calls.

- [ ] Re-run the focused tests and TypeScript.

```bash
rtk npm run test:unit -- tests/organizer-collections.test.tsx
rtk npx tsc --noEmit
```

- [ ] Commit the behavior-preserving extraction.

```bash
rtk git add shared/organizer/WorkspaceOrganizer.tsx shared/organizer/ControllerCollections.tsx shared/organizer/index.ts tests/organizer-collections.test.tsx
rtk git commit -m "refactor: extract controller collection renderer"
```

## Task 2: Add the classic shell, header, and space navigation

**Files:**
- Create: `shared/classic-organizer/ClassicWorkspaceOrganizer.tsx`
- Create: `shared/classic-organizer/ClassicSpaceSidebar.tsx`
- Create: `shared/classic-organizer/classic-organizer.css`
- Create: `shared/classic-organizer/index.ts`
- Test: `tests/classic-organizer-shell.test.tsx`
- Reference only: `extension/SpaceSidebar.tsx` at `e09da72`
- Reference only: `extension/style.css` at `e09da72`

- [ ] Write a failing shell test that requires the classic two-column structure, an initially collapsed icon rail, a persistent selected-space state, classic header actions, and no standalone Trash button.

```tsx
render(<ClassicWorkspaceOrganizerView {...props} controller={controller} />);
expect(screen.getByTestId("classic-workspace-organizer")).toHaveClass("classic-organizer");
expect(screen.getByRole("navigation", { name: "Spaces" })).toHaveClass("is-collapsed");
expect(screen.getByRole("heading", { name: "My Space" })).toBeVisible();
expect(screen.getByRole("button", { name: "New collection" })).toBeVisible();
expect(screen.getByRole("button", { name: "Search" })).toBeVisible();
expect(within(screen.getByRole("banner")).queryByRole("button", { name: "Trash" })).not.toBeInTheDocument();
```

- [ ] Confirm the new test fails because the classic compositor does not exist.

```bash
rtk npm run test:unit -- tests/classic-organizer-shell.test.tsx
```

- [ ] Implement `ClassicSpaceSidebar` as a controlled presentation component. It receives sorted spaces, selected ID, collapsed state, pending state, selection callback, create/edit/delete callbacks, brand, and optional platform content. It must not own workspace data.

```tsx
export type ClassicSpaceSidebarProps = {
  spaces: Space[];
  activeSpaceId: string;
  collapsed: boolean;
  brand: ReactNode;
  beforeSpaces?: ReactNode;
  isPending: (space: Space) => boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onSelect: (spaceId: string) => void;
  onCreate: () => void;
  onEdit: (space: Space) => void;
  onDelete?: (space: Space) => void;
};
```

- [ ] Implement `ClassicWorkspaceOrganizerView` using `WorkspaceController`, the extracted `ControllerCollections`, current dialogs/Trash/toasts, and explicit `currentTabs`, `railBeforeSpaces`, `headerActions`, and `accountControls` slots.

```tsx
export function ClassicWorkspaceOrganizerView({ controller: c, currentTabs, accountControls, ...props }: ClassicWorkspaceOrganizerProps & { controller: WorkspaceController }) {
  if (!c.ready) return <ClassicBootShell error={c.bootError} />;
  return <div className="classic-organizer" data-testid="classic-workspace-organizer">
    <ClassicSpaceSidebar
      spaces={[...c.snapshot.spaces].sort((a, b) => a.position - b.position)}
      activeSpaceId={c.selectedSpaceId}
      collapsed={c.railCollapsed}
      onCollapsedChange={c.setRailCollapsed}
      onSelect={c.selectSpace}
      onCreate={() => c.openDialog({ type: "create-space" })}
      onEdit={(space) => c.openDialog({ type: "edit-space", space })}
      onDelete={props.trashRepository ? (space) => void c.requestDelete("space", space.id) : undefined}
      isPending={(space) => c.isPending(space.id)}
      brand={<TabloomBrand />}
    />
    <section className="classic-main">
      <ClassicHeader controller={c} accountControls={accountControls} {...props} />
      {props.mainContentBefore}
      <ControllerCollections {...props} controller={c} />
    </section>
    {currentTabs}
    <ClassicOverlays controller={c} {...props} />
  </div>;
}
```

- [ ] Port only the classic structural tokens from `e09da72`: fixed rail, independent main scroll, Poppins typography, light/dark variables, classic spacing, selected space treatment, and reduced-motion rules. Keep all selectors scoped below `.classic-organizer`.

- [ ] Pass the shell tests in both light and dark media-query modes.

```bash
rtk npm run test:unit -- tests/classic-organizer-shell.test.tsx tests/organizer-preferences.test.ts
```

- [ ] Commit the classic shell.

```bash
rtk git add shared/classic-organizer tests/classic-organizer-shell.test.tsx
rtk git commit -m "feat: add classic organizer shell"
```

## Task 3: Restore classic collections and saved-link cards without losing current actions

**Files:**
- Modify: `shared/organizer/ControllerCollections.tsx`
- Modify: `shared/organizer/CollectionSection.tsx`
- Modify: `shared/organizer/SavedLinkCard.tsx`
- Modify: `shared/classic-organizer/classic-organizer.css`
- Test: `tests/classic-organizer-collections.test.tsx`
- Test: `tests/organizer-collections.test.tsx`
- Test: `tests/extension-collection-rows.test.tsx`
- Reference only: `extension/CollectionRows.tsx` at `e09da72`

- [ ] Write failing tests for classic card density and action behavior: title/subtitle, favicon fallback, explicit drag handle, pointer cursor on the card body, hover/focus edit/delete actions, collapse icon alignment, share action for mutable collections, and no share action for bookmark collections.

```tsx
const card = screen.getByRole("link", { name: /Example saved link/ });
expect(card).toHaveClass("classic-link-card");
expect(screen.getByRole("button", { name: "Drag Example" })).toBeVisible();
expect(screen.getByRole("button", { name: "Edit Example" })).toBeVisible();
expect(screen.getByRole("button", { name: "Delete Example" })).toBeVisible();
expect(screen.getByRole("button", { name: "Share Reading" })).toBeVisible();
```

- [ ] Run the focused tests and confirm the new classic expectations fail.

```bash
rtk npm run test:unit -- tests/classic-organizer-collections.test.tsx tests/organizer-collections.test.tsx tests/extension-collection-rows.test.tsx
```

- [ ] Add presentation hooks (`classic-link-card`, `classic-collection-row`, `classic-collection-header`, `classic-card-actions`) without changing mutation callbacks, drag payloads, stable IDs, accessible names, or origin/read-only rules.

- [ ] Port the `e09da72` card sizing, spacing, 500-weight title, 16px title, 14px subtitle, favicon tile, explicit six-dot drag affordance, and hover/focus action placement. Keep the current subtitle rule: description first, hostname fallback.

- [ ] Restore the classic horizontal saved-card layout and collection-row separators. Ensure the delete control is absolutely positioned/overlaid so it consumes no row width while hidden.

- [ ] Preserve current collection functionality: rename, add link, delete to Trash, share, collapse persistence, drag/reorder previews, keyboard up/down, cross-collection saved-link movement, bookmark copy, Current Tabs drop targets, and Open All.

- [ ] Pass collection and card tests.

```bash
rtk npm run test:unit -- tests/classic-organizer-collections.test.tsx tests/organizer-collections.test.tsx tests/extension-collection-rows.test.tsx
```

- [ ] Commit the collection/card restoration.

```bash
rtk git add shared/organizer/ControllerCollections.tsx shared/organizer/CollectionSection.tsx shared/organizer/SavedLinkCard.tsx shared/classic-organizer/classic-organizer.css tests/classic-organizer-collections.test.tsx tests/organizer-collections.test.tsx tests/extension-collection-rows.test.tsx
rtk git commit -m "feat: restore classic collections and cards"
```

## Task 4: Restore classic search, dialogs, account placement, and mini toasts

**Files:**
- Modify: `shared/organizer/GlobalSearch.tsx`
- Modify: `shared/organizer/WorkspaceDialogs.tsx`
- Modify: `shared/organizer/TrashDialog.tsx`
- Modify: `shared/organizer/ToastRegion.tsx`
- Modify: `shared/classic-organizer/ClassicWorkspaceOrganizer.tsx`
- Modify: `shared/classic-organizer/classic-organizer.css`
- Test: `tests/classic-organizer-overlays.test.tsx`
- Test: `tests/organizer-search.test.tsx`
- Test: `tests/organizer-dialogs.test.tsx`
- Test: `tests/organizer-modal-stack.test.tsx`

- [ ] Write failing tests that require the classic Search button, full-screen inert backdrop, large centered search input, cross-space result metadata, current-tab result support when provided, classic modal button/input heights, and three-second transient mini toasts.

```tsx
await user.click(screen.getByRole("button", { name: "Search" }));
expect(screen.getByTestId("global-search-backdrop")).toHaveClass("classic-search-backdrop");
expect(screen.getByRole("dialog", { name: "Search Tabloom" })).toBeVisible();
expect(screen.getByText("My Space · Reading")).toBeVisible();
expect(screen.getByRole("button", { name: "Close search backdrop" })).toBeVisible();
```

- [ ] Confirm the focused tests fail on the new classic presentation requirements.

```bash
rtk npm run test:unit -- tests/classic-organizer-overlays.test.tsx tests/organizer-search.test.tsx tests/organizer-dialogs.test.tsx tests/organizer-modal-stack.test.tsx
```

- [ ] Add a presentation class/variant boundary to the existing search, dialogs, Trash dialog, and toast region; do not fork their data or keyboard logic.

- [ ] Port classic overlay styling from `e09da72`, including opaque dropdown/menu surfaces, full-viewport modal backdrop, visible focus rings, standardized controls, centered close icons, Enter/Escape behavior, and motion that respects `prefers-reduced-motion`.

- [ ] Keep account controls immediately to the right of Search. The classic header must never render a Trash button; the account menu supplied by each platform continues to open `controller.setTrashOpen(true)`.

- [ ] Preserve current search semantics across saved links, spaces, collections, bookmarks, and current-window tabs. A current-tab result must activate the existing tab and close the Tabloom tab; a saved link keeps current-tab/default-modifier browser behavior.

- [ ] Use three-second auto-dismiss for normal success/error notifications and persistent display only for retry-required failures.

- [ ] Pass overlay tests and existing search/dialog regressions.

```bash
rtk npm run test:unit -- tests/classic-organizer-overlays.test.tsx tests/organizer-search.test.tsx tests/global-search.test.tsx tests/organizer-dialogs.test.tsx tests/organizer-modal-stack.test.tsx
```

- [ ] Commit the overlay restoration.

```bash
rtk git add shared/organizer/GlobalSearch.tsx shared/organizer/WorkspaceDialogs.tsx shared/organizer/TrashDialog.tsx shared/organizer/ToastRegion.tsx shared/classic-organizer tests/classic-organizer-overlays.test.tsx tests/organizer-search.test.tsx tests/organizer-dialogs.test.tsx tests/organizer-modal-stack.test.tsx
rtk git commit -m "feat: restore classic organizer overlays"
```

## Task 5: Switch the extension to the classic presentation and preserve browser-only panels

**Files:**
- Modify: `extension/src.tsx`
- Modify: `extension/style.css`
- Modify: `extension/CurrentTabsSheet.tsx`
- Modify: `extension/BrowserBookmarksPanel.tsx`
- Test: `tests/extension-bootstrap-integration.test.tsx`
- Test: `tests/current-tabs-sheet.test.tsx`
- Test: `tests/extension-style-consistency.test.tsx`
- Test: `tests/extension-motion.test.ts`

- [ ] Update extension integration tests to require `ClassicWorkspaceOrganizerView`, browser bookmark content before collections, and Current Tabs as the right side sheet. Assert that a standalone header Trash button is absent while account-menu Trash remains present.

```tsx
expect(screen.getByTestId("classic-workspace-organizer")).toBeVisible();
expect(screen.getByRole("complementary", { name: "Current tabs" })).toBeVisible();
expect(screen.queryByTestId("shared-workspace-organizer")).not.toBeInTheDocument();
expect(within(screen.getByRole("banner")).queryByRole("button", { name: "Trash" })).not.toBeInTheDocument();
expect(within(screen.getByRole("menu", { name: "Account" })).getByText("Trash")).toBeVisible();
```

- [ ] Confirm extension tests fail before the composition switch.

```bash
rtk npm run test:unit -- tests/extension-bootstrap-integration.test.tsx tests/current-tabs-sheet.test.tsx tests/extension-style-consistency.test.tsx tests/extension-motion.test.ts
```

- [ ] Replace the extension import and render call with `ClassicWorkspaceOrganizerView`; keep the existing controller instance, repositories, sync coordinator, sharing adapter, favicon resolver, bookmarks, login prompt, merge prompt, and error policy unchanged.

```tsx
import { ClassicWorkspaceOrganizerView } from "../shared/classic-organizer";

return <ClassicWorkspaceOrganizerView
  {...organizerOptions}
  controller={controller}
  mainContentBefore={<BrowserBookmarksPanel {...bookmarkProps} />}
  currentTabs={<CurrentTabsSheet {...currentTabsProps} />}
  accountControls={accountControls}
/>;
```

- [ ] Restyle Current Tabs to the previous vertical, open-by-default, collapsible sheet. Preserve live tab removal, per-tab close, duplicate close confirmation, drag-to-collection, close-after-drop confirmation, and save-all-to-named-collection.

- [ ] Scope extension-only rules below `.classic-organizer`. Remove or stop importing obsolete modern presentation rules; retain browser-normalization and Poppins font imports.

- [ ] Pass extension tests and build all browser targets.

```bash
rtk npm run test:unit -- tests/extension-bootstrap-integration.test.tsx tests/current-tabs-sheet.test.tsx tests/extension-collection-rows.test.tsx tests/extension-style-consistency.test.tsx tests/extension-motion.test.ts
rtk npm run build:extension
```

- [ ] Commit the extension switch.

```bash
rtk git add extension/src.tsx extension/style.css extension/CurrentTabsSheet.tsx extension/BrowserBookmarksPanel.tsx tests/extension-bootstrap-integration.test.tsx tests/current-tabs-sheet.test.tsx tests/extension-style-consistency.test.tsx tests/extension-motion.test.ts
rtk git commit -m "feat: restore classic extension organizer"
```

## Task 6: Switch `/app` to the same classic presentation

**Files:**
- Modify: `app/app/WorkspaceClient.tsx`
- Modify: `app/globals.css`
- Test: `tests/web-organizer-parity.test.tsx`
- Test: `tests/web-workspace-bootstrap.test.tsx`
- Test: `tests/workspace.test.tsx`
- Test: `tests/e2e/web-extension-parity.spec.ts`

- [ ] Update web parity tests to assert the same classic shell, header, space rail, collection/card classes, search dialog, dialogs, and toasts as the extension. Assert that Current Tabs is absent on web and Trash exists only in the account dropdown.

```tsx
expect(screen.getByTestId("classic-workspace-organizer")).toBeVisible();
expect(screen.queryByRole("complementary", { name: "Current tabs" })).not.toBeInTheDocument();
expect(screen.getByRole("button", { name: "New collection" })).toBeVisible();
expect(screen.getByRole("button", { name: "Search" })).toBeVisible();
expect(within(screen.getByRole("banner")).queryByRole("button", { name: "Trash" })).not.toBeInTheDocument();
```

- [ ] Confirm the focused web tests fail before switching `/app`.

```bash
rtk npm run test:unit -- tests/web-organizer-parity.test.tsx tests/web-workspace-bootstrap.test.tsx tests/workspace.test.tsx
```

- [ ] Replace `WorkspaceOrganizerView` with `ClassicWorkspaceOrganizerView` in `WorkspaceClient.tsx`. Keep the existing controller, preference scope, deep-linked collection selection, account dropdown, sign-out, sharing, Trash, and rollback-on-failure policy unchanged.

- [ ] Remove web-only modern organizer overrides from `app/globals.css`. Keep only layout integration and account-menu styling that cannot live in shared classic CSS.

- [ ] Ensure `/app` account status retains green Synced, yellow Syncing, and red Offline/Failed colors, including subtitle text.

- [ ] Pass web unit tests, then run web/extension parity E2E.

```bash
rtk npm run test:unit -- tests/web-organizer-parity.test.tsx tests/web-workspace-bootstrap.test.tsx tests/workspace.test.tsx
rtk npx playwright test tests/e2e/web-extension-parity.spec.ts --project=chromium
```

- [ ] Commit the `/app` switch.

```bash
rtk git add app/app/WorkspaceClient.tsx app/globals.css tests/web-organizer-parity.test.tsx tests/web-workspace-bootstrap.test.tsx tests/workspace.test.tsx tests/e2e/web-extension-parity.spec.ts
rtk git commit -m "feat: align web workspace with classic organizer"
```

## Task 7: Lock visual parity and remove only unreachable presentation code

**Files:**
- Modify: `tests/e2e/fixtures/organizer.ts`
- Modify: `tests/e2e/fixtures/organizer-web.tsx`
- Modify: `tests/e2e/visual-consistency.spec.ts`
- Modify: `tests/e2e/web-extension-parity.spec.ts`
- Update: `tests/e2e/__screenshots__/visual-consistency.spec.ts/*`
- Update: `tests/e2e/__screenshots__/web-extension-parity.spec.ts/*`
- Potentially delete after proof: `shared/organizer/WorkspaceShell.tsx`
- Potentially delete after proof: `shared/organizer/WorkspaceHeader.tsx`
- Potentially delete after proof: `shared/organizer/SpaceRail.tsx`
- Modify: `shared/organizer/index.ts`

- [ ] Add deterministic visual fixtures for desktop light, desktop dark, constrained-width light, constrained-width dark, open Search, open modal, open account menu, expanded Current Tabs, and a collection drag preview.

- [ ] Compare the resulting screenshots with `e09da72` as the reference. Accept only intentional differences required by current capabilities (Share, Trash/Undo, sync status, and current action set), all styled in the classic language.

```bash
rtk npx playwright test tests/e2e/visual-consistency.spec.ts tests/e2e/web-extension-parity.spec.ts --project=chromium-visual --update-snapshots
rtk npx playwright test tests/e2e/visual-consistency.spec.ts tests/e2e/web-extension-parity.spec.ts --project=chromium-visual --project=firefox-visual --project=webkit-visual
```

- [ ] Search imports and graph references before deleting anything. Remove only the obsolete modern shell/header/rail files that have zero production and test consumers; otherwise leave them in place for a later cleanup.

```bash
rtk rg 'WorkspaceShell|WorkspaceHeader|SpaceRail|WorkspaceOrganizerView' app extension shared tests
rtk npx tsc --noEmit
```

- [ ] Verify accessibility-critical behavior: tab order, visible focus, Escape dismissal/restoration, keyboard link movement, collapse buttons, account menu, and reduced motion.

- [ ] Commit visual baselines and proven cleanup.

```bash
rtk git add shared/organizer tests/e2e
rtk git commit -m "test: lock classic organizer visual parity"
```

## Task 8: Run release gates and produce updated packages

**Files:**
- Verify: `dist-extension/chromium/`
- Verify: `dist-extension/firefox/`
- Verify: `dist-extension/safari/`
- Verify: `dist-extension/packages/`
- Verify: `public/downloads/`
- Modify only if the existing release script requires it: package metadata/version files

- [ ] Run the complete repository verification. Do not claim completion while any gate fails.

```bash
rtk npm run verify
```

- [ ] Run browser interaction E2E for drag/drop, bookmarks, sharing, Trash, and visual parity.

```bash
rtk npx playwright test tests/e2e/organizer-drag.spec.ts tests/e2e/browser-bookmarks.spec.ts tests/e2e/collection-sharing.spec.ts tests/e2e/workspace-trash.spec.ts --project=chromium
rtk npm run test:e2e:visual
```

- [ ] Build/package Chromium, Firefox, and Safari with the existing release workflow. `extension/scripts/build-extension.mjs` must regenerate the three website archives directly in `public/downloads`; do not manually edit generated archives.

```bash
rtk npm run build:extension
```

- [ ] Verify package manifests, versions, checksums, and website download links point to the newly generated files.

```bash
rtk find dist-extension public/downloads -maxdepth 3 -type f
rtk git status --short
```

- [ ] Request a code review using `superpowers:requesting-code-review`, address all correctness findings, and rerun affected tests.

- [ ] Run `superpowers:verification-before-completion`, then commit generated release metadata/packages only if the repository already tracks them.

```bash
rtk git add public/downloads/tabloom-chromium.zip public/downloads/tabloom-firefox.zip public/downloads/tabloom-safari.zip
rtk git commit -m "build: refresh classic organizer packages"
```

- [ ] Stop before production deployment unless the user explicitly authorizes deployment in the execution session. Once authorized, deploy the web app and package downloads together, then smoke-test `/`, `/app`, sign-in return, sharing, Trash, and each public download URL.
