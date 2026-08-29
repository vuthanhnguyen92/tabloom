export type McpAuthConfig = {
  supabaseUrl: URL;
  issuer: string;
  jwksUrl: URL;
  anonKey: string;
  resourceUrl: URL;
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

export function loadMcpAuthConfig(env: NodeJS.ProcessEnv): McpAuthConfig {
  const supabaseUrl = requiredHttpsOrigin(env.SUPABASE_URL, "SUPABASE_URL");
  const resourceUrl = requiredHttpsOrigin(
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
