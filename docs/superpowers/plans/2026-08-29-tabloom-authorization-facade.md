# Tabloom Authorization Facade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the failed direct-Supabase MCP OAuth path with a standards-compliant Vercel authorization facade that issues exact-resource ES256 tokens while preserving Supabase user identity and row-level security.

**Architecture:** The existing `services/tabloom-mcp` Next.js service becomes both OAuth issuer and MCP resource server. It authenticates users upstream through Supabase Google OAuth, keeps Supabase credentials inside encrypted server-managed artifacts, issues short-lived resource-bound Tabloom tokens, and reconstructs a request-local RLS-preserving Supabase client after nested token verification. Narrow anonymous Supabase RPCs store only public client metadata and hashes needed for replay prevention and revocation; no service-role key is introduced.

**Tech Stack:** Next.js 16.3.3 App Router, TypeScript 5.9.3, Node.js 22.13+, `jose` 6.2.10, `@supabase/supabase-js` 2.112.4, `mcp-handler` 2.1.1, Vitest 4.1.11, Supabase Postgres/pgTAP, Vercel.

**Spec:** `docs/superpowers/specs/2026-08-29-tabloom-authorization-facade-design.md`

## Global Constraints

- Keep the facade behind `TABLOOM_OAUTH_ENABLED`; public metadata and JWKS may be deployed while disabled, but authorization, registration, token, revocation, and MCP requests return safe unavailable responses until enabled.
- The exact issuer and exact resource are the same canonical HTTPS origin. `/api/mcp` is a transport path, never an audience.
- Support only public clients, Authorization Code with PKCE S256, refresh tokens, exact redirect matching, DCR, HTTPS Client ID Metadata Documents, and scope `tabloom:workspace`.
- Never accept a direct Supabase token at `/api/mcp`, never accept `aud: authenticated` as the MCP audience, and never use a Supabase service-role key.
- Never put Supabase access or refresh tokens in browser JavaScript, HTML, form fields, logs, reports, query strings, or MCP responses.
- Derive independent AES-256-GCM keys by HKDF for each artifact purpose. Require one active versioned signing key and one active versioned encryption root while retaining explicitly configured verification/decryption keys for rotation overlap.
- Use host-only `HttpOnly; Secure; SameSite=Lax` cookies with ten-minute maximum lifetime. Authorization codes live at most two minutes; access tokens live at most ten minutes and never beyond the inner Supabase token; refresh tokens live at most thirty days.
- Hash random JTIs and grant-family IDs with SHA-256 before persistence. Persist no OAuth bearer credential.
- All OAuth responses use `Cache-Control: no-store` and `Pragma: no-cache`; all unexpected errors expose only a correlation ID.
- Preserve the existing extension and web Google login behavior. Do not change their Supabase callbacks.
- Implement each task test-first and commit it independently. Do not proceed to the original workspace read/write tasks until Task 11's live gate passes.

---

### Task 1: Define facade configuration and versioned cryptographic primitives

**Files:**
- Modify: `services/tabloom-mcp/src/auth/config.ts`
- Create: `services/tabloom-mcp/src/auth/key-rings.ts`
- Create: `services/tabloom-mcp/src/auth/artifacts.ts`
- Create: `services/tabloom-mcp/src/auth/access-token.ts`
- Test: `tests/mcp/facade-config.test.ts`
- Test: `tests/mcp/crypto.test.ts`

**Interfaces:**

```ts
export type OAuthArtifactPurpose =
  | "upstream_state"
  | "consent_session"
  | "authorization_code"
  | "inner_access_token"
  | "refresh_token";

export type FacadeAuthConfig = McpAuthConfig & {
  oauthEnabled: boolean;
  issuerUrl: URL;
  signingKeys: SigningKeyRing;
  encryptionKeys: EncryptionKeyRing;
};

export type TabloomAccessClaims = {
  sub: string;
  client_id: string;
  scope: "tabloom:workspace";
  grant_id: string;
  supabase_token: string; // compact JWE, never the plaintext inner token
};
```

- [ ] **Step 1: Write failing configuration and cryptography tests**

Cover missing/template values, issuer/resource mismatch, non-origin URLs, disabled mode without private keys, enabled mode requiring exactly one active ES256 private JWK and one active 32-byte encryption root, duplicate `kid`, unknown algorithm, invalid base64url, oversized environment JSON, and retained inactive keys.

Add artifact tests that prove round trips, wrong purpose, wrong key, expired/not-yet-valid artifact, malformed compact JWE, payload over 16 KiB, `kid` rotation overlap, and rejection after the old key is removed. Add access-token tests for exact `iss`, `aud`, `sub`, `client_id`, scope, `iat`, `nbf`, `exp`, `jti`, `grant_id`, and encrypted `supabase_token`.

```ts
it("never extends the outer token beyond the inner Supabase expiry", async () => {
  const token = await issueAccessToken(input({ innerExpiresAt: NOW + 90 }), config, NOW);
  const { payload } = await verifyAccessToken(token, config, NOW);
  expect(payload.exp).toBe(NOW + 90);
});

it("rejects an artifact opened under a different purpose", async () => {
  const sealed = await sealArtifact("authorization_code", codePayload, 120, keys, NOW);
  await expect(openArtifact("refresh_token", sealed, keys, NOW)).rejects.toThrow();
});
```

- [ ] **Step 2: Run tests and verify they fail for missing facade modules**

