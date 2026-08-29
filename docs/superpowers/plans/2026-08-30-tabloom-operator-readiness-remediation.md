# Tabloom Operator Readiness Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining authorization-facade review findings so the generated database proof can be installed exactly, dynamic client registration behaves consistently across Node and PostgreSQL, and the production readiness probe enforces the published OAuth metadata types.

**Architecture:** Keep the existing Vercel OAuth facade and Supabase persistence boundary. Tighten three seams only: the offline secret artifact/operator workflow, the Node-to-RPC registration contract, and the probe's distinction between JWT audience values and metadata arrays. Database failures cross the persistence boundary as typed, non-sensitive categories; HTTP routes own the public OAuth status and headers.

**Tech Stack:** Next.js 16.3.3 App Router, TypeScript 5.9.3, Node.js 22.13+, Vitest 4.1.11, Supabase Postgres/pgTAP, Vercel CLI.

**Spec:** `docs/superpowers/specs/2026-08-29-tabloom-authorization-facade-design.md`

## Global Constraints

- Make no Supabase, Vercel, DNS, OAuth-provider, or production deployment mutation during these remediation tasks.
- Keep `TABLOOM_OAUTH_DATABASE_SECRET` canonical: exactly 43 unpadded base64url characters decoding to 32 bytes. Do not trim it at a consumer boundary.
- Never print, log, commit, place in an argv value, or place in a saved SQL query any database proof secret or database credential.
- Verify database installation with a SHA-256 fingerprint of the decoded bytes, never by exposing the secret and never by checking length alone.
- Mirror every PostgreSQL registration bound in Node before the RPC: exact object shape, client-name character and UTF-8 byte limits, redirect count/uniqueness, redirect UTF-8 byte limit, scheme/host syntax, credential/fragment/wildcard/whitespace rejection, and explicit port range.
- Preserve scalar-or-array handling only for JWT `aud`; OAuth discovery and registration metadata fields specified as arrays must be actual arrays of strings.
- Preserve existing web and browser-extension authentication, local-mode behavior, RLS, and the anon-key-only persistence design.
- Return only categorical OAuth errors. Never expose PostgreSQL codes, messages, proof values, or correlation internals to clients.
- Implement each task test-first and commit it independently. Run the full local gate and an independent final review before requesting authority for any operator action.

---

### Task 1: Make the database-proof artifact exact and safely installable

**Files:**
- Modify: `services/tabloom-mcp/scripts/generate-oauth-keys.mjs`
- Create: `services/tabloom-mcp/scripts/install-oauth-database-secret.mjs`
- Modify: `services/tabloom-mcp/package.json`
- Modify: `package-lock.json`
- Modify: `docs/mcp-setup.md`
- Test: `tests/mcp/oauth-probe.test.ts`
- Test: `tests/mcp/oauth-database-secret-installer.test.ts`

**Interfaces:**

```js
export async function installOAuthDatabaseSecret({
  secretPath,
  databaseUrl,
  connect,
}) // => Promise<{ fingerprint: string }>
```

- [ ] **Step 1: Write failing artifact and installer tests**

Generate keys into a private temporary directory and read `database-proof-v1.txt` without modification. Assert its byte length is 43, it matches `/^[A-Za-z0-9_-]{43}$/`, it contains no line ending or whitespace, and `createOAuthDatabaseProofKey(fileBytes.toString("utf8"))` accepts it. Retain a separate test proving the strict consumer rejects the same value with `\n` appended.

For the installer, inject a fake parameterized database connection and prove it receives decoded 32-byte `Buffer` data, performs a single transactional upsert into `oauth_private.facade_secret`, returns the database-computed lowercase SHA-256 fingerprint, and never interpolates the secret into SQL text. Cover missing file, symlink/non-regular file, group/world-readable mode, newline/whitespace, non-canonical base64url, wrong decoded length, missing database URL, connection failure, transaction rollback, malformed fingerprint, and cleanup. Capture stdout/stderr and error messages to prove neither the secret nor database URL appears.

- [ ] **Step 2: Run the focused tests and verify the new contract fails**

```bash
npx vitest run tests/mcp/oauth-probe.test.ts tests/mcp/oauth-database-secret-installer.test.ts
```

- [ ] **Step 3: Write the database secret without a line feed**

Change only the database-proof artifact to write the canonical base64url value verbatim. Keep newline-terminated JSON key-ring files unchanged. Keep atomic exclusive creation, identity checks, mode `0600`, sync, cleanup, and no-secret output behavior.

- [ ] **Step 4: Implement a parameterized, non-logging installer**

