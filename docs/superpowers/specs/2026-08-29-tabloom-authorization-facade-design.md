# Tabloom Resource-Bound Authorization Facade Design

## Status

Approved in conversation on 2026-08-29. This design replaces the failed direct-Supabase OAuth issuer path in the Tabloom Remote MCP plan.

## Problem

The live Supabase OAuth 2.1 flow completed successfully with public dynamic client registration and PKCE, but the issued ES256 access token contained only `aud: ["authenticated"]`. It did not contain the requested Tabloom MCP resource, `https://tabloom-mcp.nickvu.dev`.

Tabloom must not accept that token at the MCP resource server because it is not cryptographically bound to the MCP resource. The original plan therefore stopped before exposing any workspace tools.

The fallback must:

- Issue an access token with exact issuer and resource audience binding.
- Preserve the existing Supabase user UUID and row-level security boundary.
- Avoid a Supabase service-role key and avoid importing a privately held signing key into Supabase.
- Keep web and extension authentication unchanged.
- Provide a publicly reachable consent route independent of the owner-only Sites deployment.
- Support current MCP OAuth clients without weakening redirect, PKCE, replay, or token validation.

## Scope

### Included

- A dedicated OAuth 2.1 authorization facade inside the existing `services/tabloom-mcp` Vercel service.
- Supabase Google authentication as the upstream user-login mechanism.
- Authorization Code with PKCE, refresh-token rotation, revocation, discovery, JWKS, dynamic client registration, and Client ID Metadata Document support.
- A public Vercel consent surface.
- Resource-bound ES256 Tabloom access tokens containing an encrypted, short-lived Supabase user credential.
- Narrow Supabase persistence for public client metadata, replay prevention, and grant revocation.
- A verified user-scoped Supabase request context for MCP tools.
- Migration of the already-planned MCP read and mutation tools to the new request context.

### Excluded

- Teams, invitations, shared workspaces, public collections, or additional product scopes.
- Browser-local tabs, bookmarks, or Chrome APIs through MCP.
- Client credentials, device authorization, password grants, implicit grants, or bearer API keys.
- A service-role key, imported Supabase signing key, or third-party identity vendor.
- General-purpose identity-provider features unrelated to Tabloom MCP.

## Architecture

The production origin `https://tabloom-mcp.nickvu.dev` serves two isolated subsystems.

### Authorization facade

The authorization facade is the OAuth issuer. It owns:

- OAuth Authorization Server Metadata.
- OpenID-style JWKS publication for access-token verification.
- Dynamic Client Registration for compatible public MCP clients.
- HTTPS Client ID Metadata Document validation for current MCP clients.
- Authorization, public consent, token, refresh, and revocation endpoints.
- Upstream Supabase Google login and callback handling.
- Cryptographic state, code, token, and cookie handling.
- Replay and grant-revocation persistence.

The facade is not a general Supabase replacement. It authenticates a user through Supabase, then issues a resource-bound credential specifically for Tabloom MCP.

### MCP resource server

The existing `/api/mcp` route remains the resource server. It:

1. Verifies the Tabloom access-token signature, algorithm, issuer, audience, lifetime, subject, client, scope, and grant state.
2. Decrypts the enclosed Supabase access token.
3. validates the inner token with the same Supabase project and confirms that its user UUID equals the outer `sub`.
4. Creates a request-local Supabase client using the inner token.
5. Relies on existing RLS policies for all workspace reads and writes.

The resource server never accepts `user_id` from MCP tool input and never uses a service-role key.

### Sites deployment

The Sites deployment remains the marketing/web application surface. It is not an OAuth dependency after this migration. The existing Sites consent route is retired or changed to a non-sensitive redirect after the facade is accepted. The OAuth consent and callback routes live on the public Vercel service.

## Public Endpoints

The facade exposes:

- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/jwks.json`
- `POST /oauth/register`
- `GET /oauth/authorize`
- `GET /oauth/callback/supabase`
- `GET|POST /oauth/consent`
- `POST /oauth/token`
- `POST /oauth/revoke`

The resource server continues to expose:

- `GET /.well-known/oauth-protected-resource`
- `GET|POST /api/mcp`

The authorization server issuer and protected resource identifier are both the exact origin `https://tabloom-mcp.nickvu.dev`. Endpoint paths do not become token audiences.

The facade does not advertise OpenID Connect or issue ID tokens. It publishes OAuth Authorization Server Metadata only; Supabase remains the upstream OpenID identity provider used internally for user login.

