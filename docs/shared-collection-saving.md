# Saving shared collections

Visitors can use **Save to my collections** beside **Open all** on a public share. This saves a private, editable copy. The name, link titles, URLs, descriptions, and visible order are preserved; IDs and timestamps are fresh and favicon URLs are null. Changes to the original will not update the copy. Source revocation or deletion does not remove it.

Signed-in recipients save in one click and stay on the share page. Confirmation shows **Saved to your collections** and **View collection**. Returning recipients see **View saved collection**; the original owner sees **Open my collection**. Destination links select and focus the collection in its current space.

The first ordinary space ordered by position, creation time, and ID receives the copy. An account without spaces gets **My collections** (`#f56f72`). Empty collections can be saved. Saving again returns the existing copy, including after share regeneration or disable/re-enable. If the recipient deletes the copy or its space, another explicit save creates a new copy; browsing alone never recreates it.

Signed-out visitors see a sign-in dialog and use the existing Google browser authentication. An explicit save intent is kept in session storage for up to 30 minutes. Only a valid intent matching the returned share and nonce can resume saving. No session credentials are stored in the intent. A failed or cancelled sign-in does not save. Uncertain save failures require explicit retry and confirmation from the server before showing success.

## OAuth configuration and rollout

1. Apply `supabase/migrations/202609090001_save_shared_collection.sql` to the target database.
2. Configure the hosted Supabase Auth redirect allowlist with the exact web callback origin and `/auth/shared-save` path. Include each intended local development origin when testing, matching `supabase/config.toml`, and the actual production web origin. Also allow `/app?collection=*` on each intended web origin so ordinary workspace sign-in preserves validated collection targets. Repository config changes alone do **not** update hosted Auth.
3. Deploy the web UI, including `/auth/shared-save`.
4. Run the two-user smoke test below and manually verify the real Google flow before considering production rollout complete.

The callback uses Supabase's existing browser session handling. It does not accept an arbitrary `next` redirect. Preserve `/app?collection=<UUID>` through ordinary workspace sign-in too.

If rollback is needed, roll back the UI first. Saved collections are normal user data: do not delete them or their links as part of rollback. No new extension protocol is required; normal workspace revision and snapshot sync delivers the saved collection.

## Automated acceptance setup

Use a disposable local or staging Supabase project with both sharing migrations applied, password authentication enabled, and two distinct, dedicated confirmed test users. The recipient must start with no ordinary spaces. The tests refuse to clear pre-existing recipient data. Do not run against production or a personal account. Stop other clients using these identities during the run.

Start the web app against the **same** Supabase project, and export these variables through your test runner or shell's secret mechanism. Do not put passwords/session tokens in committed files, screenshots, traces, or logs.

| Variable | Purpose |
| --- | --- |
| `TABLOOM_E2E_LIVE=1` | Explicitly enable live acceptance |
| `TABLOOM_E2E_DISPOSABLE=1` | Confirm the selected local/staging project and users are disposable |
| `VITE_SUPABASE_URL` | Test Supabase URL used by the running web app |
| `VITE_SUPABASE_ANON_KEY` | Test project's public anon key |
| `TABLOOM_E2E_WEB_URL` | Running test web origin |
| `TABLOOM_E2E_USER_EMAIL` | Dedicated source owner email |
| `TABLOOM_E2E_USER_PASSWORD` | Source owner password |
| `TABLOOM_E2E_RECIPIENT_EMAIL` | Distinct dedicated recipient email |
| `TABLOOM_E2E_RECIPIENT_PASSWORD` | Recipient password |

Run:

```sh
rtk npx playwright test tests/e2e/collection-saving.spec.ts --project=chromium
```

The suite deliberately does not load dotenv files. It skips unless every variable and both opt-ins are supplied. Fixture authentication uses password sessions injected into isolated browser contexts; it never prints credentials. Fixtures have fresh UUIDs. Cleanup deletes only the fixture source space, copies found through that source's provenance, and their now-empty generated destination spaces. It does not delete users or reset the database. A forcibly terminated process may leave fixtures: inspect and remove only the identified test data before retrying, never bulk-clear a valuable account.

Coverage includes the browser save/status/destination flow, default destination for an empty account, preserved links and private defaults, editing the recipient copy in the workspace, source independence, repeated mutation idempotency, share regeneration, revocation, source deletion, and the source-owner shortcut. Controlled callback cases prove that a valid stored intent resumes once and malformed/missing intent or a forged resume query cannot save. These cases exercise the actual callback with a fixture session; they do **not** prove Google provider configuration.

Unit tests cover action state transitions, callback errors, intent validation, and destination resolution. Database tests cover transactional content/order, permissions, revision/snapshot compatibility, and repeat behavior. The separate gated local concurrency suite tests simultaneous saves and revocation races. A skipped test is not a passing integration check.

