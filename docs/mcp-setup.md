# Tabloom authorization facade operator guide

The remote MCP service is a separate Vercel project at the canonical origin
`https://tabloom-mcp.nickvu.dev`. That exact origin is both the OAuth issuer
and protected-resource identifier. Supabase remains the upstream Google
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
- `TABLOOM_MCP_RESOURCE_URL`: `https://tabloom-mcp.nickvu.dev`.
- `TABLOOM_OAUTH_ISSUER_URL`: `https://tabloom-mcp.nickvu.dev`.
- `TABLOOM_OAUTH_ENABLED`: exactly `false` for the first deployment.

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
https://tabloom-mcp.nickvu.dev/oauth/callback/supabase
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

## Run the redacted readiness probe

The local probe starts a literal `127.0.0.1` callback and opens the interactive
authorization request in the default browser. It discovers the issuer from the
protected resource, reads issuer metadata, performs public DCR, requests exact
S256/resource/scope bindings, verifies both access tokens through the published
JWKS, refreshes once, replays the original refresh token and requires exact
`invalid_grant`, calls `get_service_status`, revokes the rotated grant, and
requires the same access token to receive `401` from `/api/mcp`.

```bash
TABLOOM_MCP_RESOURCE_URL=https://tabloom-mcp.nickvu.dev \
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
  "resource": "https://tabloom-mcp.nickvu.dev",
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
TABLOOM_E2E_MCP_RESOURCE_URL=https://tabloom-mcp.nickvu.dev \
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
