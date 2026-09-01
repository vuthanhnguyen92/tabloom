# Tabloom Extension Reinstall Recovery Design

## Summary

Make Tabloom preserve the current experience across ordinary extension updates and restore a signed-in user's workspace after a true uninstall and reinstall.

An update or reload continues from the existing extension-local workspace and Supabase session. A true uninstall removes extension-owned local storage, so a reinstalled Tabloom first attempts non-interactive account recovery and restores the canonical workspace from Supabase before creating any default local data. If silent recovery is unavailable, Tabloom remains fully usable in local mode and offers an explicit reconnection action.

This design cannot preserve unsynced, local-only data through a true uninstall because browsers remove the extension's storage. Signed-in optimistic mutations must therefore continue syncing to Supabase immediately, and local-only users retain JSON export as their portable backup option.

## Goals

- Preserve the local workspace, selected space, UI preferences, and Supabase session across extension updates and reloads.
- Restore spaces, collections, links, ordering, and identifiers after a true reinstall when the browser can silently recover the user's account.
- Prevent the default `My Space` and `My Collection` state from flashing or being uploaded before recovery completes.
- Never open an interactive OAuth window automatically during new-tab startup.
- Keep the extension usable when silent authentication, networking, or Supabase is unavailable.
- Retain optimistic local mutations and the existing retryable failed-sync behavior.
- Apply one shared recovery model across Chromium, Firefox, and Safari through the existing browser adapter boundary.

## Non-goals

- Guarantee prompt-free recovery after the Google or Supabase browser session has expired.
- Preserve data that existed only in extension-local storage after the extension was uninstalled.
- Store refresh tokens or full workspace snapshots in browser synchronization storage.
- Add a native host, operating-system keychain integration, or browser-profile account impersonation.
- Automatically open a Google sign-in prompt during startup.

## Existing Behavior and Problem

`ExtensionApp` currently creates the local repository first. `LocalWorkspaceRepository.create` creates `My Space` and `My Collection` when extension-local storage is empty. Only afterward does the app ask Supabase for a stored session and begin cloud synchronization.

This works for normal launches, but after a true reinstall both the local workspace and the Supabase session are absent. The app immediately creates a new local workspace and has no opportunity to distinguish first use from reinstall recovery. A subsequent account connection can therefore require a merge and can briefly show incorrect default content.

The current OAuth helper always invokes `launchWebAuthFlow` interactively. It cannot safely probe for an existing browser session during startup without risking an unsolicited sign-in window.

## Architecture

### Bootstrap coordinator

Move startup decision-making into a focused bootstrap coordinator with a small result contract. `ExtensionApp` consumes the result and remains responsible for rendering, repository activation, and ongoing synchronization.

The coordinator reads these inputs in parallel:

- The raw local workspace envelope, without creating defaults.
- The locally persisted Supabase session.
- The configuration and browser capability needed for silent OAuth.

It returns one of these outcomes:

- `local-session`: local workspace and valid session are available.
- `local-only`: local workspace is available without a session.
- `recovered`: local workspace was absent, silent authentication succeeded, and the cloud workspace was cached locally.
- `reconnect-required`: neither local workspace nor a recoverable session is available.
- `offline`: recovery could not be attempted because the network was unavailable.

The coordinator does not render UI and does not start the long-lived workspace sync coordinator. Its responsibility ends after selecting and materializing the safest initial state.

### Two-phase local repository initialization

Split local initialization into two operations:

1. Read an existing local workspace without mutating storage.
2. Create the default local workspace only when the bootstrap decision explicitly selects local-first onboarding.

Normal launches with existing local data remain cache-first and render immediately. Empty storage no longer implies that defaults should be created before authentication recovery has been evaluated.

### Silent OAuth mode

Extend the shared OAuth helper and browser identity adapter to support interactive and non-interactive modes.

Silent recovery uses:

- `launchWebAuthFlow({ interactive: false })`.
- Google authorization parameter `prompt=none`.
- The existing PKCE exchange and target-specific callback URL.

The helper classifies expected silent failures, including `login_required`, an expired provider session, cancellation, and a browser that cannot complete a non-interactive flow. These results mean `reconnect-required`; they are not fatal bootstrap errors.

Manual sign-in continues using `interactive: true`. No interactive flow is initiated from a mount effect or other automatic startup path.

### Cloud restoration

After silent OAuth succeeds, the coordinator obtains the authenticated user ID and loads the canonical Supabase workspace. It writes that snapshot and revision into the existing per-user local-first cache before returning `recovered`.

Because extension-local storage was empty, this is restoration rather than a first-sync merge:

- Preserve all remote entity IDs.
- Preserve positions and relationships.
- Do not show the local/cloud merge confirmation.
- Do not create or upload default local entities.
- Reconcile the selected-space preference if it exists; otherwise select the first canonical space.

After the recovered snapshot is visible, `ExtensionApp` activates the existing local-first repository and event-driven synchronization coordinator for subsequent mutations.

### Stable extension identity

Updates preserve storage only when the installed extension retains the same browser identity. Release packaging must therefore keep stable identifiers:

- Chromium builds use the stable manifest/package key that produces the configured extension ID.
- Firefox builds use a stable Gecko extension ID.
- Safari builds use a stable bundle identifier and signing identity.

Build tests inspect generated manifests and packaging metadata so accidental identifier drift fails before delivery.

