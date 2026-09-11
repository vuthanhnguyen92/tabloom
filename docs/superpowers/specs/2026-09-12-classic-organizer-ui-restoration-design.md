# Classic Organizer UI Restoration Design

**Date:** 2026-09-12  
**Status:** Approved design  
**Experience reference:** Git commit `e09da72` (`fix OAuth client compatibility`)

## Summary

Restore the Tabloom extension and `/app` workspace to the visual language and interaction experience that existed at `e09da72`, before the shared-organizer UI merge. Keep the current controller, local-first repositories, synchronization protocol, Trash recovery, sharing, OAuth, MCP, browser adapters, and database behavior.

This is a presentation-layer restoration, not a source rollback. Reverting the shared-organizer merge wholesale would also remove newer correctness and product capabilities and is explicitly out of scope.

## Goals

- Make the Chromium, Firefox, and Safari extensions look and behave like the `e09da72` organizer experience.
- Give `https://tabloom.nickvu.dev/app` the same classic organizer UI as the extension.
- Preserve one shared presentation for spaces, collections, saved-link cards, global search, dialogs, toasts, and account controls.
- Preserve all newer backend and data behavior.
- Keep browser-only functionality isolated from the shared presentation.
- Remove the redundant header Trash action; Trash remains available through the account menu.

## Non-goals

- Reverting database migrations, OAuth changes, MCP tools, sharing, Trash, or sync reconciliation.
- Restoring independent extension and web synchronization implementations.
- Reintroducing demo-only language or behavior.
- Redesigning the marketing landing page or public shared-collection page.
- Changing the schema or stored workspace data.
- Removing newer user capabilities merely because they did not exist at `e09da72`.

## Design principles

### Reference fidelity

The checked-in code and styles at `e09da72` are the source of truth for visual density, spacing, typography, cards, collection rows, space navigation, Current Tabs, drag affordances, dialogs, and search behavior. The implementation may adapt markup for accessibility and controller integration, but it must not reinterpret the classic experience into another redesign.

### Current behavior underneath

The current shared workspace controller remains the owner of workspace state and commands. The classic presentation receives state and callbacks from that controller. It does not load Supabase directly, maintain a second canonical snapshot, or create a separate mutation queue.

### Shared where behavior is shared

The extension and `/app` use the same classic presentation components for common organizer behavior. Platform-specific features enter through explicit slots and capabilities rather than browser checks scattered throughout shared components.

## Architecture

### Classic presentation layer

Introduce a classic organizer renderer based on the `e09da72` components and styles. Its public contract is driven by the existing controller and organizer capabilities. It composes:

- Classic workspace shell and header
- Space navigation
- Collection rows and collection headers
- Saved-link cards
- Global search
- Dialogs and confirmation flows
- Mini toasts
- Account controls

The renderer must not depend directly on Chrome, Firefox, Safari, Supabase, or Next.js APIs.

### Platform composition

The extension composition supplies:

- Current-window tabs sheet
- Browser tab activation and closing
- Browser bookmarks where supported
- Browser permission requests
- Extension account and sync status actions
- Extension-specific favicon resolution and cached assets

The `/app` composition supplies:

- Web account controls
- Web routing
- Supabase-backed sharing
- Web Trash repository
- No Current Tabs panel or browser-only actions

Both compositions use the same current controller and repository contracts.

### Transition strategy

Keep the newer shared-organizer renderer available internally during implementation until classic parity and regression tests pass. Switch both product surfaces to the classic renderer together. Remove dead presentation code only after the new route is verified, so the change remains easy to review and reverse during development.

This temporary coexistence is an implementation safety mechanism, not a user-facing theme or permanent UI toggle.

## User experience

### Header

The primary header contains:

- New Collection
- Search
- Account menu

The standalone Trash icon beside New Collection is removed. Trash is available from the account menu only.

### Spaces and collections

- Space navigation follows the `e09da72` layout and density.
- Existing selected-space persistence remains active and is applied before showing the workspace.
- Collections retain collapse, reorder, rename, delete, share, Open All, and link-drop behavior.
- Persisted collapsed states remain authoritative.
- Newer collection actions use classic sizing, colors, hover states, and placement.

### Saved links

- Cards follow the classic `e09da72` appearance and click-first cursor behavior.
- Drag handles remain small explicit affordances.
- Edit, delete, favicon fallback, cross-collection movement, and keyboard movement remain available.
- Opening behavior remains current: normal click uses the current tab and the browser modifier opens a new tab.

### Current Tabs

Current Tabs remains extension-only and follows the previous side-sheet experience. It preserves current capabilities including live tab removal, duplicate closing, drag-to-collection, confirmation before closing a captured tab, and save-all-to-new-collection.

