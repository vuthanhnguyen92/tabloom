import { SignJWT, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

const RESOURCE = "https://mcp.tabloom.app";
const ISSUER = "https://example.supabase.co/auth/v1";

function useValidEnvironment() {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "test-anon-key");
  vi.stubEnv("TABLOOM_MCP_RESOURCE_URL", RESOURCE);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("MCP OAuth discovery", () => {
  it("publishes the exact canonical resource and Supabase authorization server", async () => {
    useValidEnvironment();
    const route = await import(
      "../../services/tabloom-mcp/app/.well-known/oauth-protected-resource/route"
    );

    const response = route.GET(
      new Request(`${RESOURCE}/.well-known/oauth-protected-resource`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(response.json()).resolves.toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
    });

    const optionsResponse = route.OPTIONS();
    expect(optionsResponse.status).toBe(200);
    expect(optionsResponse.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
  });

  it("uses the same canonical resource in authentication challenges", async () => {
    useValidEnvironment();
    const route = await import(
      "../../services/tabloom-mcp/app/api/mcp/route"
    );

    const response = await route.GET(
      new Request(`${RESOURCE}/api/mcp`, { method: "GET" }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata=\"${RESOURCE}/.well-known/oauth-protected-resource\"`,
    );
    expect(route.POST).toBeTypeOf("function");
    expect("DELETE" in route).toBe(false);
  });

  it("reuses one remote JWKS resolver across authenticated requests", async () => {
    useValidEnvironment();
    const fetchJwks = vi.fn(async () =>
      Response.json({ keys: [] }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchJwks);
    const { privateKey } = await generateKeyPair("ES256");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: ISSUER,
      aud: RESOURCE,
      sub: "2f1c5393-46b8-4d79-a12b-b4624b1bc54c",
      client_id: "tabloom-test-client",
      exp: now + 3600,
    })
      .setProtectedHeader({ alg: "ES256", kid: "unknown-key" })
      .sign(privateKey);
    const route = await import(
      "../../services/tabloom-mcp/app/api/mcp/route"
    );
    const request = (method: "GET" | "POST") =>
      new Request(`${RESOURCE}/api/mcp`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });

    const first = await route.GET(request("GET"));
    const second = await route.POST(request("POST"));

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    expect(fetchJwks.mock.calls[0]?.[0]).toBe(
      "https://example.supabase.co/auth/v1/.well-known/jwks.json",
    );
  });
});