## OAuth Flow

### Client discovery and identification

Tabloom supports both:

- Public Dynamic Client Registration for clients that still use DCR.
- HTTPS Client ID Metadata Documents for current MCP clients.

DCR creates an opaque client ID and stores only validated public metadata. It does not create or return a client secret. CIMD client IDs are fetched through a hardened HTTPS fetcher that rejects credentials, fragments, redirects, private/reserved addresses, oversized responses, invalid content types, and metadata whose declared client ID does not exactly match its URL.

Every authorization request requires:

- `response_type=code`
- An exact registered redirect URI
- `code_challenge_method=S256`
- A valid S256 challenge
- The exact Tabloom resource
- The single `tabloom:workspace` scope
- A non-empty client state value

Plain PKCE, wildcard redirects, URL fragments, userinfo, unsupported scopes, and unregistered resources are rejected.

### Upstream user login

The facade initiates Supabase Google OAuth with a fixed redirect URL:

`https://tabloom-mcp.nickvu.dev/oauth/callback/supabase`

The upstream PKCE verifier and original authorization request are encrypted in host-only, `HttpOnly`, `Secure`, `SameSite=Lax` cookies. Supabase continues to use its existing Google provider and its own `/auth/v1/callback` provider callback.

The Vercel callback exchanges the Supabase code server-side, validates the resulting user through Supabase Auth, and confirms a UUID user subject. It then creates a short-lived encrypted consent session. Supabase access or refresh tokens are never serialized into browser-visible JavaScript or form fields.

### Consent

The Vercel consent page displays:

- The validated client name.
- The exact redirect URI.
- Whole-workspace read/write permission for synchronized spaces, collections, and saved links.
- An explicit statement that browser-local tabs and bookmarks are excluded.

Consent is required for every new authorization. Refresh-token use does not reopen consent. Denial returns a standard OAuth error to the exact validated redirect URI.

### Authorization code exchange

Approval creates an encrypted authorization code that is:

- Bound to the client ID, redirect URI, resource, scope, PKCE challenge, and Supabase user UUID.
- Valid for no more than two minutes.
- Identified by a random 256-bit JTI.
- Consumable exactly once through an atomic replay-prevention function.

The token endpoint verifies the code, client, redirect, resource, and PKCE verifier before issuing tokens. Replay, expiry, mismatch, or malformed input returns `invalid_grant` without identifying which check failed.

## Token Formats and Lifetimes

### Access token

The MCP access token is an ES256-signed JWT with:

- `iss`: exact Tabloom authorization issuer.
- `aud`: exact Tabloom MCP resource.
- `sub`: Supabase user UUID.
- `client_id`: validated DCR client ID or CIMD URL.
- `scope`: `tabloom:workspace`.
- `iat`, `nbf`, `exp`, and random `jti`.
- A random grant-family identifier.
- An encrypted inner Supabase access token.

The inner credential uses compact JWE with `A256GCM`, purpose-specific authenticated data, and a versioned `kid`. The outer token lifetime is at most ten minutes and never exceeds the inner Supabase token lifetime. Bearer tokens larger than the configured maximum are rejected before cryptographic work.

### Refresh token

The refresh token is an opaque compact JWE containing:

- The Supabase refresh token.
- Supabase user UUID.
- Client, resource, and scope binding.
- Grant-family identifier.
- Random refresh-token JTI.
- Issued-at and expiration values.

Every successful refresh atomically consumes the previous refresh JTI, refreshes the upstream Supabase session, and returns a new access/refresh pair. Concurrent reuse has one winner; later attempts return `invalid_grant`.

### State, cookies, and codes

OAuth state, upstream-login state, consent cookies, and authorization codes use independent cryptographic purposes derived from the active encryption key. Context separation prevents one encrypted artifact type from being accepted as another.

State and consent cookies expire within ten minutes. Authorization codes expire within two minutes. Cookies are host-only and are deleted after success or denial.

## Keys and Secrets

Vercel stores two versioned secret sets:

- ES256 signing JWKs, with exactly one active private key and retained public verification keys during rotation.
- 256-bit encryption roots, with exactly one active key and retained decryption keys for the maximum token overlap.

Purpose-specific AES-GCM keys are derived through HKDF rather than reusing raw key material across cookies, authorization codes, access-token inner credentials, and refresh tokens.

