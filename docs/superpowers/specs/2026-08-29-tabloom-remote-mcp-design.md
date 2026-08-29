# Tabloom Remote MCP Design

## Status

Approved for implementation planning on 2026-08-29.

## Objective

Let a Tabloom user authorize an MCP-compatible agent to search and organize the spaces, collections, and saved links synchronized to that user's Supabase account. The integration must preserve Tabloom's existing row-level user isolation, require explicit OAuth consent, expose no service-role credential, and deploy as a separate Vercel service from the same repository.

## Scope

The first release covers synchronized workspace records:

- Spaces owned by the signed-in user.
- Collections owned by the signed-in user.
- Saved links owned by the signed-in user.
- Search, duplicate inspection, creation, editing, movement, ordering, and deletion.

The first release does not expose current browser tabs, `chrome.storage.local`, browser bookmarks that have not been synchronized, tab opening or closing, duplicate-tab closing, or any other browser API. Those operations require a later local companion and a separate design.

## Architecture

Tabloom remains one repository with three deployable surfaces:

```text
Tabloom site (Sites/Vinext)
  /oauth/consent              User login and OAuth approve/deny UI

Tabloom extension
  Existing local and Supabase-synchronized workspace behavior

Tabloom MCP (Vercel)
  /api/mcp                    Stateless Streamable HTTP MCP endpoint
  /.well-known/oauth-protected-resource
                              RFC 9728 resource metadata
```

Supabase Auth is the OAuth 2.1 authorization server. The MCP service is an OAuth protected resource and never issues access tokens. A typical request is:

```text
Agent calls /api/mcp without a token
  -> MCP responds 401 with protected-resource metadata
  -> Agent discovers the Supabase OAuth issuer
  -> Supabase redirects the user to Tabloom /oauth/consent
  -> User signs in and approves the named client
  -> Supabase returns a PKCE authorization code to the agent
  -> Agent exchanges the code for a Supabase OAuth access token
  -> MCP validates the token and executes tools as that user
```

The MCP service lives in `services/tabloom-mcp`. Vercel imports the existing GitHub repository as a separate project whose root directory is that service. The main site continues to deploy through Sites. Shared domain validation remains in the repository and is exposed to the service through a small workspace package rather than copied into a second implementation.

## OAuth and Consent

### Supabase configuration

The Supabase project `tctjlsvfufzxhauhywsm` must have OAuth 2.1 Server enabled with:

- Authorization path: `/oauth/consent`.
- Dynamic client registration enabled for MCP clients that still depend on RFC 7591.
- Explicit user approval for every newly authorized client.
- Existing ES256 signing keys and JWKS retained.

The consent page receives `authorization_id`, preserves it through Google sign-in, retrieves authorization details through Supabase Auth, displays the client name, redirect URI, and requested identity scopes, and offers Approve and Deny actions. It must state that the agent receives access to read and modify all synchronized Tabloom workspace data. Supabase currently supports identity scopes rather than custom Tabloom read/write scopes, so the UI must not imply a narrower database permission model.

Users must be able to deny a request without creating an MCP grant. Revocation remains available through Supabase OAuth grant management; a Tabloom account-integrations UI is outside the first implementation but the setup guide must document dashboard revocation.

### Protected-resource discovery

`/.well-known/oauth-protected-resource` advertises:

- Resource: the canonical production MCP URL.
- Authorization server: `https://tctjlsvfufzxhauhywsm.supabase.co/auth/v1`.
- Supported identity scopes required by the implementation.

Unauthenticated MCP requests return `401 Unauthorized` with a `WWW-Authenticate` header that points to this metadata document. CORS is enabled only as required for metadata discovery and MCP transports.

### Token validation

Every MCP request validates the bearer token before tool dispatch:

