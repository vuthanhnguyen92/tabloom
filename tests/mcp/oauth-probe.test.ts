import { describe, expect, it } from "vitest";
import {
  evaluateAudience,
  evaluateDiscovery,
  redactTokenResult,
} from "../../scripts/probe-mcp-oauth.mjs";

const RESOURCE = "https://tabloom-mcp.example.com";
const ISSUER = "https://tctjlsvfufzxhauhywsm.supabase.co/auth/v1";

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
});