## Startup Data Flow

### Existing local workspace

1. Read the local workspace and Supabase session concurrently.
2. Render the local workspace as soon as its selected-space preference is reconciled.
3. If a session exists, activate account-scoped local-first synchronization.
4. Refresh from Supabase according to the existing focus/open lifecycle.

No OAuth request is made merely because a cloud refresh fails.

### Empty storage with silent recovery

1. Keep the boot boundary visible; do not render default entities.
2. Attempt non-interactive OAuth.
3. Load the authenticated user's canonical workspace.
4. Persist the account-scoped cache atomically.
5. Render the restored workspace.
6. Start normal event-driven synchronization.

### Empty storage without silent recovery

1. Create the standard local `My Space` and `My Collection` workspace once.
2. Render local mode with a compact `Reconnect to restore workspace` action.
3. Allow all local organizer behavior.
4. When manual authentication succeeds, run the existing first-sync preview and merge flow so local changes are not discarded.

### Offline launch

If local data exists, render it and show offline sync status. If local storage is empty, initialize local mode rather than blocking the new-tab page indefinitely. Retry silent recovery only after an explicit reconnect action or a later focused launch; never poll continuously.

## UI States

The boot boundary represents a real startup state instead of briefly rendering an empty organizer:

- `Restoring workspace`: neutral progress state while silent recovery and the first cloud read are in progress.
- Ready: no success banner; render the recovered workspace.
- Reconnect required: compact account action in the existing header control.
- Offline: local workspace remains usable and existing sync status styling applies.
- Recovery error: mini toast with Retry; no destructive rollback.

The account control continues to own manual Google sign-in and logout. Logout retains the merged device-local workspace as currently designed, while explicitly clearing the local Supabase session so a user-requested logout is never silently undone.

## Security and Privacy

- Keep Supabase session material in extension-local storage during normal operation.
- Do not copy access or refresh tokens into `storage.sync`.
- Do not place tokens in query strings beyond the existing short-lived PKCE authorization code callback.
- Preserve exact redirect URL validation for each browser target.
- Treat a user-initiated logout as an opt-out from silent recovery on that installation. Persist a local logout marker so the next launch does not immediately recover the same account.
- A true uninstall removes the logout marker along with all other extension data. On reinstall, silent recovery may use the browser's still-valid provider session; otherwise manual reconnection is required.
- Never claim that a local-only workspace is uninstall-safe. Keep export language explicit.

## Error Handling

- Expected non-interactive OAuth failures resolve to `reconnect-required` without an error toast.
- Network errors resolve to `offline` and preserve or create a usable local workspace.
- A successful authentication followed by a failed cloud read retains the session, enters local mode, and exposes Retry.
- A partially written recovery cache is rejected through the existing envelope validation; cloud restoration is retried on the next eligible launch.
- Normal optimistic mutations remain visible when synchronization fails. They remain queued with `Failed to sync` and Retry rather than being reverted.
- Bootstrap attempts are generation-scoped so stale OAuth or cloud responses cannot replace a repository activated by a newer sign-in, logout, or account switch.

## Cross-browser Behavior

The bootstrap coordinator depends only on the typed browser adapter. Each adapter reports whether non-interactive web authentication is supported and implements the same result semantics.

- Chromium uses `chrome.identity.launchWebAuthFlow`.
- Firefox uses the compatible `browser.identity.launchWebAuthFlow` path and its stable add-on ID callback.
- Safari uses the existing Safari authentication bridge. If the platform cannot perform a silent identity flow, it returns `unsupported` and Tabloom shows manual reconnection without degrading local storage.

The recovery feature does not create browser-specific workspace repositories or merge implementations.

## Testing

### Unit tests

- Bootstrap outcome selection for every combination of local data, stored session, OAuth recovery, network state, and configuration.
- Default workspace creation occurs only after recovery is declined or unavailable.
- Silent OAuth passes `interactive: false` and `prompt=none`.
- Manual OAuth remains interactive.
- Expected silent-auth errors map to `reconnect-required`.
- Logout marker suppresses silent recovery on subsequent launches.
- Recovered snapshots retain remote IDs, ordering, and relationships.

### Component tests

- Existing local state renders without a default-state flash.
- `Restoring workspace`, reconnect, offline, and retry states.
- Successful recovery bypasses merge confirmation.
- Manual reconnection after local edits still presents the current merge confirmation.

### Browser and build tests

- Reloading and updating a build with the same identity preserves the session, workspace, selected space, and collapsed state.
- A clean profile with an existing provider session silently restores the cloud workspace when the browser supports it.
- Failed silent recovery never opens an interactive window.
- Chromium, Firefox, and Safari output retain their configured stable identifiers.
- All browser production builds complete successfully.

## Acceptance Criteria

- Installing a newer Tabloom build over an existing installation preserves the signed-in state and all local UI/workspace state.
- After a true reinstall, a user with a valid browser provider session sees the Supabase workspace restored without an interactive sign-in prompt.
- If silent recovery is unavailable, Tabloom remains usable locally and clearly offers manual reconnection.
- Reinstall startup never flashes or uploads an empty default workspace before recovery finishes.
- Manual reconnection preserves local changes and merges them using the existing confirmation rules.
- No refresh token or full workspace is stored in browser synchronization storage.
- The behavior is implemented once through shared extension modules and browser adapters.
