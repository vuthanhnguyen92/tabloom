# Tabloom Logo and Current-Tab Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved Woven Tabs identity and let users press Command-F or Control-F in Tabloom to search supported tabs in the current browser window alongside saved links, activate an existing result, and close the calling Tabloom tab.

**Architecture:** Keep the SVG as one shared source asset, generate browser package icons deterministically during builds, and render the same mark in hosted and extension surfaces. Keep current-window tab discovery transient and adapter-backed: `GlobalSearch` loads tabs each time it opens, a pure module filters and searches them, and the browser adapter owns activate-then-close ordering.

**Tech Stack:** React 19, TypeScript 5.9, Vite/Vinext, WebExtension Manifest V3 APIs, Vitest + Testing Library, Playwright, Sharp for deterministic PNG generation.

**Spec:** `docs/superpowers/specs/2026-08-31-tabloom-logo-current-tab-search-design.md`

## Global Constraints

- Search only tabs in the current browser window. Do not query other windows.
- Override browser Find only while the Tabloom page is focused. Use Command-F on macOS and Control-F elsewhere; Command-K/Control-K must stop opening Tabloom search.
- Do not add permissions. Existing `tabs` access is sufficient.
- Do not persist or synchronize current-tab search data. Query the browser every time the overlay opens; Supabase remains uninvolved.
- Show `Current tabs` before `Saved links`; keep one continuous keyboard-selection index and do not deduplicate matching URLs across sources.
- Activate an existing browser tab before removing the calling Tabloom tab. Never open a duplicate current-tab result.
- Preserve the existing Current Tabs sheet, local-first workspace behavior, mini-toast error flow, selected-space preference, and all cross-browser build targets.
- The worktree already contains approved uncommitted changes in `extension/src.tsx`, `extension/style.css`, and `tests/e2e/visual-consistency.spec.ts`. Review diffs before editing and stage only this plan's hunks with `rtk git add -p` for those files.
- Do not modify or stage `shared/workspace-merge.ts`, `shared/toby-import.ts`, `tests/toby-import.test.ts`, `.superpowers/`, or unrelated dirty hunks.
- Never use `git add .`.

---

## File Structure

### New files

- `shared/assets/tabloom-mark.svg` — canonical Woven Tabs vector source.
- `shared/TabloomMark.tsx` — accessible shared React renderer backed by the canonical asset.
- `extension/current-tab-search.ts` — pure current-tab eligibility, matching, and result-model rules.
- `extension/scripts/generate-extension-icons.mjs` — deterministic 16/32/48/128 PNG writer.
- `tests/tabloom-mark.test.tsx` — shared logo rendering coverage.
- `tests/current-tab-search.test.ts` — filtering and text matching coverage.
- `tests/extension-icon-build.test.ts` — source-to-raster output checks.

### Modified files

- `app/components/Brand.tsx`, `app/globals.css`, `public/favicon.svg` — hosted branding.
- `extension/src.tsx`, `extension/style.css`, `extension/index.html` — extension branding, search wiring, and favicon.
- `extension/browser/types.ts`, `extension/browser/webextension.ts` — activate-existing-tab adapter contract.
- `extension/GlobalSearch.tsx` — current-tab loading, combined results, and Command-F/Control-F behavior.
- `extension/scripts/build-extension.mjs` — icon generation for every target output.
- `extension/manifests/chromium.json`, `extension/manifests/firefox.json`, `extension/manifests/safari.json` — shared icon paths.
- `tests/browser-adapter.test.ts`, `tests/browser-manifests.test.ts`, `tests/global-search.test.tsx` — contract and UI coverage.
- `tests/e2e/browser-bookmarks.spec.ts`, `tests/e2e/visual-consistency.spec.ts` — packaged extension behavior and visual fixture coverage.
- `package.json`, `package-lock.json` — Sharp build dependency.

---

## Task 1: Establish the Shared Woven Tabs Mark

**Files:**

- Create: `shared/assets/tabloom-mark.svg`
- Create: `shared/TabloomMark.tsx`
- Create: `tests/tabloom-mark.test.tsx`
- Modify: `app/components/Brand.tsx`
- Modify: `app/globals.css`
- Modify: `public/favicon.svg`
- Modify: `extension/src.tsx`

**Interfaces:**

```tsx
export type TabloomMarkProps = {
  className?: string;
  title?: string;
};

export function TabloomMark({ className, title }: TabloomMarkProps): React.JSX.Element;
```

