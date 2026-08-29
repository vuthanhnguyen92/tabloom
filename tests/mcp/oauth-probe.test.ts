import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  buildDynamicClientRegistration,
  createCallbackListener,
  derivePkceChallenge,
  evaluateAudience,
  evaluateDiscovery,
  parseOAuthCallback,
  redactTokenResult,
  runCli,
  runProbe,
  writeReport,
} from "../../scripts/probe-mcp-oauth.mjs";

const RESOURCE = "https://tabloom-mcp.example.com";
const ISSUER = "https://tctjlsvfufzxhauhywsm.supabase.co/auth/v1";
const CALLBACK_URL = "http://127.0.0.1:54321/callback";

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  code_challenge_methods_supported: ["S256"],
};

describe("MCP OAuth readiness probe", () => {
  it("passes only when the MCP resource is in the token audience", () => {
    expect(evaluateAudience(["authenticated", RESOURCE], RESOURCE)).toEqual({
      pass: true,
    });
    expect(evaluateAudience("authenticated", RESOURCE)).toEqual({
      pass: false,
      reason: "resource_audience_missing",
    });
  });

  it("requires the OAuth endpoints and PKCE S256 support", () => {
    expect(
      evaluateDiscovery(
        {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          registration_endpoint: `${ISSUER}/register`,
          code_challenge_methods_supported: ["S256"],
        },
        ISSUER,
      ),
    ).toEqual({
      discoverySupported: true,
      issuer: ISSUER,
      issuerMatch: true,
    });

    expect(
      evaluateDiscovery(
        {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          registration_endpoint: `${ISSUER}/register`,
          code_challenge_methods_supported: ["plain"],
        },
        ISSUER,
      ),
    ).toEqual({
      discoverySupported: false,
      issuer: ISSUER,
      issuerMatch: true,
    });
  });

  it("registers a public authorization-code client with no token endpoint authentication", () => {
    expect(buildDynamicClientRegistration(CALLBACK_URL)).toEqual({
      client_name: "Tabloom MCP OAuth readiness probe",
      redirect_uris: [CALLBACK_URL],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("derives the RFC 7636 S256 challenge from the verifier", () => {
    expect(
      derivePkceChallenge(
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      ),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("binds the exact MCP resource into the authorization request", () => {
    const authorizationUrl = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: `${ISSUER}/authorize`,
        clientId: "public-client",
        callbackUrl: CALLBACK_URL,
        state: "csrf-state",
        challenge: "pkce-challenge",
        resource: RESOURCE,
      }),
    );

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      `${ISSUER}/authorize`,
    );
    expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual({
      response_type: "code",
      client_id: "public-client",
      redirect_uri: CALLBACK_URL,
      state: "csrf-state",
      code_challenge: "pkce-challenge",
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "email",
    });
  });

  it("rejects malformed and state-mismatched callbacks before reporting success", () => {
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
    expect(parseOAuthCallback("/callback?state=expected-state", "expected-state"))
      .toEqual({
        status: 400,
        body: "OAuth callback did not include an authorization code.",
        terminal: true,
        error: "OAuth callback did not include a code",
      });
    expect(
      parseOAuthCallback(
        "/callback?state=expected-state&error=access_denied&code=stray-code",
        "expected-state",
      ),
    ).toEqual({
      status: 400,
      body: "OAuth authorization was not approved.",
      terminal: true,
      error: "OAuth authorization was not approved",
    });
  });

  it("ignores a stray wrong-state request and resolves only a valid callback", async () => {
    const listener = await createCallbackListener("expected-state");
    let callbackStatus = "pending";
    void listener.callback.then(
      () => { callbackStatus = "resolved"; },
      () => { callbackStatus = "rejected"; },
    );

    try {
      const strayResponse = await fetch(
        `${listener.callbackUrl}?state=wrong-state&code=stray-code`,
      );
      expect(strayResponse.status).toBe(400);
      expect(await strayResponse.text()).toBe("Invalid OAuth callback.");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(callbackStatus).toBe("pending");

      const validResponse = await fetch(
        `${listener.callbackUrl}?state=expected-state&code=approved-code`,
      );
      expect(validResponse.status).toBe(200);
      await expect(listener.callback).resolves.toBe("approved-code");
    } finally {
      await listener.close();
    }
  });

  it("redacts a verified token result to allowlisted readiness fields", () => {
    const report = redactTokenResult({
      protectedHeader: { alg: "ES256", kid: "signing-key" },
      payload: {
        iss: ISSUER,
        aud: ["authenticated", RESOURCE],
        sub: "9a5a1ff4-493a-4da0-9c1f-d31e814d13cb",
        client_id: "public-client",
        email: "person@example.com",
        role: "authenticated",
      },
      tokenResponse: {
        access_token: "secret-access-token",
        refresh_token: "secret-refresh-token",
        token_type: "bearer",
      },
      expectedIssuer: ISSUER,
      expectedResource: RESOURCE,
      discovery: {
        discoverySupported: true,
        issuer: ISSUER,
        issuerMatch: true,
      },
    });

    expect(report).toEqual({
      discoverySupported: true,
      issuer: ISSUER,
      issuerMatch: true,
      algorithm: "ES256",
      audience: ["authenticated", RESOURCE],
      audienceMatch: true,
      subjectPresent: true,
      clientPresent: true,
      pass: true,
    });
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(JSON.stringify(report)).not.toContain("person@example.com");
    expect(Object.keys(report)).toEqual([
      "discoverySupported",
      "issuer",
      "issuerMatch",
      "algorithm",
      "audience",
      "audienceMatch",
      "subjectPresent",
      "clientPresent",
      "pass",
    ]);
  });

  it("runs the failing gate deterministically without leaking transient secrets", async () => {
    const reports: Array<Record<string, unknown>> = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const authorizationCode = "private-authorization-code";
    const verifier = "private-pkce-verifier";
    const accessToken = "private-access-token";
    const refreshToken = "private-refresh-token";

    const exitCode = await runCli({
      run: () => runProbe({
        env: {
          NODE_ENV: "test",
          SUPABASE_URL: "https://tctjlsvfufzxhauhywsm.supabase.co",
          TABLOOM_MCP_RESOURCE_URL: RESOURCE,
        },
        fetchDiscovery: async () => DISCOVERY,
        requestJson: async (_url, _init, label) => {
          if (label === "Dynamic client registration") {
            return { client_id: "public-client" };
          }
          if (label === "OAuth token exchange") {
            return {
              access_token: accessToken,
              refresh_token: refreshToken,
            };
          }
          throw new Error("Unexpected request");
        },
        createPkce: () => ({
          state: "public-state",
          verifier,
          challenge: "public-challenge",
        }),
        createCallbackListener: async () => ({
          callback: Promise.resolve(authorizationCode),
          callbackUrl: CALLBACK_URL,
          close: async () => undefined,
        }),
        openAuthorizationUrl: () => undefined,
        verifyAccessToken: async () => ({
          key: {} as CryptoKey,
          protectedHeader: { alg: "ES256" },
          payload: {
            iss: ISSUER,
            aud: ["authenticated"],
            sub: "private-user-id",
            client_id: "public-client",
            email: "private-person@example.com",
          },
        }),
        writeReport: async (report) => { reports.push(report); },
        log: (message) => { stdout.push(message); },
      }),
      error: (message) => { stderr.push(message); },
    });

    expect(exitCode).toBe(1);
    expect(reports.at(-1)).toEqual({
      discoverySupported: true,
      issuer: ISSUER,
      issuerMatch: true,
      algorithm: "ES256",
      audience: ["authenticated"],
      audienceMatch: false,
      subjectPresent: true,
      clientPresent: true,
      pass: false,
    });
    const observableOutput = JSON.stringify({ stdout, stderr, reports });
    for (const privateValue of [
      authorizationCode,
      verifier,
      accessToken,
      refreshToken,
      "private-user-id",
      "private-person@example.com",
    ]) {
      expect(observableOutput).not.toContain(privateValue);
    }
  });

  it("returns a nonzero result without echoing unexpected error details", async () => {
    const stderr: string[] = [];

    const exitCode = await runCli({
      run: async () => { throw new Error("private-refresh-token"); },
      error: (message) => { stderr.push(message); },
    });

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([
      "OAuth readiness gate failed. See the redacted report for details.",
    ]);
    expect(stderr.join("\n")).not.toContain("private-refresh-token");
  });

  it("writes the redacted report with mode 0600 even when replacing a loose file", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "tabloom-oauth-probe-"),
    );
    const reportPath = join(temporaryDirectory, "readiness.json");
    const report = {
      discoverySupported: false,
      issuer: ISSUER,
      issuerMatch: false,
      algorithm: "",
      audience: [],
      audienceMatch: false,
      subjectPresent: false,
      clientPresent: false,
      pass: false,
    };

    try {
      await writeFile(reportPath, "loose", { mode: 0o644 });
      await chmod(reportPath, 0o644);
      await writeReport(report, reportPath);

      expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
