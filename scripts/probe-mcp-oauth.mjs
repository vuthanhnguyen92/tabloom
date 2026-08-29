#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const REPORT_PATH = resolve("outputs/mcp-oauth-readiness.json");
const CALLBACK_PATH = "/callback";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function evaluateAudience(audience, expectedResource) {
  const values = Array.isArray(audience) ? audience : [audience];
  return values.some((value) => value === expectedResource)
    ? { pass: true }
    : { pass: false, reason: "resource_audience_missing" };
}

export function evaluateDiscovery(discovery, expectedIssuer) {
  const issuer =
    discovery && typeof discovery.issuer === "string" ? discovery.issuer : "";
  const endpointsPresent = [
    discovery?.authorization_endpoint,
    discovery?.token_endpoint,
    discovery?.registration_endpoint,
  ].every((value) => typeof value === "string" && value.length > 0);
  const supportsS256 =
    Array.isArray(discovery?.code_challenge_methods_supported) &&
    discovery.code_challenge_methods_supported.includes("S256");

  return {
    discoverySupported: endpointsPresent && supportsS256,
    issuer,
    issuerMatch: issuer === expectedIssuer,
  };
}

/**
 * @param {{
 *   protectedHeader?: { alg?: unknown; [key: string]: unknown };
 *   payload?: { iss?: unknown; aud?: unknown; sub?: unknown; client_id?: unknown; [key: string]: unknown };
 *   tokenResponse?: Record<string, unknown>;
 *   expectedIssuer: string;
 *   expectedResource: string;
 *   discovery: { discoverySupported: boolean; issuer: string; issuerMatch: boolean };
 * }} result
 */
