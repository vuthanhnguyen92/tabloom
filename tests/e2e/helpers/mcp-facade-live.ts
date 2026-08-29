import type { Browser, BrowserContext, BrowserContextOptions } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { SupabaseWorkspaceRepository } from "../../../shared/repository";
import {
  createPrivateProbeResultChannel,
  beginProbeAcceptance,
  probeRequest,
} from "../../../scripts/probe-mcp-oauth.mjs";
import {
  createLocalJWKSet,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from "jose";
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
  ownedCollectionId: string;
  ownedLinkId: string;
};

export type ParsedLiveAcceptanceFixture = {
  version: 1;
  resource: typeof LIVE_RESOURCE;
  supabaseUrl: string;
  supabaseAnonKey: string;
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

async function verifyFacadeBearer(
  token: string,
  jwks: { keys: JsonWebKey[] },
  resource: string,
  now: number,
) {
  const result = await jwtVerify(token, createLocalJWKSet(jwks), {
    algorithms: ["ES256"],
    issuer: resource,
    audience: resource,
    currentDate: new Date(now * 1000),
    requiredClaims: [...ACCESS_TOKEN_CLAIMS],
  });
  if (!hasExactKeys(result.protectedHeader as JsonRecord, ["alg", "kid", "typ"]) ||
      result.protectedHeader.alg !== "ES256" ||
      result.protectedHeader.typ !== "at+jwt" ||
      typeof result.protectedHeader.kid !== "string") {
    throw new Error("Invalid facade access-token header");
  }
  validFacadePayload(result.payload, resource, now);
  return result;
}

type SubjectMismatchInput = {
  mismatchBearer: string;
  userAAccessToken: string;
  userBAccessToken: string;
  expectedUserAId: string;
  expectedUserBId: string;
  jwks: { keys: JsonWebKey[] };
  resource: string;
  now?: number;
};

export async function verifySubjectMismatchBearer(
  input: SubjectMismatchInput,
): Promise<void> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (new Set([
    input.mismatchBearer,
    input.userAAccessToken,
    input.userBAccessToken,
  ]).size !== 3) {
    throw new Error("Facade acceptance tokens must be distinct");
  }
  const [mismatch, userA, userB] = await Promise.all([
    verifyFacadeBearer(input.mismatchBearer, input.jwks, input.resource, now),
    verifyFacadeBearer(input.userAAccessToken, input.jwks, input.resource, now),
    verifyFacadeBearer(input.userBAccessToken, input.jwks, input.resource, now),
  ]);
  if (input.expectedUserAId === input.expectedUserBId ||
      userA.payload.sub !== input.expectedUserAId ||
      userB.payload.sub !== input.expectedUserBId ||
      mismatch.payload.sub !== input.expectedUserAId ||
      userA.payload.supabase_token === userB.payload.supabase_token ||
      mismatch.payload.supabase_token !== userB.payload.supabase_token ||
      mismatch.payload.supabase_token === userA.payload.supabase_token ||
      mismatch.payload.client_id !== userA.payload.client_id ||
      mismatch.payload.grant_id !== userA.payload.grant_id ||
      mismatch.payload.iat !== userA.payload.iat ||
      mismatch.payload.nbf !== userA.payload.nbf ||
      mismatch.payload.exp !== userA.payload.exp ||
      mismatch.payload.jti === userA.payload.jti ||
      mismatch.payload.jti === userB.payload.jti ||
      JSON.stringify(mismatch.protectedHeader) !== JSON.stringify(userA.protectedHeader)) {
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
    "ownedCollectionId",
    "ownedLinkId",
  ])) {
    throw new Error("Invalid live acceptance user fixture");
  }
  if (typeof value.label !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value.label)) {
    throw new Error("Invalid live acceptance user label");
  }
  if (typeof value.userId !== "string" || !UUID.test(value.userId) ||
      typeof value.ownedSpaceId !== "string" || !UUID.test(value.ownedSpaceId) ||
      typeof value.ownedCollectionId !== "string" || !UUID.test(value.ownedCollectionId) ||
      typeof value.ownedLinkId !== "string" || !UUID.test(value.ownedLinkId)) {
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
    ownedCollectionId: value.ownedCollectionId,
    ownedLinkId: value.ownedLinkId,
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
      new Set(users.flatMap((user) => [
        user.ownedSpaceId,
        user.ownedCollectionId,
        user.ownedLinkId,
      ])).size !== 6 ||
      new Set(users.map((user) => user.supabaseAccessToken)).size !== 2) {
    throw new Error("Live acceptance users must be distinct");
  }
  return {
    version: 1,
    resource: LIVE_RESOURCE,
    supabaseUrl: LIVE_SUPABASE_ORIGIN,
    supabaseAnonKey: privateCredential(value.supabaseAnonKey, "supabaseAnonKey"),
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
    const bytes = await handle.readFile();
    try {
      return {
        value: JSON.parse(bytes.toString("utf8")),
        canonicalPath: canonical,
        identity: { dev: metadata.dev, ino: metadata.ino },
      };
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw new Error("Live acceptance input must be valid JSON");
  } finally {
    await handle.close();
  }
}