```bash
npx vitest run tests/mcp/facade-config.test.ts tests/mcp/crypto.test.ts
```

- [ ] **Step 3: Extend configuration without exposing secrets**

Parse these environment variables:

- `TABLOOM_OAUTH_ENABLED`: exact `true` or `false`.
- `TABLOOM_OAUTH_ISSUER_URL`: canonical HTTPS origin, equal to `TABLOOM_MCP_RESOURCE_URL` in enabled mode.
- `TABLOOM_OAUTH_SIGNING_KEYS`: JSON array of `{ kid, active, privateJwk }`; ES256 only.
- `TABLOOM_OAUTH_ENCRYPTION_KEYS`: JSON array of `{ kid, active, rootKey }`; `rootKey` is 32-byte base64url.

Do not include private material in thrown messages, snapshots, `toJSON`, health output, or diagnostics. Keep `SUPABASE_URL` and `SUPABASE_ANON_KEY` as the only Supabase credentials.

- [ ] **Step 4: Implement purpose-separated JWE and ES256 signing**

Use Node `hkdfSync("sha256", root, emptySalt, utf8("tabloom-oauth:" + purpose), 32)` and compact JWE protected headers `{ alg: "dir", enc: "A256GCM", kid, typ: "tabloom+" + purpose }`. Treat the protected header as authenticated purpose data and require the exact `typ` on open. Use `SignJWT` with protected header `{ alg: "ES256", kid, typ: "at+jwt" }` and a random 256-bit JTI.

Implement `hashOpaqueIdentifier(value): string` as lowercase SHA-256 hex for persistence. Limit bearer tokens to 32 KiB before JOSE parsing.

- [ ] **Step 5: Verify configuration and crypto**

```bash
npx vitest run tests/mcp/facade-config.test.ts tests/mcp/crypto.test.ts
npm --workspace @tabloom/mcp run type-check
```

- [ ] **Step 6: Commit cryptographic foundation**

```bash
git add services/tabloom-mcp/src/auth/config.ts services/tabloom-mcp/src/auth/key-rings.ts services/tabloom-mcp/src/auth/artifacts.ts services/tabloom-mcp/src/auth/access-token.ts tests/mcp/facade-config.test.ts tests/mcp/crypto.test.ts
git commit -m "feat: add authorization facade cryptography"
```

---

### Task 2: Add isolated OAuth persistence and narrow anonymous RPCs

**Files:**
- Create: `supabase/migrations/202608290002_oauth_facade.sql`
- Create: `supabase/tests/oauth_facade.test.sql`
- Create: `services/tabloom-mcp/src/oauth/persistence.ts`
- Test: `tests/mcp/oauth-persistence.test.ts`

**Interfaces:**

```ts
export type StoredPublicClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
  expiresAt: string | null;
};

export interface OAuthPersistence {
  registerClient(input: Omit<StoredPublicClient, "clientId" | "createdAt">): Promise<StoredPublicClient>;
  getClient(clientId: string): Promise<StoredPublicClient | null>;
  consume(kind: "authorization_code" | "refresh_token", jti: string, expiresAt: Date): Promise<boolean>;
  revokeGrant(grantId: string, expiresAt: Date): Promise<void>;
  isGrantRevoked(grantId: string): Promise<boolean>;
}
```

- [ ] **Step 1: Write failing pgTAP isolation and concurrency cases**

Create tests for `oauth_clients`, `oauth_consumed_tokens`, and `oauth_revoked_grants`; RLS enabled; no direct `anon` or `authenticated` table access; no table grants; strict JSON key sets; 1–10 exact redirect URIs; name length 1–100; expiry bounds; 64-character lowercase hex hashes; allowlisted kinds; idempotent revocation; exact opaque client lookup; and bounded cleanup.

Use competing transactions or two database connections to prove that exactly one call to `consume_oauth_token` returns true for the same hash. Assert OAuth functions cannot read `spaces`, `collections`, `links`, `workspace_sync_state`, or `auth.users`.

- [ ] **Step 2: Write failing TypeScript adapter tests**

Use a typed fake Supabase client's `rpc` method. Verify snake_case decoding, not-found handling, exact RPC argument names, SHA-256 hashing before calls, and mapping retryable database failures to a non-sensitive `OAuthPersistenceUnavailableError`.

- [ ] **Step 3: Run the missing migration/adapter tests**

```bash
npx vitest run tests/mcp/oauth-persistence.test.ts
npx supabase test db supabase/tests/oauth_facade.test.sql
```

- [ ] **Step 4: Implement tables and security-definer RPCs**

Create these functions with `security definer`, `set search_path = public, pg_temp`, explicit input validation, and revoked default execution:

- `register_oauth_client(client_metadata jsonb) returns jsonb`
- `get_oauth_client(client_id uuid) returns jsonb`
- `consume_oauth_token(token_hash text, token_kind text, expires_at timestamptz) returns boolean`
- `revoke_oauth_grant(grant_hash text, expires_at timestamptz) returns void`
- `is_oauth_grant_revoked(grant_hash text) returns boolean`

Grant only these functions to `anon`; do not grant OAuth tables. Opportunistically delete at most 100 expired replay/revocation rows per write call. Use `gen_random_uuid()` for DCR client IDs and a unique `(kind, token_hash)` key for atomic consumption.

- [ ] **Step 5: Implement the anon-key persistence adapter**