Public configuration includes only:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `TABLOOM_MCP_RESOURCE_URL`
- `TABLOOM_OAUTH_ISSUER_URL`
- `TABLOOM_OAUTH_ENABLED`

Private signing or encryption material is never committed, logged, returned by diagnostics, or exposed to client JavaScript. No Supabase service-role key, Google client secret, or imported Supabase signing key is deployed.

## Persistence

Three isolated tables support the facade.

### `oauth_clients`

Stores validated public DCR metadata:

- Opaque client UUID.
- Client name.
- Exact redirect URI array.
- Grant/response methods fixed to public Authorization Code with PKCE.
- Creation and optional expiry timestamps.

It contains no client secret and no user identity.

### `oauth_consumed_tokens`

Stores only a SHA-256 hash of a random token JTI, its allowlisted kind (`authorization_code` or `refresh_token`), and expiry. A unique key makes consumption atomic.

### `oauth_revoked_grants`

Stores only a SHA-256 hash of a random grant-family identifier plus expiry and revocation time.

Direct access to all three tables is denied. Narrow security-definer functions provide:

- DCR registration and exact-client retrieval.
- Atomic one-time JTI consumption.
- Grant-family revocation.
- Grant-revocation lookup.
- Bounded opportunistic cleanup of expired rows.

Functions validate exact key sets, lengths, timestamp windows, kinds, URI counts, and JSON shapes. Anonymous callers cannot enumerate rows. Knowing a record hash requires possession of its high-entropy encrypted artifact.

## RLS-Preserving Request Context

After outer-token verification, the resource server:

1. Decrypts the inner Supabase access token.
2. Calls the same configured Supabase project's user-validation endpoint.
3. Requires the returned user UUID to equal the outer `sub`.
4. Creates `@supabase/supabase-js` with `accessToken: async () => innerToken` and disabled session persistence.
5. Instantiates existing workspace repositories with that request-local client.

The inner credential is forwarded only to the same Supabase project. It is never forwarded to an agent, another API, logs, metrics, or error responses.

## Revocation

The revocation endpoint accepts access or refresh tokens without disclosing validity. A valid token revokes its grant family and consumes the presented refresh JTI when applicable.

The token endpoint always checks grant revocation. The MCP verifier checks revocation before exposing an authenticated request context. Revoked access therefore stops working immediately rather than only at its short expiration.

Revoking or expiring the upstream Supabase session also prevents future resource refresh. Inner/outer subject mismatch fails closed.

## Error Model

OAuth routes return standards-shaped errors with no provider details:

- `invalid_request`: malformed or unsupported parameters.
- `invalid_client`: unknown, expired, or invalid client metadata.
- `invalid_grant`: stale, replayed, revoked, or mismatched code/refresh token.
- `invalid_scope`: any scope other than `tabloom:workspace`.
- `access_denied`: user denial.
- `temporarily_unavailable`: retryable Supabase or Vercel dependency failure.
- `server_error`: unexpected failure with a correlation ID only.

MCP authentication returns `401 invalid_token` for signature, issuer, audience, lifetime, subject, client, scope, decryption, upstream validation, or revocation failure. It never falls back to `aud: authenticated`.

OAuth responses set `Cache-Control: no-store` and `Pragma: no-cache`. Logs contain route category, latency, result class, correlation ID, and hashed client/grant identifiers only.

## Threat Model and Controls

- **Token substitution:** outer and inner user UUIDs must match.
- **Cross-resource replay:** exact audience is mandatory.
- **Authorization-code interception:** S256 PKCE, exact redirects, two-minute code lifetime, and one-time JTI consumption.
- **Refresh replay:** atomic rotation and grant-family revocation.
- **CSRF/login confusion:** encrypted state bound to request, client, resource, and host-only cookies.
- **Open redirect:** exact prevalidated redirect URI matching only.
- **SSRF through CIMD:** HTTPS-only pinned public address resolution, no redirects, strict size/time/content limits, and exact metadata identity.
- **XSS/token disclosure:** Supabase credentials never enter browser JavaScript; consent uses server-managed encrypted cookies.
- **Database RPC abuse:** high-entropy hashed identifiers, no enumeration, strict function schemas, and rate limits.
- **Signing-key compromise:** an attacker could issue outer tokens but still lacks a valid encrypted Supabase user token.
- **Encryption-key compromise:** rotate the key, revoke active grant families, and rely on short access-token lifetime; secrets remain isolated in Vercel.
- **Combined facade compromise:** treat as an authentication incident, rotate both key sets, revoke all facade grants, and disable the facade flag.