- [ ] **Step 1: Add a failing shared-mark component test.**

```tsx
// tests/tabloom-mark.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TabloomMark } from "../shared/TabloomMark";

describe("TabloomMark", () => {
  it("renders the canonical mark as decorative by default", () => {
    const { container } = render(<TabloomMark className="test-mark" />);
    const image = container.querySelector("img.test-mark");
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("aria-hidden", "true");
    expect(image?.getAttribute("src")).toContain("tabloom-mark.svg");
  });

  it("can expose an accessible title", () => {
    render(<TabloomMark title="Tabloom" />);
    expect(screen.getByRole("img", { name: "Tabloom" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Verify the test fails because the component does not exist.**

Run: `rtk npx vitest run tests/tabloom-mark.test.tsx`

Expected: FAIL with an unresolved `../shared/TabloomMark` import.

- [ ] **Step 3: Add the exact canonical SVG.**

```svg
<!-- shared/assets/tabloom-mark.svg and byte-identical public/favicon.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="17" fill="#292637"/>
  <rect x="11" y="12" width="31" height="31" rx="9" fill="#F56F72"/>
  <rect x="22" y="21" width="31" height="31" rx="9" fill="#7657E8"/>
  <path d="M22 27a6 6 0 0 1 6-6h14v16a6 6 0 0 1-6 6H22V27Z" fill="#BFAFFF" opacity=".72"/>
  <circle cx="47" cy="27" r="2.5" fill="#F7F4FF"/>
</svg>
```

- [ ] **Step 4: Implement the shared renderer and replace hosted/extension marks.**

```tsx
// shared/TabloomMark.tsx
import markUrl from "./assets/tabloom-mark.svg";

export type TabloomMarkProps = { className?: string; title?: string };

export function TabloomMark({ className, title }: TabloomMarkProps) {
  return (
    // The source is a bundled local asset shared by hosted and extension surfaces.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      className={className}
      src={markUrl}
    />
  );
}
```

Update `Brand` to render `<TabloomMark className="brand-mark" />` followed by the existing lowercase wordmark. Update extension `Mark` to render `<TabloomMark className="ext-brand-mark" />` followed by `tabloom`. Remove the old flower/star child markup and replace its CSS with fixed square image sizing; do not add the mark to the collapsed sidebar's top control.

- [ ] **Step 5: Verify component and existing brand tests pass.**

Run: `rtk npx vitest run tests/tabloom-mark.test.tsx tests/extension-style-consistency.test.tsx tests/space-sidebar.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit only the shared branding work.**

```bash
rtk git add shared/assets/tabloom-mark.svg shared/TabloomMark.tsx tests/tabloom-mark.test.tsx app/components/Brand.tsx app/globals.css public/favicon.svg
rtk git add -p extension/src.tsx
rtk git diff --cached --check
rtk git commit -m "feat: adopt woven tabs brand mark"
```

---

## Task 2: Generate and Package Browser Icons Deterministically

**Files:**

- Create: `extension/scripts/generate-extension-icons.mjs`
- Create: `tests/extension-icon-build.test.ts`
- Modify: `extension/scripts/build-extension.mjs`
- Modify: `extension/manifests/chromium.json`
- Modify: `extension/manifests/firefox.json`
- Modify: `extension/manifests/safari.json`
- Modify: `extension/index.html`
- Modify: `tests/browser-manifests.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

```js
export const extensionIconSizes = [16, 32, 48, 128];
export async function generateExtensionIcons(outputDirectory, sourcePath): Promise<void>;
```

- [ ] **Step 1: Install the raster dependency and add failing icon tests.**

Run: `rtk npm install --save-dev sharp`

Add a test that imports `generateExtensionIcons`, writes to a temporary directory, and asserts each PNG exists, is a PNG, and has the requested square dimensions via `sharp(path).metadata()`. Extend the manifest test to require this exact map in every target:

```ts
const icons = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
};
expect(manifest.icons).toEqual(icons);
```

- [ ] **Step 2: Verify tests fail before the generator and manifest fields exist.**

Run: `rtk npx vitest run tests/extension-icon-build.test.ts tests/browser-manifests.test.ts`

Expected: FAIL on missing generator and `manifest.icons`.

- [ ] **Step 3: Implement the deterministic generator.**

```js
// extension/scripts/generate-extension-icons.mjs
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

