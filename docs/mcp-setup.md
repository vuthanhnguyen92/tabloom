# Tabloom authorization facade operator guide

The remote MCP service is a separate Vercel project at the canonical origin
`https://tabloom-mcp.vercel.app`. That exact origin is both the OAuth issuer
and protected-resource identifier. Supabase remains the upstream Google
identity provider; it is not the MCP token issuer.

Every production mutation in this guide requires explicit operator approval.
Preparing files, running local tests, or reviewing this checklist does not
authorize linking or pushing Supabase, changing Auth redirect settings, setting
Vercel variables, deploying, inspecting live logs, enabling OAuth, or executing
cutover.

## Configuration contract

The Vercel service requires these public values:

- `SUPABASE_URL`: the Supabase project HTTPS origin.
- `SUPABASE_ANON_KEY`: the public anonymous key; never use a service-role key.
- `TABLOOM_MCP_RESOURCE_URL`: `https://tabloom-mcp.vercel.app`.
- `TABLOOM_OAUTH_ISSUER_URL`: `https://tabloom-mcp.vercel.app`.
- `TABLOOM_OAUTH_ENABLED`: exactly `false` for the first deployment.

The private `TABLOOM_OAUTH_SIGNING_KEYS` and
`TABLOOM_OAUTH_ENCRYPTION_KEYS` values are JSON arrays. Disabled mode may use
`[]`. Enabled production requires exactly one active ES256 private signing JWK
and exactly one active 32-byte encryption root. Template values in
`.env.example` are not deployable secrets.

Do not commit key files, place them inside this repository, paste them into a
shell command argument, print them, or copy them into `.env.local`. Generated
files are local transfer artifacts only.

## Generate and enter facade secrets

Create an operator-owned directory outside the repository, then pass two new
absolute paths. The generator refuses stdout, relative paths, existing files,
symlinks, and every path inside the repository. It creates both files with mode
`0600` and removes its own partial output if generation fails.

```bash
node services/tabloom-mcp/scripts/generate-oauth-keys.mjs \
  --signing-out /absolute/external/path/signing-v1.json \
  --encryption-out /absolute/external/path/encryption-v1.json
```

Enter each JSON file through the Vercel dashboard's secret-value editor, or
through stdin so the value is not retained in shell history:

```bash
vercel env add TABLOOM_OAUTH_SIGNING_KEYS production \
  < /absolute/external/path/signing-v1.json
vercel env add TABLOOM_OAUTH_ENCRYPTION_KEYS production \
  < /absolute/external/path/encryption-v1.json
```

Do not use command substitution or put JSON after the command name. Confirm the
files are untracked, transfer them through the approved secret channel, and
securely remove the local copies under the operator's retention policy.

### Rotation order

1. Generate a new signing and encryption pair outside the repository.
2. In the secret editor, create combined rings with the new entries active and
   every retained entry inactive. Keep the old private signing JWK because the
   current parser validates every configured signing entry; keep old encryption
   roots so existing artifacts can still be opened.
3. Deploy the overlapping rings while the old keys remain available, then run
   the complete redacted probe and two-user gate.
4. Retain old signing verification material for at least the maximum access
   overlap and old encryption roots for the maximum outstanding artifact and
   refresh-family overlap (currently 30 days).
5. Remove expired inactive entries in a later approved deployment and repeat
   the gate. Never switch both rings without an overlap deployment.

If rotation fails, disable the facade first, redeploy, revoke facade grant
families, and only then rotate or remove compromised rings. Ordinary Supabase
web and extension login must remain active.

## Supabase callback contract

After an approved disabled deployment, add this one upstream callback to
Supabase **Authentication → URL Configuration → Redirect URLs**:

```text
https://tabloom-mcp.vercel.app/oauth/callback/supabase
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
3. Configure the public values and versioned rings in Vercel with
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
JWKS, refreshes once, calls `get_service_status`, revokes the rotated grant, and
requires the same access token to receive `401` from `/api/mcp`.

```bash
TABLOOM_MCP_RESOURCE_URL=https://tabloom-mcp.vercel.app \
  node scripts/probe-mcp-oauth.mjs
```

The ignored `outputs/mcp-oauth-readiness.json` file is mode `0600`. It contains
only booleans, issuer/resource strings, algorithm, audience, scope, and HTTP
result classes. It never contains authorization codes, access or refresh
tokens, PKCE verifiers, cookies, subjects, client IDs, emails, or key IDs. A
successful local fake/in-process test is not evidence that Supabase or Vercel
production works.

## Two-user live acceptance fixture

`tests/e2e/mcp-facade-live.spec.ts` is skipped unless
`TABLOOM_E2E_MCP_LIVE=1` and every documented live variable is present. The
fixture module path must be absolute and should point to an ignored,
operator-controlled module outside the repository. Its
`createMcpFacadeLiveFixture({ resource })` function keeps codes, tokens,
verifiers, cookies, and user credentials inside closure state and exposes only:

- `authorize(label)` returning a session handle;
- redacted `claims()`;
- categorical service-status, refresh, replay, revoke, and post-revoke results;
- fixture-level nested-subject mismatch and cross-user workspace-isolation
  checks.

The fixture must use two distinct human-authenticated Supabase test users. It
must never return or log raw credentials. The acceptance proves exact ES256
issuer/resource/scope claims, service status, one-winner refresh rotation,
immediate revocation, outer/inner subject binding, and User A/User B RLS
isolation through request-local repository fixtures. Do not enable future
workspace MCP tools to run this test.

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