Add `pg` as a private MCP service dependency and a script entry named `oauth:install-database-secret`. The CLI accepts `--secret-file /absolute/private/path`, reads the connection string only from `TABLOOM_OAUTH_DATABASE_URL`, rejects extra/unknown flags, validates the external file and exact canonical value, decodes it locally, and uses a parameterized query inside an explicit transaction:

```sql
insert into oauth_private.facade_secret (singleton, secret)
values (true, $1::bytea)
on conflict (singleton) do update set secret = excluded.secret
returning encode(extensions.digest(secret, 'sha256'), 'hex') as fingerprint
```

The command prints only the resulting fingerprint. It closes the connection on every path and normalizes failures to non-sensitive messages.

- [ ] **Step 5: Document the exact operator workflow**

Replace the direct `vercel env add < file` instruction with a command that reads the now newline-free file exactly. Document installing the same artifact into Postgres with `TABLOOM_OAUTH_DATABASE_URL` in the operator environment and `npm --workspace @tabloom/mcp run oauth:install-database-secret -- --secret-file /Users/nickvu/.tabloom-secrets/database-proof-v1.txt`. Document computing the local decoded-byte SHA-256 fingerprint with a repository command that emits no secret, and require it to equal the installer's returned fingerprint before enabling OAuth. State that length-only checks are insufficient and that neither artifact nor connection string belongs in Git, shell history, Vercel build logs, or saved SQL.

- [ ] **Step 6: Verify and commit the exact secret workflow**

```bash
npx vitest run tests/mcp/oauth-probe.test.ts tests/mcp/oauth-database-secret-installer.test.ts tests/mcp/oauth-persistence.test.ts
npm --workspace @tabloom/mcp run lint
npm --workspace @tabloom/mcp run type-check
git diff --check
git add services/tabloom-mcp/scripts/generate-oauth-keys.mjs services/tabloom-mcp/scripts/install-oauth-database-secret.mjs services/tabloom-mcp/package.json package-lock.json docs/mcp-setup.md tests/mcp/oauth-probe.test.ts tests/mcp/oauth-database-secret-installer.test.ts
git commit -m "fix: make OAuth database secret installation exact"
```

---

### Task 2: Align dynamic registration validation and persistence errors

**Files:**
- Modify: `services/tabloom-mcp/src/oauth/client-metadata.ts`
- Modify: `services/tabloom-mcp/src/oauth/persistence.ts`
- Modify: `services/tabloom-mcp/app/oauth/register/route.ts`
- Test: `tests/mcp/oauth-client.test.ts`
- Test: `tests/mcp/oauth-persistence.test.ts`
- Test: `tests/mcp/registration.test.ts`

**Interfaces:**

```ts
export class OAuthInvalidClientMetadataError extends Error {}
export class OAuthRegistrationCapacityError extends Error {
  readonly retryAfterSeconds = 60;
}
```

- [ ] **Step 1: Write failing parity and error-category tests**

Add Node validation cases matching `oauth_private.valid_redirect_uri` and `public.register_oauth_client`: client name 1–100 Unicode characters and at most 400 UTF-8 bytes; 1–10 unique redirects; each redirect 1–2048 UTF-8 bytes; exact HTTPS host or HTTP literal loopback; no user info, whitespace, fragment, wildcard, malformed authority, invalid IPv6 literal, or explicit port outside 1–65535. Include multibyte boundary cases and a redirect whose JavaScript length is below 2048 but UTF-8 length exceeds it.

Add adapter cases proving SQLSTATE `22023` becomes `OAuthInvalidClientMetadataError`, the fixed SQLSTATE/message pair `P0001` plus `OAuth registration quota exceeded` becomes `OAuthRegistrationCapacityError`, unrelated `P0001` remains generic, retryable database codes remain `OAuthPersistenceUnavailableError`, and no raw database message is exposed.

Add route cases proving invalid metadata returns `400 invalid_client_metadata`; registration capacity returns `429 temporarily_unavailable` with `Retry-After: 60`, CORS, and no-store headers; dependency outage remains `503`; unexpected failures remain sanitized `500`.

- [ ] **Step 2: Run the focused tests and verify the parity gaps fail**

```bash
npx vitest run tests/mcp/oauth-client.test.ts tests/mcp/oauth-persistence.test.ts tests/mcp/registration.test.ts
```

- [ ] **Step 3: Mirror PostgreSQL validation in Node**

