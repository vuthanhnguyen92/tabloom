import {
  createEncryptionKeyRing,
  createSigningKeyRing,
  type EncryptionKeyRing,
  type SigningKeyRing,
} from "./key-rings";
import {
  createOAuthDatabaseProofKey,
  type OAuthDatabaseProofKey,
} from "./database-proof";

export type McpAuthConfig = {
  supabaseUrl: URL;
  issuer: string;
  jwksUrl: URL;
  anonKey: string;
  resourceUrl: URL;
};

export type FacadeAuthConfig = McpAuthConfig & {
  oauthEnabled: boolean;
  issuerUrl: URL;
  signingKeys: SigningKeyRing;
  encryptionKeys: EncryptionKeyRing;
  databaseProofKey?: OAuthDatabaseProofKey;
};

const TEMPLATE_VALUE =
  /(?:\$\{[^}]+\}|<[^>]+>|\byour[-_ ]|replace[-_ ]?with|change[-_ ]?me|placeholder)/i;

function requiredValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  if (TEMPLATE_VALUE.test(normalized)) {
    throw new Error(`${name} must not be a template value`);
  }
  return normalized;
}

function requiredHttpsOrigin(value: string | undefined, name: string): URL {
  const normalized = requiredValue(value, name);
  let url: URL;

  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTPS origin without credentials, a path, query, or fragment`);
  }

  return url;
}

function requiredMcpResource(value: string | undefined, name: string): URL {
  const normalized = requiredValue(value, name);
  let url: URL;

  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/mcp" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTPS URL with the exact /mcp path and no credentials, query, or fragment`);
  }

  return url;
}

export function loadMcpAuthConfig(env: NodeJS.ProcessEnv): McpAuthConfig {
  const supabaseUrl = requiredHttpsOrigin(env.SUPABASE_URL, "SUPABASE_URL");
  const resourceUrl = requiredMcpResource(
    env.TABLOOM_MCP_RESOURCE_URL,
    "TABLOOM_MCP_RESOURCE_URL",
  );
  const issuer = new URL(
    "auth/v1",
    `${supabaseUrl.href.replace(/\/$/, "")}/`,
  ).href.replace(/\/$/, "");

  return {
    supabaseUrl,
    issuer,
    jwksUrl: new URL(`${issuer}/.well-known/jwks.json`),
    anonKey: requiredValue(env.SUPABASE_ANON_KEY, "SUPABASE_ANON_KEY"),
    resourceUrl,
  };
}

const MAX_KEY_RING_JSON_BYTES = 64 * 1024;

function requiredBoolean(value: string | undefined, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly true or false`);
}

function parseKeyRing(value: string | undefined, name: string): unknown[] {
  if (!value?.trim()) return [];
  if (Buffer.byteLength(value, "utf8") > MAX_KEY_RING_JSON_BYTES) {
    throw new Error(`${name} exceeds the maximum allowed size`);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${name} must be a JSON array`);
  }
}

export function loadFacadeAuthConfig(env: NodeJS.ProcessEnv): FacadeAuthConfig {
  const base = loadMcpAuthConfig(env);
  const oauthEnabled = requiredBoolean(
    env.TABLOOM_OAUTH_ENABLED,
    "TABLOOM_OAUTH_ENABLED",
  );
  const issuerUrl = requiredHttpsOrigin(
    env.TABLOOM_OAUTH_ISSUER_URL,
    "TABLOOM_OAUTH_ISSUER_URL",
  );
  if (issuerUrl.origin !== base.resourceUrl.origin) {
    throw new Error("TABLOOM_OAUTH_ISSUER_URL and TABLOOM_MCP_RESOURCE_URL must share an origin");
  }

  const signingKeys = createSigningKeyRing(
    parseKeyRing(env.TABLOOM_OAUTH_SIGNING_KEYS, "TABLOOM_OAUTH_SIGNING_KEYS") as Parameters<typeof createSigningKeyRing>[0],
  );
  const encryptionKeys = createEncryptionKeyRing(
    parseKeyRing(env.TABLOOM_OAUTH_ENCRYPTION_KEYS, "TABLOOM_OAUTH_ENCRYPTION_KEYS") as Parameters<typeof createEncryptionKeyRing>[0],
  );

  const databaseProofKey = env.TABLOOM_OAUTH_DATABASE_SECRET === undefined ||
      env.TABLOOM_OAUTH_DATABASE_SECRET === ""
    ? undefined
    : createOAuthDatabaseProofKey(env.TABLOOM_OAUTH_DATABASE_SECRET);

  if (oauthEnabled && (!signingKeys.active || !encryptionKeys.active || !databaseProofKey)) {
    throw new Error("Enabled OAuth facade requires active cryptographic and database proof keys");
  }

  return {
    ...base,
    oauthEnabled,
    issuerUrl,
    signingKeys,
    encryptionKeys,
    databaseProofKey,
  };
}
