import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { loadFacadeAuthConfig } from "../../../src/auth/config";
import { createTokenVerifier } from "../../../src/auth/verify-token";
import { oauthError, oauthJson } from "../../../src/oauth/responses";

export function serviceStatusResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ service: "tabloom-mcp", status: "ok" }),
      },
    ],
    structuredContent: { service: "tabloom-mcp", status: "ok" },
  };
}

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
      async () => serviceStatusResult(),
    );
  },
  {
    serverInfo: { name: "tabloom-mcp", version: "0.1.0" },
  },
);

type AuthenticatedHandler = ReturnType<typeof withMcpAuth>;

let cachedAuthenticatedHandler: AuthenticatedHandler | undefined;

function getAuthenticatedHandler(): AuthenticatedHandler | undefined {
  if (cachedAuthenticatedHandler) {
    return cachedAuthenticatedHandler;
  }

  const config = loadFacadeAuthConfig(process.env);
  if (!config.oauthEnabled) return undefined;
  const verifier = createTokenVerifier(config);
  const authenticatedHandler = withMcpAuth(handler, verifier, {
    required: true,
    requiredScopes: ["tabloom:workspace"],
    resourceMetadataPath: "/.well-known/oauth-protected-resource",
    resourceUrl: config.resourceUrl.origin,
  });

  cachedAuthenticatedHandler = authenticatedHandler;
  return authenticatedHandler;
}

async function routeHandler(request: Request): Promise<Response> {
  try {
    const authenticatedHandler = getAuthenticatedHandler();
    if (!authenticatedHandler) {
      return oauthJson({ error: "temporarily_unavailable" }, 503);
    }
    return authenticatedHandler(request);
  } catch {
    return oauthError("server_error", 500);
  }
}

export { routeHandler as GET, routeHandler as POST };
