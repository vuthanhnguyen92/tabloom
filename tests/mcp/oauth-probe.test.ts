import { createPrivateKey } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  buildDynamicClientRegistration,
  classifyHttpStatus,
  createCallbackListener,
  derivePkceChallenge,
  evaluateDiscovery,
  parseOAuthCallback,
  runCli,
  runProbe,
  writeReport,
} from "../../scripts/probe-mcp-oauth.mjs";
import {
  generateOAuthKeys,
  runKeyGeneratorCli,
} from "../../services/tabloom-mcp/scripts/generate-oauth-keys.mjs";

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
  scopes_supported: [SCOPE],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
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
  "mcpBeforeRevocationResult",
  "revocationResult",
  "mcpAfterRevocationResult",
  "revocationEnforced",
  "pass",
];

function jsonResponse(status: number, body: Record<string, unknown> = {}) {
  return { status, body };
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

  it("runs discovery through post-revocation rejection with a strict redacted report", async () => {
    const authorizationCode = "private-authorization-code";
    const verifier = "private-pkce-verifier";
    const firstAccessToken = "private-first-access-token";
    const firstRefreshToken = "private-first-refresh-token";
    const rotatedAccessToken = "private-rotated-access-token";
    const rotatedRefreshToken = "private-rotated-refresh-token";
    const reports: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let handoffUrl = "";

    const request = async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return jsonResponse(200, PROTECTED_RESOURCE);
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse(200, AUTHORIZATION_SERVER);
      }
      if (url.endsWith("/oauth/register")) {
        return jsonResponse(201, { client_id: "public-client" });
      }
      if (url.endsWith("/oauth/token")) {
        const form = new URLSearchParams(String(init?.body));
        return form.get("grant_type") === "authorization_code"
          ? jsonResponse(200, {
            access_token: firstAccessToken,
            refresh_token: firstRefreshToken,
          })
          : jsonResponse(200, {
            access_token: rotatedAccessToken,
            refresh_token: rotatedRefreshToken,
          });
      }
      if (url.endsWith("/oauth/revoke")) return jsonResponse(200);
      if (url.endsWith("/api/mcp")) {
        return jsonResponse(
          requests.filter((entry) => entry.url.endsWith("/api/mcp")).length === 1
            ? 200
            : 401,
        );
      }
      throw new Error("Unexpected request");
    };

    await runProbe({
      env: { NODE_ENV: "test", TABLOOM_MCP_RESOURCE_URL: RESOURCE },
      request,
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
      writeReport: async (report) => { reports.push(report); },
      log: (message) => { logs.push(message); },
    });

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
    ]);
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
    const request = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/.well-known/oauth-protected-resource")) return jsonResponse(200, PROTECTED_RESOURCE);
      if (url.endsWith("/.well-known/oauth-authorization-server")) return jsonResponse(200, AUTHORIZATION_SERVER);
      if (url.endsWith("/oauth/register")) return jsonResponse(201, { client_id: "public-client" });
      if (url.endsWith("/oauth/token")) {
        const refresh = new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token";
        return jsonResponse(200, {
          access_token: refresh ? "rotated-access" : "first-access",
          refresh_token: refresh ? "rotated-refresh" : "first-refresh",
        });
      }
      if (url.endsWith("/oauth/revoke")) return jsonResponse(200);
      if (url.endsWith("/api/mcp")) {
        mcpCalls += 1;
        return jsonResponse(200);
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
      writeReport: async (report) => { reports.push(report); },
      log: () => undefined,
    })).rejects.toThrow("readiness gate");
    expect(mcpCalls).toBe(2);
    expect(reports.at(-1)).toMatchObject({
      revocationEnforced: false,
      mcpAfterRevocationResult: "success",
      pass: false,
    });
    expect(Object.keys(reports.at(-1)!)).toEqual(REPORT_KEYS);
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
    const report = { pass: false, access_token: "private-access-token" };
    try {
      await writeFile(path, "loose", { mode: 0o644 });
      await chmod(path, 0o644);
      await writeReport(report, path);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const written = JSON.parse(await readFile(path, "utf8"));
      expect(Object.keys(written)).toEqual(REPORT_KEYS);
      expect(JSON.stringify(written)).not.toContain("private-access-token");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("OAuth facade key generator", () => {
  it("writes one active ES256 private JWK and one 32-byte root only to explicit external files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-keys-"));
    const signingPath = join(directory, "signing.json");
    const encryptionPath = join(directory, "encryption.json");
    try {
      await generateOAuthKeys({
        signingPath,
        encryptionPath,
        repositoryRoot: resolve("."),
      });
      const signing = JSON.parse(await readFile(signingPath, "utf8"));
      const encryption = JSON.parse(await readFile(encryptionPath, "utf8"));
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
      expect((await stat(signingPath)).mode & 0o777).toBe(0o600);
      expect((await stat(encryptionPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses stdout, repository paths, existing files, and symlink targets without replacing anything", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-keys-"));
    const existing = join(directory, "existing.json");
    const symlinkPath = join(directory, "linked.json");
    const other = join(directory, "other.json");
    await writeFile(existing, "keep", { mode: 0o600 });
    await symlink(existing, symlinkPath);
    try {
      await expect(generateOAuthKeys({ signingPath: "-", encryptionPath: other, repositoryRoot: resolve(".") })).rejects.toThrow();
      await expect(generateOAuthKeys({ signingPath: resolve("generated-signing.json"), encryptionPath: other, repositoryRoot: resolve(".") })).rejects.toThrow();
      await expect(generateOAuthKeys({ signingPath: existing, encryptionPath: other, repositoryRoot: resolve(".") })).rejects.toThrow();
      await expect(generateOAuthKeys({ signingPath: symlinkPath, encryptionPath: other, repositoryRoot: resolve(".") })).rejects.toThrow();
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
});
