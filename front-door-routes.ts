export type TabloomFrontDoorRewrite = {
  source: string;
  destination: string;
};

const PUBLIC_ORIGIN = "https://tabloom.nickvu.dev";

export function createTabloomFrontDoorRewrites(
  env: { TABLOOM_MCP_UPSTREAM_ORIGIN?: string },
): TabloomFrontDoorRewrite[] {
  const value = env.TABLOOM_MCP_UPSTREAM_ORIGIN?.trim();
  if (!value) {
    throw new Error("TABLOOM_MCP_UPSTREAM_ORIGIN is required");
  }

  const upstream = new URL(value);
  const isPathless = upstream.pathname === "/";
  if (
    upstream.protocol !== "https:"
    || !isPathless
    || upstream.username
    || upstream.password
    || upstream.search
    || upstream.hash
  ) {
    throw new Error("TABLOOM_MCP_UPSTREAM_ORIGIN must be a pathless HTTPS origin");
  }

  if (upstream.origin === PUBLIC_ORIGIN) {
    throw new Error("TABLOOM_MCP_UPSTREAM_ORIGIN cannot point back to the public Tabloom origin");
  }

  return [
    { source: "/mcp", destination: `${upstream.origin}/api/mcp` },
    { source: "/mcp/health", destination: `${upstream.origin}/api/health` },
    { source: "/oauth/:path*", destination: `${upstream.origin}/oauth/:path*` },
    { source: "/.well-known/:path*", destination: `${upstream.origin}/.well-known/:path*` },
  ];
}