## Compatibility

The facade follows OAuth Authorization Server Metadata and MCP Protected Resource Metadata discovery. It supports public clients only, Authorization Code with PKCE S256, refresh-token rotation, DCR, and CIMD.

Client credentials, private client secrets, password grants, implicit flows, device flows, wildcard redirects, and arbitrary resource indicators are rejected.

## Testing

### Unit and route tests

- ES256 and JWE success/failure, wrong keys, wrong purpose, malformed artifacts, maximum sizes, expiry, and rotation overlap.
- Exact issuer/resource/scope/client/subject validation.
- S256 PKCE generation and verification; plain-method rejection.
- Redirect validation and exact matching.
- DCR schemas and public-client-only behavior.
- CIMD SSRF, redirect, private-IP, size, timeout, content-type, and identity checks.
- Cookie flags, state binding, callback failure, consent approval/denial, and safe errors.
- Authorization-code replay, refresh rotation, concurrent reuse, and revocation.
- Logging and report redaction.

### SQL tests

- Direct anonymous/authenticated table access denied.
- Strict DCR registration and exact-client retrieval.
- Atomic one-time consumption under competing calls.
- Revocation idempotence and lookup.
- Expiry bounds and cleanup.
- No OAuth function can access spaces, collections, links, or auth identities.

### Integration tests

- Two Supabase users complete upstream login and receive distinct resource-bound tokens.
- Outer/inner subject mismatch fails.
- Each token can access only its own RLS-protected workspace.
- Revocation and upstream session expiry fail closed.
- Web and extension Google authentication remain unchanged.

### Live acceptance

The release gate requires a supported MCP client to:

1. Discover Tabloom authorization.
2. Register or present client metadata.
3. Complete Google login and public consent.
4. Receive an ES256 access token with exact issuer and resource audience.
5. Refresh and revoke successfully.
6. Read and mutate only the signed-in user's workspace.
7. Fail after grant revocation and fail against a second user's records.

No workspace MCP tools are enabled in production before this gate passes.

## Rollout

1. Add the facade behind `TABLOOM_OAUTH_ENABLED=false`.
2. Apply reviewed replay/client/revocation migrations.
3. Generate and configure versioned Vercel signing and encryption secrets.
4. Add the fixed Supabase redirect URL for the Vercel callback.
5. Deploy discovery and facade routes while MCP tools remain disabled.
6. Run local and isolated live OAuth probes.
7. Make the Vercel authorization and consent routes publicly reachable.
8. Complete two-user MCP read/write/revocation acceptance.
9. Disable Supabase's temporary OAuth Server and public DCR feature.
10. Retire the Sites consent dependency.
11. Resume the original bounded-read, mutation, hardening, and final delivery tasks against the new request context.

## Rollback

Rollback does not modify workspace data:

1. Set `TABLOOM_OAUTH_ENABLED=false`.
2. Revoke all facade grant families.
3. Rotate or remove facade signing and encryption keys.
4. Remove the Vercel callback redirect if the facade is abandoned.
5. Keep ordinary Supabase web and extension login active.

The resource server continues to reject direct Supabase OAuth tokens whose audience is not the exact Tabloom MCP resource.

## Rejected Alternatives

### Accept `aud: authenticated`

Rejected because the token is not bound to the MCP resource and may be replayable outside its intended use.

### Import a facade signing key into Supabase

Rejected because compromise of that private key could mint arbitrary Supabase-trusted roles or impersonate users directly against the Data API.

### Use a service-role key after validating the outer token

Rejected because it bypasses the existing RLS user boundary and increases the blast radius of the MCP service.

### Add Auth0, WorkOS, or another identity vendor

Rejected by product choice to keep the initial fallback within Vercel and Supabase and avoid another identity migration or billing surface.

### Add Redis or another durable token store

Deferred. The first version uses encrypted artifacts plus narrow replay/revocation functions. A dedicated store may replace those functions later without changing the public OAuth contract.

## References

- [Supabase JWT and custom token guidance](https://supabase.com/docs/guides/auth/jwts)
- [Supabase signing-key security guidance](https://supabase.com/docs/guides/auth/signing-keys)
- [Supabase OAuth 2.1 Server](https://supabase.com/docs/guides/auth/oauth-server)
- [MCP TypeScript SDK authorization guidance](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md)