## Required manual smoke checks

These checks require a configured running environment; automated fixture sessions do not replace them. Record the actual environment and outcome when performed.

- In a signed-out browser, open a share, choose **Save to my collections**, complete real Google sign-in, and verify return to the same share, exactly one private copy, and working **View collection**. Repeat with cancellation. Confirm the hosted allowlist uses the deployed origin.
- With the recipient extension signed in, make a local edit pending sync, save a share through the web, then allow a normal sync cycle. Confirm the new copy arrives and the pending local edit is preserved. Database revision assertions establish server compatibility only; this checks the actual extension flow.
- Check desktop/mobile and light/dark presentation, narrow-screen action stacking, keyboard-only dialog focus containment/Escape/focus return, and destination article focus. Confirm anonymous browsing, metadata, and **Open all** still work.
- Revoke the share between loading and saving; expect **This shared collection is no longer available.** Simulate a failed response, explicitly retry, and confirm no duplicate copy.

No hosted callback change, real Google round trip, extension smoke run, or live database execution is implied by adding this document or by collecting/skipping the browser suite.

See the [implementation plan](superpowers/plans/2026-09-09-save-shared-collection.md) and [original sharing design](superpowers/specs/2026-09-04-live-collection-sharing-design.md).

## Development verification — 2026-09-09

- Unit suite: **1,065 passed**. The two HTTP integration cases skip in the default unit run and were separately executed successfully against the disposable stack below. Full ESLint and TypeScript checks passed.
- Chromium acceptance: **4 passed**, using a separate disposable `tabloom-save-e2e` Supabase stack at local ports 55321/55322 and the worktree web app on 4174. Both fixture users were created only for this local run.
- HTTP concurrency integration: **2 passed** against that same stack (`tests/integration/save-shared-collection-concurrency.test.ts`).
- Focused acceptance-file ESLint: passed. The earlier environment-gated browser invocation collected four cases and skipped all four; the configured local run above subsequently executed and passed them.
- The local app, owned Supabase services, and temporary configuration/log files were removed after verification. The pre-existing `supabase_db_tabloom` service on 54322 was left running.
- Visual/keyboard inspection passed for desktop (1440px) and mobile (390px), in light and dark themes, including all four sign-in dialogs. Eight screenshots showed no overflow. Initial focus, forward/reverse Tab containment, Escape dismissal, focus return, and destination focus passed. The dark dialog primary-button color override was corrected afterward.
- All **273 pgTAP assertions passed**, including 53 save-specific assertions. The suite was also exercised against a disposable database rebuilt from all tracked migrations. A pre-existing sync-test fixture assumed fixed revisions despite direct row writes; its assertions now use the fixture's actual revision and still verify +1/+0 behavior. No sync implementation was changed.
- Both `npm run build:all` (web and three extension targets) and `npm run build:vercel` passed. The latter required local dependency files instead of an external worktree symlink. Generated Next type changes were restored; they are not part of the feature.
- Four rendered-HTML checks passed. Independent reviews found one same-user auth-refresh navigation regression, now fixed and covered by a passing test.
- Real Google provider round trip, hosted allowlist configuration, and extension sync/pending-edit smoke check remain unverified. The fixture sessions and server revision checks do not establish those results. No production migration or deployment was performed.

## Production rollout — 2026-09-09

Deployed following explicit operator authorization to push and deploy.

- Source: `feat/save-shared-collection`, application commit `da4fddc9517ccbe0349633230ba79f9953387864`, pushed to GitHub.
- Production: [tabloom.nickvu.dev](https://tabloom.nickvu.dev), Vercel project `tabloom-web`, deployment `dpl_2D8qHgJC5LrezDDL5SfYcaoSWUPU` (Ready).
- Applied only `202609090001_save_shared_collection.sql` to the existing Tabloom Supabase project after confirming the pending migration with a dry run.
- Added production Auth redirects `/app`, `/app?collection=*`, and `/auth/shared-save` under `https://tabloom.nickvu.dev`. Existing entries and other Auth settings were preserved; Google authentication is enabled.
- Live `/`, `/app`, `/privacy`, `/auth/shared-save`, invalid-share handling, and `/mcp/health` returned HTTP 200 with the expected route content.
- A live shared page displayed the Save action and sign-in dialog. Continuing reached Google authorization with the correct return target; anonymous viewing/sign-in entry issued no save request.
- A production transaction verified copy content, private defaults, default destination, idempotency, revision advancement, and copy survival after revocation. It was rolled back, and the absence of the temporary fixture users was verified.
- Full interactive Google login completion and the extension pending-edit smoke check were not performed. The source branch remains separate from `main`; this production deployment uses the application commit above.
