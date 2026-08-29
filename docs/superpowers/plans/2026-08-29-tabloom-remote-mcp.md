# Tabloom Remote MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a multi-user, OAuth-protected Tabloom MCP service on Vercel that lets authorized agents safely read and organize each user's synchronized Supabase workspace.

**Architecture:** The existing Tabloom site hosts the Supabase OAuth consent UI, while a separate Next.js service under `services/tabloom-mcp` serves stateless Streamable HTTP through `mcp-handler`. Supabase issues ES256 OAuth tokens, the MCP service verifies issuer/audience/client/user claims, and user-scoped Supabase clients preserve current RLS. A mandatory live audience probe prevents release if Supabase's beta issuer does not bind tokens to the MCP resource URL.

**Tech Stack:** TypeScript 5.9, React 19, Next.js 16, Supabase JS 2.112, Supabase PostgreSQL/RLS, MCP Server SDK 2, `mcp-handler` 2.1, Zod 4, JOSE 6, Vitest 4, pgTAP, Vercel CLI 51+.

**Spec:** `docs/superpowers/specs/2026-08-29-tabloom-remote-mcp-design.md`

## Global Constraints

- MCP covers only Supabase-synchronized spaces, collections, and saved links; browser-local tabs and Chrome APIs remain out of scope.
- OAuth consent grants read and write access to the complete synchronized workspace because Supabase custom application scopes are not currently available.
- Never deploy a Supabase service-role key, Google client secret, extension private key, access token, refresh token, or authenticated session artifact.
- Validate ES256 signature, exact issuer, expiry, UUID subject, OAuth `client_id`, and canonical MCP resource audience on every request.
- Keep `auth.uid() = user_id` RLS authoritative and never accept `user_id` as a tool argument.
- Require preview plus current workspace revision for deletion, duplicate-producing saves, cross-parent movement, and bulk reorder.
- Accept only `http:` and `https:` saved links and retain the existing per-collection duplicate behavior.
- Use stateless Streamable HTTP and bounded tool inputs, result sizes, and execution times.
- Stop public deployment if the live Supabase issuer does not bind the requested MCP resource into the access-token audience.

---

### Task 1: Preserve the Chromium PKCE regression fix

**Files:**
- Modify: `extension/supabase.ts`
- Test: `tests/extension-supabase.test.ts`

**Interfaces:**
- Consumes: existing `browserAuthStorage`, `browserAdapter`, and Supabase environment variables.
- Produces: an extension Supabase client configured with `flowType: "pkce"` so the existing callback parser receives an authorization code.

- [ ] **Step 1: Re-run the existing red/green regression proof**

The test already demonstrated `Received: "implicit"` before the fix. Run the fixed case again:

```bash
npx vitest run tests/extension-supabase.test.ts tests/extension-oauth.test.ts
```

Expected: 7 tests pass with no unhandled browser-storage rejection.

- [ ] **Step 2: Verify the minimal production setting remains present**

```ts
createClient(url, key, {
  auth: {
    storage: browserAuthStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: "pkce",
  },
});
```

- [ ] **Step 3: Commit only the PKCE fix and regression test**

```bash
git add extension/supabase.ts tests/extension-supabase.test.ts
git commit -m "fix: use PKCE for extension OAuth"
```

### Task 2: Build the Tabloom OAuth consent page

**Files:**
- Create: `app/oauth/consent/page.tsx`
- Create: `app/oauth/consent/OAuthConsent.tsx`
- Modify: `app/globals.css`
- Test: `tests/oauth-consent.test.tsx`

**Interfaces:**
- Consumes: `getSupabaseBrowserClient()`, `supabase.auth.getSession()`, `signInWithOAuth()`, and `supabase.auth.oauth.{getAuthorizationDetails,approveAuthorization,denyAuthorization}`.
- Produces: `OAuthConsent({ authorizationId, client? })`, a testable client component that preserves `authorization_id` through login and redirects only to URLs returned by Supabase.

- [ ] **Step 1: Write the failing consent tests**

Cover missing request IDs, signed-out login, authorization details, already-approved redirect, approve, deny, and provider failure:

```tsx
it("shows the requesting client and whole-workspace permission", async () => {
  render(<OAuthConsent authorizationId="authorization-1" client={oauthClient(details)} />);
  expect(await screen.findByRole("heading", { name: "Connect Codex to Tabloom" })).toBeInTheDocument();
  expect(screen.getByText(/read and modify all synchronized spaces/i)).toBeInTheDocument();
  expect(screen.getByText("https://client.example/callback")).toBeInTheDocument();
});

it("preserves authorization_id when Google sign-in is required", async () => {
  const client = signedOutOAuthClient();
  render(<OAuthConsent authorizationId="authorization-1" client={client} />);
  await userEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
  expect(client.auth.signInWithOAuth).toHaveBeenCalledWith({
    provider: "google",
    options: { redirectTo: expect.stringContaining("/oauth/consent?authorization_id=authorization-1") },
  });
});

it.each(["approve", "deny"] as const)("returns the %s decision to the OAuth client", async (decision) => {
  const client = signedInOAuthClient(details, `https://client.example/callback?${decision}=1`);
  render(<OAuthConsent authorizationId="authorization-1" client={client} />);
  await userEvent.click(await screen.findByRole("button", { name: decision === "approve" ? "Approve access" : "Deny" }));
  expect(client.auth.oauth[decision === "approve" ? "approveAuthorization" : "denyAuthorization"])
    .toHaveBeenCalledWith("authorization-1", { skipBrowserRedirect: true });
});
```

- [ ] **Step 2: Run the test and verify the missing component failure**

```bash
npx vitest run tests/oauth-consent.test.tsx
```

Expected: FAIL because `app/oauth/consent/OAuthConsent.tsx` does not exist.

- [ ] **Step 3: Implement the consent state machine**

Use these explicit states and response narrowing:

```ts
type ConsentState =
  | { kind: "checking-session" }
  | { kind: "signed-out" }
  | { kind: "loading-request" }
  | { kind: "ready"; details: OAuthAuthorizationDetails }
  | { kind: "submitting"; details: OAuthAuthorizationDetails }
  | { kind: "error"; message: string };

if (data && "redirect_url" in data) {
  window.location.assign(data.redirect_url);
} else if (data && "authorization_id" in data) {
  setState({ kind: "ready", details: data });
}
```

Approve and deny must call the corresponding Supabase OAuth method with `{ skipBrowserRedirect: true }`, reject missing/changed authorization IDs, disable both actions while submitting, and display only safe provider-error summaries.

- [ ] **Step 4: Add the server page wrapper and accessible styling**

```tsx
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string }>;
}) {
  const { authorization_id: authorizationId = "" } = await searchParams;
  return <OAuthConsent authorizationId={authorizationId} />;
}
```

Use the existing `Brand`, Poppins typography, focus-visible states, minimum 44px controls, and responsive card styles. Do not display the signed-in user's email in error messages or logs.

- [ ] **Step 5: Verify component, type, lint, and site build**

```bash
npx vitest run tests/oauth-consent.test.tsx
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the consent surface**

```bash
git add app/oauth/consent app/globals.css tests/oauth-consent.test.tsx
git commit -m "feat: add MCP OAuth consent page"
```

### Task 3: Scaffold the shared workspace package and Vercel MCP service

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `shared/package.json`
- Create: `services/tabloom-mcp/package.json`
- Create: `services/tabloom-mcp/next.config.ts`
- Create: `services/tabloom-mcp/tsconfig.json`
- Create: `services/tabloom-mcp/app/layout.tsx`
- Create: `services/tabloom-mcp/app/page.tsx`
- Create: `services/tabloom-mcp/app/api/health/route.ts`
- Create: `services/tabloom-mcp/vercel.json`
- Test: `tests/mcp/service-config.test.ts`

**Interfaces:**
- Consumes: `shared/domain.ts`, `shared/repository.ts`, Node.js 22, and the root npm lockfile.
- Produces: workspace package `@tabloom/workspace` and service scripts `dev`, `build`, `type-check`, and `lint` under `@tabloom/mcp`.

- [ ] **Step 1: Write the failing service-configuration test**

```ts
it("pins the supported MCP server runtime", async () => {
  const manifest = JSON.parse(await readFile("services/tabloom-mcp/package.json", "utf8"));
  expect(manifest.engines.node).toBe(">=22.13.0");
  expect(manifest.dependencies).toMatchObject({
    "@modelcontextprotocol/server": "2.0.0",
    "mcp-handler": "2.1.1",
    "jose": "6.2.10",
    "zod": "4.5.2",
  });
});

it("exports only domain and repository modules from the shared package", async () => {
  const manifest = JSON.parse(await readFile("shared/package.json", "utf8"));
  expect(Object.keys(manifest.exports)).toEqual([
    "./domain",
    "./repository",
    "./workspace-sync-repository",
  ]);
});
```

- [ ] **Step 2: Run the test and verify missing manifests**

```bash
npx vitest run tests/mcp/service-config.test.ts
```

Expected: FAIL with `ENOENT` for the service package.

- [ ] **Step 3: Add npm workspaces and exact service dependencies**

Add `"workspaces": ["shared", "services/*"]` to the root manifest. Create `services/tabloom-mcp/package.json` with:

```json
{
  "name": "@tabloom/mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.13.0" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "type-check": "tsc --noEmit",
    "lint": "eslint ."
  },
  "dependencies": {
    "@modelcontextprotocol/server": "2.0.0",
    "@supabase/supabase-js": "2.112.4",
    "@tabloom/workspace": "file:../../shared",
    "jose": "6.2.10",
    "mcp-handler": "2.1.1",
    "next": "16.3.3",
    "react": "19.2.6",
    "react-dom": "19.2.6",
    "zod": "4.5.2"
  }
}
```

Create `shared/package.json` with the three TypeScript exports and `"name": "@tabloom/workspace"`, `"version": "0.1.0"`, and `"private": true`. Configure Next with `transpilePackages: ["@tabloom/workspace"]`.