export function redactTokenResult({
  protectedHeader,
  payload,
  expectedIssuer,
  expectedResource,
  discovery,
}) {
  const algorithm =
    typeof protectedHeader?.alg === "string" ? protectedHeader.alg : "";
  const issuer = typeof payload?.iss === "string" ? payload.iss : discovery.issuer;
  const audience = (Array.isArray(payload?.aud) ? payload.aud : [payload?.aud]).filter(
    (value) => typeof value === "string",
  );
  const audienceResult = evaluateAudience(audience, expectedResource);
  const issuerMatch = discovery.issuerMatch && issuer === expectedIssuer;
  const subjectPresent =
    typeof payload?.sub === "string" && payload.sub.trim().length > 0;
  const clientPresent =
    typeof payload?.client_id === "string" && payload.client_id.trim().length > 0;
  const audienceMatch = audienceResult.pass;
  const pass =
    discovery.discoverySupported &&
    issuerMatch &&
    algorithm === "ES256" &&
    audienceMatch &&
    subjectPresent &&
    clientPresent;

  return {
    discoverySupported: discovery.discoverySupported,
    issuer,
    issuerMatch,
    algorithm,
    audience,
    audienceMatch,
    subjectPresent,
    clientPresent,
    pass,
  };
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

export function derivePkceChallenge(verifier) {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function createPkce() {
  const state = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(64));
  return { state, verifier, challenge: derivePkceChallenge(verifier) };
}

export function buildDynamicClientRegistration(callbackUrl) {
  return {
    client_name: "Tabloom MCP OAuth readiness probe",
    redirect_uris: [callbackUrl],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export function buildAuthorizationUrl({
  authorizationEndpoint,
  clientId,
  callbackUrl,
  state,
  challenge,
  resource,
}) {
  const authorizationUrl = new URL(authorizationEndpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callbackUrl,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    scope: "email",
  }).toString();
  return authorizationUrl.href;
}

function requiredHttpsOrigin(value, name) {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }

  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  return url.origin;
}

async function fetchJson(url, init, label) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchDiscovery(supabaseOrigin) {
  const urls = [
    `${supabaseOrigin}/.well-known/oauth-authorization-server/auth/v1`,
    `${supabaseOrigin}/auth/v1/.well-known/oauth-authorization-server`,
  ];
  let lastError;

  for (const url of urls) {
    try {
      return await fetchJson(url, undefined, "OAuth discovery");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("OAuth discovery failed");
}

export function parseOAuthCallback(requestTarget, expectedState) {
  let requestUrl;
  try {
    requestUrl = new URL(requestTarget, "http://127.0.0.1");
  } catch {
    return {
      status: 400,
      body: "Invalid OAuth callback.",
      terminal: false,
    };
  }

  if (requestUrl.pathname !== CALLBACK_PATH) {
    return { status: 404, body: "Not found", terminal: false };
  }
  if (requestUrl.searchParams.get("state") !== expectedState) {
    return {
      status: 400,
      body: "Invalid OAuth callback.",
      terminal: false,
    };
  }
  if (requestUrl.searchParams.has("error")) {
    return {
      status: 400,
      body: "OAuth authorization was not approved.",
      terminal: true,
      error: "OAuth authorization was not approved",
    };
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) {
    return {
      status: 400,
      body: "OAuth callback did not include an authorization code.",
      terminal: true,
      error: "OAuth callback did not include a code",
    };
  }
  return {
    status: 200,
    body: "Tabloom OAuth readiness probe received the response. You can close this tab.",
    terminal: true,
    code,
  };
}

export async function createCallbackListener(expectedState) {
  let settle;
  let settled = false;
  const callback = new Promise((resolveCallback, rejectCallback) => {
    settle = { resolve: resolveCallback, reject: rejectCallback };
  });

  const server = createServer((request, response) => {
    const result = parseOAuthCallback(request.url ?? "/", expectedState);
    response.writeHead(result.status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(result.body);

    if (!result.terminal || settled) {
      return;
    }
    settled = true;
    if ("code" in result) {
      settle.resolve(result.code);
    } else {
      settle.reject(new Error(result.error));
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to start the local OAuth callback");
  }

  return {
    callback,
    callbackUrl: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function openAuthorizationUrl(url) {
  if (process.platform === "darwin") {
    const child = spawn("open", [url], { detached: true, stdio: "ignore" });
    child.unref();
  }
}

function emptyReport(discovery, issuer) {
  return {
    discoverySupported: discovery.discoverySupported,
    issuer,
    issuerMatch: discovery.issuerMatch,
    algorithm: "",
    audience: [],
    audienceMatch: false,
    subjectPresent: false,
    clientPresent: false,
    pass: false,
  };
}

export async function writeReport(report, reportPath = REPORT_PATH) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(reportPath, 0o600);
}

async function verifyAccessToken(accessToken, { metadata, expectedIssuer }) {
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  const jwksUrl =
    typeof metadata.jwks_uri === "string"
      ? metadata.jwks_uri
      : `${expectedIssuer}/.well-known/jwks.json`;
  try {
    return await jwtVerify(
      accessToken,
      createRemoteJWKSet(new URL(jwksUrl)),
      { algorithms: ["ES256"], issuer: expectedIssuer },
    );
  } catch {
    throw new Error("OAuth access-token verification failed");
  }
}

export async function runProbe({
  env = process.env,
  reportPath = REPORT_PATH,
  fetchDiscovery: fetchDiscoveryFn = fetchDiscovery,
  requestJson = fetchJson,
  createPkce: createPkceFn = createPkce,
  createCallbackListener: createCallbackListenerFn = createCallbackListener,
  openAuthorizationUrl: openAuthorizationUrlFn = openAuthorizationUrl,
  verifyAccessToken: verifyAccessTokenFn = verifyAccessToken,
  writeReport: writeReportFn = writeReport,
  log = console.log,
} = {}) {
  const supabaseOrigin = requiredHttpsOrigin(
    env.SUPABASE_URL,
    "SUPABASE_URL",
  );
  const expectedResource = requiredHttpsOrigin(
    env.TABLOOM_MCP_RESOURCE_URL,
    "TABLOOM_MCP_RESOURCE_URL",
  );
  const expectedIssuer = `${supabaseOrigin}/auth/v1`;
  let discoveryResult = {
    discoverySupported: false,
    issuer: expectedIssuer,
    issuerMatch: false,
  };
  let latestReport = emptyReport(discoveryResult, expectedIssuer);

  try {
    const metadata = await fetchDiscoveryFn(supabaseOrigin);
    discoveryResult = evaluateDiscovery(metadata, expectedIssuer);
    latestReport = emptyReport(discoveryResult, discoveryResult.issuer);
    await writeReportFn(latestReport, reportPath);
    if (!discoveryResult.discoverySupported || !discoveryResult.issuerMatch) {
      throw new Error("OAuth discovery does not meet the readiness gate");
    }

    const { state, verifier, challenge } = createPkceFn();
    const listener = await createCallbackListenerFn(state);

    try {
      log(`Local OAuth callback: ${listener.callbackUrl}`);
      const registration = await requestJson(
        metadata.registration_endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            buildDynamicClientRegistration(listener.callbackUrl),
          ),
        },
        "Dynamic client registration",
      );
      if (typeof registration.client_id !== "string" || !registration.client_id) {
        throw new Error("Dynamic client registration returned no client ID");
      }

      const authorizationUrl = buildAuthorizationUrl({
        authorizationEndpoint: metadata.authorization_endpoint,
        clientId: registration.client_id,
        callbackUrl: listener.callbackUrl,
        state,
        challenge,
        resource: expectedResource,
      });
      log(`Approve the OAuth request in your browser:\n${authorizationUrl}`);
      openAuthorizationUrlFn(authorizationUrl);

      const timeoutMs = Number(env.TABLOOM_MCP_OAUTH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
      const code = await Promise.race([
        listener.callback,
        new Promise((_, rejectTimeout) => {
          setTimeout(
            () => rejectTimeout(new Error("OAuth approval timed out")),
            timeoutMs,
          ).unref();
        }),
      ]);

      const tokenResponse = await requestJson(
        metadata.token_endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: registration.client_id,
            redirect_uri: listener.callbackUrl,
            code_verifier: verifier,
          }),
        },
        "OAuth token exchange",
      );
      if (typeof tokenResponse.access_token !== "string") {
        throw new Error("OAuth token exchange returned no access token");
      }

      const verified = await verifyAccessTokenFn(tokenResponse.access_token, {
        metadata,
        expectedIssuer,
      });

      const report = redactTokenResult({
        ...verified,
        expectedIssuer,
        expectedResource,
        discovery: discoveryResult,
      });
      latestReport = report;
      await writeReportFn(latestReport, reportPath);
      log(`Redacted readiness report written to ${reportPath}`);
      if (!report.pass) {
        throw new Error("OAuth token failed the exact resource-audience gate");
      }
    } finally {
      await listener.close();
    }
  } catch (error) {
    await writeReportFn(latestReport, reportPath);
    throw error;
  }
}

export async function runCli({
  run = () => runProbe(),
  error = console.error,
} = {}) {
  try {
    await run();
    return 0;
  } catch {
    error("OAuth readiness gate failed. See the redacted report for details.");
    return 1;
  }
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
