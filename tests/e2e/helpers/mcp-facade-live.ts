import type { Browser, BrowserContext, BrowserContextOptions } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { SupabaseWorkspaceRepository } from "../../../shared/repository";
import {
  createPrivateProbeResultChannel,
  probeRequest,
  runProbe,
} from "../../../scripts/probe-mcp-oauth.mjs";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const LIVE_RESOURCE = "https://tabloom-mcp.vercel.app";
const LIVE_SUPABASE_ORIGIN = "https://tctjlsvfufzxhauhywsm.supabase.co";
const MAX_FIXTURE_BYTES = 64 * 1024;
const MAX_STORAGE_STATE_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createExactSupabaseFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error("Supabase request URL was invalid");
    }
    if (url.origin !== LIVE_SUPABASE_ORIGIN) {
      throw new Error("Supabase request escaped the approved origin");
    }
    const response = await baseFetch(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Supabase request redirects are not allowed");
    }
    return response;
  }) as typeof fetch;
}

type JsonRecord = Record<string, unknown>;
type ProbePrivateResult = {
  first: { accessToken: string; verified: { payload: JWTPayload } };
  rotated: { accessToken: string; verified: { payload: JWTPayload } };
  jwks: { keys: JsonWebKey[] };
};

type StorageState = Exclude<BrowserContextOptions["storageState"], string | undefined>;

export type LiveAcceptanceUserInput = {
  label: string;
  userId: string;
  storageStatePath: string;
  supabaseAccessToken: string;
  ownedSpaceId: string;
};

export type ParsedLiveAcceptanceFixture = {
  version: 1;
  resource: typeof LIVE_RESOURCE;
  supabaseUrl: string;
  supabaseAnonKey: string;
  subjectMismatchBearer: string;
  users: [LiveAcceptanceUserInput, LiveAcceptanceUserInput];
};

export type LiveAcceptanceUser = Omit<LiveAcceptanceUserInput, "storageStatePath"> & {
  storageState: StorageState;
};

export type LiveAcceptanceFixture = Omit<ParsedLiveAcceptanceFixture, "users"> & {
  users: [LiveAcceptanceUser, LiveAcceptanceUser];
};

type ParseOptions = { repositoryRoot: string };

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const ACCESS_TOKEN_CLAIMS = [
  "aud", "client_id", "exp", "grant_id", "iat", "iss", "jti", "nbf",
  "scope", "sub", "supabase_token",
] as const;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9_-]{43}$/;
const DCR_CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validFacadePayload(payload: JWTPayload, resource: string, now: number) {
  if (!hasExactKeys(payload as JsonRecord, ACCESS_TOKEN_CLAIMS) ||
      payload.iss !== resource || payload.aud !== resource ||
      payload.scope !== "tabloom:workspace" || typeof payload.sub !== "string" ||
      !UUID.test(payload.sub) || typeof payload.client_id !== "string" ||
      !DCR_CLIENT_ID.test(payload.client_id) || typeof payload.grant_id !== "string" ||
      !OPAQUE_IDENTIFIER.test(payload.grant_id) || typeof payload.jti !== "string" ||
      !OPAQUE_IDENTIFIER.test(payload.jti) ||
      typeof payload.supabase_token !== "string" ||
      payload.supabase_token.split(".").length !== 5 ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.nbf) ||
      !Number.isSafeInteger(payload.exp) || payload.iat !== payload.nbf ||
      payload.exp! <= now || payload.exp! > payload.iat! + 600) {
    throw new Error("Invalid facade access-token claims");
  }
}