- [ ] **Step 4: Add a minimal service shell and health contract**

```ts
export function GET() {
  return Response.json(
    { service: "tabloom-mcp", status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
```

The root page contains only service identity, documentation link, and health status; it exposes no environment values.

- [ ] **Step 5: Install, test, and build the workspace**

```bash
npm install
npx vitest run tests/mcp/service-config.test.ts
npm --workspace @tabloom/mcp run type-check
npm --workspace @tabloom/mcp run build
```

Expected: all commands exit 0 and the lockfile contains one pinned MCP dependency graph.

- [ ] **Step 6: Commit the service scaffold**

```bash
git add package.json package-lock.json shared/package.json services/tabloom-mcp tests/mcp/service-config.test.ts
git commit -m "feat: scaffold Tabloom MCP service"
```

### Task 4: Implement protected-resource discovery and strict JWT verification

**Files:**
- Create: `services/tabloom-mcp/src/auth/config.ts`
- Create: `services/tabloom-mcp/src/auth/verify-token.ts`
- Create: `services/tabloom-mcp/app/.well-known/oauth-protected-resource/route.ts`
- Create: `services/tabloom-mcp/app/api/mcp/route.ts`
- Test: `tests/mcp/auth.test.ts`
- Test: `tests/mcp/discovery.test.ts`

**Interfaces:**
- Consumes: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TABLOOM_MCP_RESOURCE_URL`, Supabase JWKS, and `mcp-handler` authentication wrappers.
- Produces: `loadMcpAuthConfig(env): McpAuthConfig`, `createTokenVerifier(config, jwks?)`, protected-resource metadata, and an authenticated MCP endpoint.

- [ ] **Step 1: Write failing configuration and JWT tests**

Generate an ES256 test key with JOSE and cover every required claim:

```ts
it("accepts a resource-bound Supabase OAuth token", async () => {
  const token = await signToken({
    iss: ISSUER,
    aud: ["authenticated", RESOURCE],
    sub: USER_ID,
    client_id: CLIENT_ID,
    scope: "openid email",
  });
  await expect(verifier(new Request(RESOURCE), token)).resolves.toMatchObject({
    clientId: CLIENT_ID,
    scopes: ["openid", "email"],
    extra: { userId: USER_ID },
  });
});

it.each([
  ["issuer", { iss: "https://attacker.example" }],
  ["audience", { aud: "authenticated" }],
  ["subject", { sub: "not-a-uuid" }],
  ["client", { client_id: "" }],
  ["expiry", { exp: 1 }],
])("rejects a token with invalid %s", async (_name, overrides) => {
  await expect(verifier(new Request(RESOURCE), await signToken(overrides))).resolves.toBeUndefined();
});
```

Test missing, malformed, template-valued, HTTP production, and mismatched resource configuration.

- [ ] **Step 2: Run auth tests and verify missing modules**

```bash
npx vitest run tests/mcp/auth.test.ts tests/mcp/discovery.test.ts
```

Expected: FAIL because auth configuration and routes do not exist.

- [ ] **Step 3: Implement strict environment parsing**

```ts
export type McpAuthConfig = {
  supabaseUrl: URL;
  issuer: string;
  jwksUrl: URL;
  anonKey: string;
  resourceUrl: URL;
};

