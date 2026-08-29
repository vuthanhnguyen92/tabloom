#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const REPORT_PATH = resolve("outputs/mcp-oauth-readiness.json");
const CALLBACK_PATH = "/callback";
const REQUIRED_SCOPE = "tabloom:workspace";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROBE_RESPONSE_BYTES = 256 * 1024;

function strings(value) {
  return Array.isArray(value)
    ? value.every((entry) => typeof entry === "string") ? value : []
    : typeof value === "string"
      ? [value]
      : [];
}

export function evaluateAudience(audience, expectedResource) {
  const values = strings(audience);
  return values.length === 1 && values[0] === expectedResource
    ? { pass: true }
    : { pass: false, reason: "resource_audience_mismatch" };
}

function exactStringArray(value, required) {
  const values = strings(value);
  return values.length === required.length &&
    required.every((entry) => values.includes(entry));
}

export function evaluateDiscovery(
  protectedResource,
  authorizationServer,
  expectedResource,
) {
  const resource = typeof protectedResource?.resource === "string"
    ? protectedResource.resource
    : "";
  const authorizationServers = strings(
    protectedResource?.authorization_servers,
  );
  const issuer = authorizationServers.length === 1
    ? authorizationServers[0]
    : "";
  const resourceMatch = resource === expectedResource;
  const issuerMatch =
    issuer.length > 0 && authorizationServer?.issuer === issuer;
  const endpointsMatch = issuer.length > 0 &&
    authorizationServer?.authorization_endpoint === `${issuer}/oauth/authorize` &&
    authorizationServer?.token_endpoint === `${issuer}/oauth/token` &&
    authorizationServer?.registration_endpoint === `${issuer}/oauth/register` &&
    authorizationServer?.revocation_endpoint === `${issuer}/oauth/revoke` &&
    authorizationServer?.jwks_uri === `${issuer}/.well-known/jwks.json`;
  const discoverySupported =
    resourceMatch &&
    issuerMatch &&
    endpointsMatch &&
    exactStringArray(
      authorizationServer?.code_challenge_methods_supported,
      ["S256"],
    ) &&
    exactStringArray(
      authorizationServer?.grant_types_supported,
      ["authorization_code", "refresh_token"],
    ) &&
    exactStringArray(authorizationServer?.response_types_supported, ["code"]) &&
    exactStringArray(authorizationServer?.scopes_supported, [REQUIRED_SCOPE]) &&
    exactStringArray(
      authorizationServer?.token_endpoint_auth_methods_supported,
      ["none"],
    );

  return {
    discoverySupported,
    resource,
    resourceMatch,
    issuer,
    issuerMatch,
  };
}

export function classifyHttpStatus(status) {
  if (status >= 200 && status < 300) return "success";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "client_error";
  return "server_error";
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
    grant_types: ["authorization_code", "refresh_token"],
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
  scope = REQUIRED_SCOPE,
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
    scope,
  }).toString();
  return authorizationUrl.href;
}