- ES256 signature against the Supabase JWKS.
- Exact issuer `https://tctjlsvfufzxhauhywsm.supabase.co/auth/v1`.
- Expiration and not-before timestamps.
- Non-empty UUID subject.
- Non-empty OAuth `client_id` claim.
- Audience containing the canonical MCP resource URL.

The bearer token is never written to application logs, error payloads, analytics, or persistent Vercel storage. The MCP service ships no Supabase service-role key.

### Audience compatibility gate

Supabase OAuth 2.1 Server is currently beta. After enabling it, an automated authorization probe and a real MCP-client login must prove that the hosted issuer honors the OAuth `resource` parameter and places the canonical MCP URL in the token audience. Production authorization remains disabled if the issuer returns only the generic `authenticated` audience.

If this gate fails, implementation stops before public launch and the authorization boundary is replaced by a dedicated OAuth facade that issues MCP-resource-bound tokens. The MCP tool and repository interfaces remain unchanged so this fallback does not rewrite business behavior. The service must never weaken audience validation to make a beta issuer appear compatible.

## User Isolation and Data Access

The user ID is derived only from the verified token subject. Tool inputs never accept `user_id`. Each request constructs a user-scoped Supabase client and executes through the existing public API and repository boundaries so the current `auth.uid() = user_id` row-level policies remain authoritative.

OAuth tokens contain a `client_id` claim. Database migrations add integration tests proving:

- User A cannot read or mutate User B's rows through an OAuth-shaped token.
- Cross-owner space, collection, and link references remain rejected.
- Anonymous requests receive no workspace rows.
- MCP operations cannot choose or override another subject.

The service may forward the verified Supabase access token only to the same Supabase project for the documented RLS-backed data operation. It must not forward the token to any other API or third party. If protocol conformance testing treats this Supabase-backed call as forbidden token passthrough, the audience compatibility gate fails and the dedicated authorization facade is required.

## MCP Tool Surface

Tools return concise human-readable text plus structured JSON. IDs are stable UUIDs and all ordering results use canonical database order.

### Read tools

- `get_workspace`: Return all spaces and collections plus link counts. Full link payloads are optional and paginated.
- `search_links`: Search normalized title, URL, description, space name, and collection name with optional space/collection filters and a bounded result limit.
- `list_links`: List canonical links for one collection with pagination.
- `find_duplicate_links`: Group normalized URLs duplicated within a collection or across the user's workspace.

### Mutation tools

- `create_space`: Create a named space at the end of canonical space order.
- `update_space`: Rename or recolor one owned space.
- `create_collection`: Create a named collection at the end of one owned space.
- `update_collection`: Rename or move one owned collection.
- `save_link`: Validate an `http:` or `https:` URL and add it to an owned collection. A duplicate URL in the same collection returns the existing match unless `allow_duplicate` is explicitly true.
- `update_link`: Edit title, URL, description, or favicon URL for one owned saved link.
- `move_link`: Move one owned link to another owned collection at a requested position.
- `reorder_items`: Atomically reorder spaces, collections within a space, or links within a collection and return canonical order.
- `delete_item`: Delete one owned space, collection, or link.

All input schemas reject unknown fields, malformed UUIDs, unsupported URLs, unbounded text, invalid positions, and inconsistent parent IDs. Result payloads never expose access tokens, email addresses, provider metadata, or records outside the workspace schema.

## Confirmation and Agent Safety

Read tools are non-destructive. Create and ordinary edit operations execute immediately after validation. The MCP SDK annotations identify read-only, idempotent, and destructive tools accurately.

`delete_item`, duplicate-producing saves, cross-parent movement, and bulk reorder use a two-step contract:

1. A call without `confirm` returns a preview containing the affected item IDs, names, parent changes, and current workspace revision.
2. A call with `confirm: true` and the returned revision applies the exact operation only if the revision remains current.

Revision conflicts return a retryable structured error and a fresh preview. This prevents an agent from approving a stale deletion or applying a reorder to a workspace that changed after preview.