export function loadMcpAuthConfig(env: NodeJS.ProcessEnv): McpAuthConfig {
  const supabaseUrl = requiredHttpsUrl(env.SUPABASE_URL, "SUPABASE_URL");
  const resourceUrl = requiredHttpsUrl(env.TABLOOM_MCP_RESOURCE_URL, "TABLOOM_MCP_RESOURCE_URL");
  const issuer = new URL("auth/v1", `${supabaseUrl.href.replace(/\/$/, "")}/`).href.replace(/\/$/, "");
  return {
    supabaseUrl,
    issuer,
    jwksUrl: new URL(`${issuer}/.well-known/jwks.json`),
    anonKey: requiredValue(env.SUPABASE_ANON_KEY, "SUPABASE_ANON_KEY"),
    resourceUrl,
  };
}
```

- [ ] **Step 4: Implement ES256 verification**

Use `createRemoteJWKSet` and `jwtVerify` with `algorithms: ["ES256"]`, exact issuer, and exact resource audience. Parse UUIDs with a local strict regex and return `undefined` for all invalid credentials without logging the token:

```ts
return {
  token: bearerToken,
  clientId: payload.client_id,
  scopes: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [],
  extra: { userId: payload.sub, claims: safeClaims(payload) },
};
```

- [ ] **Step 5: Add discovery and authenticated MCP routes**

```ts
const metadata = protectedResourceHandler({
  authServerUrls: [config.issuer],
  resourceUrl: config.resourceUrl.href.replace(/\/$/, ""),
});
export { metadata as GET };
export const OPTIONS = metadataCorsOptionsRequestHandler();
```

Wrap a temporary `get_service_status` read-only tool with:

```ts
withMcpAuth(handler, verifier, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
  resourceUrl: config.resourceUrl.origin,
});
```

Export GET and POST; do not enable DELETE because the service is stateless. The protected-resource identifier is the canonical production origin, while the transport endpoint is `${config.resourceUrl.origin}/api/mcp`.

- [ ] **Step 6: Verify discovery, JWT tests, types, and build**

```bash
npx vitest run tests/mcp/auth.test.ts tests/mcp/discovery.test.ts
npm --workspace @tabloom/mcp run type-check
npm --workspace @tabloom/mcp run build
```

Expected: all commands exit 0; a generic `aud: authenticated` token is rejected.

- [ ] **Step 7: Commit protected-resource authorization**

```bash
git add services/tabloom-mcp/src/auth services/tabloom-mcp/app/.well-known services/tabloom-mcp/app/api/mcp tests/mcp/auth.test.ts tests/mcp/discovery.test.ts
git commit -m "feat: protect MCP with Supabase OAuth"
```

### Task 5: Bootstrap deployment and run the OAuth audience gate

**Files:**
- Create: `scripts/probe-mcp-oauth.mjs`
- Modify: `.env.example`
- Modify: `docs/mcp-setup.md`
- Test: `tests/mcp/oauth-probe.test.ts`

**Interfaces:**
- Consumes: live Vercel URL, Supabase OAuth discovery, a public dynamically registered client, PKCE verifier, and user approval through `/oauth/consent`.
- Produces: a redacted JSON report containing discovery support, token algorithm, issuer match, audience match, subject/client presence, and pass/fail—never token values.

- [ ] **Step 1: Write the failing probe-parser tests**

```ts
it("passes only when the MCP resource is in the token audience", () => {
  expect(evaluateAudience(["authenticated", RESOURCE], RESOURCE)).toEqual({ pass: true });
  expect(evaluateAudience("authenticated", RESOURCE)).toEqual({
    pass: false,
    reason: "resource_audience_missing",
  });
});
```

- [ ] **Step 2: Run the test and verify the missing probe module**

```bash
npx vitest run tests/mcp/oauth-probe.test.ts
```

Expected: FAIL because the probe module does not exist.

- [ ] **Step 3: Implement the redacted PKCE probe**

The script must:

1. Fetch Supabase OAuth discovery.
2. Register a public client with the local callback printed by the script.
3. Generate PKCE S256 and an authorization URL containing `resource=TABLOOM_MCP_RESOURCE_URL`.
4. Open or print that URL for user approval.
5. Exchange the returned code.
6. Verify, but never print, the access token.
7. Write only booleans, issuer, algorithm, and audience strings to the ignored `outputs/mcp-oauth-readiness.json` file.

Expose pure `evaluateAudience`, `evaluateDiscovery`, and `redactTokenResult` functions for tests.

- [ ] **Step 4: Create and deploy the initial Vercel project**

```bash
vercel link --cwd services/tabloom-mcp --project tabloom-mcp --scope vuthanhnguyen92s-projects --yes
vercel env add SUPABASE_URL production --cwd services/tabloom-mcp
vercel env add SUPABASE_ANON_KEY production --cwd services/tabloom-mcp
vercel env add TABLOOM_MCP_RESOURCE_URL production --cwd services/tabloom-mcp
vercel deploy --prod --cwd services/tabloom-mcp --yes
```

Use the actual project URL returned by Vercel as `TABLOOM_MCP_RESOURCE_URL`, then redeploy once so metadata and JWT verification use the canonical URL.

- [ ] **Step 5: Deploy the consent page and enable Supabase OAuth**

Deploy the main site through Sites. In Supabase Authentication → OAuth Server:

- Enable OAuth 2.1 Server.
- Set Authorization Path to `/oauth/consent`.
- Enable Dynamic Client Registration for compatibility.
- Keep explicit consent enabled.

Do not modify the Google provider callback; it remains the Supabase `/auth/v1/callback` URL.

- [ ] **Step 6: Run the live gate**

```bash
node scripts/probe-mcp-oauth.mjs
```

Expected: report contains `"pass": true`, ES256, the exact Supabase issuer, and the exact Vercel MCP resource audience.

If the resource audience is absent, do not continue to Task 6 and do not weaken verification. Record the report, keep the MCP project non-public, and return to the approved design's dedicated-authorization-facade fallback.

- [ ] **Step 7: Commit the probe and setup evidence format**

```bash
git add scripts/probe-mcp-oauth.mjs tests/mcp/oauth-probe.test.ts .env.example docs/mcp-setup.md
git commit -m "test: gate MCP on resource-bound OAuth"
```

### Task 6: Implement bounded workspace reads

**Files:**
- Create: `services/tabloom-mcp/src/workspace/context.ts`
- Create: `services/tabloom-mcp/src/workspace/read-service.ts`
- Create: `services/tabloom-mcp/src/tools/result.ts`
- Create: `services/tabloom-mcp/src/tools/register-read-tools.ts`
- Modify: `services/tabloom-mcp/app/api/mcp/route.ts`
- Test: `tests/mcp/read-service.test.ts`
- Test: `tests/mcp/read-tools.test.ts`

**Interfaces:**
- Consumes: verified `AuthInfo`, `SupabaseWorkspaceRepository`, `SupabaseWorkspaceSyncRepository`, and shared domain normalization.
- Produces: `createWorkspaceContext(authInfo, config)`, `WorkspaceReadService`, and four MCP read tools.

- [ ] **Step 1: Write failing read-service tests against the real memory repository**

```ts
it("searches title, URL, description, space, and collection with a bounded limit", async () => {
  const service = new WorkspaceReadService(memoryRepository(snapshot));
  const result = await service.searchLinks({ query: "product", limit: 2, offset: 0 });
  expect(result.items).toHaveLength(2);
  expect(result.total).toBeGreaterThanOrEqual(2);
  expect(result.items.every((item) => item.user_id === undefined)).toBe(true);
});

