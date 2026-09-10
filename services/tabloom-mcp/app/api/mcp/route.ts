import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { loadFacadeAuthConfig } from "../../../src/auth/config";
import { createTokenVerifier } from "../../../src/auth/verify-token";
import { oauthError, oauthJson } from "../../../src/oauth/responses";
import { registerWorkspaceTools } from "../../../src/workspace/register-tools";

export function serviceStatusResult(mutationsEnabled = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ service: "tabloom-mcp", status: "ok", mutationsEnabled }),
      },
    ],
    structuredContent: { service: "tabloom-mcp", status: "ok", mutationsEnabled },
  };
}

function createHandler(mutationsEnabled: boolean) {
  return createMcpHandler(
    (server) => {
      server.registerTool(
        "get_service_status",
        {
          title: "Get service status",
          description: "Report whether the Tabloom MCP service is available.",
          inputSchema: z.strictObject({}),
          outputSchema: z.object({ service: z.literal("tabloom-mcp"), status: z.literal("ok"), mutationsEnabled: z.boolean() }),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async () => serviceStatusResult(mutationsEnabled),
      );
      registerWorkspaceTools(server, { mutationsEnabled });
    },
    {
      serverInfo: { name: "tabloom-mcp", version: "0.1.0" },
    },
  );
}

type AuthenticatedHandler = ReturnType<typeof withMcpAuth>;

let cachedAuthenticatedHandler: AuthenticatedHandler | undefined;

function getAuthenticatedHandler(): AuthenticatedHandler | undefined {
  if (cachedAuthenticatedHandler) {
    return cachedAuthenticatedHandler;
  }

  const config = loadFacadeAuthConfig(process.env);
  if (!config.oauthEnabled) return undefined;
  const verifier = createTokenVerifier(config);
  const authenticatedHandler = withMcpAuth(createHandler(config.mutationsEnabled), verifier, {
    required: true,
    requiredScopes: ["tabloom:workspace"],
    resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
    // mcp-handler prefixes resourceMetadataPath with this value; the verifier
    // still binds tokens to config.resourceUrl.href (the exact /mcp audience).
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
