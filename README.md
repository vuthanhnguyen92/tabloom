# Tabloom

Tabloom is an original tab and link workspace inspired by the workflow of visual bookmark organizers. It includes a public marketing site, a synchronized web workspace, and a cross-browser Manifest V3 new-tab extension.

## Requirements

- Node.js 22.13 or newer
- A Supabase project for synchronized accounts
- A Google OAuth client configured through Supabase
- Chrome, Arc, Dia, Firefox, or Safari on macOS for extension testing

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev -- --port 4173
```

The extension is local-first: without Supabase it creates a persistent browser workspace and keeps every space, collection, and saved link in extension storage. Supabase is required only for account sign-in and cross-device synchronization.

Signed-in synchronization is event-driven. Tabloom reads remote changes once on first open and when its tab genuinely regains focus; it does not poll or continuously sync in the background. Local edits are saved optimistically and sent immediately in order. If a write fails, the local edit remains available, later writes wait behind it, and the account menu shows **Failed to sync** with an explicit **Retry sync** action.

Useful commands:

```bash
npm run test:unit
npm run test:supabase
npm run build
npm run build:extension
npm run build:all
npm test
```

The web and extension use the same organizer components, Poppins typography, automatic light/dark theme, collection/card drag targets, keyboard movement, and saved workspace preferences. Current Tabs and live browser-bookmark controls are extension-only. The web account dropdown shows synchronization status and opens Trash. Saved-link deletion offers immediate Undo; space and collection deletion asks for confirmation. Trash retains deleted trees for 30 days and offers an alternate writable destination when the original parent is missing.

### Local acceptance gate

Run Docker and `npx supabase start` before the database gate. `test:supabase` resets **only the local Supabase database**, applies every migration, then runs pgTAP and transaction-scoped database integration tests. Install the test browsers once with `npx playwright install chromium firefox webkit`.

```bash
npm run lint
npx tsc --noEmit
npm run type-check --workspace @tabloom/mcp
npm run test:unit -- --maxWorkers=2 --pool=threads
npm run test:supabase
npm run build --workspace @tabloom/mcp
npm run build:all
npm run build:vercel --ignore-scripts
npx playwright test tests/e2e/web-extension-parity.spec.ts tests/e2e/workspace-trash.spec.ts tests/e2e/organizer-drag.spec.ts --project=chromium
npm run test:e2e:visual
npm run test:e2e:bookmarks
```

Parity/recovery tests launch the built Chromium extension in a temporary browser profile, so a graphical browser session is required. The web fixture mounts the production `WorkspaceClient` and controller with a local durable repository/Trash adapter; it does not authenticate against a hosted account. Native bookmark-control acceptance builds a separate temporary extension configured only for a synthetic loopback API; deliverable manifests and hosted accounts are unchanged. The visual suite renders those real components in Chromium, Firefox, and WebKit, checks browser/page errors, and saves review candidates in the test output directory. Review intentional changes before running `--update-snapshots`; no live credentials are needed for these local tests. Opt-in authenticated sharing, sync, and OAuth tests remain a separate approved release gate. WebKit verifies shared rendering, not a signed Safari application.

## Supabase and Google sign-in

1. Create a Supabase project and apply every migration in `supabase/migrations/` with the Supabase CLI or SQL editor.
2. In Google Cloud, create an OAuth 2.0 web client. Add the callback URL shown under Supabase **Authentication → Providers → Google** to Google’s authorized redirect URIs.
3. Enable Google in Supabase and enter the Google client ID and secret there. The secret belongs only in Supabase and must never be added to this repository.
4. Add `http://localhost:4173/app` and the production `/app` URL to Supabase **Authentication → URL Configuration → Redirect URLs**.
5. Copy `.env.example` to `.env.local` and set the public Supabase project URL and anonymous key for both the `NEXT_PUBLIC_` and `VITE_` variables. The anonymous key is intentionally client-visible; never use the service-role key.

Row-level security ensures every user can read and change only rows whose `user_id` matches their authenticated Supabase user.

## Live collection sharing

Signed-in users can enable a read-only live URL for an ordinary synced collection from the web workspace or any extension build. Sharing is off by default. Anyone possessing `https://tabloom.nickvu.dev/s/<token>` can view the collection without signing in; the owner identity, parent space, device information, and sync state are never included. Synced edits appear when the recipient reloads. Regenerating the URL or disabling sharing invalidates the previous bearer link immediately, and deleting the collection revokes it through the database cascade. Restoring the collection from Trash does not reactivate that URL; enable sharing again to issue a new one.