it("groups normalized duplicate URLs without exposing owner fields", async () => {
  const result = await service.findDuplicates({ scope: "workspace", limit: 100 });
  expect(result.groups[0]).toMatchObject({ normalizedUrl: "https://example.com/", count: 2 });
});
```

Cover `limit` 1–100, non-negative offset, unknown parents, canonical position order, omitted `user_id`, and `includeLinks: false` workspace summaries.

- [ ] **Step 2: Run tests and verify missing read service**

```bash
npx vitest run tests/mcp/read-service.test.ts tests/mcp/read-tools.test.ts
```

Expected: FAIL because the service and registrations do not exist.

- [ ] **Step 3: Build a user-scoped request context**

```ts
export function createWorkspaceContext(authInfo: AuthInfo, config: McpAuthConfig) {
  const userId = requireAuthUserId(authInfo);
  const token = authInfo.token;
  const client = createClient(config.supabaseUrl.href, config.anonKey, {
    accessToken: async () => token,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    userId,
    repository: new SupabaseWorkspaceRepository(client, userId),
    revisions: new SupabaseWorkspaceSyncRepository(client),
  };
}
```

Never accept a user ID from tool input and never return the token from this context.

- [ ] **Step 4: Implement read DTOs and pagination**

Define explicit safe DTOs that omit `user_id`, `origin`, and `read_only`. Use shared `filterWorkspace`, `normalizeUrlForDuplicate`, and canonical position ordering. Reject result limits above 100 before loading data.

- [ ] **Step 5: Register the four read tools**

Register `get_workspace`, `search_links`, `list_links`, and `find_duplicate_links` using strict Zod schemas, `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`. Each result contains both a concise text summary and matching `structuredContent`.

- [ ] **Step 6: Verify read behavior and MCP tool discovery**

```bash
npx vitest run tests/mcp/read-service.test.ts tests/mcp/read-tools.test.ts
npm --workspace @tabloom/mcp run type-check
npm --workspace @tabloom/mcp run build
```

Expected: all commands exit 0; tool schemas contain no `user_id` property.

- [ ] **Step 7: Commit read tools**

```bash
git add services/tabloom-mcp/src/workspace services/tabloom-mcp/src/tools services/tabloom-mcp/app/api/mcp/route.ts tests/mcp/read-service.test.ts tests/mcp/read-tools.test.ts
git commit -m "feat: expose bounded MCP workspace reads"
```

### Task 7: Add revision-guarded atomic workspace mutations

**Files:**
- Create: `supabase/migrations/202608290002_mcp_workspace_mutations.sql`
- Create: `shared/mcp-mutation-repository.ts`
- Modify: `shared/package.json`
- Test: `supabase/tests/mcp_workspace_mutations.test.sql`
- Test: `tests/mcp-mutation-repository.test.ts`

**Interfaces:**
- Consumes: `auth.uid()`, `workspace_sync_state`, `tabloom.merge_in_progress`, and existing owner foreign keys.
- Produces: RPC `apply_workspace_mutation(mutation jsonb, expected_revision bigint)` and `SupabaseMcpMutationRepository.apply(mutation, expectedRevision)`.

- [ ] **Step 1: Write failing pgTAP cases**

Cover every mutation kind, stale revision, wrong owner, invalid parent, partial order, invalid URL, and a single revision increment:

```sql
select throws_ok(
  $$ select public.apply_workspace_mutation(
    '{"type":"delete-link","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'::jsonb,
    99
  ) $$,
  '40001',
  'workspace revision conflict',
  'stale destructive confirmation is rejected'
);

select is(
  (public.apply_workspace_mutation(
    '{"type":"move-link","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","collectionId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","position":0}'::jsonb,
    0
  )->>'revision')::bigint,
  1::bigint,
  'cross-collection move increments revision once'
);
```

- [ ] **Step 2: Write the failing TypeScript repository contract test**

```ts
it("maps a 40001 RPC response to WorkspaceRevisionConflictError", async () => {
  const client = rpcClient({ code: "40001", message: "workspace revision conflict" });
  await expect(new SupabaseMcpMutationRepository(client).apply(mutation, 3))
    .rejects.toBeInstanceOf(WorkspaceRevisionConflictError);
});
```

- [ ] **Step 3: Run tests and verify missing RPC/repository**

```bash
npx vitest run tests/mcp-mutation-repository.test.ts
npx supabase test db supabase/tests/mcp_workspace_mutations.test.sql
```

Expected: TypeScript import failure and pgTAP missing-function failure.

- [ ] **Step 4: Implement the mutation union and RPC adapter**

```ts
export type WorkspaceMutation =
  | { type: "move-collection"; id: string; spaceId: string; position: number }
  | { type: "move-link"; id: string; collectionId: string; position: number }
  | { type: "reorder-spaces"; orderedIds: string[] }
  | { type: "reorder-collections"; spaceId: string; orderedIds: string[] }
  | { type: "reorder-links"; collectionId: string; orderedIds: string[] }
  | { type: "delete-space"; id: string }
  | { type: "delete-collection"; id: string }
  | { type: "delete-link"; id: string };
```

The adapter calls `apply_workspace_mutation` with `{ mutation, expected_revision }`, decodes `{ revision, snapshot }`, and maps SQLSTATE `40001`, `23503`, `22023`, `28000`, and not-found responses to typed errors.

- [ ] **Step 5: Implement the atomic SQL function**

The `security invoker` function must:

1. Require `auth.uid()` and non-negative expected revision.
2. Insert the caller's sync-state row if missing and lock it `FOR UPDATE`.
3. Compare the current revision before changing any row.
4. Set `tabloom.merge_in_progress=on` transaction-locally.
5. Validate the mutation object's exact key set and UUID/position values.
6. For moves, verify both item and target parent belong to `auth.uid()`, update the parent, then normalize source and destination sibling positions.
7. For reorder, require the supplied IDs to equal the complete owned sibling ID set and update positions with `unnest(ordered_ids) with ordinality`.
8. For delete, verify the item belongs to the caller before deleting and normalize remaining sibling positions.
9. Increment `workspace_sync_state.revision` exactly once.
10. Return `jsonb_build_object('revision', revision, 'snapshot', public.workspace_snapshot_json(owner_id))`.

Revoke execution from `public` and `anon`; grant only to `authenticated`.

- [ ] **Step 6: Verify atomicity and repository behavior**

```bash
npx vitest run tests/mcp-mutation-repository.test.ts
npx supabase db reset
npx supabase test db supabase/tests/*.test.sql
```

Expected: all TypeScript and pgTAP tests pass, including the existing workspace-merge suite.

- [ ] **Step 7: Commit atomic mutation support**

```bash
git add supabase/migrations/202608290002_mcp_workspace_mutations.sql supabase/tests/mcp_workspace_mutations.test.sql shared/mcp-mutation-repository.ts shared/package.json tests/mcp-mutation-repository.test.ts
git commit -m "feat: add atomic MCP workspace mutations"
```

### Task 8: Implement mutation previews and MCP write tools

**Files:**
- Create: `services/tabloom-mcp/src/workspace/mutation-service.ts`
- Create: `services/tabloom-mcp/src/tools/register-mutation-tools.ts`
- Modify: `services/tabloom-mcp/app/api/mcp/route.ts`
- Test: `tests/mcp/mutation-service.test.ts`
- Test: `tests/mcp/mutation-tools.test.ts`

**Interfaces:**
- Consumes: `WorkspaceRepository`, `WorkspaceSyncRepository`, `SupabaseMcpMutationRepository`, shared duplicate/URL helpers, and verified request context.
- Produces: immediate create/edit operations plus revision-confirmed move/reorder/delete operations and nine MCP mutation tools.

- [ ] **Step 1: Write failing mutation-service tests**

```ts
it("previews deletion without mutating", async () => {
  const result = await service.deleteItem({ kind: "collection", id: COLLECTION_ID });
  expect(result).toMatchObject({
    status: "confirmation_required",
    expectedRevision: 4,
    operation: { type: "delete-collection", id: COLLECTION_ID },
  });
  expect(await repository.load()).toEqual(originalSnapshot);
});

it("rejects a confirmed operation after the workspace changes", async () => {
  await expect(service.deleteItem({
    kind: "collection",
    id: COLLECTION_ID,
    confirm: true,
    expectedRevision: 4,
  })).rejects.toBeInstanceOf(WorkspaceRevisionConflictError);
});

it("requires confirmation before creating a duplicate copy", async () => {
  const result = await service.saveLink({
    collectionId: COLLECTION_ID,
    url: "https://example.com",
    title: "Example",
    allowDuplicate: true,
  });
  expect(result.status).toBe("confirmation_required");
});
```

Cover create/update ownership, text bounds, default title/hostname behavior, duplicate return, duplicate confirmation, cross-parent preview, complete reorder ID sets, and safe DTO output.

- [ ] **Step 2: Run tests and verify missing service**

```bash
npx vitest run tests/mcp/mutation-service.test.ts tests/mcp/mutation-tools.test.ts
```

Expected: FAIL because mutation service and registrations do not exist.

- [ ] **Step 3: Implement immediate mutation behavior**

Create-space, update-space, create-collection, same-parent rename, non-duplicate save-link, and update-link execute through `WorkspaceRepository` after loading the owned target. Return the created/updated safe DTO and current canonical revision.

`saveLink` returns `{ status: "already_exists", item }` for a same-collection normalized duplicate unless `allowDuplicate` is true. With `allowDuplicate: true`, the first call returns a preview; only `confirm: true` plus the current revision creates the copy.

- [ ] **Step 4: Implement revision-confirmed operations**

Use this result union consistently:

```ts
export type MutationResult<T> =
  | { status: "applied"; revision: number; value: T }
  | { status: "already_exists"; revision: number; value: T }
  | {
      status: "confirmation_required";
      expectedRevision: number;
      summary: string;
      operation: WorkspaceMutation;
      affected: Array<{ kind: "space" | "collection" | "link"; id: string; name: string }>;
    };
```

Confirmed input must reproduce the same operation fields and revision returned by the preview. On a conflict, load a fresh versioned snapshot and return a retryable error containing a new preview, never partially apply.

- [ ] **Step 5: Register strict write tools and annotations**

Register `create_space`, `update_space`, `create_collection`, `update_collection`, `save_link`, `update_link`, `move_link`, `reorder_items`, and `delete_item`. Use strict Zod objects and exact database bounds. Mark delete, cross-parent move, reorder, and duplicate-copy tools with `destructiveHint: true`; mark only create and safe update tools as non-destructive. No tool schema contains `user_id` or arbitrary SQL/filter fields.

- [ ] **Step 6: Verify writes, schemas, types, and build**

```bash
npx vitest run tests/mcp/mutation-service.test.ts tests/mcp/mutation-tools.test.ts
npm --workspace @tabloom/mcp run type-check
npm --workspace @tabloom/mcp run build
```

Expected: all commands exit 0 and every destructive path proves preview-before-apply.

- [ ] **Step 7: Commit mutation tools**

```bash
git add services/tabloom-mcp/src/workspace/mutation-service.ts services/tabloom-mcp/src/tools/register-mutation-tools.ts services/tabloom-mcp/app/api/mcp/route.ts tests/mcp/mutation-service.test.ts tests/mcp/mutation-tools.test.ts
git commit -m "feat: add confirmed MCP workspace mutations"
```

### Task 9: Add OAuth-shaped RLS tests, rate limits, and safe observability

**Files:**
- Create: `supabase/migrations/202608290003_mcp_rate_limits.sql`
- Create: `supabase/tests/mcp_oauth_isolation.test.sql`
- Create: `services/tabloom-mcp/src/security/rate-limit.ts`
- Create: `services/tabloom-mcp/src/observability/audit.ts`
- Modify: `services/tabloom-mcp/app/api/mcp/route.ts`
- Test: `tests/mcp/security.test.ts`

**Interfaces:**
- Consumes: verified `sub`, `client_id`, `auth.jwt()` OAuth-shaped claims, and request correlation IDs.
- Produces: `consume_mcp_rate_limit()` RPC, `enforceRateLimit(context)`, and content-redacted request audit records.

- [ ] **Step 1: Write failing two-user OAuth RLS tests**

Use two real `auth.users` fixtures and set claims including `sub`, `role: authenticated`, `aud`, and `client_id`. Assert User A sees/mutates only User A, cannot reference User B parents, and anonymous access remains empty.

```sql
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', :'user_a',
  'role', 'authenticated',
  'aud', jsonb_build_array('authenticated', 'https://tabloom-mcp.vercel.app'),
  'client_id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
)::text, true);

select is((select count(*) from public.links where user_id = :'user_b'::uuid), 0::bigint,
  'OAuth-shaped User A claims cannot read User B links');
```

- [ ] **Step 2: Write failing rate-limit and redaction tests**

```ts
it("hashes identities and omits workspace content and bearer tokens", () => {
  const record = auditRecord({ userId: USER_ID, clientId: CLIENT_ID, tool: "search_links", token: "secret", arguments: { query: "private" } });
  expect(JSON.stringify(record)).not.toContain(USER_ID);
  expect(JSON.stringify(record)).not.toContain("secret");
  expect(JSON.stringify(record)).not.toContain("private");
});
```

- [ ] **Step 3: Implement per-user/client rate limiting in Supabase**

Create `mcp_rate_limit_windows(user_id uuid, client_id text, window_start timestamptz, request_count integer)` with RLS scoped to `auth.uid()` and an RPC that derives both user and client from JWT claims. Use a one-minute window and reject request 61 for the same user/client. The tool cannot supply either identifier. Delete windows older than 24 hours opportunistically inside the RPC.

- [ ] **Step 4: Implement safe audit records and error mapping**

Generate a UUID correlation ID per HTTP request. Log only correlation ID, tool name, duration, stable result category, and SHA-256 hashes of user/client IDs. Map infrastructure errors to `unauthenticated`, `forbidden`, `invalid_input`, `not_found`, `conflict`, `temporarily_unavailable`, or `internal_error`; return only the correlation ID for unexpected failures.

- [ ] **Step 5: Verify RLS, rate limiting, and redaction**

```bash
npx supabase db reset
npx supabase test db supabase/tests/*.test.sql
npx vitest run tests/mcp/security.test.ts
npm --workspace @tabloom/mcp run build
```

Expected: all commands exit 0; OAuth-shaped two-user isolation and the 61st-request rejection pass.

- [ ] **Step 6: Commit security hardening**

```bash
git add supabase/migrations/202608290003_mcp_rate_limits.sql supabase/tests/mcp_oauth_isolation.test.sql services/tabloom-mcp/src/security services/tabloom-mcp/src/observability services/tabloom-mcp/app/api/mcp/route.ts tests/mcp/security.test.ts
git commit -m "feat: harden MCP isolation and rate limits"
```

### Task 10: Complete deployment, documentation, and end-to-end acceptance

**Files:**
- Modify: `README.md`
- Modify: `docs/mcp-setup.md`
- Modify: `.env.example`
- Create: `services/tabloom-mcp/scripts/test-client.mjs`
- Create: `tests/e2e/mcp-live.spec.ts`

**Interfaces:**
- Consumes: live Sites deployment, live Supabase OAuth/RLS migrations, live Vercel MCP deployment, and a user-approved OAuth grant.
- Produces: a documented MCP URL, repeatable client smoke test, live acceptance evidence, and install instructions for Codex/ChatGPT-compatible clients.

- [ ] **Step 1: Write the failing deployed-contract test**

The test accepts `TABLOOM_MCP_TEST_URL` and an optional user token from an ignored environment variable. Without a token it must prove health, resource metadata, and `401`; with a token it initializes MCP, lists all 13 tools, and executes a read-only workspace query.

```ts
expect(metadata.authorization_servers).toEqual([
  "https://tctjlsvfufzxhauhywsm.supabase.co/auth/v1",
]);
expect(metadata.resource).toBe(process.env.TABLOOM_MCP_RESOURCE_URL);
expect(unauthenticated.status).toBe(401);
```

- [ ] **Step 2: Add a reusable SDK v2 client smoke script**

Connect with Streamable HTTP, initialize, list tools, optionally pass `Authorization: Bearer`, call `get_workspace`, print only tool names/counts, and close. Never print token or workspace URLs.

- [ ] **Step 3: Apply migrations and run the complete local verification suite**

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
```

Expected: every command exits 0 with no console errors or token output.

- [ ] **Step 4: Apply live Supabase migrations and deploy both surfaces**

Link/authenticate Supabase without committing its access token, push the three reviewed migrations, deploy the consent-enabled site through Sites, and deploy the MCP service:

```bash
vercel deploy --prod --cwd services/tabloom-mcp --yes
```

Confirm Vercel production environment contains only `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `TABLOOM_MCP_RESOURCE_URL` for this feature.

- [ ] **Step 5: Run public and authenticated acceptance checks**

```bash
TABLOOM_MCP_TEST_URL="${TABLOOM_MCP_RESOURCE_URL%/}/api/mcp" npx playwright test tests/e2e/mcp-live.spec.ts
node services/tabloom-mcp/scripts/test-client.mjs "${TABLOOM_MCP_RESOURCE_URL%/}/api/mcp"
```

Then authorize one supported MCP client through Google and the Tabloom consent page. Verify search, create collection, save link, cross-collection move preview/apply, delete preview/apply, web/extension synchronization, denial, expiry, and revocation. Create a second Supabase user fixture and prove no cross-user reads or mutations.

- [ ] **Step 6: Inspect production logs for secret leakage**

Use Vercel logs for the acceptance window and search for JWT-shaped strings, `access_token`, `refresh_token`, saved URLs, and descriptions. Expected: no matches; audit lines contain only hashed identifiers and correlation IDs.

- [ ] **Step 7: Finish operator and user documentation**

Document:

- MCP endpoint and supported tools.
- Whole-workspace permission semantics.
- OAuth enablement, consent path, DCR compatibility, and revocation.
- Vercel linking/environment/deployment commands.
- Audience-probe failure behavior.
- Codex/ChatGPT-compatible connection instructions.
- Explicit exclusion of local current tabs and browser actions.

- [ ] **Step 8: Commit delivery artifacts**

```bash
git add README.md docs/mcp-setup.md .env.example services/tabloom-mcp/scripts/test-client.mjs tests/e2e/mcp-live.spec.ts
git commit -m "docs: deliver Tabloom MCP setup and acceptance"
```

- [ ] **Step 9: Final branch verification and integration**

```bash
git status --short
git log --oneline --decorate -15
git diff origin/main...HEAD --check
```

Expected: no uncommitted implementation files, no whitespace errors, and all task commits present. Do not push until the user explicitly requests it.
