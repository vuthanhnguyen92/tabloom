import { describe, expect, it } from "vitest";

import {
  resolveClient,
  validateCimdClientMetadata,
  validateDcrClientMetadata,
} from "../../services/tabloom-mcp/src/oauth/client-metadata";
import type { OAuthPersistence, StoredPublicClient } from "../../services/tabloom-mcp/src/oauth/persistence";

const validRegistration = {
  client_name: "Example MCP Client",
  redirect_uris: ["https://client.example/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

function persistenceWith(client: StoredPublicClient | null): OAuthPersistence {
  return {
    async getClient() { return client; },
    async registerClient() { throw new Error("not used"); },
    async consume() { throw new Error("not used"); },
    async revokeGrant() { throw new Error("not used"); },
    async isGrantRevoked() { throw new Error("not used"); },
  };
}

describe("public OAuth client metadata", () => {
  it("accepts only the exact public authorization-code registration shape", () => {
    expect(validateDcrClientMetadata(validRegistration)).toEqual({
      clientName: "Example MCP Client",
      redirectUris: ["https://client.example/callback"],
    });
    expect(validateDcrClientMetadata({
      ...validRegistration,
      grant_types: ["authorization_code"],
    })).toEqual({
      clientName: "Example MCP Client",
      redirectUris: ["https://client.example/callback"],
    });
    expect(validateDcrClientMetadata({
      ...validRegistration,
      grant_types: ["refresh_token", "authorization_code"],
    })).toEqual({
      clientName: "Example MCP Client",
      redirectUris: ["https://client.example/callback"],
    });
  });

  it.each([
    ["missing required key", {
      redirect_uris: validRegistration.redirect_uris,
      grant_types: validRegistration.grant_types,
      response_types: validRegistration.response_types,
      token_endpoint_auth_method: validRegistration.token_endpoint_auth_method,
    }],
    ["unknown key", { ...validRegistration, logo_uri: "https://client.example/logo.png" }],
    ["client secret", { ...validRegistration, client_secret: "secret" }],
    ["JWKS", { ...validRegistration, jwks: { keys: [] } }],
    ["JWKS URI", { ...validRegistration, jwks_uri: "https://client.example/jwks" }],
    ["software statement", { ...validRegistration, software_statement: "signed" }],
    ["private authentication", { ...validRegistration, token_endpoint_auth_method: "client_secret_basic" }],
    ["implicit grant", { ...validRegistration, grant_types: ["implicit"] }],
    ["missing authorization-code grant", { ...validRegistration, grant_types: ["refresh_token"] }],
    ["duplicate grant", { ...validRegistration, grant_types: ["authorization_code", "authorization_code"] }],
    ["token response", { ...validRegistration, response_types: ["token"] }],
  ])("rejects %s", (_label, metadata) => {
    expect(() => validateDcrClientMetadata(metadata)).toThrow();
  });

  it("preserves exact client names and counts PostgreSQL Unicode characters", () => {
    const decomposedName = "Cafe\u0301 Client";
    const fourHundredByteName = "😀".repeat(100);

    expect(validateDcrClientMetadata({
      ...validRegistration,
      client_name: decomposedName,
    }).clientName).toBe(decomposedName);
    expect(validateDcrClientMetadata({
      ...validRegistration,
      client_name: fourHundredByteName,
    }).clientName).toBe(fourHundredByteName);
  });

  it.each([
    ["empty", ""],
    ["only whitespace", "   "],
    ["leading whitespace", " Example"],
    ["trailing whitespace", "Example "],
    ["more than 100 Unicode characters", `${"😀".repeat(100)}x`],
    ["control character", "bad\u0000name"],
  ])("rejects a %s client name", (_label, clientName) => {
    expect(() => validateDcrClientMetadata({
      ...validRegistration,
      client_name: clientName,
    })).toThrow();
  });

  it("accepts HTTPS and literal-IP loopback HTTP redirect URIs", () => {
    const exactRedirect = "https://CLIENT.example:00443/%2f?value=%41";
    expect(validateDcrClientMetadata({
      ...validRegistration,
      redirect_uris: [
        exactRedirect,
        "http://127.0.0.1:49152/callback",
        "http://[::1]:49152/callback",
      ],
    }).redirectUris).toEqual([
      exactRedirect,
      "http://127.0.0.1:49152/callback",
      "http://[::1]:49152/callback",
    ]);
  });

  it("accepts a redirect at the exact 2048-byte boundary", () => {
    const redirectUri = "https://client.example/".padEnd(2048, "a");

    expect(Buffer.byteLength(redirectUri, "utf8")).toBe(2048);
    expect(validateDcrClientMetadata({
      ...validRegistration,
      redirect_uris: [redirectUri],
    }).redirectUris).toEqual([redirectUri]);
  });

  it.each([
    "",
    "http://localhost/callback",
    "http://127.0.0.2/callback",
    "https://user:password@client.example/callback",
    "https://client.example/callback#fragment",
    "https://client.example/callback#",
    " https://client.example/callback",
    "https://client.exa\tmple/callback",
    "https://client.example/call\nback",
    "https://client.example/callback\n",
    "https://*.client.example/callback",
    "https://client.example/call*back",
    "https://client.example:/callback",
    "https://client.example:0/callback",
    "https://client.example:65536/callback",
    "https://client.example:123456/callback",
    "https://client.example:443:444/callback",
    "https://-client.example/callback",
    "https://client.example-/callback",
    "https://client_example/callback",
    "https://K.example/callback",
    "https://[1::2::3]/callback",
    "https://[::1/callback",
    "https:///callback",
  ])("rejects unsafe redirect URI %s", (redirectUri) => {
    expect(() => validateDcrClientMetadata({
      ...validRegistration,
      redirect_uris: [redirectUri],
    })).toThrow();
  });

  it.each([
    "http://127.1/callback",
    "http://2130706433/callback",
    "http://0x7f000001/callback",
    "http://0177.0.0.1/callback",
    "http://[0:0:0:0:0:0:0:1]/callback",
  ])("rejects non-literal loopback spelling %s", (redirectUri) => {
    expect(() => validateDcrClientMetadata({
      ...validRegistration,
      redirect_uris: [redirectUri],
    })).toThrow();
  });

  it("requires between one and ten unique exact redirect URIs", () => {
    expect(() => validateDcrClientMetadata({ ...validRegistration, redirect_uris: [] })).toThrow();
    expect(() => validateDcrClientMetadata({
      ...validRegistration,
      redirect_uris: Array.from({ length: 11 }, (_, index) => `https://client.example/${index}`),
    })).toThrow();
    expect(() => validateDcrClientMetadata({
      ...validRegistration,
      redirect_uris: ["https://client.example/callback", "https://client.example/callback"],
    })).toThrow();
  });

  it("rejects a redirect URI at 2049 UTF-8 bytes", () => {
    const redirectUri = "https://client.example/".padEnd(2049, "a");

    expect(Buffer.byteLength(redirectUri, "utf8")).toBe(2049);
    expect(() => validateDcrClientMetadata({
      ...validRegistration,
      redirect_uris: [redirectUri],
    })).toThrow();
  });

  it("rejects a multibyte redirect below 2048 JavaScript units but over 2048 UTF-8 bytes", () => {
    const redirectUri = `https://client.example/${"😀".repeat(600)}`;

    expect(redirectUri.length).toBeLessThan(2048);
    expect(Buffer.byteLength(redirectUri, "utf8")).toBeGreaterThan(2048);
    expect(() => validateDcrClientMetadata({
      ...validRegistration,
      redirect_uris: [redirectUri],
    })).toThrow();
  });

  it("validates CIMD metadata against its exact URL identity", () => {
    const clientId = "https://client.example/oauth/client.json";
    expect(validateCimdClientMetadata({ client_id: clientId, ...validRegistration }, clientId)).toEqual({
      clientId,
      clientName: "Example MCP Client",
      redirectUris: ["https://client.example/callback"],
      source: "cimd",
    });
    expect(() => validateCimdClientMetadata({
      client_id: "https://client.example/oauth/other.json",
      ...validRegistration,
    }, clientId)).toThrow();
  });
});

describe("client resolution", () => {
  const stored: StoredPublicClient = {
    clientId: "5c177e69-8954-4c57-a777-07c732513bea",
    clientName: "Stored Client",
    redirectUris: ["https://client.example/callback"],
    createdAt: "2026-08-29T00:00:00.000Z",
    expiresAt: "2026-08-30T00:00:00.000Z",
  };

  it("classifies a syntactically invalid identifier as an invalid client", async () => {
    await expect(resolveClient("not-a-client", persistenceWith(null)))
      .rejects.toMatchObject({ name: "InvalidOAuthClientError" });
  });

  it("resolves an opaque UUID only through persistence", async () => {
    await expect(resolveClient(stored.clientId, persistenceWith(stored), {
      fetchCimd: async () => { throw new Error("must not fetch"); },
      now: () => new Date("2026-08-29T01:00:00.000Z"),
    })).resolves.toEqual({
      clientId: stored.clientId,
      clientName: "Stored Client",
      redirectUris: ["https://client.example/callback"],
      source: "dcr",
    });
  });

  it("rejects unknown and expired DCR clients", async () => {
    await expect(resolveClient(stored.clientId, persistenceWith(null))).rejects.toThrow();
    await expect(resolveClient(stored.clientId, persistenceWith({
      ...stored,
      expiresAt: "2026-08-29T00:59:59.000Z",
    }), { now: () => new Date("2026-08-29T01:00:00.000Z") })).rejects.toThrow();
    await expect(resolveClient(stored.clientId, persistenceWith({
      ...stored,
      expiresAt: "not-a-date",
    }))).rejects.toThrow();
  });

  it("resolves an exact HTTPS client id through CIMD", async () => {
    const clientId = "https://client.example/oauth/client.json";
    const cimdClient = {
      clientId,
      clientName: "CIMD Client",
      redirectUris: ["https://client.example/callback"],
      source: "cimd" as const,
    };
    await expect(resolveClient(clientId, persistenceWith(null), {
      fetchCimd: async (requested) => requested === clientId ? cimdClient : Promise.reject(new Error("wrong id")),
    })).resolves.toEqual(cimdClient);
  });

  it.each([
    "not-a-client",
    "ftp://client.example/metadata.json",
    "http://client.example/metadata.json",
    "https://user@client.example/metadata.json",
    "https://client.example/metadata.json#fragment",
    "https://client.example/metadata.json#",
    " https://client.example/metadata.json",
  ])("rejects unsupported client id %s", async (clientId) => {
    await expect(resolveClient(clientId, persistenceWith(null), {
      fetchCimd: async () => { throw new Error("must not fetch invalid identifiers"); },
    })).rejects.toThrow();
  });
});
