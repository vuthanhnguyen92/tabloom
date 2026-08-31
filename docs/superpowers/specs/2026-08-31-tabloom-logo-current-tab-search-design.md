# Tabloom Logo and Current-Tab Search Design

## Objective

Adopt the Woven Tabs logo as Tabloom's shared brand mark and extend global search so it can find and activate supported tabs in the current browser window. While Tabloom is focused, Command-F on macOS and Control-F elsewhere opens Tabloom search instead of the browser Find interface.

## Scope

This change applies to the shared extension implementation and all Chrome, Firefox, and Safari builds. The selected logo also replaces existing Tabloom marks and favicons on the hosted product. Search remains limited to the current browser window; it does not inspect or switch to tabs in other windows.

## Brand Assets

The canonical Woven Tabs mark uses a 64-by-64 view box:

- A `#292637` rounded-square background.
- A coral `#F56F72` rounded tab from `(11, 12)` with size `31 × 31`.
- A violet `#7657E8` rounded tab from `(22, 21)` with size `31 × 31`.
- A translucent `#BFAFFF` overlap and a small light status dot.

Store one canonical SVG source in the repository. Use it directly in React branding and the hosted favicon. Generate deterministic 16, 32, 48, and 128 pixel PNG assets for extension manifests because Chromium extension icons require raster files. All target manifests reference the same generated icon set, and the build script copies the assets into each target output.

The expanded sidebar renders the logo beside the lowercase `tabloom` wordmark in Poppins. The collapsed sidebar continues to reserve its top position for the panel-expand control, so the new brand mark does not reintroduce the previously removed logo-and-chevron stack.

## Browser Adapter Contract

Extend the shared tabs adapter with an operation that activates an existing tab in the current window and closes the calling Tabloom tab afterward. The adapter owns browser-specific API details so the search UI never calls `chrome`, `browser`, or Safari APIs directly.

The operation follows this order:

1. Query the active tab in the current window and capture its ID as the calling Tabloom tab.
2. Activate the target tab with the browser's tabs-update API.
3. After successful activation, close the captured Tabloom tab when its ID exists and differs from the target ID.
4. If activation fails, do not close Tabloom and propagate a retryable error.
5. If activation succeeds but closing Tabloom fails, leave the user on the activated target and report the cleanup failure without reopening anything.

The existing `tabs` permission covers listing, updating, and removing tabs, so no new permission is required.

## Current-Tab Search Source

Global search loads current-window tabs when the search overlay opens. This is a local browser API read and does not involve Supabase or persistent caching. A fresh read on every opening avoids stale tab results while keeping the workspace snapshot local-first.

Current-tab candidates must:

- Have a numeric browser tab ID.
- Use an `http:` or `https:` URL.
- Not be the active Tabloom extension page.
- Preserve their title, URL, and favicon metadata.

Search logic produces a discriminated result model with `current-tab` and `saved-link` variants. Current tabs match against title and URL. Saved links retain the existing title, URL, description, space, and collection matching. The overlay displays two source-labeled sections—Current tabs first and Saved links second—while maintaining one keyboard-navigation index across all visible results.

Current-tab rows show the favicon, title, hostname, and `Current window`. Saved-link rows continue to show the space, collection, and source label. Identical URLs may appear in both sections because one result navigates to an existing browser tab and the other represents a saved Tabloom record.

## Search Shortcut and Interaction

Replace the existing Command-K/Control-K listener and visible hint with Command-F/Control-F. Register the listener on `window` in capture mode. When Tabloom is focused and the shortcut is pressed, call `preventDefault()` and `stopPropagation()` before opening the overlay so the browser Find interface does not appear.

The override is intentionally page-scoped: Tabloom does not and cannot replace browser Find while another website is focused.

Opening a current-tab result calls the adapter activation operation, closes the overlay, and reports failures through the existing toast system. Opening a saved-link result retains the current separate-navigation behavior. Escape, arrow navigation, pointer selection, and Enter continue to work across the combined result list.

## Component Boundaries

- `GlobalSearch` owns overlay state, current-tab loading state, combined keyboard navigation, and result rendering.
- A small current-tab search module owns filtering and text matching independent of React and browser APIs.
- `BrowserAdapter.tabs` owns listing, activation, and close-after-activation ordering.
- `ExtensionApp` supplies adapter-backed callbacks and routes errors to the existing mini-toast implementation.
- The logo component and canonical asset are shared by the extension and hosted surfaces; build scripts own raster generation and target packaging.

The Current Tabs side sheet remains independent. Both surfaces perform inexpensive current-window reads because lifting transient browser state into application-wide state would add coupling and create additional stale-state rules.

## Error Handling

- If reading current tabs fails, saved-link search remains usable and the overlay shows a compact retryable current-tabs error.
- Unsupported and internal URLs are silently excluded from search results.
- If target activation fails, Tabloom remains open and shows an error toast.
- If Tabloom cleanup fails after activation, the existing tab is still focused; the cleanup error is surfaced without opening another tab.
- Empty queries show the existing instructional state, updated to mention current tabs.

## Testing

Add tests that prove:

- Command-F and Control-F suppress the browser default and open Tabloom search.
- The old Command-K shortcut no longer opens search.
- Current tabs are read when the overlay opens and refreshed on the next opening.
- Internal, unsupported, missing-ID, and active Tabloom tabs are excluded.
- Current-tab and saved-link results render in labeled sections with continuous keyboard navigation.
- Selecting a current-tab result activates the existing tab before closing Tabloom.
- Activation failure leaves Tabloom open; cleanup failure does not open a duplicate.
- Chrome, Firefox, and Safari adapters implement the same contract.
- Manifest icon paths exist in every built target and raster assets match the canonical logo.
- Unit, component, visual, and production extension builds pass for all supported targets.

## Acceptance Criteria

A user opens Tabloom, presses Command-F or Control-F, searches across saved links and supported tabs in the current window, selects a current-tab result, and lands on that existing tab while the original Tabloom tab closes. The selected Woven Tabs mark appears consistently in the application, hosted favicon, and packaged extension icons.
