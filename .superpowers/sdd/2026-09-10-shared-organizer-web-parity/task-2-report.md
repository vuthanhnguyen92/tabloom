# Task 2 — Shared organizer shell report

## RED

- Added `tests/organizer-shell.test.tsx` before shared shell implementation.
- Ran `npx vitest run tests/organizer-shell.test.tsx tests/space-sidebar.test.tsx tests/toast-region.test.tsx`.
- Observed the expected failure: Vite could not resolve `shared/organizer/SpaceRail`; existing sidebar and toast suites still passed.
- Added the shared-style loading and independent-scroll assertion to `tests/extension-style-consistency.test.tsx` before creating the stylesheet.
- Ran `npx vitest run tests/extension-style-consistency.test.tsx` and observed the expected `ENOENT` for `shared/organizer/organizer.css`.

## GREEN

- Created platform-neutral `SpaceRail`, `WorkspaceHeader`, `WorkspaceShell`, and `ToastRegion` components.
- Added a boot state that withholds workspace children until preferences are ready.
- Kept extension import paths through thin adapters for `SpaceSidebar` and `ToastRegion`.
- Added shared organizer tokens and light/dark/reduced-motion shell styles, then imported them from extension and web stylesheets.
- Final focused suite: `20` tests passed across `organizer-shell`, `space-sidebar`, `toast-region`, and `extension-style-consistency`.

## Files

- Created: `shared/organizer/SpaceRail.tsx`, `WorkspaceHeader.tsx`, `WorkspaceShell.tsx`, `ToastRegion.tsx`, `organizer.css`, and `tests/organizer-shell.test.tsx`.
- Updated: `shared/organizer/index.ts`, extension sidebar/toast adapters and stylesheet, web globals stylesheet, and extension style consistency test.

## Verification

- `npx vitest run tests/organizer-shell.test.tsx tests/space-sidebar.test.tsx tests/toast-region.test.tsx tests/extension-style-consistency.test.tsx` — pass (20 tests).
- `npx tsc --noEmit` — pass.
- `npm run lint` — pass.
- `npm run build` — pass for Chromium, Firefox, Safari extension bundles and the web app.
- `git diff --check` — pass.

## Accessibility and CSS self-review

- The rail uses an `aside` plus labeled `nav`; rail buttons retain accessible names and the collapse button exposes `aria-expanded`.
- Collapsed rails are icon-only, with the active state communicated by `aria-current`; expanded titles ellipsize instead of wrapping.
- The workspace header only emits its actions wrapper when actions exist, so unavailable controls consume no width. Account menus are opaque and right-anchored within the header-actions slot.
- Toasts use `status` for success and `alert` for errors; transient toasts auto-dismiss after 3 seconds, while actionable errors remain until explicitly resolved or dismissed.
- The grid shell confines scrolling to the rail and main workspace, retains color tokens for dark/light schemes, and disables nonessential motion when the OS requests reduced motion.

## Concerns

- To avoid extension behavior changes during this extraction, `WorkspaceHeader` and `WorkspaceShell` are exported shared primitives but are not yet composed by `extension/src.tsx`; Task 3 can adopt those slots. The existing extension header and boot wrapper remain intact.

## Review round 1/5

### RED

- Added a fake-timer test that rerenders a transient toast after two seconds and expects dismissal at the original three-second deadline through the newest callback.
- Added cleanup coverage for removed and unmounted transient toasts.
- Added null/false/empty-array header-action coverage and narrow-screen shell policy coverage.
- Ran `npx vitest run tests/organizer-shell.test.tsx tests/extension-style-consistency.test.tsx`; observed the expected four failures: delayed dismissal after rerender, an empty action wrapper, missing narrow side-panel stacking, and duplicate extension dark token declarations.

### GREEN

- `ToastRegion` now uses `globalThis` timers only from effects, keeps a per-ID timer/deadline registry, updates the callback through an effect-backed ref, and clears removed or unmounted timers.
- `WorkspaceHeader` uses `Children.toArray` before deciding whether to emit its actions container.
- At `640px` and below, the shell keeps a 68px rail/main grid, stacks an optional side panel in a second row, and overlays an expanded rail instead of shrinking the main content.
- Removed the duplicate extension dark-mode `:root` token declaration; shared `organizer.css` is the token owner.

### Verification

- `npx vitest run tests/organizer-shell.test.tsx tests/toast-region.test.tsx tests/space-sidebar.test.tsx tests/extension-style-consistency.test.tsx` — pass (25 tests).
- `npx tsc --noEmit` — pass.
- `npm run lint` — pass.
- `npm run build` — pass for Chromium, Firefox, Safari extension bundles and the web app.

## Review round 2/5

### RED

- Added a fake-timer replacement case: a same-ID toast with a new message at 2.5 seconds must not dismiss at the first toast's original three-second deadline and must receive a full new lifetime.
- Added an empty capability-gated `Fragment` action-slot case.
- Ran `npx vitest run tests/organizer-shell.test.tsx tests/toast-region.test.tsx`; observed the expected two failures: the old same-ID timer dismissed the replacement, and the empty fragment emitted an actions wrapper.

### GREEN

- Timer records now retain semantic toast identity (tone, message, and action label/handler) alongside their ID. A same semantic toast retains its deadline; a semantic replacement clears the old handle and starts a new three-second timer using the current dismiss callback.
- Header action normalization now recursively unwraps fragments and only emits the actions wrapper for a renderable string, number, or element descendant.

### Verification

- `npx vitest run tests/organizer-shell.test.tsx tests/toast-region.test.tsx tests/space-sidebar.test.tsx` — pass (18 tests).
- `npx tsc --noEmit` — pass.
- `npm run lint` — pass.
- `npm run build` — pass for Chromium, Firefox, Safari extension bundles and the web app.
