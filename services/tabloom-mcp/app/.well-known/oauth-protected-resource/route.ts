import { loadFacadeAuthConfig } from "../../../src/auth/config";
import { corsOptions, publicMetadataHeaders } from "../../../src/oauth/responses";

export function GET(): Response {
  const config = loadFacadeAuthConfig(process.env);
  return Response.json({
    resource: config.resourceUrl.href,
    authorization_servers: [config.issuerUrl.origin],
  }, { headers: publicMetadataHeaders() });
}

export function OPTIONS(): Response {
  return corsOptions("GET, OPTIONS");
}
