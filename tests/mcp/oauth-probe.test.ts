import { createPrivateKey } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import * as probeModule from "../../scripts/probe-mcp-oauth.mjs";
import {
  buildAuthorizationUrl,
  buildDynamicClientRegistration,
  beginProbeAcceptance,
  classifyHttpStatus,
  createCallbackListener,
  createPrivateProbeResultChannel,
  derivePkceChallenge,
  evaluateAudience,
  evaluateDiscovery,
  parseOAuthCallback,
  probeRequest,
  runCli,
  runProbe,
  writeReport,
} from "../../scripts/probe-mcp-oauth.mjs";
import {
  generateOAuthKeys,
  runKeyGeneratorCli,
} from "../../services/tabloom-mcp/scripts/generate-oauth-keys.mjs";
import { createOAuthDatabaseProofKey } from "../../services/tabloom-mcp/src/auth/database-proof";
import {
  closeBrowserContextWithActiveCleanup,
  completeLiveAcceptancePhases,
  evaluateRlsUpdateSettlements,
  loadAcceptanceMismatchSigner,
  createExactSupabaseFetch,
  loadLiveAcceptanceFixture,
  parseLiveAcceptanceFixture,
  planRlsRestoration,
  recordLiveProbeReport,
  requireOptimisticRestorationRow,
  runRestorableRlsWriteCheck,
  verifyActiveBearerControlsAndMismatch,
  verifySubjectMismatchBearer,
  withLiveCleanupCategory,
} from "../e2e/helpers/mcp-facade-live";

const RESOURCE = "https://tabloom-mcp.example.com";
const ISSUER = RESOURCE;
const SCOPE = "tabloom:workspace";
const CALLBACK_URL = "http://127.0.0.1:54321/callback";

const PROTECTED_RESOURCE = {
  resource: RESOURCE,
  authorization_servers: [ISSUER],
};

const AUTHORIZATION_SERVER = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  grant_types_supported: ["authorization_code", "refresh_token"],
  response_types_supported: ["code"],
  scopes_supported: [SCOPE],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
};

const PUBLIC_JWKS = {
  keys: [{
    kty: "EC",
    crv: "P-256",
    alg: "ES256",
    kid: "public-signing-key",
    x: "public-x-coordinate",
    y: "public-y-coordinate",
  }],
};

const DCR_RESPONSE = {
  client_id: "public-client",
  client_name: "Tabloom MCP OAuth readiness probe",
  redirect_uris: [CALLBACK_URL],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

const REPORT_KEYS = [
  "discoverySupported",
  "resource",
  "resourceMatch",
  "issuer",
  "issuerMatch",
  "algorithm",
  "audience",
  "audienceMatch",
  "scope",
  "scopeMatch",
  "refreshRotated",
  "refreshReplayRejected",
  "cleanupFailed",
  "mcpContractMatch",
  "mcpBeforeRevocationResult",
  "revocationResult",
  "mcpAfterRevocationResult",
  "revocationEnforced",
  "pass",
];

type ProbeRequest = (
  url: string,
  init?: RequestInit,
) => Promise<{ status: number; body: unknown; mediaType?: string }>;

type EvaluateMcpServiceStatus = (
  response: { status: number; body: unknown; mediaType?: string },
  requestId: number,
) => boolean;

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

function serviceStatusResponse(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      structuredContent: { service: "tabloom-mcp", status: "ok" },
    },
  };
}

function jsonResponse(status: number, body: Record<string, unknown> = {}) {
  return {
    status,
    body: typeof body.access_token === "string"
      ? { token_type: "Bearer", expires_in: 300, scope: SCOPE, ...body }
      : body,
  };
}

function successfulProbeHarness(options: {
  listenerCloseError?: Error;
  failReportCall?: number;
  invalidReadiness?: boolean;
  invalidFirstTokenResponse?: boolean;
  firstVerificationError?: Error;
  refreshFailure?: "resolved" | "throw" | "invalid";
  cleanupReject?: boolean;
  privateJwks?: boolean;
  secretRegistration?: boolean;
  invalidTokenMetadata?: boolean;
  registrationOverrides?: Record<string, unknown>;
} = {}) {
  const reports: Array<Record<string, unknown>> = [];
  let reportCalls = 0;
  let refreshCalls = 0;
  let mcpCalls = 0;
  let revokeCalls = 0;
  const revokedTokens: string[] = [];
  const request = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/.well-known/oauth-protected-resource")) {
      return jsonResponse(200, PROTECTED_RESOURCE);
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return jsonResponse(200, AUTHORIZATION_SERVER);
    }
    if (url.endsWith("/.well-known/jwks.json")) {
      return jsonResponse(200, options.privateJwks
        ? { keys: [{ ...PUBLIC_JWKS.keys[0], d: "private-key-material" }] }
        : PUBLIC_JWKS);
    }
    if (url.endsWith("/oauth/register")) {
      return jsonResponse(201, options.secretRegistration
        ? { ...DCR_RESPONSE, client_secret: "must-not-be-accepted" }
        : { ...DCR_RESPONSE, ...options.registrationOverrides });
    }
    if (url.endsWith("/oauth/token")) {
      const refresh = new URLSearchParams(String(init?.body))
        .get("grant_type") === "refresh_token";
      if (!refresh) {
        if (options.invalidFirstTokenResponse) {
          return jsonResponse(200, { access_token: "first-access" });
        }
        return jsonResponse(200, {
          access_token: "first-access",
          refresh_token: "first-refresh",
          ...(options.invalidTokenMetadata ? { token_type: "Basic" } : {}),
        });
      }
      refreshCalls += 1;
      if (options.refreshFailure === "throw") {
        throw new Error("private refresh transport detail");
      }
      if (options.refreshFailure === "resolved") {
        return jsonResponse(503, { error: "temporarily_unavailable" });
      }
      if (options.refreshFailure === "invalid") {
        return jsonResponse(200, { access_token: "private-invalid-rotated" });
      }
      return refreshCalls === 1
        ? jsonResponse(200, {
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
        })
        : jsonResponse(400, { error: "invalid_grant" });
    }
    if (url.endsWith("/oauth/revoke")) {
      revokeCalls += 1;
      revokedTokens.push(String(new URLSearchParams(String(init?.body)).get("token")));
      return jsonResponse(options.cleanupReject ? 503 : 200);
    }
    if (url.endsWith("/api/mcp")) {
      mcpCalls += 1;
      if (revokeCalls > 0) return jsonResponse(401);
      return jsonResponse(200, options.invalidReadiness
        ? { jsonrpc: "2.0", id: 1, error: { code: -32603 } }
        : serviceStatusResponse(1));
    }
    throw new Error("Unexpected request");
  };
  return {
    reports,
    revokedTokens,
    counts: () => ({ mcpCalls, revokeCalls }),
    probeOptions: {
      env: { NODE_ENV: "test", TABLOOM_MCP_RESOURCE_URL: RESOURCE },
      request,
      createPkce: () => ({
        state: "state",
        verifier: "verifier",
        challenge: "challenge",
      }),
      createCallbackListener: async () => ({
        callbackUrl: CALLBACK_URL,
        callback: Promise.resolve("code"),
        close: async () => {
          if (options.listenerCloseError) throw options.listenerCloseError;
        },
      }),
      handoffAuthorization: async () => undefined,
      verifyAccessToken: async (token: string) => {
        if (token === "first-access" && options.firstVerificationError) {
          throw options.firstVerificationError;
        }
        return ({
        key: {} as CryptoKey,
        protectedHeader: { alg: "ES256" },
        payload: { iss: ISSUER, aud: RESOURCE, scope: SCOPE },
        });
      },
      writeReport: async (report: Record<string, unknown>) => {
        reportCalls += 1;
        if (reportCalls === options.failReportCall) {
          throw new Error("report write failed");
        }
        reports.push(report);
      },
      log: () => undefined,
    },
  };
}

