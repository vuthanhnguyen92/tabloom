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
});
