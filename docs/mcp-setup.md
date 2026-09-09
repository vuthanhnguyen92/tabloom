# Tabloom authorization facade operator guide

The remote MCP service runs behind the canonical public origin
`https://tabloom.nickvu.dev`. The OAuth issuer is that pathless origin and the
protected-resource identifier is exactly `https://tabloom.nickvu.dev/mcp`.
Supabase remains the upstream Google
identity provider; it is not the MCP token issuer.

Every production mutation in this guide requires explicit operator approval.
Preparing files, running local tests, or reviewing this checklist does not
authorize linking or pushing Supabase, changing Auth redirect settings, setting
Vercel variables, deploying, inspecting live logs, enabling OAuth, or executing
cutover.

## Configuration contract

The Vercel service requires these public values:

- `SUPABASE_URL`: exactly
  `https://tctjlsvfufzxhauhywsm.supabase.co` for the approved production
  project.
- `SUPABASE_ANON_KEY`: the public anonymous key; never use a service-role key.
- `TABLOOM_MCP_RESOURCE_URL`: `https://tabloom.nickvu.dev/mcp`.
- `TABLOOM_OAUTH_ISSUER_URL`: `https://tabloom.nickvu.dev`.
- `TABLOOM_OAUTH_ENABLED`: exactly `false` for the first deployment.
- `TABLOOM_MCP_MUTATIONS_ENABLED`: exactly `false` for the first workspace
  data deployment. Only the literal value `true` registers mutation tools.

The private `TABLOOM_OAUTH_SIGNING_KEYS` and
`TABLOOM_OAUTH_ENCRYPTION_KEYS` values are JSON arrays. Disabled mode may use
`[]`. Enabled production requires exactly one active ES256 private signing JWK,
exactly one active 32-byte encryption root, and a canonical 32-byte base64url
`TABLOOM_OAUTH_DATABASE_SECRET`. The database stores the same raw 32 bytes in
the no-grant `oauth_private.facade_secret` table. This secret signs short-lived,
request-bound mutation proofs; it is never an RPC argument, logged value, or
replacement for the public anonymous key. Template values in `.env.example`
are not deployable secrets, and a service-role credential is never used.

Do not commit key files, place them inside this repository, paste them into a
shell command argument, print them, or copy them into `.env.local`. Generated
files are local transfer artifacts only.

## Generate and enter facade secrets

Create an operator-owned mode-`0700` directory outside the repository, then
pass three new absolute paths. The generator refuses stdout, relative paths,
existing files, symlinks, non-owned/non-`0700` parents, and every path inside
the repository. It captures each parent device/inode, exclusively opens each
output with no-follow semantics, and compares parent, pathname, and handle
identities before generating or writing secret bytes. It creates both files
with mode `0600` and removes only matching inodes created by its invocation if
writing, syncing, or closing fails.

```bash
install -d -m 700 /absolute/external/path
```

Node does not expose portable `openat(2)` directory-descriptor-relative opens.
The identity checks close cross-user and ordinary symlink/replacement races,
but cannot eliminate a malicious same-user process racing the final checked
pathname. Run the generator only in a trusted operator account with no
untrusted same-UID processes.

```bash
node services/tabloom-mcp/scripts/generate-oauth-keys.mjs \
  --signing-out /absolute/external/path/signing-v1.json \
  --encryption-out /absolute/external/path/encryption-v1.json \
  --database-secret-out /absolute/external/path/database-proof-v1.txt
```

Enter the JSON values through the Vercel dashboard's secret-value editor, or
through stdin so they are not retained in shell history. The database-proof
file has exactly 43 base64url bytes and no trailing line ending; pass that file
directly on stdin so Vercel receives it byte-for-byte:

```bash
vercel env add TABLOOM_OAUTH_SIGNING_KEYS production \
  < /absolute/external/path/signing-v1.json
vercel env add TABLOOM_OAUTH_ENCRYPTION_KEYS production \
  < /absolute/external/path/encryption-v1.json
vercel env add TABLOOM_OAUTH_DATABASE_SECRET production \
  < /absolute/external/path/database-proof-v1.txt
```