describe("MCP OAuth readiness probe", () => {
  it("discovers the facade issuer from protected-resource metadata", () => {
    expect(
      evaluateDiscovery(PROTECTED_RESOURCE, AUTHORIZATION_SERVER, RESOURCE),
    ).toEqual({
      discoverySupported: true,
      resource: RESOURCE,
      resourceMatch: true,
      issuer: ISSUER,
      issuerMatch: true,
    });

    expect(
      evaluateDiscovery(
        { ...PROTECTED_RESOURCE, resource: "https://wrong.example.com" },
        { ...AUTHORIZATION_SERVER, scopes_supported: ["email"] },
        RESOURCE,
      ),
    ).toMatchObject({
      discoverySupported: false,
      resourceMatch: false,
      issuerMatch: true,
    });
    expect(
      evaluateDiscovery(
        PROTECTED_RESOURCE,
        {
          ...AUTHORIZATION_SERVER,
          token_endpoint: "https://unexpected.example.com/oauth/token",
        },
        RESOURCE,
      ).discoverySupported,
    ).toBe(false);
    expect(evaluateDiscovery(
      PROTECTED_RESOURCE,
      { ...AUTHORIZATION_SERVER, grant_types_supported: ["authorization_code", 42] },
      RESOURCE,
    ).discoverySupported).toBe(false);
    expect(evaluateDiscovery(
      PROTECTED_RESOURCE,
      { ...AUTHORIZATION_SERVER, response_types_supported: undefined },
      RESOURCE,
    ).discoverySupported).toBe(false);
  });

  it.each([
    ["authorization_servers", PROTECTED_RESOURCE, ISSUER],
    ["code_challenge_methods_supported", AUTHORIZATION_SERVER, "S256"],
    ["grant_types_supported", AUTHORIZATION_SERVER, "authorization_code"],
    ["response_types_supported", AUTHORIZATION_SERVER, "code"],
    ["scopes_supported", AUTHORIZATION_SERVER, SCOPE],
    ["token_endpoint_auth_methods_supported", AUTHORIZATION_SERVER, "none"],
  ])("rejects scalar %s discovery metadata", (field, source, scalar) => {
    const protectedResource = source === PROTECTED_RESOURCE
      ? { ...PROTECTED_RESOURCE, [field]: scalar }
      : PROTECTED_RESOURCE;
    const authorizationServer = source === AUTHORIZATION_SERVER
      ? { ...AUTHORIZATION_SERVER, [field]: scalar }
      : AUTHORIZATION_SERVER;

    expect(evaluateDiscovery(
      protectedResource,
      authorizationServer,
      RESOURCE,
    ).discoverySupported).toBe(false);
  });

  it("accepts JWT audiences only as one expected string or string array", () => {
    expect(evaluateAudience(RESOURCE, RESOURCE)).toEqual({ pass: true });
    expect(evaluateAudience([RESOURCE], RESOURCE)).toEqual({ pass: true });
    expect(evaluateAudience([RESOURCE, "https://other.example.com"], RESOURCE))
      .toEqual({ pass: false, reason: "resource_audience_mismatch" });
  });

  it.each([
    ["authorization_servers", PROTECTED_RESOURCE, ISSUER],
    ["code_challenge_methods_supported", AUTHORIZATION_SERVER, "S256"],
    ["grant_types_supported", AUTHORIZATION_SERVER, "authorization_code"],
    ["response_types_supported", AUTHORIZATION_SERVER, "code"],
    ["scopes_supported", AUTHORIZATION_SERVER, SCOPE],
    ["token_endpoint_auth_methods_supported", AUTHORIZATION_SERVER, "none"],
  ])("stops before DCR or browser handoff for scalar %s discovery metadata", async (field, source, scalar) => {
    const requests: string[] = [];
    let listenerCalls = 0;
    let handoffCalls = 0;
    const protectedResource = source === PROTECTED_RESOURCE
      ? { ...PROTECTED_RESOURCE, [field]: scalar }
      : PROTECTED_RESOURCE;
    const authorizationServer = source === AUTHORIZATION_SERVER
      ? { ...AUTHORIZATION_SERVER, [field]: scalar }
      : AUTHORIZATION_SERVER;

    await expect(beginProbeAcceptance({
      env: { NODE_ENV: "test", TABLOOM_MCP_RESOURCE_URL: RESOURCE },
      request: async (url) => {
        requests.push(url);
        if (url.endsWith("/.well-known/oauth-protected-resource")) {
          return jsonResponse(200, protectedResource);
        }
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return jsonResponse(200, authorizationServer);
        }
        throw new Error("unexpected request");
      },
      createCallbackListener: async () => {
        listenerCalls += 1;
        throw new Error("listener must not start");
      },
      handoffAuthorization: async () => { handoffCalls += 1; },
      writeReport: async () => undefined,
      log: () => undefined,
    })).rejects.toThrow(
      source === PROTECTED_RESOURCE
        ? "Protected-resource discovery failed"
        : "readiness gate",
    );

    expect(requests).toEqual(source === PROTECTED_RESOURCE
      ? [`${RESOURCE}/.well-known/oauth-protected-resource`]
      : [
        `${RESOURCE}/.well-known/oauth-protected-resource`,
        `${RESOURCE}/.well-known/oauth-authorization-server`,
      ]);
    expect(listenerCalls).toBe(0);
    expect(handoffCalls).toBe(0);
  });

  it.each([
    ["redirect_uris", CALLBACK_URL],
    ["grant_types", "authorization_code"],
    ["response_types", "code"],
  ])("rejects scalar DCR %s metadata before browser handoff", async (field, scalar) => {
    const harness = successfulProbeHarness({
      registrationOverrides: { [field]: scalar },
    });

    await expect(beginProbeAcceptance(
      harness.probeOptions as Parameters<typeof beginProbeAcceptance>[0],
    )).rejects.toThrow("Dynamic client registration failed");
  });

  it("rejects a foreign discovered issuer before any off-origin request or browser handoff", async () => {
    const foreignIssuer = "https://attacker.example";
    const requests: string[] = [];
    let listenerCalls = 0;
    let handoffCalls = 0;

    await expect(beginProbeAcceptance({
      env: { NODE_ENV: "test", TABLOOM_MCP_RESOURCE_URL: RESOURCE },
      request: async (url) => {
        requests.push(url);
        return jsonResponse(200, {
          resource: RESOURCE,
          authorization_servers: [foreignIssuer],
        });
      },
      createCallbackListener: async () => {
        listenerCalls += 1;
        throw new Error("listener must not start");
      },
      handoffAuthorization: async () => { handoffCalls += 1; },
      writeReport: async () => undefined,
      log: () => undefined,
    })).rejects.toThrow("unexpected issuer");

    expect(requests).toEqual([`${RESOURCE}/.well-known/oauth-protected-resource`]);
    expect(listenerCalls).toBe(0);
    expect(handoffCalls).toBe(0);
  });

  it.each([
    [{ privateJwks: true }, "JWKS discovery"],
    [{ secretRegistration: true }, "Dynamic client registration"],
    [{ invalidTokenMetadata: true }, "invalid token pair"],
  ])("fails readiness for strict public metadata: %j", async (options, expected) => {
    const harness = successfulProbeHarness(options);
    await expect(beginProbeAcceptance(
      harness.probeOptions as Parameters<typeof beginProbeAcceptance>[0],
    )).rejects.toThrow(expected);
  });

  it("registers a public refresh-capable client and builds an exact S256 authorization request", () => {
    expect(buildDynamicClientRegistration(CALLBACK_URL)).toEqual({
      client_name: "Tabloom MCP OAuth readiness probe",
      redirect_uris: [CALLBACK_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(
      derivePkceChallenge(
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      ),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");

    const authorizationUrl = new URL(buildAuthorizationUrl({
      authorizationEndpoint: AUTHORIZATION_SERVER.authorization_endpoint,
      clientId: "public-client",
      callbackUrl: CALLBACK_URL,
      state: "csrf-state",
      challenge: "pkce-challenge",
      resource: RESOURCE,
      scope: SCOPE,
    }));
    expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual({
      response_type: "code",
      client_id: "public-client",
      redirect_uri: CALLBACK_URL,
      state: "csrf-state",
      code_challenge: "pkce-challenge",
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: SCOPE,
    });
  });

  it("accepts only the matching loopback callback state", async () => {
    expect(
      parseOAuthCallback(
        "/callback?state=wrong-state&code=stray-code",
        "expected-state",
      ),
    ).toEqual({
      status: 400,
      body: "Invalid OAuth callback.",
      terminal: false,
    });
    const listener = await createCallbackListener("expected-state");
    try {
      const stray = await fetch(
        `${listener.callbackUrl}?state=wrong-state&code=stray-code`,
      );
      expect(stray.status).toBe(400);
      const valid = await fetch(
        `${listener.callbackUrl}?state=expected-state&code=approved-code`,
      );
      expect(valid.status).toBe(200);
      await expect(listener.callback).resolves.toBe("approved-code");
    } finally {
      await listener.close();
    }
  });

  it.each([
    [200, "success"],
    [204, "success"],
    [400, "client_error"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [503, "server_error"],
  ])("classifies HTTP %i without retaining response content", (status, result) => {
    expect(classifyHttpStatus(status)).toBe(result);
  });

  it.each([307, 308])(
    "refuses a real cross-origin HTTP %i redirect without forwarding secrets",
    async (status) => {
      const probeRequest = (probeModule as unknown as {
        probeRequest?: ProbeRequest;
      }).probeRequest;
      expect(typeof probeRequest).toBe("function");
      const secret = "private-redirected-refresh-token";
      const stderr: string[] = [];
      const directory = await mkdtemp(join(tmpdir(), "tabloom-probe-redirect-"));
      const reportPath = join(directory, "report.json");
      let redirectedRequests = 0;
      const redirected = createServer((_request, response) => {
        redirectedRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
      const redirectedOrigin = await listen(redirected);
      const source = createServer((request, response) => {
        request.resume();
        response.writeHead(status, { Location: `${redirectedOrigin}/stolen` });
        response.end();
      });
      const sourceOrigin = await listen(source);
      try {
        const exitCode = await runCli({
          run: async () => {
            await probeRequest!(`${sourceOrigin}/.well-known/oauth-protected-resource`, {
              headers: { authorization: `Bearer ${secret}` },
            });
          },
          error: (message) => { stderr.push(message); },
        });
        await writeReport({ pass: false, detail: secret }, reportPath);
        expect(exitCode).toBe(1);
        expect(redirectedRequests).toBe(0);
        const observable = `${stderr.join("\n")}\n${await readFile(reportPath, "utf8")}`;
        expect(observable).not.toContain(secret);
      } finally {
        await closeServer(source);
        await closeServer(redirected);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("accepts exact JSON and SSE JSON-RPC service-status responses", () => {
    const evaluate = (probeModule as unknown as {
      evaluateMcpServiceStatus?: EvaluateMcpServiceStatus;
    }).evaluateMcpServiceStatus;
    expect(typeof evaluate).toBe("function");
    expect(evaluate!({
      status: 200,
      mediaType: "application/json",
      body: serviceStatusResponse(7),
    }, 7)).toBe(true);
    expect(evaluate!({
      status: 200,
      mediaType: "text/event-stream",
      body: `event: message\ndata: ${JSON.stringify(serviceStatusResponse(8))}\n\n`,
    }, 8)).toBe(true);
  });

  it.each([
    {
      name: "JSON-RPC error",
      body: { jsonrpc: "2.0", id: 7, error: { code: -32603 } },
    },
    { name: "wrong id", body: serviceStatusResponse(8) },
    {
      name: "wrong result",
      body: {
        jsonrpc: "2.0",
        id: 7,
        result: { structuredContent: { service: "other", status: "ok" } },
      },
    },
  ])("rejects a 200 $name response", ({ body }) => {
    const evaluate = (probeModule as unknown as {
      evaluateMcpServiceStatus?: EvaluateMcpServiceStatus;
    }).evaluateMcpServiceStatus;
    expect(typeof evaluate).toBe("function");
    expect(evaluate!({ status: 200, mediaType: "application/json", body }, 7))
      .toBe(false);
  });

  it("runs discovery through post-revocation rejection with a strict redacted report", async () => {
    const authorizationCode = "private-authorization-code";
    const verifier = "private-pkce-verifier";
    const firstAccessToken = "private-first-access-token";
    const firstRefreshToken = "private-first-refresh-token";
    const rotatedAccessToken = "private-rotated-access-token";
    const rotatedRefreshToken = "private-rotated-refresh-token";
    const reports: Array<Record<string, unknown>> = [];
    const privateResults = createPrivateProbeResultChannel();
    const logs: string[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let refreshCalls = 0;
    let handoffUrl = "";

    const request = async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return jsonResponse(200, PROTECTED_RESOURCE);
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse(200, AUTHORIZATION_SERVER);
      }
      if (url.endsWith("/.well-known/jwks.json")) {
        return jsonResponse(200, PUBLIC_JWKS);
      }
      if (url.endsWith("/oauth/register")) {
        return jsonResponse(201, DCR_RESPONSE);
      }
      if (url.endsWith("/oauth/token")) {
        const form = new URLSearchParams(String(init?.body));
        if (form.get("grant_type") === "authorization_code") {
          return jsonResponse(200, {
            access_token: firstAccessToken,
            refresh_token: firstRefreshToken,
          });
        }
        refreshCalls += 1;
        return refreshCalls === 1
          ? jsonResponse(200, {
            access_token: rotatedAccessToken,
            refresh_token: rotatedRefreshToken,
          })
          : jsonResponse(400, { error: "invalid_grant" });
      }
      if (url.endsWith("/oauth/revoke")) return jsonResponse(200);
      if (url.endsWith("/api/mcp")) {
        const callCount = requests.filter(
          (entry) => entry.url.endsWith("/api/mcp"),
        ).length;
        return callCount === 1
          ? jsonResponse(200, serviceStatusResponse(1))
          : jsonResponse(401);
      }
      throw new Error("Unexpected request");
    };

    const phase = await beginProbeAcceptance({
      env: { NODE_ENV: "test", TABLOOM_MCP_RESOURCE_URL: RESOURCE },
      request,
      privateResultChannel: privateResults.channel,
      createPkce: () => ({
        state: "private-state",
        verifier,
        challenge: "public-challenge",
      }),
      createCallbackListener: async () => ({
        callbackUrl: CALLBACK_URL,
        callback: Promise.resolve(authorizationCode),
        close: async () => undefined,
      }),
      handoffAuthorization: async (url) => { handoffUrl = url; },
      verifyAccessToken: async (token) => ({
        key: {} as CryptoKey,
        protectedHeader: { alg: "ES256", kid: "private-signing-kid" },
        payload: {
          iss: ISSUER,
          aud: RESOURCE,
          scope: SCOPE,
          sub: token === firstAccessToken ? "private-user-a" : "private-user-a",
          client_id: "public-client",
        },
      }),
      writeReport: async (report: Record<string, unknown>) => { reports.push(report); },
      log: (message) => { logs.push(message); },
    });

    expect(requests.some((entry) => entry.url.endsWith("/oauth/revoke")))
      .toBe(false);
    expect(requests.filter((entry) => entry.url.endsWith("/api/mcp")))
      .toHaveLength(1);
    expect(reports.at(-1)).toMatchObject({
      refreshRotated: true,
      refreshReplayRejected: true,
      cleanupFailed: false,
      mcpContractMatch: true,
      mcpBeforeRevocationResult: "success",
      revocationResult: "server_error",
      pass: false,
    });
    expect(privateResults.take()).toMatchObject({
      first: {
        accessToken: firstAccessToken,
        verified: { payload: { sub: "private-user-a" } },
      },
      rotated: {
        accessToken: rotatedAccessToken,
        verified: { payload: { sub: "private-user-a" } },
      },
      jwks: PUBLIC_JWKS,
    });
    expect(() => privateResults.take()).toThrow();

    await phase.complete();
    await phase.complete();
    expect(requests.filter((entry) => entry.url.endsWith("/oauth/revoke")))
      .toHaveLength(1);

    expect(Object.fromEntries(new URL(handoffUrl).searchParams)).toEqual({
      response_type: "code",
      client_id: "public-client",
      redirect_uri: CALLBACK_URL,
      state: "private-state",
      code_challenge: "public-challenge",
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: SCOPE,
    });
    const registration = JSON.parse(String(
      requests.find((entry) => entry.url.endsWith("/oauth/register"))?.init?.body,
    ));
    expect(registration.grant_types).toEqual(["authorization_code", "refresh_token"]);
    const tokenForms = requests
      .filter((entry) => entry.url.endsWith("/oauth/token"))
      .map((entry) => Object.fromEntries(new URLSearchParams(String(entry.init?.body))));
    expect(tokenForms).toEqual([
      {
        grant_type: "authorization_code",
        code: authorizationCode,
        client_id: "public-client",
        redirect_uri: CALLBACK_URL,
        resource: RESOURCE,
        code_verifier: verifier,
      },
      {
        grant_type: "refresh_token",
        refresh_token: firstRefreshToken,
        client_id: "public-client",
        resource: RESOURCE,
        scope: SCOPE,
      },
      {
        grant_type: "refresh_token",
        refresh_token: firstRefreshToken,
        client_id: "public-client",
        resource: RESOURCE,
        scope: SCOPE,
      },
    ]);
    expect(requests.every((entry) => entry.init?.redirect === "manual"))
      .toBe(true);
    const report = reports.at(-1)!;
    expect(report).toEqual({
      discoverySupported: true,
      resource: RESOURCE,
      resourceMatch: true,
      issuer: ISSUER,
      issuerMatch: true,
      algorithm: "ES256",
      audience: [RESOURCE],
      audienceMatch: true,
      scope: SCOPE,
      scopeMatch: true,
      refreshRotated: true,
      refreshReplayRejected: true,
      cleanupFailed: false,
      mcpContractMatch: true,
      mcpBeforeRevocationResult: "success",
      revocationResult: "success",
      mcpAfterRevocationResult: "unauthorized",
      revocationEnforced: true,
      pass: true,
    });
    expect(Object.keys(report)).toEqual(REPORT_KEYS);
    expect(JSON.stringify(report)).not.toMatch(
      /access_token|refresh_token|authorization_code|cookie|verifier/i,
    );
    const observableOutput = JSON.stringify({ reports, logs });
    for (const secret of [
      authorizationCode,
      verifier,
      firstAccessToken,
      firstRefreshToken,
      rotatedAccessToken,
      rotatedRefreshToken,
      "private-user-a",
      "private-signing-kid",
    ]) {
      expect(observableOutput).not.toContain(secret);
    }
  });

  it("fails closed and reports only allowlisted fields when revocation is not enforced", async () => {
    const reports: Array<Record<string, unknown>> = [];
    let mcpCalls = 0;
    let refreshCalls = 0;
    const request = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/.well-known/oauth-protected-resource")) return jsonResponse(200, PROTECTED_RESOURCE);
      if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(200, AUTHORIZATION_SERVER);
      if (url.endsWith("/.well-known/jwks.json")) return jsonResponse(200, PUBLIC_JWKS);
      if (url.endsWith("/oauth/register")) return jsonResponse(201, DCR_RESPONSE);
      if (url.endsWith("/oauth/token")) {
        const refresh = new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token";
        if (refresh && ++refreshCalls > 1) {
          return jsonResponse(400, { error: "invalid_grant" });
        }
        return jsonResponse(200, {
          access_token: refresh ? "rotated-access" : "first-access",
          refresh_token: refresh ? "rotated-refresh" : "first-refresh",
        });
      }
      if (url.endsWith("/oauth/revoke")) return jsonResponse(200);
      if (url.endsWith("/api/mcp")) {
        mcpCalls += 1;
        return jsonResponse(200, serviceStatusResponse(mcpCalls));
      }
      throw new Error("Unexpected request");
    };

    await expect(runProbe({
      env: { NODE_ENV: "test", TABLOOM_MCP_RESOURCE_URL: RESOURCE },
      request,
      createPkce: () => ({ state: "state", verifier: "verifier", challenge: "challenge" }),
      createCallbackListener: async () => ({ callbackUrl: CALLBACK_URL, callback: Promise.resolve("code"), close: async () => undefined }),
      handoffAuthorization: async () => undefined,
      verifyAccessToken: async () => ({
        key: {} as CryptoKey,
        protectedHeader: { alg: "ES256" },
        payload: { iss: ISSUER, aud: RESOURCE, scope: SCOPE },
      }),
      writeReport: async (report: Record<string, unknown>) => {
        reports.push(report);
      },
      log: () => undefined,
    })).rejects.toThrow("cleanup failed");
    expect(mcpCalls).toBe(2);
    expect(reports.at(-1)).toMatchObject({
      refreshReplayRejected: true,
      cleanupFailed: true,
      revocationEnforced: false,
      mcpAfterRevocationResult: "success",
      pass: false,
    });
    expect(Object.keys(reports.at(-1)!)).toEqual(REPORT_KEYS);
  });

  it.each([
    {
      name: "callback listener close",
      options: { listenerCloseError: new Error("listener close failed") },
      expected: "listener close failed",
    },
    {
      name: "active report write",
      options: { failReportCall: 2 },
      expected: "report write failed",
    },
    {
      name: "active readiness",
      options: { invalidReadiness: true },
      expected: "readiness gate",
    },
  ])("cleans the rotated grant after $name failure", async ({ options, expected }) => {
    const harness = successfulProbeHarness(options);
    await expect(beginProbeAcceptance(
      harness.probeOptions as Parameters<typeof beginProbeAcceptance>[0],
    ))
      .rejects.toThrow(expected);
    expect(harness.counts()).toEqual({ mcpCalls: 2, revokeCalls: 1 });
    expect(harness.revokedTokens).toEqual(["rotated-access"]);
    expect(harness.reports.at(-1)).toMatchObject({
      cleanupFailed: false,
      mcpAfterRevocationResult: "unauthorized",
      revocationResult: "success",
      pass: false,
    });
  });

  it.each([
    {
      name: "first access-token verification",
      options: { firstVerificationError: new Error("private first-token detail") },
      expected: "private first-token detail",
    },
    {
      name: "resolved refresh exchange error",
      options: { refreshFailure: "resolved" as const },
      expected: "Refresh-token exchange failed",
    },
    {
      name: "thrown refresh exchange error",
      options: { refreshFailure: "throw" as const },
      expected: "private refresh transport detail",
    },
    {
      name: "invalid refresh exchange response",
      options: { refreshFailure: "invalid" as const },
      expected: "invalid token pair",
    },
  ])("cleans the first grant after $name", async ({ options, expected }) => {
    const harness = successfulProbeHarness(options);
    await expect(beginProbeAcceptance(
      harness.probeOptions as Parameters<typeof beginProbeAcceptance>[0],
    )).rejects.toThrow(expected);
    expect(harness.counts()).toEqual({ mcpCalls: 1, revokeCalls: 1 });
    expect(harness.revokedTokens).toEqual(["first-access"]);
    expect(harness.reports.at(-1)).toMatchObject({
      cleanupFailed: false,
      mcpAfterRevocationResult: "unauthorized",
      revocationResult: "success",
      pass: false,
    });
    expect(JSON.stringify(harness.reports)).not.toMatch(
      /first-access|first-refresh|private-invalid-rotated|private .* detail/i,
    );
  });

  it("revokes a partially returned first access token before surfacing a categorical token-pair failure", async () => {
    const harness = successfulProbeHarness({ invalidFirstTokenResponse: true });
    await expect(beginProbeAcceptance(
      harness.probeOptions as Parameters<typeof beginProbeAcceptance>[0],
    )).rejects.toThrow("Authorization-code exchange returned an invalid token pair");

    expect(harness.revokedTokens).toEqual(["first-access"]);
    expect(harness.counts()).toEqual({ mcpCalls: 1, revokeCalls: 1 });
    expect(harness.reports.at(-1)).toMatchObject({
      cleanupFailed: false,
      revocationResult: "success",
      mcpAfterRevocationResult: "unauthorized",
      pass: false,
    });
    expect(JSON.stringify(harness.reports)).not.toContain("first-access");
  });

  it("returns a fixed nonzero CLI error without echoing unexpected details", async () => {
    const stderr: string[] = [];
    const exitCode = await runCli({
      run: async () => { throw new Error("private-refresh-token"); },
      error: (message) => { stderr.push(message); },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toEqual([
      "OAuth readiness gate failed. See the redacted report for details.",
    ]);
  });

  it("writes only the report allowlist with mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-probe-"));
    const path = join(directory, "readiness.json");
    const report = {
      pass: false,
      access_token: "private-access-token",
      privateResult: {
        first: { accessToken: "private-first", verified: { payload: { sub: "private-sub" } } },
      },
    };
    try {
      await writeFile(path, "loose", { mode: 0o644 });
      await chmod(path, 0o644);
      await writeReport(report, path);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const written = JSON.parse(await readFile(path, "utf8"));
      expect(Object.keys(written)).toEqual(REPORT_KEYS);
      expect(JSON.stringify(written)).not.toContain("private-access-token");
      expect(JSON.stringify(written)).not.toContain("private-first");
      expect(JSON.stringify(written)).not.toContain("private-sub");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("OAuth facade key generator", () => {
  it("requires an existing mode-0700 parent owned by the current user", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-parent-"));
    const signingPath = join(directory, "signing.json");
    const encryptionPath = join(directory, "encryption.json");
    try {
      await chmod(directory, 0o755);
      await expect(generateOAuthKeys({
        signingPath,
        encryptionPath,
        repositoryRoot: resolve("."),
      })).rejects.toThrow();
      await expect(stat(signingPath)).rejects.toThrow();
      await expect(stat(encryptionPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cleans both exclusive outputs when the parent identity changes before any secret write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-parent-race-"));
    const signingPath = join(directory, "signing.json");
    const encryptionPath = join(directory, "encryption.json");
    let inspections = 0;
    try {
      await expect(generateOAuthKeys({
        signingPath,
        encryptionPath,
        repositoryRoot: resolve("."),
        inspectParent: async (path: string) => {
          const metadata = await stat(path, { bigint: true });
          inspections += 1;
          return {
            dev: metadata.dev,
            ino: inspections > 2 ? metadata.ino + BigInt(1) : metadata.ino,
          };
        },
      })).rejects.toThrow();
      expect(inspections).toBeGreaterThanOrEqual(4);
      await expect(stat(signingPath)).rejects.toThrow();
      await expect(stat(encryptionPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cleans both exclusive outputs when an output path identity changes before writing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-output-race-"));
    const signingPath = join(directory, "signing.json");
    const encryptionPath = join(directory, "encryption.json");
    let inspections = 0;
    try {
      await expect(generateOAuthKeys({
        signingPath,
        encryptionPath,
        repositoryRoot: resolve("."),
        inspectOutput: async (handle: { stat(options: { bigint: true }): Promise<{ dev: bigint; ino: bigint }> }) => {
          const metadata = await handle.stat({ bigint: true });
          inspections += 1;
          return {
            dev: metadata.dev,
            ino: inspections > 2 ? metadata.ino + BigInt(1) : metadata.ino,
          };
        },
      })).rejects.toThrow();
      expect(inspections).toBeGreaterThanOrEqual(4);
      await expect(stat(signingPath)).rejects.toThrow();
      await expect(stat(encryptionPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes one active private JWK, one encryption root, and one database proof secret externally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-keys-"));
    const signingPath = join(directory, "signing.json");
    const encryptionPath = join(directory, "encryption.json");
    const databaseSecretPath = join(directory, "database-secret.txt");
    try {
      await generateOAuthKeys({
        signingPath,
        encryptionPath,
        databaseSecretPath,
        repositoryRoot: resolve("."),
      });
      const signing = JSON.parse(await readFile(signingPath, "utf8"));
      const encryption = JSON.parse(await readFile(encryptionPath, "utf8"));
      const databaseProof = await readFile(databaseSecretPath);
      const databaseSecret = databaseProof.toString("utf8");
      expect(signing).toHaveLength(1);
      expect(signing[0]).toMatchObject({
        active: true,
        privateJwk: { kty: "EC", crv: "P-256", alg: "ES256" },
      });
      expect(signing[0].kid).toMatch(/^signing-v1-[A-Za-z0-9_-]{16,}$/);
      expect(() => createPrivateKey({ key: signing[0].privateJwk, format: "jwk" })).not.toThrow();
      expect(encryption).toHaveLength(1);
      expect(encryption[0]).toMatchObject({ active: true });
      expect(encryption[0].kid).toMatch(/^encryption-v1-[A-Za-z0-9_-]{16,}$/);
      expect(Buffer.from(encryption[0].rootKey, "base64url")).toHaveLength(32);
      expect(databaseProof).toHaveLength(43);
      expect(databaseSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(databaseSecret).not.toMatch(/\s/);
      expect(Buffer.from(databaseSecret, "base64url")).toHaveLength(32);
      expect(() => createOAuthDatabaseProofKey(databaseSecret)).not.toThrow();
      expect(() => createOAuthDatabaseProofKey(`${databaseSecret}\n`)).toThrow();
      expect((await stat(signingPath)).mode & 0o777).toBe(0o600);
      expect((await stat(encryptionPath)).mode & 0o777).toBe(0o600);
      expect((await stat(databaseSecretPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses stdout, repository paths, existing files, and symlink targets without replacing anything", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-keys-"));
    const existing = join(directory, "existing.json");
    const symlinkPath = join(directory, "linked.json");
    const other = join(directory, "other.json");
    const realParent = join(directory, "real-parent");
    const linkedParent = join(directory, "linked-parent");
    await writeFile(existing, "keep", { mode: 0o600 });
    await symlink(existing, symlinkPath);
    await mkdir(realParent, { mode: 0o700 });
    await symlink(realParent, linkedParent);
    try {
      await expect(generateOAuthKeys({ signingPath: "-", encryptionPath: other, repositoryRoot: resolve(".") })).rejects.toThrow();
      await expect(generateOAuthKeys({ signingPath: resolve("generated-signing.json"), encryptionPath: other, repositoryRoot: resolve(".") })).rejects.toThrow();
      await expect(generateOAuthKeys({ signingPath: existing, encryptionPath: other, repositoryRoot: resolve(".") })).rejects.toThrow();
      await expect(generateOAuthKeys({ signingPath: symlinkPath, encryptionPath: other, repositoryRoot: resolve(".") })).rejects.toThrow();
      await expect(generateOAuthKeys({
        signingPath: join(linkedParent, "signing.json"),
        encryptionPath: join(linkedParent, "encryption.json"),
        repositoryRoot: resolve("."),
      })).rejects.toThrow();
      expect(await readFile(existing, "utf8")).toBe("keep");
      await expect(stat(other)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never writes generated material to stdout", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-keys-"));
    try {
      const exitCode = await runKeyGeneratorCli({
        argv: [
          "--signing-out",
          join(directory, "signing.json"),
          "--encryption-out",
          join(directory, "encryption.json"),
          "--database-secret-out",
          join(directory, "database-secret.txt"),
        ],
        repositoryRoot: resolve("."),
        stdout: (message) => { stdout.push(message); },
        stderr: (message) => { stderr.push(message); },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("attempts both closes and removes both files when one close fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-keys-"));
    const signingPath = join(directory, "signing.json");
    const encryptionPath = join(directory, "encryption.json");
    let closeCalls = 0;
    try {
      await expect(generateOAuthKeys({
        signingPath,
        encryptionPath,
        repositoryRoot: resolve("."),
        closeHandle: async (handle: { close(): Promise<void> }) => {
          const call = ++closeCalls;
          await handle.close();
          if (call === 1) throw new Error("injected close failure");
        },
      })).rejects.toThrow();
      expect(closeCalls).toBe(2);
      await expect(stat(signingPath)).rejects.toThrow();
      await expect(stat(encryptionPath)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("live MCP facade acceptance fixture schema", () => {
  function validFixture(directory: string) {
    return {
      version: 1,
      resource: "https://tabloom-mcp.vercel.app",
      supabaseUrl: "https://tctjlsvfufzxhauhywsm.supabase.co",
      supabaseAnonKey: "public-anon-key",
      quiescentAcceptanceAccounts: true,
      users: [
        {
          label: "user-a",
          userId: "11111111-1111-4111-8111-111111111111",
          storageStatePath: join(directory, "user-a-storage.json"),
          supabaseAccessToken: "user-a-access-token",
          ownedSpaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          ownedCollectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
          ownedLinkId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac",
        },
        {
          label: "user-b",
          userId: "22222222-2222-4222-8222-222222222222",
          storageStatePath: join(directory, "user-b-storage.json"),
          supabaseAccessToken: "user-b-access-token",
          ownedSpaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          ownedCollectionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc",
          ownedLinkId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd",
        },
      ],
    };
  }

  it("accepts only the exact two-user credential schema", () => {
    const directory = join(tmpdir(), "tabloom-live-fixture");
    const parsed = parseLiveAcceptanceFixture(validFixture(directory), {
      repositoryRoot: resolve("."),
    });
    expect(parsed.users.map((user) => user.label)).toEqual(["user-a", "user-b"]);

    expect(() => parseLiveAcceptanceFixture({
      ...validFixture(directory),
      supabaseUrl: "https://other-project.supabase.co",
    }, { repositoryRoot: resolve(".") })).toThrow();

    expect(() => parseLiveAcceptanceFixture({
      ...validFixture(directory),
      fixtureModule: "/tmp/untrusted-code.mjs",
    }, { repositoryRoot: resolve(".") })).toThrow();
    expect(() => parseLiveAcceptanceFixture({
      ...validFixture(directory),
      subjectMismatchRejected: true,
    }, { repositoryRoot: resolve(".") })).toThrow();
    expect(() => parseLiveAcceptanceFixture({
      ...validFixture(directory),
      quiescentAcceptanceAccounts: false,
    }, { repositoryRoot: resolve(".") })).toThrow();
    const duplicate = validFixture(directory);
    duplicate.users[1]!.userId = duplicate.users[0]!.userId;
    expect(() => parseLiveAcceptanceFixture(duplicate, {
      repositoryRoot: resolve("."),
    })).toThrow();
  });

  it("confines Supabase SDK fetches to the exact production origin and rejects redirects", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const baseFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response("", { status: 307, headers: { location: "https://evil.example/stolen" } });
    };
    const hardened = createExactSupabaseFetch(baseFetch);
    await expect(hardened("https://evil.example/rest/v1/spaces", {
      headers: { authorization: "Bearer private-token" },
    })).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await expect(hardened(
      "https://tctjlsvfufzxhauhywsm.supabase.co/rest/v1/spaces",
    )).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.redirect).toBe("manual");
  });

  it("accepts only B's complete fresh token payload with the subject changed to A", async () => {
    const now = 1_800_000_000;
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const publicJwk = {
      ...await exportJWK(publicKey),
      alg: "ES256",
      use: "sig",
      kid: "signing-v1-live",
    };
    const sign = (claims: {
      sub: string;
      clientId: string;
      grantId: string;
      inner: string;
      jti: string;
      issuedAt?: number;
      expiresAt?: number;
    }) => new SignJWT({
      sub: claims.sub,
      client_id: claims.clientId,
      scope: SCOPE,
      grant_id: claims.grantId,
      supabase_token: claims.inner,
    })
      .setProtectedHeader({ alg: "ES256", kid: publicJwk.kid, typ: "at+jwt" })
      .setIssuer(RESOURCE)
      .setAudience(RESOURCE)
      .setIssuedAt(claims.issuedAt ?? now)
      .setNotBefore(claims.issuedAt ?? now)
      .setExpirationTime(claims.expiresAt ?? now + 300)
      .setJti(claims.jti)
      .sign(privateKey);
    const userAId = "11111111-1111-4111-8111-111111111111";
    const userBId = "22222222-2222-4222-8222-222222222222";
    const clientA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const clientB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const grantA = "A".repeat(43);
    const grantB = "B".repeat(43);
    const innerA = "a.b.c.d.e";
    const innerB = "f.g.h.i.j";
    const userAIssuedAt = now - 120;
    const userBIssuedAt = now - 30;
    const userAAccessToken = await sign({
      sub: userAId,
      clientId: clientA,
      grantId: grantA,
      inner: innerA,
      jti: "C".repeat(43),
      issuedAt: userAIssuedAt,
      expiresAt: now + 180,
    });
    const userBAccessToken = await sign({
      sub: userBId,
      clientId: clientB,
      grantId: grantB,
      inner: innerB,
      jti: "D".repeat(43),
      issuedAt: userBIssuedAt,
      expiresAt: now + 270,
    });
    const mismatchBearer = await sign({
      sub: userAId,
      clientId: clientB,
      grantId: grantB,
      inner: innerB,
      jti: "E".repeat(43),
      issuedAt: userBIssuedAt,
      expiresAt: now + 270,
    });
    const input = {
      mismatchBearer,
      userAAccessToken,
      userBAccessToken,
      expectedUserAId: userAId,
      expectedUserBId: userBId,
      jwks: { keys: [publicJwk] },
      resource: RESOURCE,
      now,
    };
    await expect(verifySubjectMismatchBearer(input)).resolves.toBeUndefined();
    await expect(verifySubjectMismatchBearer({
      ...input,
      mismatchBearer: "random-malformed-bearer",
    })).rejects.toThrow();
    await expect(verifySubjectMismatchBearer({
      ...input,
      mismatchBearer: await sign({
        sub: userAId,
        clientId: clientA,
        grantId: grantA,
        inner: innerB,
        jti: "F".repeat(43),
        issuedAt: now - 600,
        expiresAt: now - 1,
      }),
    })).rejects.toThrow();

    const directory = await mkdtemp(join(tmpdir(), "tabloom-live-signer-"));
    const signingPath = join(directory, "acceptance-signing-key.json");
    try {
      const privateJwk = await exportJWK(privateKey);
      const signingDocument = {
        version: 1,
        active: true,
        kid: publicJwk.kid,
        privateJwk: {
          kty: "EC",
          crv: "P-256",
          x: privateJwk.x,
          y: privateJwk.y,
          d: privateJwk.d,
          alg: "ES256",
        },
      };
      await writeFile(signingPath, JSON.stringify(signingDocument), {
        mode: 0o644,
      });
      await expect(loadAcceptanceMismatchSigner(signingPath, {
        repositoryRoot: resolve("."),
      })).rejects.toThrow();
      await chmod(signingPath, 0o600);
      await writeFile(signingPath, JSON.stringify({
        ...signingDocument,
        untrustedExtra: true,
      }));
      await expect(loadAcceptanceMismatchSigner(signingPath, {
        repositoryRoot: resolve("."),
      })).rejects.toThrow();
      await writeFile(signingPath, JSON.stringify(signingDocument));
      const signer = await loadAcceptanceMismatchSigner(signingPath, {
        repositoryRoot: resolve("."),
      });
      const generated = await signer.sign({
        userAAccessToken,
        userBAccessToken,
        expectedUserAId: userAId,
        expectedUserBId: userBId,
        jwks: { keys: [publicJwk] },
        resource: RESOURCE,
        now,
      });
      expect(decodeJwt(generated)).toMatchObject({
        sub: userAId,
        client_id: clientB,
        grant_id: grantB,
        supabase_token: innerB,
        iat: userBIssuedAt,
        nbf: userBIssuedAt,
        exp: now + 270,
      });
      await expect(verifySubjectMismatchBearer({
        ...input,
        mismatchBearer: generated,
      })).resolves.toBeUndefined();
      await expect(signer.sign({
        userAAccessToken,
        userBAccessToken,
        expectedUserAId: userAId,
        expectedUserBId: userBId,
        jwks: { keys: [publicJwk] },
        resource: RESOURCE,
        now,
      })).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs active mismatch checks before either grant is revoked", async () => {
    const events: string[] = [];
    let revoked = false;
    const server = createServer((request, response) => {
      if (request.url === "/mismatch") {
        events.push("mismatch-request");
        response.writeHead(revoked ? 401 : 200).end();
        return;
      }
      events.push(String(request.url).slice(1));
      revoked = true;
      response.writeHead(200).end();
    });
    const origin = await listen(server);
    const phases = ["user-a", "user-b"].map((label) => ({
      complete: async () => {
        await probeRequest(`${origin}/revoke-${label}`, { method: "POST" });
      },
    }));
    try {
      await expect(completeLiveAcceptancePhases(phases, async () => {
        const response = await probeRequest(`${origin}/mismatch`, {
          method: "POST",
          headers: { authorization: "Bearer synthetic-secret" },
        });
        if (response.status !== 401) {
          throw new Error("mismatch bearer was accepted while active");
        }
      })).rejects.toThrow("mismatch bearer was accepted while active");
      expect(events[0]).toBe("mismatch-request");
      expect(events.slice(1).sort()).toEqual([
        "revoke-user-a",
        "revoke-user-b",
      ]);
    } finally {
      await closeServer(server);
    }
  });

  it("preserves an active-check failure while both phase cleanups settle categorically", async () => {
    const events: string[] = [];
    const statuses: Array<{ cleanupFailed: boolean }> = [];
    const phases = [
      { complete: async () => { events.push("revoke-a"); } },
      {
        complete: async () => {
          events.push("revoke-b");
          throw new Error("private-cleanup-detail");
        },
      },
    ];
    await expect(completeLiveAcceptancePhases(
      phases,
      async () => { throw new Error("duplicate active bearer"); },
      (status) => { statuses.push(status); },
    )).rejects.toThrow("duplicate active bearer");
    expect(events.sort()).toEqual(["revoke-a", "revoke-b"]);
    expect(statuses).toEqual([{ cleanupFailed: true }]);
    expect(JSON.stringify(statuses)).not.toContain("private-cleanup-detail");
  });

  it("surfaces pre-phase cleanup failure categorically without primary or cleanup detail", async () => {
    const harness = successfulProbeHarness({
      firstVerificationError: new Error("private primary detail"),
      cleanupReject: true,
    });
    const reports: Array<Record<string, unknown>> = [];
    let surfaced = "";
    try {
      await withLiveCleanupCategory(async (recordCleanupStatus) => {
        await beginProbeAcceptance({
          ...harness.probeOptions,
          writeReport: async (report: Record<string, unknown>) => {
            recordLiveProbeReport(report, reports, recordCleanupStatus);
          },
        } as Parameters<typeof beginProbeAcceptance>[0]);
      });
    } catch (error) {
      surfaced = String((error as Error).message);
    }
    expect(harness.counts()).toEqual({ mcpCalls: 1, revokeCalls: 1 });
    expect(reports.at(-1)).toMatchObject({ cleanupFailed: true, pass: false });
    expect(surfaced).toBe("Secret-safe live facade acceptance failed: cleanupFailed");
    expect(surfaced).not.toMatch(/private primary|transport|access|refresh/i);
  });

  it("cleans an acquired phase when browser context close fails", async () => {
    const events: string[] = [];
    const statuses: Array<{ cleanupFailed: boolean }> = [];
    await expect(closeBrowserContextWithActiveCleanup(
      { close: async () => { throw new Error("context close failed"); } },
      { complete: async () => { events.push("revoke"); } },
      (status) => { statuses.push(status); },
    )).rejects.toThrow("context close failed");
    expect(events).toEqual(["revoke"]);
    expect(statuses).toEqual([{ cleanupFailed: false }]);
  });

  it("requires both active ordinary bearer controls immediately before mismatch rejection", async () => {
    const calls: string[] = [];
    const request = async (_url: string, init?: RequestInit) => {
      const token = String((init?.headers as Record<string, string>).authorization)
        .replace("Bearer ", "");
      calls.push(token);
      const id = JSON.parse(String(init?.body)).id;
      return token === "mismatch"
        ? jsonResponse(401)
        : jsonResponse(200, serviceStatusResponse(id));
    };
    await expect(verifyActiveBearerControlsAndMismatch({
      resource: RESOURCE,
      userAAccessToken: "ordinary-a",
      userBAccessToken: "ordinary-b",
      mismatchBearer: "mismatch",
      request,
    })).resolves.toBeUndefined();
    expect(calls).toEqual(["ordinary-a", "ordinary-b", "mismatch"]);
  });

  it("restores three-table records and sync revision after broken-RLS trigger drift", async () => {
    const original = {
      records: {
        spaces: { name: "Space B", updated_at: "2026-08-29T00:00:00Z" },
        collections: { name: "Collection B", updated_at: "2026-08-29T00:00:01Z" },
        links: { title: "Link B", updated_at: "2026-08-29T00:00:02Z" },
      },
      sync: { revision: 7, updated_at: "2026-08-29T00:00:03Z" },
    };
    let state = structuredClone(original);
    const statuses: Array<{ cleanupFailed: boolean }> = [];
    await expect(runRestorableRlsWriteCheck({
      capture: async () => structuredClone(original),
      attempt: async () => {
        state.records.spaces.updated_at = "drift-space";
        state.records.collections.updated_at = "drift-collection";
        state.records.links.updated_at = "drift-link";
        state.sync = { revision: 10, updated_at: "drift-sync" };
        throw new Error("cross-user no-op returned rows");
      },
      restore: async (baseline) => { state = structuredClone(baseline); },
      verifyRestored: async (baseline) => {
        expect(state).toEqual(baseline);
      },
      recordCleanupStatus: (status) => { statuses.push(status); },
    })).rejects.toThrow("cross-user no-op returned rows");
    expect(state).toEqual(original);
    expect(statuses).toEqual([{ cleanupFailed: false }]);
  });

  it("records every fulfilled sibling success before surfacing a mixed RLS response error", async () => {
    const evaluation = evaluateRlsUpdateSettlements([
      { status: "fulfilled", value: { error: { code: "private" }, data: null } },
      { status: "fulfilled", value: { error: null, data: [{ id: "collection-b" }] } },
      { status: "fulfilled", value: { error: null, data: [] } },
    ]);
    expect(evaluation).toEqual({
      returnedRecords: ["collection"],
      ambiguousRecords: [],
      responseFailure: true,
    });

    const baseline = {
      records: {
        space: { id: "space-b", name: "Space B", updated_at: "before" },
        collection: { id: "collection-b", name: "Collection B", updated_at: "before" },
        link: { id: "link-b", title: "Link B", updated_at: "before" },
      },
      sync: { revision: 7, updated_at: "before" },
    };
    const current = structuredClone(baseline);
    current.records.collection.updated_at = "known-write";
    current.sync = { revision: 8, updated_at: "known-write" };
    expect(planRlsRestoration({
      baseline,
      current,
      returnedRecords: evaluation.returnedRecords,
      ambiguousRecords: evaluation.ambiguousRecords,
      expectedRecords: baseline.records,
    })).toEqual({ restoreRecords: ["collection"], restoreSync: true });
  });

  it("categorizes a rejected RLS promise as ambiguous while safely identifying only attributable drift", () => {
    const evaluation = evaluateRlsUpdateSettlements([
      { status: "fulfilled", value: { error: null, data: [] } },
      { status: "fulfilled", value: { error: null, data: [] } },
      { status: "rejected", reason: new Error("private transport detail") },
    ]);
    expect(evaluation).toEqual({
      returnedRecords: [],
      ambiguousRecords: ["link"],
      responseFailure: true,
    });
    expect(JSON.stringify(evaluation)).not.toContain("private transport detail");

    const baseline = {
      records: {
        space: { id: "space-b", name: "Space B", updated_at: "before" },
        collection: { id: "collection-b", name: "Collection B", updated_at: "before" },
        link: { id: "link-b", title: "Link B", updated_at: "before" },
      },
      sync: { revision: 7, updated_at: "before" },
    };
    const attributable = structuredClone(baseline);
    attributable.records.link.updated_at = "ambiguous-write";
    attributable.sync = { revision: 8, updated_at: "ambiguous-write" };
    expect(planRlsRestoration({
      baseline,
      current: attributable,
      returnedRecords: [],
      ambiguousRecords: evaluation.ambiguousRecords,
      expectedRecords: baseline.records,
    })).toEqual({ restoreRecords: ["link"], restoreSync: true });

    const noOpApplied = structuredClone(baseline);
    noOpApplied.sync = { revision: 8, updated_at: "ambiguous-no-op" };
    expect(planRlsRestoration({
      baseline,
      current: noOpApplied,
      returnedRecords: [],
      ambiguousRecords: evaluation.ambiguousRecords,
      expectedRecords: baseline.records,
    })).toEqual({ restoreRecords: [], restoreSync: true });

    attributable.records.link.title = "concurrent operator edit";
    expect(() => planRlsRestoration({
      baseline,
      current: attributable,
      returnedRecords: [],
      ambiguousRecords: evaluation.ambiguousRecords,
      expectedRecords: baseline.records,
    })).toThrow("concurrentFixtureMutation");
  });

  it("does not overwrite a concurrent fixture mutation observed before restoration", async () => {
    const original = {
      records: {
        space: { id: "space-b", name: "Space B", updated_at: "before" },
        collection: { id: "collection-b", space_id: "space-b", name: "Collection B", updated_at: "before" },
        link: { id: "link-b", collection_id: "collection-b", title: "Link B", updated_at: "before" },
      },
      sync: { revision: 7, updated_at: "before" },
    };
    const state = structuredClone(original);
    const statuses: Array<{
      cleanupFailed: boolean;
      concurrentFixtureMutation?: boolean;
    }> = [];
    let overwriteAttempts = 0;
    await expect(runRestorableRlsWriteCheck({
      capture: async () => structuredClone(original),
      attempt: async () => {
        state.records.space.name = "concurrent operator edit";
        state.records.space.updated_at = "concurrent";
        state.sync = { revision: 11, updated_at: "concurrent" };
        throw new Error("broken RLS returned rows");
      },
      restore: async (baseline) => {
        planRlsRestoration({
          baseline,
          current: state,
          returnedRecords: ["space", "collection", "link"],
        });
        overwriteAttempts += 1;
      },
      verifyRestored: async () => undefined,
      recordCleanupStatus: (status) => { statuses.push(status); },
    })).rejects.toThrow("concurrentFixtureMutation");
    expect(overwriteAttempts).toBe(0);
    expect(state.records.space.name).toBe("concurrent operator edit");
    expect(state.sync.revision).toBe(11);
    expect(statuses).toEqual([{
      cleanupFailed: true,
      concurrentFixtureMutation: true,
    }]);
  });

  it("treats any drift after zero returned cross-user writes as concurrent", () => {
    const baseline = {
      records: {
        space: { id: "space-b", name: "Space B", updated_at: "before" },
        collection: { id: "collection-b", space_id: "space-b", updated_at: "before" },
        link: { id: "link-b", collection_id: "collection-b", updated_at: "before" },
      },
      sync: { revision: 7, updated_at: "before" },
    };
    const current = structuredClone(baseline);
    current.records.link.updated_at = "unexpected";
    expect(() => planRlsRestoration({
      baseline,
      current,
      returnedRecords: [],
    })).toThrow("concurrentFixtureMutation");
  });

  it("does not overwrite or roll back a concurrent mutation between read and restore", async () => {
    const original = {
      records: {
        space: { id: "space-b", name: "Space B", updated_at: "before" },
        collection: { id: "collection-b", space_id: "space-b", name: "Collection B", updated_at: "before" },
        link: { id: "link-b", collection_id: "collection-b", title: "Link B", updated_at: "before" },
      },
      sync: { revision: 7, updated_at: "before" },
    };
    const state = structuredClone(original);
    const statuses: Array<{
      cleanupFailed: boolean;
      concurrentFixtureMutation?: boolean;
    }> = [];
    await expect(runRestorableRlsWriteCheck({
      capture: async () => structuredClone(original),
      attempt: async () => {
        state.records.space.updated_at = "test-space";
        state.records.collection.updated_at = "test-collection";
        state.records.link.updated_at = "test-link";
        state.sync = { revision: 10, updated_at: "test-sync" };
        throw new Error("broken RLS returned rows");
      },
      restore: async (baseline) => {
        const observed = structuredClone(state);
        planRlsRestoration({
          baseline,
          current: observed,
          returnedRecords: ["space", "collection", "link"],
        });
        state.records.space.name = "concurrent operator edit";
        state.records.space.updated_at = "concurrent";
        state.sync = { revision: 11, updated_at: "concurrent" };
        requireOptimisticRestorationRow({ error: null, data: [] }, "Space");
        state.records.space = structuredClone(baseline.records.space);
        state.sync = structuredClone(baseline.sync);
      },
      verifyRestored: async () => undefined,
      recordCleanupStatus: (status) => { statuses.push(status); },
    })).rejects.toThrow("concurrentFixtureMutation");
    expect(state.records.space.name).toBe("concurrent operator edit");
    expect(state.sync.revision).toBe(11);
    expect(statuses).toEqual([{
      cleanupFailed: true,
      concurrentFixtureMutation: true,
    }]);
  });

  it("settles both grants even when RLS restoration aborts on concurrency", async () => {
    const events: string[] = [];
    const baseline = {
      records: {
        space: { id: "space-b", name: "Space B", updated_at: "before" },
        collection: { id: "collection-b", space_id: "space-b", updated_at: "before" },
        link: { id: "link-b", collection_id: "collection-b", updated_at: "before" },
      },
      sync: { revision: 7, updated_at: "before" },
    };
    await expect(withLiveCleanupCategory(async (recordCleanupStatus) => {
      await completeLiveAcceptancePhases([
        { complete: async () => { events.push("revoke-a"); } },
        { complete: async () => { events.push("revoke-b"); } },
      ], async () => {
        await runRestorableRlsWriteCheck({
          capture: async () => structuredClone(baseline),
          attempt: async () => undefined,
          restore: async (captured) => {
            const current = structuredClone(captured);
            current.records.space.name = "concurrent operator edit";
            planRlsRestoration({
              baseline: captured,
              current,
              returnedRecords: [],
            });
          },
          verifyRestored: async () => undefined,
          recordCleanupStatus,
        });
      }, recordCleanupStatus);
    })).rejects.toThrow(
      "Secret-safe live facade acceptance failed: concurrentFixtureMutation",
    );
    expect(events.sort()).toEqual(["revoke-a", "revoke-b"]);
  });

  it("loads only private regular JSON fixture and storage-state files outside the repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-live-fixture-"));
    const fixturePath = join(directory, "fixture.json");
    const fixture = validFixture(directory);
    try {
      for (const user of fixture.users) {
        await writeFile(
          user.storageStatePath,
          JSON.stringify({ cookies: [], origins: [] }),
          { mode: 0o600 },
        );
      }
      await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o644 });
      await expect(loadLiveAcceptanceFixture(fixturePath, {
        repositoryRoot: resolve("."),
      })).rejects.toThrow();
      await chmod(fixturePath, 0o600);
      const loaded = await loadLiveAcceptanceFixture(fixturePath, {
        repositoryRoot: resolve("."),
      });
      expect(loaded).toMatchObject({ version: 1, resource: fixture.resource });
      expect(loaded.users.map((user) => user.storageState)).toEqual([
        { cookies: [], origins: [] },
        { cookies: [], origins: [] },
      ]);
      expect(loaded.users.some((user) => "storageStatePath" in user)).toBe(false);
      await writeFile(fixture.users[0]!.storageStatePath, JSON.stringify({
        cookies: [{
          name: "session",
          value: "private",
          domain: ".example.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          executable: "not part of the audited data schema",
        }],
        origins: [],
      }), { mode: 0o600 });
      await expect(loadLiveAcceptanceFixture(fixturePath, {
        repositoryRoot: resolve("."),
      })).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects storage-state aliases that resolve to the same file identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-live-alias-"));
    const fixturePath = join(directory, "fixture.json");
    const fixture = validFixture(directory);
    try {
      await writeFile(
        fixture.users[0]!.storageStatePath,
        JSON.stringify({ cookies: [], origins: [] }),
        { mode: 0o600 },
      );
      await link(
        fixture.users[0]!.storageStatePath,
        fixture.users[1]!.storageStatePath,
      );
      await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
      await expect(loadLiveAcceptanceFixture(fixturePath, {
        repositoryRoot: resolve("."),
      })).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