## Repository and Concurrency

The MCP adapter reuses Tabloom domain types and URL/search normalization. It does not import UI or browser adapters. Repository operations use the existing Supabase tables and atomic workspace revision mechanism.

Single-record mutations return the database row after mutation. Reordering and cross-parent moves execute through atomic RPCs. Failed or conflicting writes do not leave partial positions; the service reloads canonical order before returning a retryable conflict.

Every tool request has bounded execution time, bounded result size, and no process-local session dependency. The Vercel deployment uses stateless Streamable HTTP so concurrent calls may land on different function instances.

## Error Model

Errors use stable categories without leaking infrastructure details:

- `unauthenticated`: Missing, expired, invalid, or incorrectly-audienced token.
- `forbidden`: Valid identity without access to the requested record.
- `invalid_input`: Invalid UUID, URL, text, parent relationship, position, or limit.
- `not_found`: Owned item does not exist.
- `conflict`: Workspace revision changed or duplicate policy requires confirmation.
- `temporarily_unavailable`: Supabase or Vercel dependency failed; safe to retry.
- `internal_error`: Unexpected failure with a server-side correlation ID only.

Logs include the correlation ID, tool name, duration, result category, and hashed user/client identifiers. Logs exclude tool arguments containing URLs or descriptions by default.

## Deployment and Configuration

The Vercel project is created under the authenticated `vuthanhnguyen92` account. Initial deployment uses the generated `*.vercel.app` production URL as the canonical MCP resource. A custom `mcp.tabloom.app` domain may replace it later only after DNS is available; changing the canonical URL requires updating audience configuration and re-running OAuth compatibility tests.

Public environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `TABLOOM_MCP_RESOURCE_URL`

No secret service-role key is deployed. Vercel preview deployments use a separate non-production resource URL and must not share production OAuth grants.

The repository setup guide documents Vercel linking, environment configuration, Supabase OAuth enablement, authorization-path setup, dynamic registration, consent testing, revocation, and MCP-client connection.

## Testing and Acceptance

### Automated tests

- Unit tests for tool input validation, URL policy, duplicate behavior, pagination, previews, revision enforcement, and error mapping.
- JWT tests for valid ES256 tokens and failures for wrong issuer, subject, expiration, client ID, signature, and audience.
- Component tests for signed-out consent, sign-in return, authorization details, approve, deny, loading, and provider errors.
- SQL integration tests with two users and OAuth-shaped claims proving RLS isolation and ownership constraints.
- MCP integration tests for initialization, tool discovery, unauthenticated `401`, protected-resource metadata, authenticated reads, mutations, stale confirmations, and structured errors.
- Production builds for the site, Chromium extension, and Vercel MCP service.

### Deployment verification

- Public discovery metadata returns the exact Supabase issuer and canonical resource.
- A supported MCP client discovers OAuth without manually supplied credentials.
- A user signs in with Google, sees the Tabloom consent page, approves, and completes PKCE.
- The issued token passes issuer, signature, subject, client ID, expiration, and resource-audience validation.
- The agent searches existing links, creates a collection, saves and moves a link, previews and confirms deletion, and sees the same canonical state in the web app or extension.
- A second user cannot observe or mutate the first user's workspace.
- Denial creates no usable grant, revocation prevents refresh, and expired access is rejected.
- Vercel and browser logs contain no access or refresh tokens.

The release is not complete until every acceptance check passes against the deployed Vercel service and the live Supabase project.

## Operational Rollout

The initial rollout is private to the project owner for live verification, but the implementation is multi-user from the beginning. After the acceptance suite passes, additional Tabloom users can authorize their own agents without schema or authentication redesign.

Rate limiting is applied per hashed user and OAuth client. Unexpected error rate, authorization failures, and mutation conflicts are observable without recording workspace content. The beta Supabase OAuth dependency is documented, and the service can be disabled independently from the web app and extension.