export async function verifySubjectMismatchBearer(input: {
  mismatchBearer: string;
  userAAccessToken: string;
  userBAccessToken: string;
  expectedUserAId: string;
  expectedUserBId: string;
  jwks: { keys: JsonWebKey[] };
  resource: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (new Set([
    input.mismatchBearer,
    input.userAAccessToken,
    input.userBAccessToken,
  ]).size !== 3) {
    throw new Error("Facade acceptance tokens must be distinct");
  }
  const verify = async (token: string) => {
    const result = await jwtVerify(
      token,
      createLocalJWKSet(input.jwks),
      {
        algorithms: ["ES256"],
        issuer: input.resource,
        audience: input.resource,
        currentDate: new Date(now * 1000),
        requiredClaims: [...ACCESS_TOKEN_CLAIMS],
      },
    );
    if (!hasExactKeys(result.protectedHeader as JsonRecord, ["alg", "kid", "typ"]) ||
        result.protectedHeader.alg !== "ES256" ||
        result.protectedHeader.typ !== "at+jwt" ||
        typeof result.protectedHeader.kid !== "string") {
      throw new Error("Invalid facade access-token header");
    }
    validFacadePayload(result.payload, input.resource, now);
    return result.payload;
  };
  const [mismatch, userA, userB] = await Promise.all([
    verify(input.mismatchBearer),
    verify(input.userAAccessToken),
    verify(input.userBAccessToken),
  ]);
  if (input.expectedUserAId === input.expectedUserBId ||
      userA.sub !== input.expectedUserAId || userB.sub !== input.expectedUserBId ||
      mismatch.sub !== input.expectedUserAId ||
      userA.supabase_token === userB.supabase_token ||
      mismatch.supabase_token !== userB.supabase_token ||
      mismatch.supabase_token === userA.supabase_token ||
      mismatch.client_id !== userA.client_id || mismatch.grant_id !== userA.grant_id ||
      mismatch.iat !== userA.iat || mismatch.nbf !== userA.nbf ||
      mismatch.exp !== userA.exp || mismatch.jti === userA.jti || mismatch.jti === userB.jti) {
    throw new Error("Subject-mismatch bearer was not bound to fresh A/B tokens");
  }
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function privateCredential(value: unknown, label: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 16_384 || value.trim() !== value) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function isInside(root: string, candidate: string) {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function externalAbsolutePath(value: unknown, repositoryRoot: string, label: string) {
  if (typeof value !== "string" || !isAbsolute(value) || isInside(repositoryRoot, value)) {
    throw new Error(`${label} must be an absolute path outside the repository`);
  }
  return resolve(value);
}

function parseUser(value: unknown, repositoryRoot: string): LiveAcceptanceUserInput {
  if (!isRecord(value) || !hasExactKeys(value, [
    "label",
    "userId",
    "storageStatePath",
    "supabaseAccessToken",
    "ownedSpaceId",
  ])) {
    throw new Error("Invalid live acceptance user fixture");
  }
  if (typeof value.label !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value.label)) {
    throw new Error("Invalid live acceptance user label");
  }
  if (typeof value.userId !== "string" || !UUID.test(value.userId) ||
      typeof value.ownedSpaceId !== "string" || !UUID.test(value.ownedSpaceId)) {
    throw new Error("Invalid live acceptance UUID");
  }
  return {
    label: value.label,
    userId: value.userId,
    storageStatePath: externalAbsolutePath(
      value.storageStatePath,
      repositoryRoot,
      "storageStatePath",
    ),
    supabaseAccessToken: privateCredential(
      value.supabaseAccessToken,
      "supabaseAccessToken",
    ),
    ownedSpaceId: value.ownedSpaceId,
  };
}

export function parseLiveAcceptanceFixture(
  value: unknown,
  { repositoryRoot }: ParseOptions,
): ParsedLiveAcceptanceFixture {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "resource",
    "supabaseUrl",
    "supabaseAnonKey",
    "subjectMismatchBearer",
    "users",
  ])) {
    throw new Error("Invalid live acceptance fixture");
  }
  if (value.version !== 1 || value.resource !== LIVE_RESOURCE ||
      !Array.isArray(value.users) || value.users.length !== 2) {
    throw new Error("Invalid live acceptance fixture contract");
  }
  let supabaseUrl: URL;
  try {
    supabaseUrl = new URL(String(value.supabaseUrl));
  } catch {
    throw new Error("Invalid Supabase URL");
  }
  if (supabaseUrl.origin !== LIVE_SUPABASE_ORIGIN ||
      supabaseUrl.href.replace(/\/$/, "") !== LIVE_SUPABASE_ORIGIN) {
    throw new Error("Supabase URL must be the approved production origin");
  }
  const users = value.users.map((user) => parseUser(user, repositoryRoot)) as [
    LiveAcceptanceUserInput,
    LiveAcceptanceUserInput,
  ];
  if (new Set(users.map((user) => user.label)).size !== 2 ||
      new Set(users.map((user) => user.userId)).size !== 2 ||
      new Set(users.map((user) => user.ownedSpaceId)).size !== 2 ||
      new Set(users.map((user) => user.supabaseAccessToken)).size !== 2) {
    throw new Error("Live acceptance users must be distinct");
  }
  return {
    version: 1,
    resource: LIVE_RESOURCE,
    supabaseUrl: LIVE_SUPABASE_ORIGIN,
    supabaseAnonKey: privateCredential(value.supabaseAnonKey, "supabaseAnonKey"),
    subjectMismatchBearer: privateCredential(
      value.subjectMismatchBearer,
      "subjectMismatchBearer",
    ),
    users,
  };
}

