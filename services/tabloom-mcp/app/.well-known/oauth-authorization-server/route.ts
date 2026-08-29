import { loadFacadeAuthConfig } from "../../../src/auth/config";
import { corsOptions, publicMetadataHeaders } from "../../../src/oauth/responses";

export function GET(): Response {
  const config = loadFacadeAuthConfig(process.env);
  const issuer = config.issuerUrl.origin;
  return Response.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["tabloom:workspace"],
  }, { headers: publicMetadataHeaders() });
}

export function OPTIONS(): Response {
  return corsOptions("GET, OPTIONS");
}
