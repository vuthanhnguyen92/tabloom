import { describe, expect, it } from "vitest";

import { createTabloomFrontDoorRewrites } from "../front-door-routes";

describe("Tabloom Vercel front-door routing", () => {
  it("maps the public MCP, health, OAuth, and discovery paths to the private service origin", () => {
    expect(createTabloomFrontDoorRewrites({
      TABLOOM_MCP_UPSTREAM_ORIGIN: "https://tabloom-mcp-production.vercel.app",
    })).toEqual([
      { source: "/mcp", destination: "https://tabloom-mcp-production.vercel.app/api/mcp" },
      { source: "/mcp/health", destination: "https://tabloom-mcp-production.vercel.app/api/health" },
      { source: "/oauth/:path*", destination: "https://tabloom-mcp-production.vercel.app/oauth/:path*" },
      { source: "/.well-known/:path*", destination: "https://tabloom-mcp-production.vercel.app/.well-known/:path*" },
    ]);
  });

  it.each([
    ["missing upstream", undefined],
    ["non-HTTPS upstream", "http://tabloom-mcp-production.vercel.app"],
    ["upstream path", "https://tabloom-mcp-production.vercel.app/service"],
    ["public-domain loop", "https://tabloom.nickvu.dev"],
  ])("rejects %s", (_label, upstream) => {
    expect(() => createTabloomFrontDoorRewrites({
      TABLOOM_MCP_UPSTREAM_ORIGIN: upstream,
    })).toThrow();
  });
});