async function readPrivateExternalJson(
  path: string,
  repositoryRoot: string,
  maxBytes: number,
): Promise<{
  value: unknown;
  canonicalPath: string;
  identity: { dev: bigint; ino: bigint };
}> {
  const requested = externalAbsolutePath(path, repositoryRoot, "fixture path");
  const canonical = await realpath(requested);
  if (isInside(await realpath(repositoryRoot), canonical)) {
    throw new Error("Live acceptance input resolved inside the repository");
  }
  const handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat({ bigint: true });
    const canonicalMetadata = await lstat(canonical, { bigint: true });
    const expectedUid = BigInt(process.getuid?.() ?? -1);
    if (!metadata.isFile() || metadata.uid !== expectedUid ||
        (metadata.mode & BigInt(0o777)) !== BigInt(0o600) ||
        metadata.size < BigInt(2) ||
        metadata.size > BigInt(maxBytes) ||
        canonicalMetadata.dev !== metadata.dev || canonicalMetadata.ino !== metadata.ino) {
      throw new Error("Live acceptance input must be a private owned regular file");
    }
    const text = await handle.readFile({ encoding: "utf8" });
    return {
      value: JSON.parse(text),
      canonicalPath: canonical,
      identity: { dev: metadata.dev, ino: metadata.ino },
    };
  } catch {
    throw new Error("Live acceptance input must be valid JSON");
  } finally {
    await handle.close();
  }
}

function validateStorageState(value: unknown): asserts value is StorageState {
  if (!isRecord(value) || !hasExactKeys(value, ["cookies", "origins"]) ||
      !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    throw new Error("Invalid Playwright storage-state schema");
  }
  for (const cookie of value.cookies) {
    const cookieKeys = [
      "name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite",
    ];
    if (!isRecord(cookie) || !hasExactKeys(cookie, cookieKeys) ||
        typeof cookie.name !== "string" || typeof cookie.value !== "string" ||
        typeof cookie.domain !== "string" || typeof cookie.path !== "string" ||
        typeof cookie.expires !== "number" || typeof cookie.httpOnly !== "boolean" ||
        typeof cookie.secure !== "boolean" ||
        !["Strict", "Lax", "None"].includes(String(cookie.sameSite))) {
      throw new Error("Invalid Playwright cookie schema");
    }
  }
  for (const origin of value.origins) {
    if (!isRecord(origin) || !hasExactKeys(origin, ["origin", "localStorage"]) ||
        typeof origin.origin !== "string" || !Array.isArray(origin.localStorage) ||
        !origin.localStorage.every((entry) => isRecord(entry) &&
          hasExactKeys(entry, ["name", "value"]) &&
          typeof entry.name === "string" && typeof entry.value === "string")) {
      throw new Error("Invalid Playwright origin schema");
    }
  }
}

