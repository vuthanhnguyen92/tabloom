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
