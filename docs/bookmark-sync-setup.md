# Browser bookmark import

Tabloom can copy visible Chromium or Firefox bookmarks into ordinary editable collections. Import is optional and local-first: it works without signing in, never edits the browser bookmark tree, and synchronizes through the normal workspace flow only when the user signs in.

## User flow

- A new empty workspace offers **Import bookmarks** or **Not now**.
- The **New space** dialog includes **Import bookmarks from this browser**, unchecked by default.
- Tabloom requests the browser's native `bookmarks` permission only after the user opts in.
- Refusing permission leaves the new space available and makes no bookmark changes.
- Safari omits the import option because Safari WebExtensions does not expose local browser bookmarks.

## Folder and card mapping

- Each visible bookmark folder becomes a normal Tabloom collection.
- `Bookmarks bar` and `Other bookmarks` are omitted from collection paths.
- Loose bookmarks are placed in **Imported bookmarks**.
- Unsupported internal URLs are skipped.
- Duplicate normalized URLs in the same destination collection are skipped; the same URL may still exist in different collections.
- Records that the browser cannot identify as synchronized are labeled **Imported from this device**.
- Imported cards and collections support the same editing, deletion, ordering, search, sharing, local cache, and account synchronization behavior as manually saved links.

## Permissions and packaging

The Chromium and Firefox manifests declare `bookmarks` as an optional permission. No background bookmark listener is registered. Safari does not request it.

Build all targets with:

```bash
npm run build:extension
```

Load `dist-extension/chromium` from `chrome://extensions` with Developer mode enabled. Open a new tab, use the onboarding prompt or create a new space, opt into bookmark import, and confirm the browser permission prompt.

## Acceptance checks

1. Confirm a clean workspace shows the import choice and that **Not now** dismisses it.
2. Open **New space** and confirm the import checkbox starts unchecked.
3. Deny permission and confirm the empty space remains usable.
4. Retry, grant permission, and confirm visible folders become editable collections.
5. Confirm `Bookmarks bar` and `Other bookmarks` never appear as collection names, while loose bookmarks appear under **Imported bookmarks**.
6. Edit or delete an imported card and confirm the original browser bookmark is unchanged.
7. Sign in, make an imported-link change, and confirm it synchronizes through the ordinary workspace queue.

Run `npm test`, `npm run lint`, `npx tsc --noEmit`, and the headed bookmark acceptance test before packaging a release.