Create a Supabase client with disabled session persistence and the public anon key. Never attach a user access token or service-role credential. The adapter owns hashing so callers cannot accidentally persist a raw JTI/grant ID.

- [ ] **Step 6: Verify SQL and adapter behavior**

```bash
npx supabase db reset
npx supabase test db supabase/tests/oauth_facade.test.sql
npx vitest run tests/mcp/oauth-persistence.test.ts
```

- [ ] **Step 7: Commit OAuth persistence**

```bash
git add supabase/migrations/202608290002_oauth_facade.sql supabase/tests/oauth_facade.test.sql services/tabloom-mcp/src/oauth/persistence.ts tests/mcp/oauth-persistence.test.ts
git commit -m "feat: persist OAuth replay and revocation state"
```

---

### Task 3: Validate public clients, exact redirects, PKCE, and CIMD safely

**Files:**
- Create: `services/tabloom-mcp/src/oauth/client-metadata.ts`
- Create: `services/tabloom-mcp/src/oauth/cimd.ts`
- Create: `services/tabloom-mcp/src/oauth/authorization-request.ts`
- Test: `tests/mcp/oauth-client.test.ts`
- Test: `tests/mcp/cimd.test.ts`
- Test: `tests/mcp/authorization-request.test.ts`

**Interfaces:**

```ts
export type ValidatedClient = {
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
  source: "dcr" | "cimd";
};

export type ValidatedAuthorizationRequest = {
  client: ValidatedClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  scope: "tabloom:workspace";
};
```

- [ ] **Step 1: Write failing DCR and authorization validation tests**

Require exact input keys, `token_endpoint_auth_method: "none"`, grant types limited to `authorization_code` and optional `refresh_token`, response type `code`, 1–10 unique redirects, and a display name of 1–100 normalized characters. Reject secrets, JWKS fields, software statements, wildcard redirects, fragments, credentials, and HTTP redirects except literal `127.0.0.1` or `[::1]` loopback addresses.

Authorization requests must require `response_type=code`, non-empty `state` up to 512 bytes, a 43–128 character RFC 7636 verifier challenge, `code_challenge_method=S256`, exact resource origin, exact scope, exact client/redirect match, and no duplicate query parameter names.

- [ ] **Step 2: Write failing CIMD SSRF tests**

Inject a DNS resolver and HTTPS transport. Cover public IPv4/IPv6 success, DNS failure, credentials, fragments, non-HTTPS client IDs, redirects, timeout after 3 seconds, body over 32 KiB, more than one resolved address family without pinning, private/link-local/loopback/multicast/documentation/reserved IPs, invalid JSON/content type, and metadata whose `client_id` is not byte-for-byte equal to the requested URL.

- [ ] **Step 3: Run tests and verify missing validators**

```bash
npx vitest run tests/mcp/oauth-client.test.ts tests/mcp/cimd.test.ts tests/mcp/authorization-request.test.ts
```

- [ ] **Step 4: Implement client resolution**

Treat a UUID `client_id` as DCR and load it through `OAuthPersistence`. Treat an HTTPS URL as CIMD. Reject every other shape. For CIMD, resolve the hostname once, reject any non-public address, and make one `node:https` request with certificate/SNI hostname validation and a custom `lookup` callback pinned to the selected validated address. Set `maxRedirects` behavior to zero by rejecting every 3xx response.

Accept only JSON media types, cap bytes while streaming, abort on timeout, and validate the same public-client schema used for DCR. Cache successful CIMD documents in memory for at most five minutes keyed by exact URL; do not cache failures.

- [ ] **Step 5: Implement PKCE verification and exact authorization parsing**

Export `verifyS256(codeVerifier, expectedChallenge)` using SHA-256 plus `timingSafeEqual`. Parse URL parameters into an exact record and fail before redirecting when client or redirect URI has not been validated. Once redirect validation succeeds, return standard OAuth errors through that exact URI.

- [ ] **Step 6: Verify all client boundaries**

```bash
npx vitest run tests/mcp/oauth-client.test.ts tests/mcp/cimd.test.ts tests/mcp/authorization-request.test.ts
npm --workspace @tabloom/mcp run type-check
```

- [ ] **Step 7: Commit client validation**

```bash
git add services/tabloom-mcp/src/oauth/client-metadata.ts services/tabloom-mcp/src/oauth/cimd.ts services/tabloom-mcp/src/oauth/authorization-request.ts tests/mcp/oauth-client.test.ts tests/mcp/cimd.test.ts tests/mcp/authorization-request.test.ts
git commit -m "feat: validate public OAuth clients"
```

---

### Task 4: Publish facade metadata, JWKS, and dynamic registration

**Files:**
- Create: `services/tabloom-mcp/app/.well-known/oauth-authorization-server/route.ts`
- Create: `services/tabloom-mcp/app/.well-known/jwks.json/route.ts`
- Create: `services/tabloom-mcp/app/oauth/register/route.ts`
- Create: `services/tabloom-mcp/src/oauth/responses.ts`
- Modify: `services/tabloom-mcp/app/.well-known/oauth-protected-resource/route.ts`
- Modify: `tests/mcp/discovery.test.ts`
- Create: `tests/mcp/registration.test.ts`

- [ ] **Step 1: Rewrite discovery tests for the facade issuer**

Assert the authorization metadata advertises the exact origin issuer, authorization/token/registration/revocation endpoints, JWKS URI, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, and `scopes_supported: ["tabloom:workspace"]`.

