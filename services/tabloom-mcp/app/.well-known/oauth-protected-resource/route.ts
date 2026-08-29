import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from "mcp-handler";
import { loadMcpAuthConfig } from "../../../src/auth/config";

export function GET(request: Request): Response {
  const config = loadMcpAuthConfig(process.env);
  return protectedResourceHandler({
    authServerUrls: [config.issuer],
    resourceUrl: config.resourceUrl.origin,
  })(request);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
