# Tabloom remote MCP setup

The remote MCP service is a separate Vercel project. Its protected-resource identifier is the canonical production origin, without a trailing slash. The OAuth issuer is the matching Supabase Auth issuer:

```text
https://<project-ref>.supabase.co/auth/v1
```

## Deploy the MCP service

Link `services/tabloom-mcp` to the `tabloom-mcp` Vercel project and configure these production variables:

- `SUPABASE_URL`: the Supabase project origin
- `SUPABASE_ANON_KEY`: the project's public anon key
- `TABLOOM_MCP_RESOURCE_URL`: the canonical Vercel production origin

Keep real values in ignored environment files or the Vercel environment. Do not commit them or pass them in command arguments that may be retained in shell history. Configure only those three variables for this service.

Deploy once to obtain the canonical production alias, set `TABLOOM_MCP_RESOURCE_URL` to that exact alias, and deploy again. Verify that:

- `GET /api/health` returns `200` without sensitive fields.
- `GET /.well-known/oauth-protected-resource` identifies the exact production origin and Supabase issuer.
- An unauthenticated request to `/api/mcp` returns `401` and points to the protected-resource metadata.

## Configure Supabase OAuth

Deploy the main Tabloom site, including `/oauth/consent`, before enabling the OAuth server. In **Authentication → OAuth Server** for the Supabase project:

1. Enable the OAuth 2.1 Server.
2. Set **Authorization Path** to `/oauth/consent`.
3. Enable Dynamic Client Registration.
4. Keep explicit user consent enabled.

The Google provider callback remains the Supabase `/auth/v1/callback` URL. Do not replace it with the consent page.

## Run the audience readiness gate

Set `SUPABASE_URL` and `TABLOOM_MCP_RESOURCE_URL` in the local process environment, then run:

```bash
node scripts/probe-mcp-oauth.mjs
```

The probe dynamically registers a public client, starts a loopback callback, creates a PKCE S256 request containing the exact MCP `resource`, and opens the approval URL. Complete the approval in the browser that has the intended Tabloom user session. The authorization code, PKCE verifier, access and refresh tokens, authenticated session, and user claims are never printed or written.

The ignored `outputs/mcp-oauth-readiness.json` report contains only allowlisted booleans plus issuer, algorithm, and audience strings. Readiness passes only when all of these are true:

- OAuth discovery exposes authorization, token, and dynamic registration endpoints with PKCE S256.
- The verified access token uses `ES256`.
- The token issuer exactly matches the Supabase Auth issuer.
- The token audience contains the exact `TABLOOM_MCP_RESOURCE_URL` origin.
- The token has non-empty subject and client identifiers.

An otherwise authenticated token whose audience is only `authenticated` fails with `resource_audience_missing`; generic authentication is not sufficient. If the report has `"pass": false`, keep the MCP project non-public, do not continue with workspace tools, and use the approved dedicated-authorization-facade fallback rather than weakening the audience check.