Assert protected-resource metadata points only to the facade issuer. Assert JWKS contains public ES256 keys only, includes retained verification keys, marks no private parameter, and has public cache headers. Metadata must support CORS `GET, OPTIONS`.

- [ ] **Step 2: Write failing registration route tests**

Test JSON-only POST, 32 KiB body cap, disabled feature behavior, successful `201` response, no `client_secret`, and standards-shaped `invalid_client_metadata`/`invalid_request` responses. Every response must be no-store and must not echo rejected secrets or unknown fields.

- [ ] **Step 3: Run route tests and verify missing routes**

```bash
npx vitest run tests/mcp/discovery.test.ts tests/mcp/registration.test.ts
```

- [ ] **Step 4: Implement shared safe OAuth responses and routes**

Create helpers for JSON errors, redirect errors, correlation IDs, no-store headers, and method/content-type/body-size enforcement. Metadata/JWKS remain readable when the facade is disabled so deployment can be inspected; `/oauth/register` returns `503 temporarily_unavailable` until enabled.

Build JWKS from configured private JWKs using `exportJWK(await importJWK(...))`, remove `d`, and publish only `kty`, `crv`, `x`, `y`, `alg`, `use`, and `kid`.

- [ ] **Step 5: Verify discovery, registration, and build**

```bash
npx vitest run tests/mcp/discovery.test.ts tests/mcp/registration.test.ts
npm --workspace @tabloom/mcp run build
```

- [ ] **Step 6: Commit public OAuth discovery**

```bash
git add services/tabloom-mcp/app/.well-known/oauth-authorization-server services/tabloom-mcp/app/.well-known/jwks.json services/tabloom-mcp/app/oauth/register services/tabloom-mcp/src/oauth/responses.ts services/tabloom-mcp/app/.well-known/oauth-protected-resource/route.ts tests/mcp/discovery.test.ts tests/mcp/registration.test.ts
git commit -m "feat: publish Tabloom OAuth discovery"
```

---

### Task 5: Implement upstream Supabase Google login and callback state

**Files:**
- Create: `services/tabloom-mcp/src/oauth/cookies.ts`
- Create: `services/tabloom-mcp/src/oauth/upstream-supabase.ts`
- Create: `services/tabloom-mcp/app/oauth/authorize/route.ts`
- Create: `services/tabloom-mcp/app/oauth/callback/supabase/route.ts`
- Test: `tests/mcp/oauth-cookies.test.ts`
- Test: `tests/mcp/upstream-login.test.ts`
- Test: `tests/mcp/authorize-route.test.ts`

**Interfaces:**

```ts
export type UpstreamLoginState = {
  request: ValidatedAuthorizationRequest;
  supabaseCodeVerifier: string;
};

export interface UpstreamSupabaseAuth {
  begin(redirectTo: string): Promise<{ providerUrl: string; codeVerifier: string }>;
  exchange(code: string, codeVerifier: string): Promise<ValidatedSupabaseSession>;
}
```

- [ ] **Step 1: Write failing cookie and upstream adapter tests**

Assert `__Host-tabloom_oauth_state` and `__Host-tabloom_consent` are host-only, path `/`, `HttpOnly`, `Secure`, `SameSite=Lax`, max-age at most 600, encrypted, purpose-separated, and cleared with identical attributes. Test that provider errors, missing code/state cookie, expired cookies, absent PKCE verifier, absent session fields, invalid UUID subjects, and inner token expiry all fail closed.

- [ ] **Step 2: Write failing authorize/callback route tests**

Test validation before redirect, disabled behavior, DCR and CIMD clients, exact fixed callback `https://<issuer>/oauth/callback/supabase`, Supabase provider URL redirection, encrypted transaction-cookie creation, provider denial, code exchange, `auth.getUser(accessToken)` validation, outer/inner subject extraction, consent-cookie creation, and transaction-cookie deletion.

- [ ] **Step 3: Run tests and verify missing login flow**

```bash
npx vitest run tests/mcp/oauth-cookies.test.ts tests/mcp/upstream-login.test.ts tests/mcp/authorize-route.test.ts
```

- [ ] **Step 4: Implement Supabase PKCE without browser token exposure**

Instantiate `@supabase/supabase-js` with `flowType: "pkce"`, `persistSession: false`, `autoRefreshToken: false`, and an injected in-memory storage adapter. `begin` calls `signInWithOAuth({ provider: "google", options: { redirectTo, skipBrowserRedirect: true } })`, captures the generated code verifier from storage, then discards storage. `exchange` preloads only that verifier, calls `exchangeCodeForSession`, validates the user with `getUser(accessToken)`, and returns only the server-side session object.

Never use provider tokens and never serialize the Supabase session into a client-readable cookie.

- [ ] **Step 5: Implement authorization and callback routes**

`GET /oauth/authorize` validates and encrypts the original request plus the upstream PKCE verifier before redirecting. `GET /oauth/callback/supabase` requires and opens that transaction cookie, exchanges the returned code with the cookie-bound verifier, validates the user UUID, seals a consent session containing the original request and Supabase access/refresh credentials, clears the transaction cookie, and redirects to `/oauth/consent`. Do not require Supabase to echo the MCP client's `state`; the upstream CSRF binding is the encrypted host-only transaction cookie plus Supabase PKCE, while the original client state stays inside the encrypted transaction and consent artifacts until the final client redirect.

- [ ] **Step 6: Verify upstream flow and build**

