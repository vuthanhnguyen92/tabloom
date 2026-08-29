import { exportJWK } from "jose";

import { loadFacadeAuthConfig } from "../../../src/auth/config";
import { signingPublicKey } from "../../../src/auth/key-rings";
import { corsOptions, publicMetadataHeaders } from "../../../src/oauth/responses";

type PublicJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  alg: "ES256";
  use: "sig";
  kid: string;
};

async function publicJwk(kid: string, config: ReturnType<typeof loadFacadeAuthConfig>): Promise<PublicJwk> {
  const jwk = await exportJWK(signingPublicKey(config.signingKeys, kid));
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("OAuth signing key could not be converted to a public JWK");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, alg: "ES256", use: "sig", kid };
}

export async function GET(): Promise<Response> {
  const config = loadFacadeAuthConfig(process.env);
  const keys = await Promise.all(
    [...config.signingKeys.keys.keys()].map((kid) => publicJwk(kid, config)),
  );
  return Response.json({ keys }, { headers: publicMetadataHeaders() });
}

export function OPTIONS(): Response {
  return corsOptions("GET, OPTIONS");
}