function requiredHttpsOrigin(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required`);
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

async function readResponseText(response) {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) &&
      BigInt(declared) > BigInt(MAX_PROBE_RESPONSE_BYTES)) {
    throw new Error("OAuth probe response exceeded the size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PROBE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("OAuth probe response exceeded the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("OAuth probe response was not valid UTF-8");
  }
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<{status: number, body: unknown, mediaType?: string}>}
 */
export async function probeRequest(url, init) {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: {
      accept: "application/json",
      ...init?.headers,
    },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("OAuth probe redirects are not allowed");
  }
  const mediaType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  const text = await readResponseText(response);
  let body = text;
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
  }
  return { status: response.status, body, mediaType };
}

async function noRedirectRequest(requestFn, url, init) {
  const response = await requestFn(url, { ...init, redirect: "manual" });
  if (response?.status >= 300 && response.status < 400) {
    throw new Error("OAuth probe redirects are not allowed");
  }
  return response;
}

function successfulJson(response, label) {
  if (
    classifyHttpStatus(response?.status) !== "success" ||
    !response.body ||
    typeof response.body !== "object" ||
    Array.isArray(response.body)
  ) {
    throw new Error(`${label} failed`);
  }
  return response.body;
}

function validatePublicJwks(value) {
  if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length < 1 ||
      !value.keys.every((key) => isRecord(key) &&
        key.kty === "EC" && key.crv === "P-256" && key.alg === "ES256" &&
        typeof key.kid === "string" && key.kid.length > 0 &&
        typeof key.x === "string" && key.x.length > 0 &&
        typeof key.y === "string" && key.y.length > 0 &&
        !Object.hasOwn(key, "d"))) {
    throw new Error("OAuth JWKS discovery failed");
  }
  return value;
}

function validateRegistrationResponse(body, expectedMetadata) {
  if (typeof body.client_id !== "string" || !body.client_id ||
      body.client_name !== expectedMetadata.client_name ||
      !exactStringArray(body.redirect_uris, expectedMetadata.redirect_uris) ||
      !exactStringArray(body.grant_types, expectedMetadata.grant_types) ||
      !exactStringArray(body.response_types, expectedMetadata.response_types) ||
      body.token_endpoint_auth_method !== "none" ||
      Object.hasOwn(body, "client_secret") ||
      Object.hasOwn(body, "registration_access_token")) {
    throw new Error("Dynamic client registration failed");
  }
  return body.client_id;
}

export function parseOAuthCallback(requestTarget, expectedState) {
  let requestUrl;
  try {
    requestUrl = new URL(requestTarget, "http://127.0.0.1");
  } catch {
    return { status: 400, body: "Invalid OAuth callback.", terminal: false };
  }
  if (requestUrl.pathname !== CALLBACK_PATH) {
    return { status: 404, body: "Not found", terminal: false };
  }
  if (requestUrl.searchParams.get("state") !== expectedState) {
    return { status: 400, body: "Invalid OAuth callback.", terminal: false };
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
  const server = createServer((incoming, outgoing) => {
    const result = parseOAuthCallback(incoming.url ?? "/", expectedState);
    outgoing.writeHead(result.status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    outgoing.end(result.body);
    if (!result.terminal || settled) return;
    settled = true;
    if ("code" in result) settle.resolve(result.code);
    else settle.reject(new Error(result.error));
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

async function handoffAuthorization(url) {
  const command = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "linux"
      ? ["xdg-open", [url]]
      : undefined;
  if (!command) throw new Error("Automatic browser handoff is unavailable");
  await new Promise((resolveHandoff, rejectHandoff) => {
    const child = spawn(command[0], command[1], {
      detached: true,
      stdio: "ignore",
    });
    child.once("spawn", () => {
      child.unref();
      resolveHandoff();
    });
    child.once("error", () => {
      rejectHandoff(new Error("Automatic browser handoff failed"));
    });
  });
}

function emptyReport(discovery = {}) {
  return {
    discoverySupported: discovery.discoverySupported === true,
    resource: typeof discovery.resource === "string" ? discovery.resource : "",
    resourceMatch: discovery.resourceMatch === true,
    issuer: typeof discovery.issuer === "string" ? discovery.issuer : "",
    issuerMatch: discovery.issuerMatch === true,
    algorithm: "",
    audience: [],
    audienceMatch: false,
    scope: "",
    scopeMatch: false,
    refreshRotated: false,
    refreshReplayRejected: false,
    cleanupFailed: false,
    mcpContractMatch: false,
    mcpBeforeRevocationResult: "server_error",
    revocationResult: "server_error",
    mcpAfterRevocationResult: "server_error",
    revocationEnforced: false,
    pass: false,
  };
}

const HTTP_RESULT_CLASSES = new Set([
  "success",
  "client_error",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "server_error",
]);
const PRIVATE_PROBE_CHANNELS = new WeakMap();

export function createPrivateProbeResultChannel() {
  const channel = Object.freeze({});
  const state = { result: undefined, consumed: false };
  PRIVATE_PROBE_CHANNELS.set(channel, state);
  return Object.freeze({
    channel,
    take() {
      if (state.consumed || !state.result) {
        throw new Error("Private probe result is unavailable");
      }
      state.consumed = true;
      const result = state.result;
      state.result = undefined;
      return result;
    },
  });
}

function httpResultClass(value) {
  return HTTP_RESULT_CLASSES.has(value) ? value : "server_error";
}

function allowlistedReport(report) {
  return {
    discoverySupported: report?.discoverySupported === true,
    resource: typeof report?.resource === "string" ? report.resource : "",
    resourceMatch: report?.resourceMatch === true,
    issuer: typeof report?.issuer === "string" ? report.issuer : "",
    issuerMatch: report?.issuerMatch === true,
    algorithm: typeof report?.algorithm === "string" ? report.algorithm : "",
    audience: strings(report?.audience),
    audienceMatch: report?.audienceMatch === true,
    scope: typeof report?.scope === "string" ? report.scope : "",
    scopeMatch: report?.scopeMatch === true,
    refreshRotated: report?.refreshRotated === true,
    refreshReplayRejected: report?.refreshReplayRejected === true,
    cleanupFailed: report?.cleanupFailed === true,
    mcpContractMatch: report?.mcpContractMatch === true,
    mcpBeforeRevocationResult: httpResultClass(
      report?.mcpBeforeRevocationResult,
    ),
    revocationResult: httpResultClass(report?.revocationResult),
    mcpAfterRevocationResult: httpResultClass(
      report?.mcpAfterRevocationResult,
    ),
    revocationEnforced: report?.revocationEnforced === true,
    pass: report?.pass === true,
  };
}

function reportFromResult({
  discovery,
  firstVerified,
  rotatedVerified,
  refreshRotated,
  refreshReplayRejected,
  cleanupFailed = false,
  mcpContractMatch,
  mcpBeforeRevocationResult,
  revocationResult,
  mcpAfterRevocationResult,
}) {
  const firstAudience = strings(firstVerified?.payload?.aud);
  const audience = strings(rotatedVerified?.payload?.aud);
  const algorithm = typeof rotatedVerified?.protectedHeader?.alg === "string"
    ? rotatedVerified.protectedHeader.alg
    : "";
  const scope = typeof rotatedVerified?.payload?.scope === "string"
    ? rotatedVerified.payload.scope
    : "";
  const audienceMatch =
    evaluateAudience(firstAudience, discovery.resource).pass &&
    evaluateAudience(audience, discovery.resource).pass;
  const issuerMatch =
    discovery.issuerMatch &&
    firstVerified?.payload?.iss === discovery.issuer &&
    rotatedVerified?.payload?.iss === discovery.issuer;
  const scopeMatch =
    firstVerified?.payload?.scope === REQUIRED_SCOPE && scope === REQUIRED_SCOPE;
  const algorithmMatch =
    firstVerified?.protectedHeader?.alg === "ES256" && algorithm === "ES256";
  const revocationEnforced = mcpAfterRevocationResult === "unauthorized";
  const pass =
    discovery.discoverySupported &&
    discovery.resourceMatch &&
    issuerMatch &&
    algorithmMatch &&
    audienceMatch &&
    scopeMatch &&
    refreshRotated &&
    refreshReplayRejected &&
    !cleanupFailed &&
    mcpContractMatch &&
    mcpBeforeRevocationResult === "success" &&
    revocationResult === "success" &&
    revocationEnforced;

  return {
    discoverySupported: discovery.discoverySupported,
    resource: discovery.resource,
    resourceMatch: discovery.resourceMatch,
    issuer: discovery.issuer,
    issuerMatch,
    algorithm,
    audience,
    audienceMatch,
    scope,
    scopeMatch,
    refreshRotated,
    refreshReplayRejected,
    cleanupFailed,
    mcpContractMatch,
    mcpBeforeRevocationResult,
    revocationResult,
    mcpAfterRevocationResult,
    revocationEnforced,
    pass,
  };
}

export async function writeReport(report, reportPath = REPORT_PATH) {
  await mkdir(dirname(reportPath), { recursive: true });
  const safeReport = allowlistedReport(report);
  await writeFile(reportPath, `${JSON.stringify(safeReport, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(reportPath, 0o600);
}

async function verifyAccessToken(accessToken, { issuer, resource, jwks }) {
  const { createLocalJWKSet, jwtVerify } = await import("jose");
  try {
    return await jwtVerify(
      accessToken,
      createLocalJWKSet(jwks),
      {
        algorithms: ["ES256"],
        issuer,
        audience: resource,
        requiredClaims: ["scope", "sub", "client_id"],
      },
    );
  } catch {
    throw new Error("OAuth access-token verification failed");
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSseMessages(text) {
  const messages = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      return [];
    }
  }
  return messages;
}

function exactServiceStatusMessage(message, requestId) {
  if (!isRecord(message) || message.jsonrpc !== "2.0" ||
      message.id !== requestId || Object.hasOwn(message, "error") ||
      !isRecord(message.result) || !isRecord(message.result.structuredContent)) {
    return false;
  }
  const content = message.result.structuredContent;
  return Object.keys(content).length === 2 &&
    content.service === "tabloom-mcp" && content.status === "ok";
}

export function evaluateMcpServiceStatus(response, requestId) {
  if (classifyHttpStatus(response?.status) !== "success") return false;
  const mediaType = response?.mediaType;
  const messages = mediaType === "text/event-stream"
    ? typeof response.body === "string"
      ? parseSseMessages(response.body)
      : []
    : isRecord(response?.body)
      ? [response.body]
      : [];
  return messages.length === 1 &&
    exactServiceStatusMessage(messages[0], requestId);
}

function tokenPair(body, label) {
  if (
    typeof body.access_token !== "string" ||
    !body.access_token ||
    typeof body.refresh_token !== "string" ||
    !body.refresh_token ||
    body.token_type !== "Bearer" ||
    !Number.isSafeInteger(body.expires_in) ||
    body.expires_in <= 0 ||
    body.expires_in > 600 ||
    body.scope !== REQUIRED_SCOPE
  ) {
    throw new Error(`${label} returned an invalid token pair`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
  };
}

function mcpRequest(accessToken, id) {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "get_service_status", arguments: {} },
    }),
  };
}