export async function loadLiveAcceptanceFixture(
  fixturePath: string,
  options: ParseOptions,
): Promise<LiveAcceptanceFixture> {
  const raw = await readPrivateExternalJson(
    fixturePath,
    options.repositoryRoot,
    MAX_FIXTURE_BYTES,
  );
  const fixture = parseLiveAcceptanceFixture(raw.value, options);
  const users = [] as LiveAcceptanceUser[];
  const storageFiles: Array<{ canonicalPath: string; identity: { dev: bigint; ino: bigint } }> = [];
  for (const user of fixture.users) {
    const storageFile = await readPrivateExternalJson(
      user.storageStatePath,
      options.repositoryRoot,
      MAX_STORAGE_STATE_BYTES,
    );
    validateStorageState(storageFile.value);
    storageFiles.push(storageFile);
    users.push({
      label: user.label,
      userId: user.userId,
      supabaseAccessToken: user.supabaseAccessToken,
      ownedSpaceId: user.ownedSpaceId,
      storageState: storageFile.value,
    });
  }
  if (storageFiles[0]!.canonicalPath === storageFiles[1]!.canonicalPath ||
      (storageFiles[0]!.identity.dev === storageFiles[1]!.identity.dev &&
       storageFiles[0]!.identity.ino === storageFiles[1]!.identity.ino)) {
    throw new Error("Live acceptance storage states must be distinct files");
  }
  return {
    ...fixture,
    users: users as [LiveAcceptanceUser, LiveAcceptanceUser],
  };
}

async function withSuppressedOutput<T>(action: () => Promise<T>): Promise<T> {
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const previousConsole = methods.map((method) => console[method]);
  const previousStdout = process.stdout.write;
  const previousStderr = process.stderr.write;
  for (const method of methods) console[method] = () => undefined;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await action();
  } catch {
    throw new Error("Secret-safe live facade acceptance failed");
  } finally {
    methods.forEach((method, index) => { console[method] = previousConsole[index]!; });
    process.stdout.write = previousStdout;
    process.stderr.write = previousStderr;
  }
}

async function authorizeWithStorageState(
  browser: Browser,
  user: LiveAcceptanceUser,
  resource: string,
) {
  let context: BrowserContext | undefined;
  const reports: Array<{ pass?: boolean }> = [];
  const privateResults = createPrivateProbeResultChannel();
  try {
    context = await browser.newContext({ storageState: user.storageState });
    const page = await context.newPage();
    page.on("console", () => undefined);
    page.on("pageerror", () => undefined);
    await runProbe({
      env: {
        NODE_ENV: "test",
        TABLOOM_MCP_RESOURCE_URL: resource,
        TABLOOM_MCP_OAUTH_TIMEOUT_MS: "300000",
      },
      handoffAuthorization: async (authorizationUrl: string) => {
        await page.goto(authorizationUrl, { waitUntil: "domcontentloaded" });
        await page.waitForURL(`${resource}/oauth/consent`, { timeout: 300_000 });
        const approve = page.locator('button[name="action"][value="approve"]');
        await Promise.all([
          page.waitForURL((url) => url.hostname === "127.0.0.1", { timeout: 300_000 }),
          approve.click(),
        ]);
      },
      writeReport: async (report: { pass?: boolean }) => { reports.push(report); },
      privateResultChannel: privateResults.channel,
      log: () => undefined,
    });
    if (reports.at(-1)?.pass !== true) throw new Error("Probe did not pass");
    const result = privateResults.take() as ProbePrivateResult;
    if (result.first.verified.payload.sub !== user.userId ||
        result.rotated.verified.payload.sub !== user.userId ||
        result.first.accessToken === result.rotated.accessToken) {
      throw new Error("Facade subject did not match the browser fixture user");
    }
    return result;
  } finally {
    await context?.close();
  }
}

function supabaseClientFor(
  fixture: LiveAcceptanceFixture,
  user: LiveAcceptanceUser,
): SupabaseClient {
  return createClient(LIVE_SUPABASE_ORIGIN, fixture.supabaseAnonKey, {
    accessToken: async () => user.supabaseAccessToken,
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { fetch: createExactSupabaseFetch() },
  });
}