### Search

Global search retains the current cross-space, cross-collection, saved-link, bookmark, and current-window tab coverage. Its visuals and transitions return to the classic experience. Browser-tab results activate the existing tab instead of opening a duplicate.

### Account, sync, Trash, and notifications

- The account menu remains on the right side of Search.
- It shows basic account information, sync status, Trash, and Sign out where applicable.
- Sync status retains the established green, yellow, and red states.
- Trash supports current restore and purge behavior.
- Undo and mutation notifications use three-second mini toasts unless a persistent retry action is required.
- Failed local-first synchronization keeps the local change and exposes Retry.

### Sharing and shared saves

- Mutable saved collections retain the Share action.
- Bookmark collections remain read-only and unshareable.
- Shared-collection saving and OAuth return continue to target the copied collection in `/app`.
- These newer controls are restyled to match the classic UI rather than removed.

## State and data flow

1. The platform bootstrap constructs the current repository, preference store, Trash repository, sharing adapter, and capabilities.
2. The existing controller loads the canonical local snapshot and stored preferences together.
3. The workspace shell remains hidden or in its neutral loading state until the controller is ready, preventing first-space flashes.
4. The classic renderer reads the controller snapshot and emits controller commands.
5. Mutations update optimistically through the current mutation pipeline.
6. Remote writes occur immediately for signed-in users.
7. Failed writes preserve local state where the extension policy requires it and show the existing retry state; the web policy continues its current rollback behavior.
8. Remote reconciliation occurs through the existing focus/initial-load rules.

No presentation component writes directly to storage or Supabase.

## Accessibility

- Preserve keyboard access for space selection, collection collapse, link movement, menus, dialogs, and search.
- Retain visible focus states and descriptive accessible names.
- Hover-only actions must also appear on keyboard focus.
- Modal focus trapping, Escape handling, and focus restoration remain owned by the current modal infrastructure.
- Drag-and-drop retains keyboard alternatives.
- Motion respects `prefers-reduced-motion`.

## Error handling

- Boot failures show a focused workspace-load error without misreporting a missing deep-linked collection.
- Mutation failures use the current controller policy and do not create a second error channel.
- Persistent sync failures retain Retry; transient success feedback uses mini toasts.
- Unsupported browser capabilities are omitted or disabled through capability configuration, not runtime crashes.
- A failed browser action must leave the source tab open and report the failure.

## Testing

### Reference and visual coverage

- Capture deterministic reference screenshots from the `e09da72` UI for light and dark themes.
- Compare extension and `/app` at desktop and constrained widths.
- Verify classic spacing, card dimensions, typography, navigation, Current Tabs, dialogs, and search presentation.
- Verify Chromium, Firefox, and WebKit render consistently.

### Shared interaction coverage

- Space selection and preference restoration
- Space and collection create/edit/delete flows
- Collection collapse and reorder previews
- Saved-link open, edit, delete, reorder, and cross-collection movement
- Share and save-shared-collection entry points
- Search across multiple spaces and collections
- Trash, Undo, purge, and failed-sync Retry
- Account menu and removal of the header Trash button

Run the same shared interaction contract against the extension composition and `/app` composition.

### Extension-specific coverage

- Current Tabs rendering and live close updates
- Dragging a current tab into a collection
- Close-after-capture confirmation
- Duplicate-tab closing
- Save-all-to-named-collection
- Browser permissions and Open All grouping
- Cached startup and focus-triggered reconciliation

### Regression gates

- Full unit suite
- Supabase pgTAP and database integration suites
- Web end-to-end tests
- Extension Chromium end-to-end tests
- TypeScript and lint
- Production builds for web, MCP, Chromium, Firefox, and Safari
- No console errors on `/app` or the extension new-tab page

## Rollout

1. Implement and validate the classic renderer without altering repositories or database contracts.
2. Switch the extension composition and complete browser-specific regression testing.
3. Switch `/app` to the same renderer and complete web parity testing.
4. Generate all browser packages and production builds.
5. Deploy the web application and updated packages together.
6. Verify `/app`, package downloads, sign-in return, sharing, and sync against production.
7. Remove presentation code proven unreachable after the classic renderer has passed all gates.

No database migration is required for this restoration.

## Acceptance criteria

- A user familiar with the `e09da72` extension recognizes the same layout, density, card treatment, navigation, Current Tabs sheet, search, and dialog experience.
- `/app` uses that same classic organizer presentation.
- Trash is accessible in the account menu and no redundant header Trash icon appears.
- All current sync, recovery, sharing, OAuth, MCP, bookmark, and browser-adapter behavior remains operational.
- Existing workspace data and stored preferences require no conversion.
- All regression gates pass before merge or deployment.