export const extensionIconSizes = [16, 32, 48, 128];

export async function generateExtensionIcons(outputDirectory, sourcePath) {
  const iconDirectory = resolve(outputDirectory, "icons");
  await mkdir(iconDirectory, { recursive: true });
  await Promise.all(extensionIconSizes.map((size) =>
    sharp(sourcePath)
      .resize(size, size, { fit: "fill" })
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toFile(resolve(iconDirectory, `icon-${size}.png`)),
  ));
}
```

- [ ] **Step 4: Wire icons into builds and HTML.**

Import the generator in `build-extension.mjs`, resolve `shared/assets/tabloom-mark.svg`, and `await generateExtensionIcons(output, markSource)` after each Vite target build. Add the exact `icons` map above to all manifests. Add `<link rel="icon" href="/icons/icon-32.png" type="image/png">` to `extension/index.html` so the packaged new-tab document uses the same mark.

- [ ] **Step 5: Verify generation and every target build.**

```bash
rtk npx vitest run tests/extension-icon-build.test.ts tests/browser-manifests.test.ts
rtk npm run build:extension
rtk node -e 'for (const t of ["chromium","firefox","safari"]) for (const s of [16,32,48,128]) require("node:fs").accessSync(`dist-extension/${t}/icons/icon-${s}.png`)'
```

Expected: PASS and all twelve raster files exist.

- [ ] **Step 6: Commit icon packaging.**

```bash
rtk git add extension/scripts/generate-extension-icons.mjs extension/scripts/build-extension.mjs extension/manifests/chromium.json extension/manifests/firefox.json extension/manifests/safari.json extension/index.html tests/extension-icon-build.test.ts tests/browser-manifests.test.ts package.json package-lock.json
rtk git diff --cached --check
rtk git commit -m "build: package shared extension icons"
```

---

## Task 3: Add Activate-Existing-Tab to the Browser Adapter

**Files:**

- Modify: `extension/browser/types.ts`
- Modify: `extension/browser/webextension.ts`
- Modify: `tests/browser-adapter.test.ts`

**Interfaces:**

```ts
export type ActivateExistingTabResult = {
  tabloomClosed: boolean;
  cleanupError?: string;
};

// WebExtensionNamespace.tabs additions
query(queryInfo: { currentWindow: boolean; active?: boolean }): Promise<BrowserTab[]>;
update(tabId: number, updateProperties: { active: boolean }): Promise<BrowserTab>;

// BrowserAdapter.tabs addition
activateExisting(tabId: number): Promise<ActivateExistingTabResult>;
```

- [ ] **Step 1: Extend the adapter test namespace with `tabs.update` and add failing ordering tests.**

Cover these cases:

```ts
it("activates an existing tab before closing the calling Tabloom tab", async () => {
  const namespace = createNamespace();
  const adapter = createWebExtensionAdapter("chromium", namespace);
  await expect(adapter.tabs.activateExisting(9)).resolves.toEqual({ tabloomClosed: true });
  expect(namespace.tabs.query).toHaveBeenCalledWith({ currentWindow: true, active: true });
  expect(namespace.tabs.update).toHaveBeenCalledWith(9, { active: true });
  expect(namespace.tabs.update.mock.invocationCallOrder[0]).toBeLessThan(namespace.tabs.remove.mock.invocationCallOrder[0]);
  expect(namespace.tabs.remove).toHaveBeenCalledWith(1);
});
```

Also assert: update rejection causes no remove; remove rejection returns `{ tabloomClosed: false, cleanupError: "close failed" }`; target equal to the caller skips removal.

- [ ] **Step 2: Verify RED.**

Run: `rtk npx vitest run tests/browser-adapter.test.ts`

Expected: FAIL because `activateExisting` and `tabs.update` are absent.

- [ ] **Step 3: Implement activate-then-close once in the shared WebExtension adapter.**

```ts
async activateExisting(tabId) {
  const [callingTab] = await api.tabs.query({ currentWindow: true, active: true });
  await api.tabs.update(tabId, { active: true });
  if (typeof callingTab?.id !== "number" || callingTab.id === tabId) {
    return { tabloomClosed: false };
  }
  try {
    await api.tabs.remove(callingTab.id);
    return { tabloomClosed: true };
  } catch (error) {
    return {
      tabloomClosed: false,
      cleanupError: error instanceof Error ? error.message : "Tabloom could not close the previous new tab.",
    };
  }
}
```

Because Chromium, Firefox, and Safari all build from `createWebExtensionAdapter`, this single implementation supplies the common contract; Safari's existing identity override remains untouched.

- [ ] **Step 4: Verify adapter coverage and types.**

Run: `rtk npx vitest run tests/browser-adapter.test.ts && rtk npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit the adapter contract.**