```bash
npx vitest run tests/mcp/oauth-cookies.test.ts tests/mcp/upstream-login.test.ts tests/mcp/authorize-route.test.ts
npm --workspace @tabloom/mcp run build
```

- [ ] **Step 7: Commit upstream login**

```bash
git add services/tabloom-mcp/src/oauth/cookies.ts services/tabloom-mcp/src/oauth/upstream-supabase.ts services/tabloom-mcp/app/oauth/authorize services/tabloom-mcp/app/oauth/callback tests/mcp/oauth-cookies.test.ts tests/mcp/upstream-login.test.ts tests/mcp/authorize-route.test.ts
git commit -m "feat: authenticate facade users with Supabase"
```

---

### Task 6: Add public Vercel consent and one-time authorization codes

**Files:**
- Create: `services/tabloom-mcp/src/oauth/consent.ts`
- Create: `services/tabloom-mcp/app/oauth/consent/route.ts`
- Test: `tests/mcp/consent.test.ts`

- [ ] **Step 1: Write failing consent rendering and action tests**

Prove the GET page escapes the validated client name and redirect URI, names the `tabloom:workspace` permission, states that browser-local tabs/bookmarks are excluded, contains no Supabase token, and sets a restrictive CSP. Test missing/expired consent session, double submission, CSRF nonce mismatch, approval, denial, cookie clearing, safe client redirect errors, and malformed POST bodies.

```ts
expect(html).toContain("Read and organize your synchronized Tabloom workspace");
expect(html).toContain("Current browser tabs and device-only bookmarks are not included");
expect(html).not.toContain(session.supabaseAccessToken);
```

- [ ] **Step 2: Run the test and verify consent is missing**

```bash
npx vitest run tests/mcp/consent.test.ts
```

- [ ] **Step 3: Implement a server-rendered GET/POST consent route**

GET opens the encrypted consent cookie and renders semantic HTML with Approve and Deny buttons. POST accepts only `application/x-www-form-urlencoded`, an exact action (`approve` or `deny`), and a constant-time-matched nonce. Use HTML escaping for every dynamic value; use `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`.

On approval, seal an authorization-code payload containing the validated bindings, user UUID, Supabase access/refresh tokens, random code JTI, random grant-family ID, issue time, and two-minute expiry. Redirect with `code` and the original client `state`. On denial, redirect with `error=access_denied` and state. Clear the consent cookie in both cases.

- [ ] **Step 4: Verify consent safety and build**

```bash
npx vitest run tests/mcp/consent.test.ts
npm --workspace @tabloom/mcp run build
```

- [ ] **Step 5: Commit Vercel consent**

```bash
git add services/tabloom-mcp/src/oauth/consent.ts services/tabloom-mcp/app/oauth/consent/route.ts tests/mcp/consent.test.ts
git commit -m "feat: add public OAuth consent"
```

---

### Task 7: Exchange codes for exact-resource access and refresh tokens

**Files:**
- Create: `services/tabloom-mcp/src/oauth/token-service.ts`
- Create: `services/tabloom-mcp/app/oauth/token/route.ts`
- Test: `tests/mcp/token-endpoint.test.ts`

**Interfaces:**

```ts
export type OAuthTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: "tabloom:workspace";
};
```

- [ ] **Step 1: Write failing authorization-code grant tests**

Test form-only POST, 32 KiB body cap, public client with no secret, exact grant/client/redirect/resource binding, S256 verifier, code expiry, code JTI one-time consumption, concurrent replay, revoked family, inner Supabase `getUser` revalidation, and inner/outer subject equality. All mismatch/replay cases return identical `invalid_grant` bodies.

Decode the issued token with the local public key and assert exact issuer/audience, ES256, `tabloom:workspace`, UUID subject, client ID, grant ID, random JTI, and `exp <= min(now + 600, innerExp)`. Open the nested JWE only in tests to prove it contains the original Supabase access token and no refresh token.

- [ ] **Step 2: Run tests and verify the endpoint is missing**

```bash
npx vitest run tests/mcp/token-endpoint.test.ts
```

- [ ] **Step 3: Implement authorization-code exchange**

Open the code under the `authorization_code` purpose, validate all submitted bindings, verify PKCE in constant time, check revocation, atomically consume the code JTI, then revalidate the Supabase access token and subject. Seal the inner access token separately, issue the outer token, and seal a refresh JWE containing only the Supabase refresh token plus subject/client/resource/scope/grant/JTI/time bindings.

Consume the authorization code before returning any token. If persistence is unavailable, return `temporarily_unavailable`; never issue a token without replay protection.

- [ ] **Step 4: Verify token exchange**

```bash
npx vitest run tests/mcp/token-endpoint.test.ts
npm --workspace @tabloom/mcp run type-check
npm --workspace @tabloom/mcp run build
```

- [ ] **Step 5: Commit code exchange**

```bash
git add services/tabloom-mcp/src/oauth/token-service.ts services/tabloom-mcp/app/oauth/token/route.ts tests/mcp/token-endpoint.test.ts
git commit -m "feat: issue resource-bound OAuth tokens"
```

---

### Task 8: Rotate refresh tokens and revoke grant families

**Files:**
- Modify: `services/tabloom-mcp/src/oauth/token-service.ts`
- Create: `services/tabloom-mcp/src/oauth/revocation-service.ts`
- Create: `services/tabloom-mcp/app/oauth/revoke/route.ts`
- Modify: `tests/mcp/token-endpoint.test.ts`
- Create: `tests/mcp/revocation.test.ts`

