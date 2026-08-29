import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { loadMcpAuthConfig } from "../../../src/auth/config";
import { createTokenVerifier } from "../../../src/auth/verify-token";

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "get_service_status",
      {
        title: "Get service status",
        description: "Report whether the Tabloom MCP service is available.",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ service: "tabloom-mcp", status: "ok" }),
          },
        ],
        structuredContent: { service: "tabloom-mcp", status: "ok" },
      }),
    );
  },
  {
    serverInfo: { name: "tabloom-mcp", version: "0.1.0" },
  },
);

async function authenticatedHandler(request: Request): Promise<Response> {
  const config = loadMcpAuthConfig(process.env);
  return withMcpAuth(handler, createTokenVerifier(config), {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource",
    resourceUrl: config.resourceUrl.origin,
  })(request);
}

export { authenticatedHandler as GET, authenticatedHandler as POST };