const PRIVATE_JWK_KEYS = ["alg", "crv", "d", "kty", "x", "y"] as const;
const PUBLIC_JWK_KEYS = ["alg", "crv", "kid", "kty", "use", "x", "y"] as const;

export async function loadAcceptanceMismatchSigner(
  signingKeyPath: string,
  options: ParseOptions,
) {
  const loaded = await readPrivateExternalJson(
    signingKeyPath,
    options.repositoryRoot,
    MAX_FIXTURE_BYTES,
  );
  let document = loaded.value;
  if (!isRecord(document) || !hasExactKeys(document, [
    "version", "active", "kid", "privateJwk",
  ]) || document.version !== 1 || document.active !== true ||
      typeof document.kid !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(document.kid) ||
      !isRecord(document.privateJwk) ||
      !hasExactKeys(document.privateJwk, PRIVATE_JWK_KEYS) ||
      document.privateJwk.kty !== "EC" ||
      document.privateJwk.crv !== "P-256" ||
      document.privateJwk.alg !== "ES256") {
    throw new Error("Invalid live acceptance signing-key schema");
  }
  const parsedJwk = document.privateJwk;
  if (!["x", "y", "d"].every((name) =>
    typeof parsedJwk[name] === "string" &&
    /^[A-Za-z0-9_-]+$/.test(String(parsedJwk[name])))) {
    throw new Error("Invalid live acceptance signing-key schema");
  }
  const kid = document.kid;
  let privateJwk: JsonRecord | undefined = parsedJwk;
  const expectedPublic = {
    kty: "EC",
    crv: "P-256",
    x: privateJwk.x,
    y: privateJwk.y,
    alg: "ES256",
    use: "sig",
    kid,
  };
  let privateKey: Awaited<ReturnType<typeof importJWK>> | undefined =
    await importJWK({ ...privateJwk }, "ES256");
  document = undefined;
  privateJwk = undefined;
  let used = false;

  return Object.freeze({
    async sign(input: Omit<SubjectMismatchInput, "mismatchBearer">) {
      if (used || !privateKey) {
        throw new Error("Live acceptance signer is no longer available");
      }
      used = true;
      const signingKey = privateKey;
      try {
        const now = input.now ?? Math.floor(Date.now() / 1000);
        const [userA, userB] = await Promise.all([
          verifyFacadeBearer(input.userAAccessToken, input.jwks, input.resource, now),
          verifyFacadeBearer(input.userBAccessToken, input.jwks, input.resource, now),
        ]);
        if (userA.payload.sub !== input.expectedUserAId ||
            userB.payload.sub !== input.expectedUserBId ||
            input.expectedUserAId === input.expectedUserBId ||
            userA.payload.supabase_token === userB.payload.supabase_token ||
            userA.protectedHeader.kid !== kid) {
          throw new Error("Fresh facade tokens did not match acceptance users");
        }
        const publishedMatches = input.jwks.keys.filter((key) =>
          isRecord(key) && hasExactKeys(key, PUBLIC_JWK_KEYS) &&
          PUBLIC_JWK_KEYS.every((name) => key[name] === expectedPublic[name]));
        if (publishedMatches.length !== 1) {
          throw new Error("Acceptance signing key did not exactly match live JWKS");
        }
        const mismatchBearer = await new SignJWT({
          ...userA.payload,
          jti: randomBytes(32).toString("base64url"),
          supabase_token: userB.payload.supabase_token,
        }).setProtectedHeader({ ...userA.protectedHeader }).sign(signingKey);
        await verifySubjectMismatchBearer({ ...input, mismatchBearer, now });
        return mismatchBearer;
      } finally {
        privateKey = undefined;
      }
    },
  });
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
      ownedCollectionId: user.ownedCollectionId,
      ownedLinkId: user.ownedLinkId,
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
  let phase: Awaited<ReturnType<typeof beginProbeAcceptance>> | undefined;
  const reports: Array<{
    refreshReplayRejected?: boolean;
    mcpBeforeRevocationResult?: string;
  }> = [];
  const privateResults = createPrivateProbeResultChannel();
  try {
    context = await browser.newContext({ storageState: user.storageState });
    const page = await context.newPage();
    page.on("console", () => undefined);
    page.on("pageerror", () => undefined);
    phase = await beginProbeAcceptance({
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
      writeReport: async (report: {
        refreshReplayRejected?: boolean;
        mcpBeforeRevocationResult?: string;
      }) => { reports.push(report); },
      privateResultChannel: privateResults.channel,
      log: () => undefined,
    });
    if (reports.at(-1)?.refreshReplayRejected !== true ||
        reports.at(-1)?.mcpBeforeRevocationResult !== "success") {
      throw new Error("Probe did not reach an active verified grant");
    }
    const result = privateResults.take() as ProbePrivateResult;
    if (result.first.verified.payload.sub !== user.userId ||
        result.rotated.verified.payload.sub !== user.userId ||
        result.first.accessToken === result.rotated.accessToken) {
      throw new Error("Facade subject did not match the browser fixture user");
    }
    return { phase, result };
  } catch (error) {
    if (phase) await phase.complete().catch(() => undefined);
    throw error;
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
  const assertIsolated = (
    workspace: typeof workspaceA,
    owner: LiveAcceptanceUser,
    foreign: LiveAcceptanceUser,
  ) => {
    const expectations = [
      [workspace.spaces, owner.ownedSpaceId, foreign.ownedSpaceId],
      [workspace.collections, owner.ownedCollectionId, foreign.ownedCollectionId],
      [workspace.links, owner.ownedLinkId, foreign.ownedLinkId],
    ] as const;
    for (const [records, expectedId, foreignId] of expectations) {
      const ids = new Set(records.map((record) => record.id));
      if (!ids.has(expectedId) || ids.has(foreignId) ||
          records.some((record) => record.user_id !== owner.userId)) {
        throw new Error("Two-user RLS isolation failed");
      }
    }
    const collection = workspace.collections.find(
      (record) => record.id === owner.ownedCollectionId,
    );
    const link = workspace.links.find((record) => record.id === owner.ownedLinkId);
    if (collection?.space_id !== owner.ownedSpaceId ||
        link?.collection_id !== owner.ownedCollectionId) {
      throw new Error("Live acceptance records were not independently owned");
    }
  };
  assertIsolated(workspaceA, userA, userB);
  assertIsolated(workspaceB, userB, userA);

  const originalB = {
    space: workspaceB.spaces.find((record) => record.id === userB.ownedSpaceId),
    collection: workspaceB.collections.find(
      (record) => record.id === userB.ownedCollectionId,
    ),
    link: workspaceB.links.find((record) => record.id === userB.ownedLinkId),
  };
  if (!originalB.space || !originalB.collection || !originalB.link) {
    throw new Error("Live acceptance owner records were missing");
  }
  const deniedUpdates = await Promise.all([
    a.client.from("spaces").update({ name: originalB.space.name })
      .eq("id", userB.ownedSpaceId).select("id"),
    a.client.from("collections").update({ name: originalB.collection.name })
      .eq("id", userB.ownedCollectionId).select("id"),
    a.client.from("links").update({ title: originalB.link.title })
      .eq("id", userB.ownedLinkId).select("id"),
  ]);
  if (deniedUpdates.some((denied) => denied.error ||
      !Array.isArray(denied.data) || denied.data.length !== 0)) {
    throw new Error("Cross-user RLS no-op update was not denied");
  }
  const afterDeniedUpdate = await b.repository.load();
  assertIsolated(afterDeniedUpdate, userB, userA);
  const reloadedB = {
    space: afterDeniedUpdate.spaces.find((record) => record.id === userB.ownedSpaceId),
    collection: afterDeniedUpdate.collections.find(
      (record) => record.id === userB.ownedCollectionId,
    ),
    link: afterDeniedUpdate.links.find((record) => record.id === userB.ownedLinkId),
  };
  if (JSON.stringify(reloadedB) !== JSON.stringify(originalB)) {
    throw new Error("Cross-user RLS update changed an owner record");
  }
}

async function verifySubjectMismatch(
  fixture: LiveAcceptanceFixture,
  userAResult: ProbePrivateResult,
  userBResult: ProbePrivateResult,
  signer: Awaited<ReturnType<typeof loadAcceptanceMismatchSigner>>,
) {
  const [userA, userB] = fixture.users;
  const mismatchBearer = await signer.sign({
    userAAccessToken: userAResult.rotated.accessToken,
    userBAccessToken: userBResult.rotated.accessToken,
    expectedUserAId: userA.userId,
    expectedUserBId: userB.userId,
    jwks: userAResult.jwks,
    resource: fixture.resource,
  });
  await verifySubjectMismatchBearer({
    mismatchBearer,
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
      authorization: `Bearer ${mismatchBearer}`,
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

type CompletableProbePhase = { complete(): Promise<void> };

export async function completeLiveAcceptancePhases(
  phases: CompletableProbePhase[],
  activeChecks: () => Promise<void>,
) {
  let activeFailure: unknown;
  try {
    await activeChecks();
  } catch (error) {
    activeFailure = error;
  }
  const completions = await Promise.allSettled(
    phases.map((phase) => phase.complete()),
  );
  if (activeFailure) throw activeFailure;
  if (completions.some((completion) => completion.status === "rejected")) {
    throw new Error("Post-acceptance revocation failed");
  }
}

export async function runMcpFacadeLiveAcceptance(options: {
  browser: Browser;
  fixture: LiveAcceptanceFixture;
  signingKeyPath: string;
  repositoryRoot: string;
}) {
  return withSuppressedOutput(async () => {
    const signer = await loadAcceptanceMismatchSigner(options.signingKeyPath, {
      repositoryRoot: options.repositoryRoot,
    });
    const starts = await Promise.allSettled(options.fixture.users.map(async (user) => {
      await verifySupabaseSubject(options.fixture, user);
      return authorizeWithStorageState(
        options.browser,
        user,
        options.fixture.resource,
      );
    }));
    const active = starts.flatMap((start) =>
      start.status === "fulfilled" ? [start.value] : []);
    if (starts.some((start) => start.status === "rejected")) {
      await Promise.allSettled(active.map((entry) => entry.phase.complete()));
      throw new Error("Two-user active-grant setup failed");
    }
    const results = active.map((entry) => entry.result);
    const allAccessTokens = results.flatMap((result) => [
      result.first.accessToken,
      result.rotated.accessToken,
    ]);
    if (new Set(allAccessTokens).size !== allAccessTokens.length) {
      throw new Error("Two-user browser OAuth results were not distinct");
    }
    await completeLiveAcceptancePhases(
      active.map((entry) => entry.phase),
      async () => {
        await verifySubjectMismatch(
          options.fixture,
          results[0]!,
          results[1]!,
          signer,
        );
        await verifyTwoUserRls(options.fixture);
      },
    );
  });
}