```bash
rtk git add extension/browser/types.ts extension/browser/webextension.ts tests/browser-adapter.test.ts
rtk git diff --cached --check
rtk git commit -m "feat: activate existing browser tabs"
```

---

## Task 4: Add Pure Current-Tab Search Rules

**Files:**

- Create: `extension/current-tab-search.ts`
- Create: `tests/current-tab-search.test.ts`

**Interfaces:**

```ts
import type { BrowserTab } from "../shared/capture";

export type CurrentTabSearchResult = {
  kind: "current-tab";
  tab: BrowserTab & { id: number; url: string };
};

export function currentTabCandidates(tabs: readonly BrowserTab[]): CurrentTabSearchResult[];
export function searchCurrentTabs(tabs: readonly BrowserTab[], query: string): CurrentTabSearchResult[];
```

- [ ] **Step 1: Write failing eligibility and matching tests.**

Use a fixture containing valid HTTP and HTTPS tabs plus `chrome://settings`, `about:config`, `safari-web-extension://tabloom/index.html`, an active extension tab, and a tab without an ID. Assert only inactive supported tabs with numeric IDs remain. Assert case-insensitive title and URL matching and empty-query behavior returns no visible search results.

- [ ] **Step 2: Verify RED.**

Run: `rtk npx vitest run tests/current-tab-search.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure functions.**

```ts
// extension/current-tab-search.ts
import type { BrowserTab } from "../shared/capture";

export type CurrentTabSearchResult = {
  kind: "current-tab";
  tab: BrowserTab & { id: number; url: string };
};

function supportedUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function currentTabCandidates(tabs: readonly BrowserTab[]): CurrentTabSearchResult[] {
  return tabs.flatMap((tab) =>
    typeof tab.id === "number" && !tab.active && supportedUrl(tab.url)
      ? [{ kind: "current-tab" as const, tab: { ...tab, id: tab.id, url: tab.url } }]
      : [],
  );
}

export function searchCurrentTabs(tabs: readonly BrowserTab[], query: string): CurrentTabSearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  return currentTabCandidates(tabs).filter(({ tab }) =>
    `${tab.title ?? ""} ${tab.url}`.toLocaleLowerCase().includes(normalized),
  );
}
```

- [ ] **Step 4: Verify rules and lint.**

Run: `rtk npx vitest run tests/current-tab-search.test.ts && rtk npx eslint extension/current-tab-search.ts tests/current-tab-search.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the domain rules.**

```bash
rtk git add extension/current-tab-search.ts tests/current-tab-search.test.ts
rtk git diff --cached --check
rtk git commit -m "feat: search supported current tabs"
```

---

## Task 5: Combine Current Tabs and Saved Links in Global Search

**Files:**

- Modify: `extension/GlobalSearch.tsx`
- Modify: `extension/style.css`
- Modify: `tests/global-search.test.tsx`

**Interfaces:**

```ts
export type GlobalSearchProps = {
  snapshot: WorkspaceSnapshot;
  listCurrentTabs: () => Promise<BrowserTab[]>;
  onActivateCurrentTab: (tabId: number) => Promise<void>;
  onError?: (message: string) => void;
  onOpen?: (link: SavedLink) => void;
};

type CombinedSearchResult =
  | CurrentTabSearchResult
  | ({ kind: "saved-link" } & WorkspaceSearchResult);
```

- [ ] **Step 1: Rewrite component tests around the new contract before changing UI code.**

Add a default `listCurrentTabs` fixture and cover:

- Command-F and Control-F dispatches have `defaultPrevented === true`, open search, and call `listCurrentTabs` once per opening.
- Command-K no longer opens the dialog.
- Closing and reopening performs a second fresh browser read.
- A matching current tab appears under `Current tabs`; a matching saved link appears under `Saved links`.
- Identical URLs remain in both sections.
- Arrow keys move across the flattened current-tab-first/saved-link-second ordering.
- Enter on a current tab calls `onActivateCurrentTab(id)` and does not call `window.open`.
- A current-tab read rejection leaves saved search usable, displays a compact error, and a `Retry current tabs` button reruns the read.