Use `Array.from(value).length` for PostgreSQL-compatible Unicode character counts and `Buffer.byteLength(value, "utf8")` for byte bounds. Parse with `URL` only after rejecting characters PostgreSQL rejects, then validate the original authority and explicit port so URL normalization cannot turn an invalid input into an accepted one. Keep exact input strings for registration and redirect comparison; do not normalize, decode, or trim them.

- [ ] **Step 4: Add typed persistence categories and public route mapping**

Classify only the stable code/message pairs above before generic failure normalization. Preserve each typed error through the adapter's catch boundary. Map invalid metadata defensively to the same 400 response as pre-RPC validation. Map capacity to 429 with a fixed 60-second retry hint and audit result `rate_limited`. Do not expose exception text or database identifiers.

- [ ] **Step 5: Verify and commit registration parity**

```bash
npx vitest run tests/mcp/oauth-client.test.ts tests/mcp/oauth-persistence.test.ts tests/mcp/registration.test.ts
npm --workspace @tabloom/mcp run lint
npm --workspace @tabloom/mcp run type-check
git diff --check
git add services/tabloom-mcp/src/oauth/client-metadata.ts services/tabloom-mcp/src/oauth/persistence.ts services/tabloom-mcp/app/oauth/register/route.ts tests/mcp/oauth-client.test.ts tests/mcp/oauth-persistence.test.ts tests/mcp/registration.test.ts
git commit -m "fix: align OAuth dynamic registration boundaries"
```

---

### Task 3: Require arrays in OAuth readiness metadata

**Files:**
- Modify: `scripts/probe-mcp-oauth.mjs`
- Test: `tests/mcp/oauth-probe.test.ts`

**Interfaces:**

```js
function jwtAudienceValues(value) // string or string[]
function metadataStringArray(value) // string[] only, otherwise []
function exactMetadataStringArray(value, required)
```

- [ ] **Step 1: Write failing scalar-metadata tests**

Prove discovery fails when any of `authorization_servers`, `code_challenge_methods_supported`, `grant_types_supported`, `response_types_supported`, `scopes_supported`, or `token_endpoint_auth_methods_supported` is supplied as a scalar string. Prove DCR verification fails when `redirect_uris`, `grant_types`, or `response_types` is a scalar. Assert malformed discovery stops before DCR or browser handoff. Retain explicit tests that JWT `aud` accepts the expected resource as either one string or a one-element string array and rejects extra audiences.

- [ ] **Step 2: Run the probe tests and verify scalar metadata is currently accepted**

```bash
npx vitest run tests/mcp/oauth-probe.test.ts
```

- [ ] **Step 3: Separate JWT audience coercion from metadata validation**

Replace the shared coercing helper with two purpose-specific helpers. Use scalar-or-array handling only in `evaluateAudience`. Require actual all-string arrays everywhere discovery or DCR schemas require arrays; preserve exact required membership and cardinality checks.

- [ ] **Step 4: Verify and commit strict readiness metadata**

```bash
npx vitest run tests/mcp/oauth-probe.test.ts
npm run lint
npm run type-check
git diff --check
git add scripts/probe-mcp-oauth.mjs tests/mcp/oauth-probe.test.ts
git commit -m "fix: enforce OAuth metadata array types"
```

---

### Task 4: Run the complete local gate and independent review

**Files:**
- Review only: all files changed by Tasks 1–3

- [ ] **Step 1: Run the full deterministic test and build matrix**

```bash
npm test
npm run lint
npm run type-check
npm run build
npm --workspace @tabloom/mcp test
npm --workspace @tabloom/mcp run lint
npm --workspace @tabloom/mcp run type-check
npm --workspace @tabloom/mcp run build
npm run build:extension:chromium
npm run build:extension:firefox
npm run build:extension:safari
git diff --check
git status --short
```

Run `npx supabase test db supabase/tests/oauth_facade.test.sql` when local Docker/Supabase is available. If unavailable, record the exact environmental blocker and rerun the repository's isolated PostgreSQL substitute; do not claim the unavailable local Supabase command passed.

- [ ] **Step 2: Perform a fresh spec and code-quality review**

Review the complete branch diff against the spec and this remediation plan. Require zero Critical or Important findings. Resolve findings test-first, rerun the affected focused gate, and repeat review, for at most five fix rounds.

- [ ] **Step 3: Stop at the operator gate**

Report the verified local state and the exact external actions still pending: inspect remote migration state, install/compare the database secret, set Vercel environment variables, deploy disabled, run public metadata/JWKS checks, enable OAuth, run the interactive readiness probe, then run one authenticated MCP read and one harmless create/delete cycle. Request explicit approval before the first remote mutation.