In the separately approved operator environment, set
`TABLOOM_OAUTH_DATABASE_URL` through its protected secret-entry workflow, then
install the same local artifact into Postgres. The connection string is read
only from that environment variable and is never a command argument:

```bash
npm --workspace @tabloom/mcp run oauth:install-database-secret -- \
  --secret-file /Users/nickvu/.tabloom-secrets/database-proof-v1.txt
```

The command calls the private `oauth_private.install_facade_secret(bytea)`
function over the direct database connection. Only managed `postgres` may
execute that function; browser-facing roles and `service_role` cannot resolve
or execute it, and the administrator receives no direct table grant. The
command prints only Postgres's lowercase SHA-256 fingerprint of the raw 32
decoded bytes. Before enabling OAuth, compute the local decoded-byte
fingerprint without printing the artifact, and require the two fingerprints to
be identical:

```bash
node --input-type=module -e 'import { createHash } from "node:crypto"; import { readFile } from "node:fs/promises"; const file = await readFile(process.argv[1]); const value = file.toString("utf8"); if (file.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, "base64url").toString("base64url") !== value) process.exit(1); process.stdout.write(`${createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex")}\\n`);' /Users/nickvu/.tabloom-secrets/database-proof-v1.txt
```

Length-only checks are insufficient: require the canonical base64url artifact
and matching decoded-byte fingerprint. Never put the artifact or connection
string in Git, shell history, Vercel build logs, saved SQL, a migration, RPC,
ticket, or log. Never grant the private schema/table to `anon`,
`authenticated`, or `service_role`. The migration intentionally contains no
production secret.

Supabase PostgreSQL 17 retains an automatic `ADMIN OPTION` membership from the
managed `postgres` migration runner to roles it creates. Supabase grants that
row through `supabase_admin`, so the managed runner cannot revoke it. Tabloom
therefore treats the managed database administrator as an explicit trusted
operator boundary while rejecting every membership that can currently inherit
or `SET ROLE` into `oauth_facade_owner`. Never expose the database connection
string or managed administrator credentials to Vercel, browser code, extension
packages, logs, or saved SQL; the application receives only the anonymous key.

Do not use command substitution or put JSON after the command name. Confirm the
files are untracked, transfer them through the approved secret channel, and
securely remove the local copies under the operator's retention policy.

### Rotation order

1. Generate a new signing and encryption pair outside the repository.
2. In the secret editor, create combined rings with the new entries active and
   every retained entry inactive. Convert each former active signing entry to
   `{ "kid": "...", "active": false, "publicJwk": { "kty": "EC", "crv": "P-256", "alg": "ES256", "x": "...", "y": "..." } }`.
   Remove `d` and the entire `privateJwk` field before retaining it. Inactive
   private material and an active public-only entry are rejected. Keep old
   encryption roots so existing artifacts can still be opened.
3. Deploy the overlapping rings while the old keys remain available, then run
   the complete redacted probe and two-user gate.
4. Retain old signing verification material for at least the maximum access
   overlap and old encryption roots for the maximum outstanding artifact and
   refresh-family overlap (currently 30 days).
5. Remove expired inactive entries in a later approved deployment and repeat
   the gate. Never switch both rings without an overlap deployment.

The database proof secret has no overlapping-key ring. Rotate it only during an
approved disabled-facade maintenance window: disable and deploy, update the raw
database singleton and Vercel secret through protected entry paths, deploy, and
then re-enable and run the full gate. A mismatch fails every mutation with the
same fixed error; do not add a service-role fallback.

If rotation fails, disable the facade first, redeploy, revoke facade grant
families, and only then rotate or remove compromised rings. Ordinary Supabase
web and extension login must remain active.

## Supabase callback contract

After an approved disabled deployment, add this one upstream callback to
Supabase **Authentication → URL Configuration → Redirect URLs**:

```text
https://tabloom.nickvu.dev/oauth/callback/supabase
```

Keep all existing web `/app` and exact browser-extension callbacks. Do not
replace Google's provider callback in Supabase, and do not point Supabase at the
old Sites consent page. The facade callback exchanges the upstream PKCE code
server-side.

## Disabled-first rollout checklist

The following is an operator checklist, not authorization to perform it:

1. Obtain production-mutation approval and record the reviewed commit.
2. Link the existing Supabase project without committing credentials, run the
   complete local pgTAP suite, review the generated diff, and push only
   `202608290002_oauth_facade.sql`.
3. Configure the public values, versioned rings, and database proof secret in Vercel with
   `TABLOOM_OAUTH_ENABLED=false`.
4. Deploy `services/tabloom-mcp`. Confirm health, protected-resource metadata,
   authorization-server metadata, and public JWKS are available. Confirm DCR,
   authorize, token, revocation, and MCP routes remain unavailable.
5. Add only the fixed Supabase facade callback while preserving web and
   extension callbacks.
6. With approval, set `TABLOOM_OAUTH_ENABLED=true`, deploy again, and run the
   readiness probe with a dedicated test user.
7. Run the two-user live acceptance and inspect live logs. Keep future workspace
   MCP tools disabled throughout this gate.
8. Only after every check passes, disable Supabase's temporary OAuth Server and
   public DCR feature and retire the owner-only Sites consent dependency.

If any check fails, set `TABLOOM_OAUTH_ENABLED=false`, redeploy, revoke facade
grant families, rotate or remove facade keys, and leave Supabase web/extension
authentication unchanged. Do not remove the fixed callback during an emergency
rollback unless the facade is being abandoned; disabling and rotating are the
credential-safety controls.

## Workspace data release checklist

This section stages the workspace MCP release; it is not authorization to run
it. Do not apply production migrations, change hosted variables, deploy, or
enable mutations until the shared organizer plan and final branch review are
complete and an operator explicitly approves the production change.

The user-facing tool contract and examples are in
[Tabloom workspace MCP tools](mcp-workspace-tools.md). MCP can access only
synchronized saved data; device-local unsynced data is unavailable.

### 1. Verify locally

From the repository root, start local Supabase if needed and run the complete
release gate:

```bash
npm run lint && npx tsc --noEmit && npm run test:unit && \
  npm run test:supabase && npm --prefix services/tabloom-mcp run type-check && \
  npm --prefix services/tabloom-mcp run build && npm run build:vercel
```

The database test command resets local Supabase. It must never be pointed at a
hosted database. It also executes the real operator cutover SQL against the
fixed local database address, tests its preconditions, final privileges, RLS,
Trash operations and extension sync, then rolls back that test's grants and
fixtures. A fresh reset therefore leaves the compatibility state in place.

### 2. Review and apply migrations 001 through 004

After approval, link only the existing production project and inspect both the
linked migration list and dry run:

```bash
npx supabase link --project-ref tctjlsvfufzxhauhywsm
npx supabase migration list --linked
npx supabase db push --linked --dry-run --skip-vault
```

Stop unless the only new migrations appear in this exact order:

1. `202609100001_workspace_trash.sql`
2. `202609100002_workspace_trash_sync.sql`
3. `202609100003_workspace_command_receipts.sql`
4. `202609100004_workspace_mcp_link_delete.sql`

With separate approval for the reviewed dry run, apply them before deploying
the service:

```bash
npx supabase db push --linked --skip-vault
```

Do not run migrations out of order and do not deploy the new service before
all four are present.

These migrations are additive for deployed client access: they retain the
existing authenticated table DELETE privileges and owner policies. The final
privilege change is deliberately outside `supabase/migrations`, in
`supabase/operations/workspace_trash_privilege_cutover.sql`; `db push` cannot
apply it. Legacy web deletion keeps its previous permanent-delete behavior
until the explicit cutover. Do not announce universal Trash protection yet.

These four migrations have not been released. If the linked migration list
already includes any of them from an earlier version of this branch, stop and
review that database's actual grants and function definitions before proceeding;
an edited migration file is not automatically reapplied by `db push`.

### 3. Deploy compatible web and MCP clients with mutations disabled

Schedule a short deletion maintenance window. Ask active web users to finish
pending work, avoid deletion during deployment, and reload `/app` afterward.
Publish the compatible extension packages and verify their sync delete RPC.
Already-open tabs can retain the old JavaScript bundle; a maintenance notice
and a new deployment alone do not replace that bundle or revoke API access.

From the repository root linked to the canonical web project, deploy the
reviewed web client that uses `SupabaseTrashRepository`:

```bash
vercel deploy --prod --cwd . --yes
```

Use a freshly loaded `/app` with dedicated fixtures to verify saved-link
deletion returns a Trash receipt and Undo restores the link, and that collection
deletion follows prepare/confirm and returns a recoverable receipt. Record the
web deployment ID as a compatible rollback target. Do not cut over privileges
if these checks fail.

Inspect whether the production variable already exists:

```bash
vercel env ls production --cwd services/tabloom-mcp
```

For its first creation, stage the disabled value without putting any secret in
the command line:

```bash
printf '%s\n' false | \
  vercel env add TABLOOM_MCP_MUTATIONS_ENABLED production \
  --cwd services/tabloom-mcp
```

If the variable already exists, update it instead:

```bash
printf '%s\n' false | \
  vercel env update TABLOOM_MCP_MUTATIONS_ENABLED production \
  --cwd services/tabloom-mcp
```

Then deploy the reviewed service commit:

```bash
vercel deploy --prod --cwd services/tabloom-mcp --yes
```

Through `https://tabloom.nickvu.dev/mcp`, require all of the following before
enablement:

- `get_service_status` reports `mutationsEnabled: false`.
- `get_workspace`, `list_spaces`, `list_collections`,
  `list_collection_items`, `search_workspace`, and `list_trash` work for an
  authenticated test user.
- Mutation tools are absent from `tools/list`, and a direct mutation call by
  name fails without changing data.
- Two dedicated users see only their own spaces, collections, links, Trash,
  and revisions. Cross-user target IDs return no data and cause no mutation.
- Logs and recorded evidence contain no tokens, raw authorization headers,
  saved URLs, descriptions, or private workspace snapshots.

Record only categorical pass/fail results, deployment and migration IDs, and
the reviewed commit.

### 4. Explicitly cut over direct DELETE privileges

After the compatible web, extension sync, and disabled MCP acceptance above
pass, run this operator-only step. Configure a private libpq service named
`tabloom-production` for project `tctjlsvfufzxhauhywsm`, using an administrative
database connection and a password file or approved secret store. Do not put
credentials into command arguments or logs. Verify the service target before
running these commands from the reviewed repository root:

```bash
PGOPTIONS='-c tabloom.trash_clients_ready=on' \
  psql 'service=tabloom-production' -X --set=ON_ERROR_STOP=1 \
  --file=supabase/operations/workspace_trash_privilege_cutover.sql
psql 'service=tabloom-production' -X --set=ON_ERROR_STOP=1 \
  --file=supabase/operations/workspace_trash_privilege_postcheck.sql
```

The readiness setting is the operator's explicit attestation that client
deployment, refresh handling, and acceptance are complete. The SQL also checks
the required authenticated RPCs, helper privileges, and ownership RLS before
changing access. The single statement revokes direct DELETE, replaces the old
ALL policies with SELECT/INSERT/UPDATE policies, and checks the final grants.
Any failed precondition or postcheck rolls back the entire statement; rerunning
a successful cutover is safe. It is never part of automatic schema deployment.

The read-only postcheck must return three rows with every boolean true. Then,
with a dedicated authenticated user, require direct DELETE on `spaces`,
`collections`, and `links` to fail with `42501`, while owned create/update/read,
Trash deletion/Undo, and extension sync still work. Repeat the two-user RLS
checks. Keep MCP mutations disabled if any result is uncertain.

Old web tabs now fail closed on direct deletion. Show affected users the refresh
instruction and have them reload `/app` before retrying. If the earlier deletion
outcome is uncertain, first read the live workspace and Trash to determine
whether it completed. Do not regrant DELETE to accommodate stale clients.
End deletion maintenance only after these postchecks pass.

### 5. Enable after client and privilege acceptance

Only after disabled deployment, explicit cutover, and two-user acceptance pass, update the
flag and redeploy:

```bash
printf '%s\n' true | \
  vercel env update TABLOOM_MCP_MUTATIONS_ENABLED production \
  --cwd services/tabloom-mcp
vercel deploy --prod --cwd services/tabloom-mcp --yes
```

Require `get_service_status` to report `mutationsEnabled: true`, then verify
with dedicated synchronized fixtures: create with an idempotent retry, stale
`expectedUpdatedAt` conflict without overwrite, prepare and explicitly confirm
a collection deletion, immediate saved-link deletion, `list_trash`, restore to
the original parent, restore with an alternate destination, and OAuth
revocation. Repeat the two-user isolation gate. Never record credentials or
raw authorization headers.

### 6. Roll back safely

Before the privilege cutover, a failed compatible-client deployment can roll
back to its prior web deployment while the additive database remains in the
compatibility state. Keep deletion maintenance in place and finish or postpone
the cutover explicitly. A failed cutover statement changes no grants.

After cutover, the web rollback target must itself use the Trash repository;
use the verified web deployment ID recorded above. A pre-Trash web build would
fail on deletion. If no healthy compatible web deployment is available, keep
workspace deletion unavailable and publish a refresh/maintenance notice until
a forward fix is deployed. Preserve the final DELETE revocation. Neither MCP
rollback nor a web rollback changes database privileges.

Before enabling mutations, preselect and record a reviewed deployment ID or
URL that passed the disabled-flag acceptance above or predates mutation-tool
registration. Do not use an arbitrary earlier deployment. Keep its non-secret
identifier available to the rollback shell without placing credentials in the
command:

```bash
export TABLOOM_MCP_ROLLBACK_DEPLOYMENT='dpl_REPLACE_WITH_REVIEWED_DISABLED_DEPLOYMENT_ID'
```

If acceptance fails, disable mutation tools first and redeploy immediately:

```bash
printf '%s\n' false | \
  vercel env update TABLOOM_MCP_MUTATIONS_ENABLED production \
  --cwd services/tabloom-mcp
vercel deploy --prod --cwd services/tabloom-mcp --yes
```

Confirm `mutationsEnabled: false`, read tools remain available, mutation tools
are absent, and the dedicated fixture's workspace revision and data are
unchanged. Capture that redacted comparison as the post-disable baseline. If
the new service itself is unhealthy, keep the flag false and roll back only to
the preselected deployment:

```bash
vercel rollback "$TABLOOM_MCP_ROLLBACK_DEPLOYMENT" \
  --cwd services/tabloom-mcp --yes
```

After rollback completes, repeat the checks rather than relying on the target
deployment's history:

- `get_service_status` succeeds. A flag-aware deployment must report
  `mutationsEnabled: false`; a pre-mutation deployment may omit that field only
  when the next check proves that mutation tools do not exist.
- `tools/list` contains no mutation tools, and a direct mutation call by name
  fails without changing data.
- The authenticated read tools remain available.
- The dedicated fixture's workspace revision and data exactly match the
  post-disable baseline. If the unhealthy service prevented that capture, use
  the most recent approved baseline and reconcile only already recorded
  acceptance mutations; any unexplained difference is a failure.

Treat any failed or ambiguous post-rollback check as an incident and keep
mutations disabled.

Leave migrations 001 through 004 in place: they are the forward-compatible
Trash and receipt foundation. Do not restore unsafe direct hard deletes or
attempt an ad hoc down migration. Diagnose and ship a reviewed forward fix;
Trash entries remain recoverable for their original 30-day windows.
After any post-cutover rollback, rerun the privilege postcheck command above
and the compatible web delete/Undo probe before ending maintenance.

## Run the redacted readiness probe

The local probe starts a literal `127.0.0.1` callback and opens the interactive
authorization request in the default browser. It discovers the issuer from the
protected resource, reads issuer metadata, performs public DCR, requests exact
S256/resource/scope bindings, verifies both access tokens through the published
JWKS, refreshes once, replays the original refresh token and requires exact
`invalid_grant`, calls `get_service_status`, revokes the rotated grant, and
requires the same access token to receive `401` from `/mcp`.

```bash
TABLOOM_MCP_RESOURCE_URL=https://tabloom.nickvu.dev/mcp \
  node scripts/probe-mcp-oauth.mjs
```

The ignored `outputs/mcp-oauth-readiness.json` file is mode `0600`. It contains
only booleans (including refresh replay rejection and cleanup failure),
issuer/resource strings, algorithm, audience, scope, and HTTP result classes. A separate one-shot
in-memory channel is the only boundary that can expose verified claims and
access tokens to the checked-in live test; the report writer and CLI cannot
serialize that channel. The report never contains authorization codes, access or refresh
tokens, PKCE verifiers, cookies, subjects, client IDs, emails, or key IDs. A
successful local fake/in-process test is not evidence that Supabase or Vercel
production works.

## Two-user live acceptance fixture

`tests/e2e/mcp-facade-live.spec.ts` is skipped unless
`TABLOOM_E2E_MCP_LIVE=1`, the exact production resource is set, and
`TABLOOM_E2E_MCP_FIXTURE_PATH` names a complete fixture, and
`TABLOOM_E2E_MCP_SIGNING_KEY_PATH` names the separate active acceptance
signing key described below. These inputs are JSON data, never JavaScript. The
checked-in acceptance code never imports or executes an external module and
never trusts precomputed pass/fail booleans.

The fixture and its two Playwright storage-state files must be owner-only
regular files with mode `0600`, addressed by absolute paths outside the
repository. Each file is opened once with no-follow semantics, checked through
its handle for owner, mode, type, size, and pathname identity, and parsed
through that same handle. Storage states must have different canonical paths
and device/inode identities. Only the validated in-memory state object is
passed to Playwright; the original path is removed from the loaded fixture.
Symlinks, aliases/hard links, repository paths, extra JSON properties,
duplicate users, and incomplete inputs are rejected. The exact version-1
fixture shape is:

```json
{
  "version": 1,
  "resource": "https://tabloom.nickvu.dev/mcp",
  "supabaseUrl": "https://tctjlsvfufzxhauhywsm.supabase.co",
  "supabaseAnonKey": "SUPABASE_PUBLIC_ANON_KEY_VALUE",
  "quiescentAcceptanceAccounts": true,
  "users": [
    {
      "label": "user-a",
      "userId": "00000000-0000-4000-8000-000000000001",
      "storageStatePath": "/absolute/external/user-a-storage.json",
      "supabaseAccessToken": "USER_A_SUPABASE_ACCESS_TOKEN",
      "ownedSpaceId": "00000000-0000-4000-8000-00000000000a",
      "ownedCollectionId": "00000000-0000-4000-8000-00000000000b",
      "ownedLinkId": "00000000-0000-4000-8000-00000000000c"
    },
    {
      "label": "user-b",
      "userId": "00000000-0000-4000-8000-000000000002",
      "storageStatePath": "/absolute/external/user-b-storage.json",
      "supabaseAccessToken": "USER_B_SUPABASE_ACCESS_TOKEN",
      "ownedSpaceId": "00000000-0000-4000-8000-00000000000d",
      "ownedCollectionId": "00000000-0000-4000-8000-00000000000e",
      "ownedLinkId": "00000000-0000-4000-8000-00000000000f"
    }
  ]
}
```

The values above are templates, not valid credentials. Each storage-state file
must use Playwright's JSON `{ "cookies": [], "origins": [] }` schema and hold
an already human-authenticated browser session for its distinct Google test
user. Each user must independently own the named space, collection, and link;
all six record UUIDs must be distinct.
`quiescentAcceptanceAccounts` is a required version-1 operator assertion: both
accounts and all six records are dedicated to this acceptance run, and no
browser, extension, sync client, script, or person may use or edit them from
fixture capture until the run finishes. Do not run this gate when exclusive
use cannot be guaranteed.

The signing-key path is intentionally separate from the general fixture. It is
an especially sensitive, operator-only copy of the currently active production
ES256 private JWK, required solely to construct the negative subject-mismatch
token at runtime. It must be an owner-only mode-`0600`, current-UID,
non-symlink regular file at an absolute path outside the repository, with this
exact shape (template values only):

```json
{
  "version": 1,
  "active": true,
  "kid": "ACTIVE_SIGNING_KID",
  "privateJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "PUBLIC_X",
    "y": "PUBLIC_Y",
    "d": "PRIVATE_D",
    "alg": "ES256"
  }
}
```

Do not create this file without explicit operator approval, do not derive it
from a fixture bearer, and never place it in the repository, shell history, or
logs. The test opens it once with `O_NOFOLLOW`, validates its owner/mode/type/
size/schema through that handle, zeroes the read buffer, and keeps the imported
key only in a one-shot closure. It requires the derived public key and `kid` to
exactly match one published live JWKS entry before signing, then drops the
private-key reference after use as far as JavaScript permits. The generated
bearer copies User A's freshly verified live header and claims, changes only the
`jti` and encrypted `supabase_token` (to User B's fresh ciphertext), is locally
verified while active, and is never serialized or printed. Random, malformed,
expired, unrelated, or unpublished-key bearers fail locally and are never sent.
Provisioning any external input remains an approved operator action.

The checked-in test performs DCR and browser login/consent for both users, reads
the published JWKS, validates exact ES256 issuer/resource/scope claims, parses
the real `get_service_status` JSON-RPC response, refreshes, and rejects replay
of the original refresh credential. It pauses both users with their rotated
grants active, requires both ordinary rotated A and B bearers to return the
exact successful `get_service_status` JSON-RPC result, then immediately submits
the runtime mismatch bearer and requires `401`. Only afterward does it resume
both probe phases, revoke each grant, and require each
rotated access token to receive post-revocation MCP `401`. Private in-memory
results bind both first and rotated facade subjects
to the fixture UUID and prove the two browser runs issued four distinct access
tokens. It independently resolves each Supabase token's subject, submits the
cryptographically validated mismatch bearer and requires `401`, and loads both
request-local workspaces to prove that every visible space, collection, and
link has the correct `user_id`, includes the expected independently owned
fixture record, and excludes the other user's fixture record. User A then
attempts a no-op update of one User B space, collection, and link, setting each
field to its already stored value. Each SDK call must return zero affected rows,
and User B must reload all three original records unchanged. Because even a
no-op update can fire revision triggers if RLS is broken, the gate first captures
all three records plus User B's exact `workspace_sync_state` revision and
`updated_at`. Before any repair it re-reads every target and sync state. It
restores only the exact timestamp/revision drift attributable to returned
no-op writes, through User B's hardened owner client, with equality
preconditions on every observed business/ownership/relationship field and on
the observed timestamps/revision. A changed field before repair, or a
zero-row optimistic repair caused by a change between read and write, produces
the fixed `concurrentFixtureMutation` category and is never overwritten or
rolled back. If all denied writes returned zero, any drift is treated as
concurrent and no repair is attempted. After attributable repairs the gate
re-reads the records and sync state for exact baseline equality. Cleanup denial,
concurrent mutation, or mismatch is a categorical fatal result;
the operator must stop rather than proceed with a possibly drifted fixture.
Every Supabase Auth and repository request uses a
silent SDK fetch wrapper confined to the exact approved production origin,
manual redirects, and all-`3xx` rejection. Console, stdout, and stderr are
disabled during all sensitive steps, errors are replaced with a fixed message,
and no credentials or browser state are reported. Do not enable future
workspace MCP tools to run this test.

Run it only after explicit approval and complete fixture preparation:

```bash
TABLOOM_E2E_MCP_LIVE=1 \
TABLOOM_E2E_MCP_RESOURCE_URL=https://tabloom.nickvu.dev/mcp \
TABLOOM_E2E_MCP_FIXTURE_PATH=/absolute/external/mcp-live-fixture.json \
TABLOOM_E2E_MCP_SIGNING_KEY_PATH=/absolute/external/mcp-live-active-signing-key.json \
  npx playwright test tests/e2e/mcp-facade-live.spec.ts --project=chromium
```

## Log inspection and cutover gate

Before cutover, an approved operator must inspect Vercel logs for JWT-shaped
strings, `access_token`, `refresh_token`, authorization codes, PKCE verifiers,
cookies, Supabase session fields, emails, raw user/client IDs, saved URLs, and
descriptions. The expected count is zero for credential and content matches.
Record only categorical/redacted results and the deployment commit.

Cutover is blocked unless the migration, disabled deployment, fixed callback,
two distinct users, exact claims, refresh race, revocation, subject mismatch,
cross-user RLS denial, and secret-free log inspection all pass. This repository
does not claim those live checks have occurred.