Apply `supabase/migrations/202609040001_live_collection_sharing.sql` before deploying owner controls. The public loader uses the anonymous key and the allow-listed `load_shared_collection` RPC; it never requires or accepts a service-role key. Release in this order: database migration, web application, then rebuilt browser packages.

Production smoke checks should cover enable, anonymous read, edit-and-reload, regenerate, disable, and collection deletion. The live Playwright gate requires `TABLOOM_E2E_LIVE=1` plus the documented `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `TABLOOM_E2E_USER_EMAIL`, `TABLOOM_E2E_USER_PASSWORD`, and `TABLOOM_E2E_WEB_URL` values.

## Remote MCP authorization

The remote MCP service uses a dedicated authorization facade at
`https://tabloom.nickvu.dev`; clients connect to the canonical endpoint
`https://tabloom.nickvu.dev/mcp`. Direct Supabase OAuth access tokens are not
accepted by `/mcp`. The facade issues ES256 tokens bound to the exact MCP
resource and the single `tabloom:workspace` scope, while its encrypted inner
Supabase credential preserves request-local RLS enforcement.

MCP reads synchronized saved workspace data only; device-local unsynced data
is unavailable. Workspace mutations are disabled by default with
`TABLOOM_MCP_MUTATIONS_ENABLED=false`. When an operator enables them after the
disabled-first acceptance gate, create and concurrency-safe update tools are
available alongside recoverable deletion: spaces and collections require a
10-minute single-use prepare/confirm intent, saved links move immediately to
Trash, and deleted data remains recoverable for 30 days. See
[Tabloom workspace MCP tools](docs/mcp-workspace-tools.md) for exact JSON
examples, retry keys, confirmation, and restore behavior.

Supabase Google login for the web app and browser extensions remains unchanged.
The additional upstream callback for the facade is exactly:

```text
https://tabloom.nickvu.dev/oauth/callback/supabase
```

Keep the existing web and exact extension callbacks when adding it. Private
signing/encryption rings and the request-proof database secret belong only in
approved Vercel/database secret entry paths, and the first
deployment must keep `TABLOOM_OAUTH_ENABLED=false`. Linking or pushing
Supabase, editing redirect URLs, setting Vercel variables, deploying, enabling
OAuth, inspecting production logs, and performing cutover all require explicit
operator approval.

See [Tabloom authorization facade operator guide](docs/mcp-setup.md) for local
key/database-proof generation, protected secret entry, public-only signing-key
retention, rotation and rollback order, the
redacted interactive probe, and the disabled-first two-user release gate. The
opt-in live gate accepts only private JSON credential/session-state files at
absolute paths outside this repository; it never imports external executable
fixture code. Storage-state files are identity-checked and parsed through
no-follow handles, and live Supabase SDK traffic is confined to the exact
approved production origin.
The live mismatch gate additionally requires a separate one-shot operator-only
mode-`0600` active ES256 signing JWK outside the repository. It constructs the
negative bearer from the two freshly issued active grants, verifies the key
against live JWKS, requires successful ordinary A/B MCP controls immediately
before the mismatch check and before either revocation, and never reports
private key or token material. Each issued grant immediately retains idempotent
categorical cleanup. The RLS fixture must assert exclusive quiescent use, and
the gate restores only exact test-attributable drift through optimistic
owner-bound writes; concurrent changes are categorized and never overwritten.

The current local checkout is connected through ignored `.env.local` values to Supabase project `tctjlsvfufzxhauhywsm`. Its migrations, RLS policies, production site URL, and web redirect URLs have been configured. Google remains disabled until a Google OAuth client ID and client secret are entered in **Authentication → Sign In / Providers → Google**.

On the first signed-in extension sync, Tabloom compares the persistent local workspace with the user's cloud workspace. An empty side is imported automatically. If both sides contain data, Tabloom previews the merge and requires confirmation; matching card IDs are merged first, URL matching is used only as a legacy fallback within the same collection, and cloud ordering wins before local-only items are appended. Cancelling or failing the merge leaves the local workspace untouched and retryable.

## Browser extensions

Build the unpacked extension:

```bash
npm run build:extension
```

The build produces `dist-extension/chromium`, `dist-extension/firefox`, and `dist-extension/safari`. Chrome, Arc, and Dia load the Chromium directory. Firefox loads the target manifest temporarily from `about:debugging`. Safari uses the converter-ready resources or an Xcode project generated by `npm run package:safari` when full Xcode is installed.

The same build writes local download ZIPs to `public/downloads/tabloom-{chromium,firefox,safari}.zip` and callback reports to `dist-extension/reports/`. These ignored artifacts are local until explicitly published. For a versioned archive, use the corresponding manifest version and run:

```bash
npx web-ext build --source-dir dist-extension/chromium --artifacts-dir dist-extension/packages --filename tabloom-chromium-0.7.0.zip --overwrite-dest
npx web-ext build --source-dir dist-extension/firefox --artifacts-dir dist-extension/packages --filename tabloom-firefox-0.7.0.zip --overwrite-dest
npx web-ext build --source-dir dist-extension/safari --artifacts-dir dist-extension/packages --filename tabloom-safari-0.7.0.zip --overwrite-dest
shasum -a 256 dist-extension/packages/tabloom-*-0.7.0.zip
```

The Safari ZIP contains unsigned converter-ready extension resources. Full Xcode, signing, and native Safari acceptance are required to distribute a Safari app.

### Workspace recovery

Extension updates and reloads preserve Tabloom's local cache and signed-in session when the browser extension ID is unchanged. After a true uninstall, browser-owned extension storage is removed. Tabloom attempts a non-interactive account recovery and restores the Supabase workspace; if the provider session has expired, the user must reconnect manually. Local-only workspaces should be exported as JSON before uninstalling.

For Google sign-in:

1. Load the target extension once so the browser assigns or confirms its ID.
2. In the extension console run `chrome.identity.getRedirectURL("auth-callback")` (or `browser.identity.getRedirectURL("auth-callback")` in Firefox).
3. Add that exact URL to the Supabase redirect allow list.
4. Rebuild after setting `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_TABLOOM_WEB_URL`.

Do not reuse the ID from another extension or add a broad `*.chromiumapp.org` wildcard. Each installed target must register the exact callback returned by its own identity API.

The extension requests only `tabs`, `storage`, and `identity`, plus network access to Supabase. Bookmark access is optional: the browser prompts for it only when the user chooses **Sync browser bookmarks**. Tabloom reads bookmarks on demand, keeps the browser authoritative, and never edits the browser bookmark tree.

See [Cross-browser extension builds](docs/cross-browser-extension.md) for target commands, installation, OAuth callbacks, feature fallbacks, and Safari conversion.

See [Manual bookmark synchronization](docs/bookmark-sync-setup.md) for local Supabase setup, permission behavior, device sources, and the two-device acceptance procedure.

## Project layout

- `app/` — marketing site, privacy page, and authenticated web workspace
- `shared/` — domain types, validation, capture behavior, and repository adapters
- `extension/` — shared new-tab interface, typed browser adapters, target manifests, OAuth, and cache
- `supabase/migrations/` — schema, ownership constraints, indexes, and RLS policies
- `tests/` — domain, repository, workspace, capture, extension, and server-rendering tests

## Deployment

`https://tabloom.nickvu.dev` is the canonical Vercel front door for the landing page, `/app`, `/privacy`, `/mcp`, `/oauth/*`, and `/.well-known/*`. Set `TABLOOM_MCP_UPSTREAM_ORIGIN` to the MCP service's stable private `.vercel.app` origin; clients must use only `https://tabloom.nickvu.dev/mcp`. Configure the public Supabase variables in Vercel before enabling synchronized sign-in. The extension is delivered as an unpacked build in v1; Chrome Web Store submission is intentionally out of scope.

Release Trash in three stages: additive schema/RPC migrations, compatible web/MCP clients, then the explicit operator DELETE-privilege cutover. The cutover SQL lives outside automatic migrations. Follow the [MCP operator guide](docs/mcp-setup.md) for client refresh, exact commands, final privilege checks, and rollback handling.

Before shipping this shared-organizer release, apply the entire migration chain in order, including `202609100005_workspace_link_move.sql`, `202609100006_workspace_sync_restore.sql`, `202609100007_workspace_restore_recovery.sql`, `202609100008_workspace_trash_identity_history.sql`, `202609100009_workspace_collection_move_sync.sql`, and `202609100010_workspace_delete_generation_guard.sql`. They provide structural link movement, explicit restore synchronization, retry/outcome recovery, permanent deletion identity history, structural collection movement, and rejection of stale offline deletions before they can remove a restored generation. Migration 008's identity/generation history and migration 010's definitive rejection receipts deliberately outlive the recoverable snapshots; do not purge them with 30-day Trash cleanup. Ship the new extension restore/move protocol only after these migrations are applied.

Local builds and packages are not a deployment approval. Hosted migrations, domains, web/MCP deployment, download replacement/publication, privilege cutover, and enabling MCP mutations each remain operator-controlled release steps. Keep OAuth and MCP mutation flags disabled for their initial production acceptance. After approval, verify `/app` with a real synchronized account, exact browser OAuth callbacks, two-account ownership isolation, cross-device restore, and the documented disabled-first MCP probes before cutover or enablement.