async function waitForCallback(callback, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      callback,
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(
          () => rejectTimeout(new Error("OAuth approval timed out")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function beginProbeAcceptance({
  env = process.env,
  reportPath = REPORT_PATH,
  request: requestFn = probeRequest,
  createPkce: createPkceFn = createPkce,
  createCallbackListener: createCallbackListenerFn = createCallbackListener,
  handoffAuthorization: handoffAuthorizationFn = handoffAuthorization,
  verifyAccessToken: verifyAccessTokenFn = verifyAccessToken,
  writeReport: writeReportFn = writeReport,
  privateResultChannel = Object.freeze({}),
  log = console.log,
} = {}) {
  const expectedResource = requiredHttpsOrigin(
    env.TABLOOM_MCP_RESOURCE_URL,
    "TABLOOM_MCP_RESOURCE_URL",
  );
  let latestReport = emptyReport({ resource: expectedResource });
  const safeRequest = (url, init) =>
    noRedirectRequest(requestFn, url, init);
  let listener;
  let listenerCloseAttempted = false;
  let cleanupActiveGrant;

  const closeListener = async () => {
    if (!listener || listenerCloseAttempted) return;
    listenerCloseAttempted = true;
    await listener.close();
  };

  try {
    const protectedResource = successfulJson(
      await safeRequest(
        `${expectedResource}/.well-known/oauth-protected-resource`,
      ),
      "Protected-resource discovery",
    );
    const discoveredIssuers = strings(protectedResource.authorization_servers);
    if (discoveredIssuers.length !== 1) {
      throw new Error("Protected-resource discovery failed");
    }
    const discoveredIssuer = requiredHttpsOrigin(
      discoveredIssuers[0],
      "Discovered OAuth issuer",
    );
    if (discoveredIssuer !== expectedResource) {
      throw new Error("Protected-resource discovery returned an unexpected issuer");
    }
    const metadata = successfulJson(
      await safeRequest(
        `${discoveredIssuer}/.well-known/oauth-authorization-server`,
      ),
      "Authorization-server discovery",
    );
    const discovery = evaluateDiscovery(
      protectedResource,
      metadata,
      expectedResource,
    );
    latestReport = emptyReport(discovery);
    await writeReportFn(latestReport, reportPath);
    if (!discovery.discoverySupported) {
      throw new Error("OAuth discovery failed the readiness gate");
    }
    const jwks = validatePublicJwks(successfulJson(
      await safeRequest(metadata.jwks_uri),
      "OAuth JWKS discovery",
    ));

    const { state, verifier, challenge } = createPkceFn();
    listener = await createCallbackListenerFn(state);
    const registrationMetadata = buildDynamicClientRegistration(listener.callbackUrl);
    const registration = successfulJson(
        await safeRequest(metadata.registration_endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            registrationMetadata,
          ),
        }),
        "Dynamic client registration",
      );
    const clientId = validateRegistrationResponse(registration, registrationMetadata);

    const authorizationUrl = buildAuthorizationUrl({
        authorizationEndpoint: metadata.authorization_endpoint,
        clientId,
        callbackUrl: listener.callbackUrl,
        state,
        challenge,
        resource: expectedResource,
      });
    log("Complete the authorization request in the opened browser window.");
    await handoffAuthorizationFn(authorizationUrl);
    const timeoutMs = Number(env.TABLOOM_MCP_OAUTH_TIMEOUT_MS) ||
      DEFAULT_TIMEOUT_MS;
    const code = await waitForCallback(listener.callback, timeoutMs);

    const firstBody = successfulJson(
        await safeRequest(metadata.token_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: clientId,
            redirect_uri: listener.callbackUrl,
            resource: expectedResource,
            code_verifier: verifier,
          }),
        }),
        "Authorization-code exchange",
    );
    let currentAccessToken = typeof firstBody.access_token === "string" &&
        firstBody.access_token
      ? firstBody.access_token
      : undefined;
    let firstVerified;
    let rotatedVerified;
    let refreshRotated = false;
    let refreshReplayRejected = false;
    let mcpContractMatch = false;
    let mcpBeforeRevocationResult = "server_error";
    let cleanupPromise;
    const createActiveGrantCleanup = () => ({ forceFailure = false } = {}) => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        let cleanupFailed = false;
        let revocationResult = "server_error";
        let mcpAfterRevocationResult = "server_error";
        try {
          const revocation = await safeRequest(metadata.revocation_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: currentAccessToken,
              token_type_hint: "access_token",
            }),
          });
          revocationResult = classifyHttpStatus(revocation.status);
          if (revocationResult !== "success") cleanupFailed = true;
        } catch {
          cleanupFailed = true;
        }
        try {
          const afterRevocation = await safeRequest(
            `${expectedResource}/api/mcp`,
            mcpRequest(currentAccessToken, 2),
          );
          mcpAfterRevocationResult = classifyHttpStatus(
            afterRevocation.status,
          );
          if (mcpAfterRevocationResult !== "unauthorized") {
            cleanupFailed = true;
          }
        } catch {
          cleanupFailed = true;
        }
        latestReport = reportFromResult({
          discovery,
          firstVerified,
          rotatedVerified,
          refreshRotated,
          refreshReplayRejected,
          cleanupFailed,
          mcpContractMatch,
          mcpBeforeRevocationResult,
          revocationResult,
          mcpAfterRevocationResult,
        });
        if (forceFailure) latestReport.pass = false;
        try {
          await writeReportFn(latestReport, reportPath);
        } catch {
          cleanupFailed = true;
          latestReport = { ...latestReport, cleanupFailed: true, pass: false };
          await writeReportFn(latestReport, reportPath).catch(() => undefined);
        }
        if (cleanupFailed) {
          throw new Error("OAuth active-grant cleanup failed");
        }
        if (!forceFailure && !latestReport.pass) {
          throw new Error("OAuth flow failed the readiness gate");
        }
        if (!forceFailure) {
          log(`Redacted readiness report written to ${reportPath}`);
        }
      })();
      return cleanupPromise;
    };
    if (currentAccessToken) cleanupActiveGrant = createActiveGrantCleanup();

    const first = tokenPair(firstBody, "Authorization-code exchange");

    firstVerified = await verifyAccessTokenFn(first.accessToken, {
        issuer: discovery.issuer,
        resource: discovery.resource,
        jwks,
      });

    const rotatedBody = successfulJson(
        await safeRequest(metadata.token_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: first.refreshToken,
            client_id: clientId,
            resource: expectedResource,
            scope: REQUIRED_SCOPE,
          }),
        }),
        "Refresh-token exchange",
      );
    const rotated = tokenPair(rotatedBody, "Refresh-token exchange");
    currentAccessToken = rotated.accessToken;
    refreshRotated =
      rotated.accessToken !== first.accessToken &&
      rotated.refreshToken !== first.refreshToken;

    rotatedVerified = await verifyAccessTokenFn(rotated.accessToken, {
      issuer: discovery.issuer,
      resource: discovery.resource,
      jwks,
    });

    const replay = await safeRequest(metadata.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: first.refreshToken,
          client_id: clientId,
          resource: expectedResource,
          scope: REQUIRED_SCOPE,
        }),
      });
    refreshReplayRejected = replay.status === 400 &&
      isRecord(replay.body) && replay.body.error === "invalid_grant";

    const beforeRevocation = await safeRequest(
        `${expectedResource}/api/mcp`,
        mcpRequest(rotated.accessToken, 1),
      );
    mcpBeforeRevocationResult = classifyHttpStatus(beforeRevocation.status);
    mcpContractMatch = evaluateMcpServiceStatus(beforeRevocation, 1);
    latestReport = reportFromResult({
        discovery,
        firstVerified,
        rotatedVerified,
        refreshRotated,
        refreshReplayRejected,
        mcpContractMatch,
        mcpBeforeRevocationResult,
        revocationResult: "server_error",
        mcpAfterRevocationResult: "server_error",
      });
    await writeReportFn(latestReport, reportPath);
    const activeGrantReady = latestReport.discoverySupported &&
      latestReport.resourceMatch && latestReport.issuerMatch &&
      latestReport.algorithm === "ES256" && latestReport.audienceMatch &&
      latestReport.scopeMatch && latestReport.refreshRotated &&
      latestReport.refreshReplayRejected && latestReport.mcpContractMatch &&
      latestReport.mcpBeforeRevocationResult === "success";
    if (!activeGrantReady) {
      throw new Error("OAuth flow failed the active-grant readiness gate");
    }
    const privateState = PRIVATE_PROBE_CHANNELS.get(privateResultChannel);
    if (privateState) {
      privateState.result = Object.freeze({
          first: Object.freeze({
            accessToken: first.accessToken,
            verified: firstVerified,
          }),
          rotated: Object.freeze({
            accessToken: rotated.accessToken,
            verified: rotatedVerified,
          }),
          jwks,
      });
    }
    const phase = Object.freeze({
      complete: () => cleanupActiveGrant({ forceFailure: false }),
    });
    await closeListener();
    return phase;
  } catch (error) {
    if (cleanupActiveGrant) {
      await cleanupActiveGrant({ forceFailure: true }).catch(() => undefined);
    }
    await closeListener().catch(() => undefined);
    await writeReportFn(latestReport, reportPath).catch(() => undefined);
    throw error;
  }
}

export async function runProbe(options = {}) {
  const phase = await beginProbeAcceptance(options);
  await phase.complete();
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