- [ ] **Step 1: Write failing refresh rotation tests**

Cover valid refresh, exact client/resource/scope binding, expiry, wrong purpose/key, revoked family, missing upstream refresh token, Supabase refresh failure, changed Supabase user, and a concurrent reuse race with exactly one winner. Assert each successful refresh returns a new refresh JTI, a new access JTI, the same grant family, and newly rotated upstream credentials.

- [ ] **Step 2: Write failing revocation tests**

Revoking either a valid access token or refresh token must hash and revoke the family. Refresh-token revocation also attempts to consume its JTI. Unknown, malformed, wrong-key, expired, and already-revoked tokens all return `200` with an empty body and leak no validity signal. Revoked access must fail immediately in the resource verifier added in Task 9.

- [ ] **Step 3: Run tests and verify refresh/revocation failures**

```bash
npx vitest run tests/mcp/token-endpoint.test.ts tests/mcp/revocation.test.ts
```

- [ ] **Step 4: Implement refresh rotation**

For `grant_type=refresh_token`, open and validate the refresh artifact, check grant revocation, atomically consume its JTI, then call Supabase `auth.refreshSession({ refresh_token })`. Validate the returned user UUID and issue a new access/refresh pair. Treat a consumed JTI as terminal `invalid_grant`; do not restore a consumed token after an upstream failure.

- [ ] **Step 5: Implement non-disclosing revocation**

Try strict access-token verification first, then strict refresh-artifact opening. For a valid format, revoke the grant through `OAuthPersistence`; for refresh tokens also consume the presented JTI. Swallow token-validity distinctions, but return `503 temporarily_unavailable` when persistence itself is unavailable so a caller is not falsely told durable revocation succeeded.

- [ ] **Step 6: Verify rotation and revocation**

```bash
npx vitest run tests/mcp/token-endpoint.test.ts tests/mcp/revocation.test.ts
npm --workspace @tabloom/mcp run build
```

- [ ] **Step 7: Commit refresh and revocation**

```bash
git add services/tabloom-mcp/src/oauth/token-service.ts services/tabloom-mcp/src/oauth/revocation-service.ts services/tabloom-mcp/app/oauth/revoke/route.ts tests/mcp/token-endpoint.test.ts tests/mcp/revocation.test.ts
git commit -m "feat: rotate and revoke OAuth grants"
```

---

### Task 9: Replace direct Supabase bearer verification with nested RLS context

**Files:**
- Modify: `services/tabloom-mcp/src/auth/verify-token.ts`
- Create: `services/tabloom-mcp/src/auth/verify-supabase-token.ts`
- Create: `services/tabloom-mcp/src/auth/request-context.ts`
- Modify: `services/tabloom-mcp/app/api/mcp/route.ts`
- Modify: `tests/mcp/auth.test.ts`
- Create: `tests/mcp/request-context.test.ts`
- Modify: `tests/mcp/discovery.test.ts`

**Interfaces:**

```ts
export type TabloomRequestContext = {
  userId: string;
  clientId: string;
  scope: "tabloom:workspace";
  supabase: SupabaseClient;
};

export type VerifiedFacadeAuthInfo = AuthInfo & {
  extra: {
    userId: string;
    clientId: string;
    requestContext: TabloomRequestContext;
  };
};
```

- [ ] **Step 1: Rewrite verifier tests around facade tokens**

Reject direct Supabase tokens, `aud: authenticated`, wrong issuer/resource/algorithm/key/type, missing/invalid claims, unsupported scope, expired/not-yet-valid token, oversized bearer, nested JWE failure, nested token expiry, grant revocation, Supabase validation failure, and outer/inner UUID mismatch. Verify failure always returns `undefined` and never logs token/provider details.

- [ ] **Step 2: Write failing request-context tests**