Use a cancelable native event for shortcut assertions:

```ts
const shortcut = new window.KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true });
window.dispatchEvent(shortcut);
expect(shortcut.defaultPrevented).toBe(true);
```

- [ ] **Step 2: Verify RED.**

Run: `rtk npx vitest run tests/global-search.test.tsx`

Expected: FAIL on old shortcut, missing props, and absent current-tab sections.

- [ ] **Step 3: Implement fresh loading and combined result state.**

In `GlobalSearch` add `currentTabs`, `currentTabsLoading`, and `currentTabsError` state. Make `showSearch` open/reset synchronously and then call an internal `loadCurrentTabs()` that handles rejection without blocking saved results. Compute:

```ts
const currentTabResults = useMemo(() => searchCurrentTabs(currentTabs, query), [currentTabs, query]);
const savedLinkResults = useMemo(
  () => searchWorkspace(snapshot, query).map((result) => ({ kind: "saved-link" as const, ...result })),
  [snapshot, query],
);
const results: CombinedSearchResult[] = [...currentTabResults, ...savedLinkResults];
```

Render source headings only when the corresponding section has results. Current-tab rows are `<button type="button">` elements with favicon/monogram, title, hostname, and `Current window`; saved rows remain anchors with space/collection/source context. Use each result's position in `results` for a single `activeIndex`.

- [ ] **Step 4: Implement capture-phase Command-F/Control-F.**

```ts
useEffect(() => {
  function handleShortcut(event: globalThis.KeyboardEvent) {
    if (event.key.toLocaleLowerCase() !== "f" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    event.stopPropagation();
    if (open) closeSearch();
    else void showSearch();
  }
  window.addEventListener("keydown", handleShortcut, { capture: true });
  return () => window.removeEventListener("keydown", handleShortcut, { capture: true });
}, [open]);
```

Change the trigger hint to `⌘ F`. Update the idle copy to `Search current tabs, saved links, spaces, collections, and bookmarks`. Keep Escape and backdrop behavior unchanged.

- [ ] **Step 5: Add balanced styles.**

Add opaque source headings, button resets matching saved anchors, loading/error rows, and a retry action. Reuse existing favicon sizing, focus/selected colors, and motion variables; do not change modal geometry or the full-screen backdrop behavior.

- [ ] **Step 6: Verify component behavior and style consistency.**

Run: `rtk npx vitest run tests/global-search.test.tsx tests/extension-style-consistency.test.tsx`

Expected: PASS with no React act warnings or unhandled promises.

- [ ] **Step 7: Commit only search UI hunks.**

```bash
rtk git add extension/GlobalSearch.tsx tests/global-search.test.tsx
rtk git add -p extension/style.css
rtk git diff --cached --check
rtk git commit -m "feat: search current tabs from global search"
```

---

## Task 6: Wire Adapter Activation and Package-Level Behavior

**Files:**

- Modify: `extension/src.tsx`
- Modify: `tests/e2e/browser-bookmarks.spec.ts`
- Modify: `tests/e2e/visual-consistency.spec.ts`

**Interfaces:**

```ts
async function activateCurrentTab(tabId: number): Promise<void>;
```

- [ ] **Step 1: Add a packaged Chromium acceptance test before wiring.**

In `browser-bookmarks.spec.ts`, open a normal page and a Tabloom new tab in the same persistent context, press Meta-F in Tabloom, search the normal page's title, select the `Current window` result, then assert the original page becomes active and the Tabloom page closes. Use `context.waitForEvent("page")` only for creating the initial pages; selecting the result must not create another page.

- [ ] **Step 2: Verify the package test fails on the unwired component.**

Run: `rtk npm run build:extension:chromium && rtk npx playwright test tests/e2e/browser-bookmarks.spec.ts --project=chromium --grep "activates a current-tab search result"`

Expected: FAIL because global search does not list or activate the current tab.

- [ ] **Step 3: Wire `ExtensionApp` to the adapter without disturbing selected-space state.**

Pass:

```tsx
<GlobalSearch
  listCurrentTabs={() => browserAdapter.tabs.listCurrentWindow()}
  onActivateCurrentTab={async (tabId) => {
    try {
      const result = await browserAdapter.tabs.activateExisting(tabId);
      if (result.cleanupError) showToast(result.cleanupError, "error");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tabloom could not switch to that tab.";
      showToast(message, "error");
      throw error;
    }
  }}
  onError={(message) => showToast(message, "error")}
  snapshot={snapshot}
/>
```

Adapt the exact toast helper signature already present in `ExtensionApp`; do not introduce a second notification system. `GlobalSearch` closes after a successful activation call and remains open on rejection so retry is possible.

- [ ] **Step 4: Update the cross-browser visual fixture.**

Update the visible shortcut from `⌘ K` to `⌘ F`, and add deterministic `Current tabs` and `Saved links` section fixtures to the search-overlay screenshot. Preserve the already-approved full-screen backdrop, collapsed rail, and account dropdown states in the existing dirty test file.

- [ ] **Step 5: Verify packaged behavior and visuals.**

```bash
rtk npm run build:extension:chromium
rtk npx playwright test tests/e2e/browser-bookmarks.spec.ts --project=chromium --grep "activates a current-tab search result"
rtk npm run test:e2e:visual
```

Expected: current-tab activation passes without opening a duplicate; visual snapshots either match or are intentionally regenerated and reviewed for all three engines.

- [ ] **Step 6: Commit only activation wiring and reviewed test hunks.**

```bash
rtk git add tests/e2e/browser-bookmarks.spec.ts
rtk git add -p extension/src.tsx tests/e2e/visual-consistency.spec.ts
rtk git diff --cached --check
rtk git commit -m "feat: switch to current tabs from search"
```

---

## Task 7: Final Cross-Browser Verification and Documentation Audit

**Files:**

- Verify all files changed in Tasks 1–6.
- Modify only failing tests or documentation directly related to the approved spec.

- [ ] **Step 1: Run focused unit and component coverage.**

```bash
rtk npx vitest run tests/tabloom-mark.test.tsx tests/extension-icon-build.test.ts tests/browser-manifests.test.ts tests/browser-adapter.test.ts tests/current-tab-search.test.ts tests/global-search.test.tsx tests/extension-style-consistency.test.tsx tests/space-sidebar.test.tsx
```

- [ ] **Step 2: Run static checks.**

```bash
rtk npm run lint
rtk npx tsc --noEmit
```

- [ ] **Step 3: Build every production surface.**

```bash
rtk npm run build
rtk npm run build:extension
```

Inspect each `dist-extension/<target>/manifest.json` and confirm its icon paths resolve. Confirm no target requests a new permission.

- [ ] **Step 4: Run extension and visual acceptance suites.**

```bash
rtk npm run test:e2e:bookmarks
rtk npm run test:e2e:visual
```

The live Supabase tests may remain skipped unless their documented credentials are present; current-tab search itself must not make Supabase requests.

- [ ] **Step 5: Audit against every acceptance criterion.**

Verify manually or by test evidence:

- Woven Tabs appears in hosted branding, favicon, extension wordmark, and all packaged icon sizes.
- Expanded branding changes do not reintroduce a collapsed-rail logo stack.
- Command-F/Control-F suppress browser Find only in Tabloom; Command-K/Control-K does nothing.
- Reopening search refreshes current-window tabs.
- Current tabs precede saved links and share one keyboard index.
- Duplicate URLs may appear in both semantic sections.
- Choosing a current tab activates it, then closes Tabloom, and never opens a new tab.
- Activation failure preserves Tabloom; close cleanup failure reports a mini toast after activation.
- Chrome, Firefox, and Safari builds use the same UI and adapter implementation.

- [ ] **Step 6: Scan for placeholders and unintended changes.**

```bash
rtk rg -n "TODO|TBD|implement later|placeholder" shared/TabloomMark.tsx extension/current-tab-search.ts extension/GlobalSearch.tsx extension/browser extension/scripts tests/tabloom-mark.test.tsx tests/current-tab-search.test.ts tests/extension-icon-build.test.ts
rtk git diff --check
rtk git status --short
```

Expected: no feature placeholders, no whitespace errors, and unrelated dirty Toby-import/selected-space files remain unstaged unless they were independently committed before execution.

- [ ] **Step 7: Create a final corrective commit only if verification required changes.**

Stage explicit related files or feature-only hunks, then:

```bash
rtk git diff --cached --check
rtk git commit -m "test: verify current-tab search across browsers"
```

Do not create an empty commit.
