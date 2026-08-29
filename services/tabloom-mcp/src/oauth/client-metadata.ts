import type { OAuthPersistence } from "./persistence";
import { fetchCimdClient } from "./cimd";

export type ValidatedClient = {
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
  source: "dcr" | "cimd";
};

export type ValidatedClientRegistration = Pick<ValidatedClient, "clientName" | "redirectUris">;

export class InvalidOAuthClientError extends Error {
  constructor() {
    super("Invalid OAuth client");
    this.name = "InvalidOAuthClientError";
  }
}

type ClientMetadata = {
  client_name: unknown;
  redirect_uris: unknown;
  grant_types: unknown;
  response_types: unknown;
  token_endpoint_auth_method: unknown;
};

const DCR_KEYS = [
  "client_name",
  "grant_types",
  "redirect_uris",
  "response_types",
  "token_endpoint_auth_method",
] as const;
const CIMD_KEYS = [...DCR_KEYS, "client_id"].sort();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTPS_REDIRECT_PATTERN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::([0-9]{1,5}))?(?:\/[^#\s]*)?(?:\?[^#\s]*)?$/i;
const HTTP_LOOPBACK_REDIRECT_PATTERN = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?(?:\/[^#\s]*)?(?:\?[^#\s]*)?$/;

function invalidClientMetadata(): Error {
  return new Error("Invalid public OAuth client metadata");
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]);
}

function validateClientName(value: unknown): string {
  if (typeof value !== "string") throw invalidClientMetadata();
  const length = Array.from(value).length;
  if (length < 1 || length > 100 || Buffer.byteLength(value, "utf8") > 400 ||
      value.startsWith(" ") || value.endsWith(" ") || /\p{Cc}/u.test(value)) {
    throw invalidClientMetadata();
  }
  return value;
}

function validateRedirectUri(value: unknown): string {
  if (typeof value !== "string") throw invalidClientMetadata();
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength < 1 || byteLength > 2048 || /[\s#*]/.test(value)) {
    throw invalidClientMetadata();
  }

  const match = HTTPS_REDIRECT_PATTERN.exec(value) ?? HTTP_LOOPBACK_REDIRECT_PATTERN.exec(value);
  if (!match) throw invalidClientMetadata();
  if (match[1] !== undefined) {
    const port = Number(match[1]);
    if (port < 1 || port > 65535) throw invalidClientMetadata();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidClientMetadata();
  }
  if (!url.hostname) throw invalidClientMetadata();
  return value;
}

function validateRedirectUris(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw invalidClientMetadata();
  }
  const redirectUris = value.map(validateRedirectUri);
  if (new Set(redirectUris).size !== redirectUris.length) throw invalidClientMetadata();
  return Object.freeze(redirectUris);
}

function isExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function validateCommon(metadata: ClientMetadata): ValidatedClientRegistration {
  const grantTypes = metadata.grant_types;
  const validGrantTypes = Array.isArray(grantTypes) &&
    (grantTypes.length === 1 || grantTypes.length === 2) &&
    new Set(grantTypes).size === grantTypes.length &&
    grantTypes.includes("authorization_code") &&
    grantTypes.every((grantType) => grantType === "authorization_code" || grantType === "refresh_token");
  if (!validGrantTypes ||
      !isExactStringArray(metadata.response_types, ["code"]) ||
      metadata.token_endpoint_auth_method !== "none") {
    throw invalidClientMetadata();
  }
  return Object.freeze({
    clientName: validateClientName(metadata.client_name),
    redirectUris: validateRedirectUris(metadata.redirect_uris),
  });
}

export function validateDcrClientMetadata(value: unknown): ValidatedClientRegistration {
  if (!isExactRecord(value, DCR_KEYS)) throw invalidClientMetadata();
  return validateCommon(value as unknown as ClientMetadata);
}

export function validateCimdClientMetadata(value: unknown, expectedClientId: string): ValidatedClient {
  if (!isExactRecord(value, CIMD_KEYS) || value.client_id !== expectedClientId) {
    throw invalidClientMetadata();
  }
  const metadata = validateCommon(value as unknown as ClientMetadata);
  return Object.freeze({
    clientId: expectedClientId,
    clientName: metadata.clientName,
    redirectUris: metadata.redirectUris,
    source: "cimd" as const,
  });
}

export function isValidCimdClientId(clientId: string): boolean {
  if (clientId.trim() !== clientId) return false;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && !clientId.includes("#") &&
    Boolean(url.hostname) && !clientId.includes("*");
}

export type ResolveClientOptions = {
  fetchCimd?: (clientId: string) => Promise<ValidatedClient>;
  now?: () => Date;
};

export async function resolveClient(
  clientId: string,
  persistence: OAuthPersistence,
  options: ResolveClientOptions = {},
): Promise<ValidatedClient> {
  if (UUID_PATTERN.test(clientId)) {
    const stored = await persistence.getClient(clientId);
    const now = (options.now ?? (() => new Date()))();
    const expiresAt = Date.parse(stored?.expiresAt ?? "");
    if (!stored || stored.clientId !== clientId ||
        !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      throw new InvalidOAuthClientError();
    }
    let clientName: string;
    let redirectUris: readonly string[];
    try {
      clientName = validateClientName(stored.clientName);
      redirectUris = validateRedirectUris(stored.redirectUris);
    } catch {
      throw new InvalidOAuthClientError();
    }
    return Object.freeze({ clientId, clientName, redirectUris, source: "dcr" as const });
  }

  if (!isValidCimdClientId(clientId)) throw new InvalidOAuthClientError();
  const client = await (options.fetchCimd ?? fetchCimdClient)(clientId);
  if (client.clientId !== clientId || client.source !== "cimd") {
    throw new InvalidOAuthClientError();
  }
  return client;
}
