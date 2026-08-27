# Manual browser bookmark synchronization

Tabloom imports Chrome bookmarks only when a signed-in extension user chooses **Sync browser bookmarks**. Each extension installation is a separate device source. The latest completed snapshot from every source is merged into a read-only **Browser Bookmarks** space in the extension and web app. Copying one of those cards creates a normal Tabloom link; it never modifies Chrome.

## Local Supabase

Install dependencies, start the local stack, reset the schema, and run the database isolation tests:

```bash
npm install
npx supabase start
npx supabase db reset
npm run test:supabase
```

The reset applies both the personal-workspace migration and the staged bookmark-sync migration. Do not copy local or hosted service-role keys into `.env.local`, the extension, test fixtures, or commits. Only the public project URL and anonymous key belong in the client environment.

Copy `.env.example` to `.env.local`, then populate the matching `NEXT_PUBLIC_` and `VITE_` Supabase variables. The web and extension values must point to the same project.

## Google OAuth callbacks

Configure Google as a provider in Supabase. Google Cloud receives the provider callback URL shown by Supabase. Supabase **Authentication → URL Configuration** must allow:

- `http://localhost:4173/app` for local web sign-in.
- The production Tabloom `/app` URL.
- `https://EXTENSION_ID.chromiumapp.org/auth-callback` for the unpacked extension.

Build and load the extension once to obtain `EXTENSION_ID`. The exact extension callback is returned by `chrome.identity.getRedirectURL("auth-callback")`. Reinstalling from a different source directory or regenerating the extension identity may assign a different ID, which requires adding the new callback. Existing Tabloom device sources are not automatically deleted after a reinstall; forget the old source from the extension if it is no longer useful.

## Load the extension

```bash
npm run build:extension
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist-extension`. Open a new tab to display Tabloom.

When **Sync browser bookmarks** is clicked for the first time, Chrome shows its native optional-permission prompt because the manifest declares `bookmarks` under `optional_permissions`. Denying the prompt leaves the current server snapshot and local cache unchanged. Clicking sync later requests it again. Granting access lets Tabloom read the visible bookmark tree for that explicit sync only; no bookmark event listener runs in the background.

## Device sources and folders

- A random installation key is stored in `chrome.storage.local`; its editable device name defaults to a browser/OS label.
- Each successful sync atomically activates a new snapshot for only that device.
- Account-synced copies with the same normalized URL and displayed folder path merge across devices.
- Device-only or uncertain entries remain separate and show `Only on <device>`.
- `Bookmarks bar` and `Other bookmarks` are omitted from displayed paths. Direct children become **Unfiled bookmarks**. Other nested folders and **Mobile bookmarks** remain visible.
- Failed or interrupted uploads never replace the last completed snapshot. Offline startup uses the last cached merged workspace.
- **Forget device** deletes only that device's uploaded source and snapshots. It does not delete or rearrange Chrome bookmarks.

## Two-device acceptance procedure

1. Start local Supabase and the web app with `npm run dev -- --port 4173`; build the extension.
2. Load `dist-extension` in two separate Chrome profiles and add both extension callback URLs to Supabase if their IDs differ.
3. In profile A, create an account-synced bookmark in `Work / Design`, a device-only bookmark in the same folder, and a direct bookmark under the bookmarks bar.
4. Deny bookmark permission once. Confirm the prior Browser Bookmarks view and cache remain unchanged, then retry and grant it.
5. Name the source `Work Mac`, sync, and confirm `Work / Design` plus **Unfiled bookmarks** appear in both the extension and `/app`; the device-only card must say `Only on Work Mac`.
6. In profile B, create the same account-synced URL/path plus a different device-only entry. Name the source `Home Mac` and sync.
7. Confirm the shared account-synced bookmark appears once, while both device-only entries remain separately labeled. Confirm `Bookmarks bar` and `Other bookmarks` never appear as collection names.
8. Search and use **Open all** in both surfaces. Drag a browser bookmark into a normal collection, verify duplicate confirmation when applicable, and confirm the original Chrome bookmark is unchanged.
9. Interrupt a later upload before finalization and confirm the previous complete view remains available online and from cache.
10. Forget `Work Mac`; confirm only source-specific Work Mac entries disappear and all Chrome bookmarks remain intact.

Run the release checks described in `README.md` before packaging the extension. Headed acceptance credentials, when used, belong only in local environment variables prefixed `TABLOOM_E2E_`.