async function verifySupabaseSubject(fixture: LiveAcceptanceFixture, user: LiveAcceptanceUser) {
  const client = supabaseClientFor(fixture, user);
  const { data, error } = await client.auth.getUser(user.supabaseAccessToken);
  if (error || data.user?.id !== user.userId) {
    throw new Error("Supabase subject did not match fixture user");
  }
}

function repositoryFor(fixture: LiveAcceptanceFixture, user: LiveAcceptanceUser) {
  const client = supabaseClientFor(fixture, user);
  return {
    client,
    repository: new SupabaseWorkspaceRepository(client, user.userId),
  };
}

async function verifyTwoUserRls(fixture: LiveAcceptanceFixture) {
  const [userA, userB] = fixture.users;
  const a = repositoryFor(fixture, userA);
  const b = repositoryFor(fixture, userB);
  const [workspaceA, workspaceB] = await Promise.all([
    a.repository.load(),
    b.repository.load(),
  ]);
  const aIds = new Set(workspaceA.spaces.map((space) => space.id));
  const bIds = new Set(workspaceB.spaces.map((space) => space.id));
  if (!aIds.has(userA.ownedSpaceId) || aIds.has(userB.ownedSpaceId) ||
      !bIds.has(userB.ownedSpaceId) || bIds.has(userA.ownedSpaceId) ||
      workspaceA.spaces.some((space) => space.user_id !== userA.userId) ||
      workspaceB.spaces.some((space) => space.user_id !== userB.userId)) {
    throw new Error("Two-user RLS isolation failed");
  }
  const originalB = workspaceB.spaces.find((space) => space.id === userB.ownedSpaceId)!;
  const sentinel = `forbidden-${randomUUID()}`;
  const denied = await a.client
    .from("spaces")
    .update({ name: sentinel })
    .eq("id", userB.ownedSpaceId)
    .select("id,name");
  if (denied.error || !Array.isArray(denied.data) || denied.data.length !== 0) {
    throw new Error("Cross-user RLS update was not denied");
  }
  const afterDeniedUpdate = await b.repository.load();
  const reloadedB = afterDeniedUpdate.spaces.find((space) => space.id === userB.ownedSpaceId);
  if (!reloadedB || reloadedB.name !== originalB.name || reloadedB.name === sentinel) {
    throw new Error("Cross-user RLS update changed the owner record");
  }
}

async function verifySubjectMismatch(
  fixture: LiveAcceptanceFixture,
  userAResult: ProbePrivateResult,
  userBResult: ProbePrivateResult,
) {
  const [userA, userB] = fixture.users;
  await verifySubjectMismatchBearer({
    mismatchBearer: fixture.subjectMismatchBearer,
    userAAccessToken: userAResult.rotated.accessToken,
    userBAccessToken: userBResult.rotated.accessToken,
    expectedUserAId: userA.userId,
    expectedUserBId: userB.userId,
    jwks: userAResult.jwks,
    resource: fixture.resource,
  });
  const response = await probeRequest(`${fixture.resource}/api/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixture.subjectMismatchBearer}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_service_status", arguments: {} },
    }),
  });
  if (response.status !== 401) throw new Error("Subject mismatch was not rejected");
}

export async function runMcpFacadeLiveAcceptance(options: {
  browser: Browser;
  fixture: LiveAcceptanceFixture;
}) {
  return withSuppressedOutput(async () => {
    const results = await Promise.all(options.fixture.users.map(async (user) => {
      await verifySupabaseSubject(options.fixture, user);
      return authorizeWithStorageState(
        options.browser,
        user,
        options.fixture.resource,
      );
    }));
    const allAccessTokens = results.flatMap((result) => [
      result.first.accessToken,
      result.rotated.accessToken,
    ]);
    if (new Set(allAccessTokens).size !== allAccessTokens.length) {
      throw new Error("Two-user browser OAuth results were not distinct");
    }
    await verifySubjectMismatch(options.fixture, results[0]!, results[1]!);
    await verifyTwoUserRls(options.fixture);
  });
}