Assert the request-local Supabase client uses only `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `accessToken: async () => innerToken`, with `persistSession`, `autoRefreshToken`, and `detectSessionInUrl` disabled. Prove it never accepts a tool-supplied user ID and that two contexts use distinct inner tokens.

- [ ] **Step 3: Run tests and observe old direct verifier behavior**

```bash
npx vitest run tests/mcp/auth.test.ts tests/mcp/request-context.test.ts tests/mcp/discovery.test.ts
```

- [ ] **Step 4: Implement nested verification in fail-closed order**

1. Reject missing/oversized bearer.
2. Verify outer ES256 signature, exact issuer/audience, type, lifetime, UUID subject, canonical client ID, exact scope, JTI, and grant ID.
3. Check the grant-family hash through `OAuthPersistence`.
4. Open `supabase_token` under `inner_access_token`.
5. Validate the inner token through the configured Supabase project's `auth.getUser(innerToken)`.
6. Require inner UUID to equal outer `sub`.
7. Create the request-local Supabase client and return it only in server-internal `AuthInfo.extra`.

Never use the outer Tabloom token against Supabase. Never forward the inner token anywhere except the configured Supabase origin.

- [ ] **Step 5: Gate MCP access on facade enablement and verified context**

Update `/api/mcp` to use the new verifier with `requiredScopes: ["tabloom:workspace"]`. When disabled, return `503` with a standards-shaped unavailable response rather than accepting the former direct token. Keep `get_service_status` as the only tool until the live facade gate passes; make its result include no config, identity, or token claims.

- [ ] **Step 6: Verify authentication and build**

```bash
npx vitest run tests/mcp/auth.test.ts tests/mcp/request-context.test.ts tests/mcp/discovery.test.ts
npm --workspace @tabloom/mcp run type-check
npm --workspace @tabloom/mcp run build
```

- [ ] **Step 7: Commit RLS-preserving verification**

```bash
git add services/tabloom-mcp/src/auth/verify-token.ts services/tabloom-mcp/src/auth/verify-supabase-token.ts services/tabloom-mcp/src/auth/request-context.ts services/tabloom-mcp/app/api/mcp/route.ts tests/mcp/auth.test.ts tests/mcp/request-context.test.ts tests/mcp/discovery.test.ts
git commit -m "feat: verify nested Supabase user context"
```

---

### Task 10: Add protocol integration coverage, rate limits, and redacted observability

**Files:**
- Create: `services/tabloom-mcp/src/security/oauth-rate-limit.ts`
- Create: `services/tabloom-mcp/src/observability/oauth-audit.ts`
- Modify: `services/tabloom-mcp/src/oauth/responses.ts`
- Modify: `services/tabloom-mcp/app/oauth/register/route.ts`
- Modify: `services/tabloom-mcp/app/oauth/authorize/route.ts`
- Modify: `services/tabloom-mcp/app/oauth/token/route.ts`
- Modify: `services/tabloom-mcp/app/oauth/revoke/route.ts`
- Create: `tests/mcp/oauth-flow.test.ts`
- Create: `tests/mcp/oauth-security.test.ts`

- [ ] **Step 1: Write an in-process end-to-end OAuth flow test**

Use fake persistence and fake Supabase auth, but real JOSE, cookies, route handlers, PKCE, and redirect parsing. Complete DCR → authorize → callback → consent → code exchange → authenticated MCP status → refresh → revoke. Assert one-time code and refresh behavior and immediate post-revocation MCP failure.

Add a CIMD variant and a second user. Deliberately substitute User B's encrypted inner token into User A's outer claims and assert rejection.

- [ ] **Step 2: Write rate-limit, header, and redaction tests**

Implement fixed-window in-memory limits suitable for one Vercel instance plus the durable replay/revocation controls: registration 20/IP/minute, authorize 30/IP/minute, token 30/client/minute, revocation 60/IP/minute. Return `429` with `Retry-After`; do not trust `x-forwarded-for` except the first syntactically valid address supplied by Vercel.

Assert OAuth routes include no-store headers, CSP where HTML is returned, `X-Content-Type-Options: nosniff`, and no credential-bearing values in logs. Audit output may contain only route category, latency bucket, result class, correlation ID, and SHA-256 hashes of client/grant identifiers.

- [ ] **Step 3: Run the failing integration/security tests**

```bash
npx vitest run tests/mcp/oauth-flow.test.ts tests/mcp/oauth-security.test.ts
```

- [ ] **Step 4: Implement rate limits and allowlisted audit events**

Keep rate-limit storage behind an interface so durable edge storage can replace it later. Do not use rate limiting as a correctness boundary; replay and revocation remain in Postgres. Map provider/network failures to `temporarily_unavailable`, malformed inputs to the correct OAuth error, and unexpected failures to `server_error` plus correlation ID.

- [ ] **Step 5: Run the full facade verification set**

```bash
npx vitest run tests/mcp/facade-config.test.ts tests/mcp/crypto.test.ts tests/mcp/oauth-persistence.test.ts tests/mcp/oauth-client.test.ts tests/mcp/cimd.test.ts tests/mcp/authorization-request.test.ts tests/mcp/discovery.test.ts tests/mcp/registration.test.ts tests/mcp/oauth-cookies.test.ts tests/mcp/upstream-login.test.ts tests/mcp/authorize-route.test.ts tests/mcp/consent.test.ts tests/mcp/token-endpoint.test.ts tests/mcp/revocation.test.ts tests/mcp/auth.test.ts tests/mcp/request-context.test.ts tests/mcp/oauth-flow.test.ts tests/mcp/oauth-security.test.ts
npx supabase db reset
npx supabase test db supabase/tests/*.test.sql
npm --workspace @tabloom/mcp run lint
npm --workspace @tabloom/mcp run type-check
npm --workspace @tabloom/mcp run build
```

- [ ] **Step 6: Commit integration hardening**

```bash
git add services/tabloom-mcp/src/security services/tabloom-mcp/src/observability services/tabloom-mcp/src/oauth/responses.ts services/tabloom-mcp/app/oauth tests/mcp/oauth-flow.test.ts tests/mcp/oauth-security.test.ts
git commit -m "test: harden authorization facade flow"
```

---

### Task 11: Deploy behind the gate and prove the live OAuth contract

**Files:**
- Modify: `scripts/probe-mcp-oauth.mjs`
- Modify: `tests/mcp/oauth-probe.test.ts`
- Modify: `.env.example`
- Modify: `docs/mcp-setup.md`
- Modify: `README.md`
- Create: `services/tabloom-mcp/scripts/generate-oauth-keys.mjs`
- Create: `tests/e2e/mcp-facade-live.spec.ts`

- [ ] **Step 1: Rewrite the readiness probe tests for the facade**

The probe must discover the issuer from protected-resource metadata, support DCR with a loopback redirect, request exact scope/resource with S256, verify the returned access token through published JWKS, refresh once, revoke the grant, and prove the access token subsequently fails at `/api/mcp`. Its report may include only booleans, issuer/resource strings, algorithm, audience, scope, and HTTP result classes.

```ts
expect(report).toMatchObject({
  issuerMatch: true,
  audienceMatch: true,
  scopeMatch: true,
  refreshRotated: true,
  revocationEnforced: true,
  pass: true,
});
expect(JSON.stringify(report)).not.toMatch(/access_token|refresh_token|authorization_code/i);
```

- [ ] **Step 2: Add a secret-safe key generator and operator docs**

Generate one ES256 private JWK and one 32-byte encryption root with versioned random `kid` values. Write JSON only to explicitly supplied local paths using mode `0600`; refuse stdout, existing files, or paths inside the repository. Document Vercel secret entry through stdin/dashboard and rotation order. Never add generated output to Git.

Update `.env.example` with template-only facade variables and document that enabled production requires private key-ring values in Vercel. Replace direct-Supabase OAuth instructions with the fixed upstream redirect:

`https://tabloom-mcp.nickvu.dev/oauth/callback/supabase`

- [ ] **Step 3: Verify probe and documentation changes locally**

```bash
npx vitest run tests/mcp/oauth-probe.test.ts
npm --workspace @tabloom/mcp run build
git diff --check
```

- [ ] **Step 4: Apply the reviewed OAuth migration**

Link the existing Supabase project without committing credentials, run the complete local pgTAP suite, inspect the generated migration diff, then push only `202608290002_oauth_facade.sql`. Confirm direct table access is denied and each narrow anonymous RPC behaves as tested.

- [ ] **Step 5: Configure and deploy with OAuth disabled**

Set the public values plus versioned key rings in the Vercel project, keep `TABLOOM_OAUTH_ENABLED=false`, deploy `services/tabloom-mcp`, and inspect health, authorization metadata, protected-resource metadata, and JWKS. Confirm registration, authorization, token, revocation, and MCP routes are unavailable.

- [ ] **Step 6: Configure the fixed Supabase callback and enable the facade**

Add only the exact Vercel callback URL to Supabase Auth redirect URLs. Keep the ordinary web and extension callbacks. Set `TABLOOM_OAUTH_ENABLED=true`, deploy again, and run the interactive readiness probe with the signed-in test user.

- [ ] **Step 7: Run two-user live acceptance**

With two distinct Supabase users:

1. Complete DCR and Google login for each user.
2. Verify exact ES256 issuer/resource/scope claims.
3. Call authenticated `get_service_status` successfully.
4. Prove outer/inner subject mismatch fails.
5. Refresh once and prove the previous refresh token loses the race.
6. Revoke and prove immediate MCP rejection.
7. Use request-local repository calls to prove User A cannot read or mutate User B's workspace under RLS.

Keep the future workspace MCP tools disabled; direct repository checks are acceptance fixtures only.

- [ ] **Step 8: Inspect live logs and execute cutover**

Search Vercel logs for JWT-shaped strings, `access_token`, `refresh_token`, Supabase session fields, saved URLs, descriptions, emails, and raw user/client IDs. Expected: no credential/content matches.

Only after every live check passes:

- Disable Supabase OAuth Server and its public DCR feature.
- Retire the owner-only Sites consent route or change it to a static link to the Vercel issuer.
- Keep web/extension Google login enabled.
- Record the redacted readiness report and deployment commit.

If any gate fails, set `TABLOOM_OAUTH_ENABLED=false`, redeploy, rotate/remove the facade signing and encryption key rings so every outstanding facade grant becomes unusable, and leave Supabase web/extension authentication unchanged.

- [ ] **Step 9: Commit delivery artifacts**

```bash
git add scripts/probe-mcp-oauth.mjs tests/mcp/oauth-probe.test.ts .env.example docs/mcp-setup.md README.md services/tabloom-mcp/scripts/generate-oauth-keys.mjs tests/e2e/mcp-facade-live.spec.ts
git commit -m "docs: deliver Tabloom authorization facade"
```

- [ ] **Step 10: Final branch verification**

```bash
npx supabase db reset
npx supabase test db supabase/tests/*.test.sql
npm run lint
npx tsc --noEmit
npm run test:unit
npm run build
npm run build:extension:chromium
npm --workspace @tabloom/mcp run type-check
npm --workspace @tabloom/mcp run build
git status --short
git diff origin/main...HEAD --check
```

Expected: all commands exit 0, the extension/web builds remain unchanged functionally, no secret files are tracked, and the branch contains one cohesive commit per task.

---

## Resume Point for the Existing MCP Plan

After Task 11 passes, resume `docs/superpowers/plans/2026-08-29-tabloom-remote-mcp.md` at its original Task 6 with these binding substitutions:

- `createWorkspaceContext` consumes `VerifiedFacadeAuthInfo.extra.requestContext` instead of treating `authInfo.token` as a Supabase token.
- Every workspace repository uses the request-local Supabase client already validated by the facade.
- Original OAuth-shaped SQL test claims use the Supabase inner user identity only; MCP outer claims are tested at the Vercel boundary.
- Production deployment metadata expects issuer `https://tabloom-mcp.nickvu.dev`, scope `tabloom:workspace`, and the facade's registration/revocation endpoints.
- The original final acceptance adds refresh rotation, revocation, and nested-subject checks from this plan.

Do not re-enable or reuse the failed direct-Supabase audience path.
