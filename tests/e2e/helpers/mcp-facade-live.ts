import type { Browser, BrowserContext, BrowserContextOptions } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { SupabaseWorkspaceRepository } from "../../../shared/repository";
import {
  createPrivateProbeResultChannel,
  beginProbeAcceptance,
  evaluateMcpServiceStatus,
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
  quiescentAcceptanceAccounts: true;
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
    "quiescentAcceptanceAccounts",
    "users",
  ])) {
    throw new Error("Invalid live acceptance fixture");
  }
  if (value.version !== 1 || value.resource !== LIVE_RESOURCE ||
      value.quiescentAcceptanceAccounts !== true ||
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
    quiescentAcceptanceAccounts: true,
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

type CompletableProbePhase = { complete(): Promise<void> };
type CleanupStatus = Readonly<{
  cleanupFailed: boolean;
  concurrentFixtureMutation?: boolean;
}>;
type CleanupStatusRecorder = (status: CleanupStatus) => void;

export function recordLiveProbeReport<T extends { cleanupFailed?: unknown }>(
  report: T,
  reports: T[],
  recordCleanupStatus: CleanupStatusRecorder,
) {
  recordCleanupStatus(Object.freeze({
    cleanupFailed: report.cleanupFailed === true,
  }));
  reports.push(report);
}

export async function withLiveCleanupCategory<T>(
  action: (recordCleanupStatus: CleanupStatusRecorder) => Promise<T>,
): Promise<T> {
  let cleanupFailed = false;
  let concurrentFixtureMutation = false;
  const recordCleanupStatus = (status: CleanupStatus) => {
    cleanupFailed ||= status.cleanupFailed;
    concurrentFixtureMutation ||= status.concurrentFixtureMutation === true;
  };
  try {
    return await withSuppressedOutput(() => action(recordCleanupStatus));
  } catch {
    if (concurrentFixtureMutation) {
      throw new Error(
        "Secret-safe live facade acceptance failed: concurrentFixtureMutation",
      );
    }
    throw new Error(cleanupFailed
      ? "Secret-safe live facade acceptance failed: cleanupFailed"
      : "Secret-safe live facade acceptance failed");
  }
}

async function settleProbeCompletions(
  phases: CompletableProbePhase[],
  recordCleanupStatus: CleanupStatusRecorder,
) {
  const completions = await Promise.allSettled(
    phases.map((phase) => phase.complete()),
  );
  const cleanupFailed = completions.some(
    (completion) => completion.status === "rejected",
  );
  recordCleanupStatus(Object.freeze({ cleanupFailed }));
  return cleanupFailed;
}

export async function closeBrowserContextWithActiveCleanup(
  context: { close(): Promise<void> },
  phase: CompletableProbePhase | undefined,
  recordCleanupStatus: CleanupStatusRecorder = () => undefined,
) {
  try {
    await context.close();
  } catch (primaryError) {
    if (phase) {
      await settleProbeCompletions([phase], recordCleanupStatus);
    }
    throw primaryError;
  }
}

class ConcurrentFixtureMutationError extends Error {
  constructor() {
    super("concurrentFixtureMutation");
  }
}

type RlsRecordKey = "space" | "collection" | "link";
type RlsRestorationSnapshot = Readonly<{
  records: Record<RlsRecordKey, JsonRecord>;
  sync: Readonly<{ revision: number; updated_at: string }>;
}>;

function equalJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withoutUpdatedAt(record: JsonRecord) {
  const businessFields = { ...record };
  delete businessFields.updated_at;
  return businessFields;
}

export function planRlsRestoration(input: {
  baseline: RlsRestorationSnapshot;
  current: RlsRestorationSnapshot;
  returnedRecords: readonly RlsRecordKey[];
  ambiguousRecords?: readonly RlsRecordKey[];
  expectedRecords?: Partial<Record<RlsRecordKey, JsonRecord>>;
}) {
  const returned = new Set(input.returnedRecords);
  const ambiguous = new Set(input.ambiguousRecords ?? []);
  if ([...returned].some((key) => ambiguous.has(key))) {
    throw new ConcurrentFixtureMutationError();
  }
  const restoreRecords: RlsRecordKey[] = [];
  let attributedWrites = returned.size;
  let unresolvedAmbiguousWrites = 0;
  for (const key of ["space", "collection", "link"] as const) {
    const baseline = input.baseline.records[key];
    const current = input.current.records[key];
    const expected = input.expectedRecords?.[key] ?? baseline;
    if (!returned.has(key) && !ambiguous.has(key)) {
      if (!equalJson(current, baseline)) throw new ConcurrentFixtureMutationError();
      continue;
    }
    if (ambiguous.has(key) && equalJson(current, baseline)) {
      unresolvedAmbiguousWrites += 1;
      continue;
    }
    if (!equalJson(withoutUpdatedAt(current), withoutUpdatedAt(expected))) {
      throw new ConcurrentFixtureMutationError();
    }
    if (ambiguous.has(key)) attributedWrites += 1;
    if (!equalJson(current, baseline)) restoreRecords.push(key);
  }

  const syncChanged = !equalJson(input.current.sync, input.baseline.sync);
  if (attributedWrites === 0) {
    if (syncChanged && unresolvedAmbiguousWrites === 0) {
      throw new ConcurrentFixtureMutationError();
    }
  } else if (syncChanged) {
    const revisionDelta = input.current.sync.revision - input.baseline.sync.revision;
    if (revisionDelta < attributedWrites ||
        revisionDelta > attributedWrites + unresolvedAmbiguousWrites ||
        typeof input.current.sync.updated_at !== "string") {
      throw new ConcurrentFixtureMutationError();
    }
  }
  if (attributedWrites === 0 && syncChanged) {
    const revisionDelta = input.current.sync.revision - input.baseline.sync.revision;
    if (revisionDelta < 1 || revisionDelta > unresolvedAmbiguousWrites ||
        typeof input.current.sync.updated_at !== "string") {
      throw new ConcurrentFixtureMutationError();
    }
  }
  return Object.freeze({
    restoreRecords: Object.freeze(restoreRecords),
    restoreSync: syncChanged,
  });
}

type RlsUpdateResult = { error: unknown; data: unknown };

export function evaluateRlsUpdateSettlements(
  settlements: readonly PromiseSettledResult<RlsUpdateResult>[],
) {
  const returnedRecords: RlsRecordKey[] = [];
  const ambiguousRecords: RlsRecordKey[] = [];
  let responseFailure = false;
  const keys = ["space", "collection", "link"] as const;
  settlements.forEach((settlement, index) => {
    const key = keys[index];
    if (!key) {
      responseFailure = true;
      return;
    }
    if (settlement.status === "rejected") {
      ambiguousRecords.push(key);
      responseFailure = true;
      return;
    }
    const result = settlement.value;
    if (result.error || !Array.isArray(result.data) || result.data.length > 1) {
      responseFailure = true;
      return;
    }
    if (result.data.length === 1) returnedRecords.push(key);
  });
  return Object.freeze({
    returnedRecords: Object.freeze(returnedRecords),
    ambiguousRecords: Object.freeze(ambiguousRecords),
    responseFailure,
  });
}

export function requireOptimisticRestorationRow(
  result: { error: unknown; data: unknown },
  label: string,
) {
  if (result.error || !Array.isArray(result.data)) {
    throw new Error(`${label} restoration failed`);
  }
  if (result.data.length !== 1) throw new ConcurrentFixtureMutationError();
}

export async function runRestorableRlsWriteCheck<T>(options: {
  capture(): Promise<T>;
  attempt(baseline: T): Promise<void>;
  restore(baseline: T): Promise<void>;
  verifyRestored(baseline: T): Promise<void>;
  recordCleanupStatus?: CleanupStatusRecorder;
}) {
  const baseline = await options.capture();
  let primaryError: unknown;
  try {
    await options.attempt(baseline);
  } catch (error) {
    primaryError = error;
  }
  let cleanupFailed = false;
  let concurrentFixtureMutation = false;
  try {
    await options.restore(baseline);
    await options.verifyRestored(baseline);
  } catch (error) {
    cleanupFailed = true;
    concurrentFixtureMutation = error instanceof ConcurrentFixtureMutationError;
  }
  options.recordCleanupStatus?.(Object.freeze({
    cleanupFailed,
    ...(concurrentFixtureMutation ? { concurrentFixtureMutation: true } : {}),
  }));
  if (concurrentFixtureMutation) {
    throw new Error("concurrentFixtureMutation");
  }
  if (cleanupFailed) throw new Error("Cross-user RLS cleanup failed");
  if (primaryError) throw primaryError;
}

async function authorizeWithStorageState(
  browser: Browser,
  user: LiveAcceptanceUser,
  resource: string,
  recordCleanupStatus: CleanupStatusRecorder,
) {
  let context: BrowserContext | undefined;
  let phase: Awaited<ReturnType<typeof beginProbeAcceptance>> | undefined;
  let acceptance: { phase: NonNullable<typeof phase>; result: ProbePrivateResult } | undefined;
  let primaryError: unknown;
  const reports: Array<{
    cleanupFailed?: boolean;
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
        cleanupFailed?: boolean;
        refreshReplayRejected?: boolean;
        mcpBeforeRevocationResult?: string;
      }) => {
        recordLiveProbeReport(report, reports, recordCleanupStatus);
      },
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
    acceptance = { phase, result };
  } catch (error) {
    primaryError = error;
    if (phase) {
      await settleProbeCompletions([phase], recordCleanupStatus);
    }
  }
  if (context) {
    try {
      await closeBrowserContextWithActiveCleanup(
        context,
        phase,
        recordCleanupStatus,
      );
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError) throw primaryError;
  if (!acceptance) throw new Error("Active probe result was unavailable");
  return acceptance;
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

async function verifyTwoUserRls(
  fixture: LiveAcceptanceFixture,
  recordCleanupStatus: CleanupStatusRecorder,
) {
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
  const originalRecords = {
    space: originalB.space,
    collection: originalB.collection,
    link: originalB.link,
  };
  const loadSyncState = async () => {
    const result = await b.client.from("workspace_sync_state")
      .select("revision,updated_at")
      .eq("user_id", userB.userId)
      .single();
    if (result.error || !isRecord(result.data) ||
        !Number.isSafeInteger(result.data.revision) ||
        typeof result.data.updated_at !== "string") {
      throw new Error("Workspace sync state could not be captured");
    }
    return {
      revision: result.data.revision as number,
      updated_at: result.data.updated_at,
    };
  };
  const targetRecords = (workspace: typeof workspaceB) => ({
    space: workspace.spaces.find((record) => record.id === userB.ownedSpaceId),
    collection: workspace.collections.find(
      (record) => record.id === userB.ownedCollectionId,
    ),
    link: workspace.links.find((record) => record.id === userB.ownedLinkId),
  });

  const restoreSnapshot = async (
    baseline: RlsRestorationSnapshot,
    returned: readonly RlsRecordKey[],
    ambiguous: readonly RlsRecordKey[],
    expectedRecords: Record<RlsRecordKey, JsonRecord>,
  ) => {
    const currentWorkspace = await b.repository.load();
    const current = targetRecords(currentWorkspace);
    if (!current.space || !current.collection || !current.link) {
      throw new ConcurrentFixtureMutationError();
    }
    const currentRecords = {
      space: current.space,
      collection: current.collection,
      link: current.link,
    };
    const currentSync = await loadSyncState();
    const plan = planRlsRestoration({
      baseline,
      current: { records: currentRecords, sync: currentSync },
      returnedRecords: returned,
      ambiguousRecords: ambiguous,
      expectedRecords,
    });
    if (plan.restoreRecords.includes("space")) {
      const restored = await b.client.from("spaces").update({
        name: baseline.records.space.name,
        color: baseline.records.space.color,
        position: baseline.records.space.position,
        created_at: baseline.records.space.created_at,
        updated_at: baseline.records.space.updated_at,
      }).eq("id", current.space.id)
        .eq("user_id", current.space.user_id)
        .eq("name", current.space.name)
        .eq("color", current.space.color)
        .eq("position", current.space.position)
        .eq("created_at", current.space.created_at)
        .eq("updated_at", current.space.updated_at)
        .select("id");
      requireOptimisticRestorationRow(restored, "Space");
    }
    if (plan.restoreRecords.includes("collection")) {
      const restored = await b.client.from("collections").update({
        space_id: baseline.records.collection.space_id,
        name: baseline.records.collection.name,
        position: baseline.records.collection.position,
        created_at: baseline.records.collection.created_at,
        updated_at: baseline.records.collection.updated_at,
      }).eq("id", current.collection.id)
        .eq("user_id", current.collection.user_id)
        .eq("space_id", current.collection.space_id)
        .eq("name", current.collection.name)
        .eq("position", current.collection.position)
        .eq("created_at", current.collection.created_at)
        .eq("updated_at", current.collection.updated_at)
        .select("id");
      requireOptimisticRestorationRow(restored, "Collection");
    }
    if (plan.restoreRecords.includes("link")) {
      let query = b.client.from("links").update({
        collection_id: baseline.records.link.collection_id,
        url: baseline.records.link.url,
        title: baseline.records.link.title,
        description: baseline.records.link.description,
        favicon_url: baseline.records.link.favicon_url,
        position: baseline.records.link.position,
        created_at: baseline.records.link.created_at,
        updated_at: baseline.records.link.updated_at,
      }).eq("id", current.link.id)
        .eq("user_id", current.link.user_id)
        .eq("collection_id", current.link.collection_id)
        .eq("url", current.link.url)
        .eq("title", current.link.title)
        .eq("description", current.link.description)
        .eq("position", current.link.position)
        .eq("created_at", current.link.created_at)
        .eq("updated_at", current.link.updated_at);
      query = current.link.favicon_url === null
        ? query.is("favicon_url", null)
        : query.eq("favicon_url", current.link.favicon_url);
      requireOptimisticRestorationRow(await query.select("id"), "Link");
    }
    let observedSyncForRestore = currentSync;
    if (plan.restoreRecords.length > 0) {
      const afterRecordRepairs = await loadSyncState();
      if (afterRecordRepairs.revision !==
            currentSync.revision + plan.restoreRecords.length) {
        throw new ConcurrentFixtureMutationError();
      }
      observedSyncForRestore = afterRecordRepairs;
    }
    if (plan.restoreSync || plan.restoreRecords.length > 0) {
      const restored = await b.client.from("workspace_sync_state").update({
        revision: baseline.sync.revision,
        updated_at: baseline.sync.updated_at,
      }).eq("user_id", userB.userId)
        .eq("revision", observedSyncForRestore.revision)
        .eq("updated_at", observedSyncForRestore.updated_at)
        .select("user_id");
      requireOptimisticRestorationRow(restored, "Workspace sync state");
    }
  };

  const verifySnapshot = async (baseline: RlsRestorationSnapshot) => {
    const restoredWorkspace = await b.repository.load();
    const restoredRecords = targetRecords(restoredWorkspace);
    const restoredSync = await loadSyncState();
    if (JSON.stringify(restoredRecords) !== JSON.stringify(baseline.records) ||
        JSON.stringify(restoredSync) !== JSON.stringify(baseline.sync)) {
      throw new ConcurrentFixtureMutationError();
    }
    assertIsolated(restoredWorkspace, userB, userA);
  };

  for (const target of [
    { key: "space", table: "spaces", field: "name", value: "Tabloom owner-write space", id: userB.ownedSpaceId },
    { key: "collection", table: "collections", field: "name", value: "Tabloom owner-write collection", id: userB.ownedCollectionId },
    { key: "link", table: "links", field: "title", value: "Tabloom owner-write link", id: userB.ownedLinkId },
  ] as const) {
    let ownerReturned: RlsRecordKey[] = [];
    let ownerAmbiguous: RlsRecordKey[] = [];
    let ownerExpected: Record<RlsRecordKey, JsonRecord> | undefined;
    await runRestorableRlsWriteCheck({
      capture: async () => {
        const workspace = await b.repository.load();
        const records = targetRecords(workspace);
        if (!records.space || !records.collection || !records.link) {
          throw new Error("Live acceptance owner records were missing");
        }
        return {
          records: {
            space: records.space,
            collection: records.collection,
            link: records.link,
          },
          sync: await loadSyncState(),
        };
      },
      attempt: async (baseline) => {
        const originalValue = baseline.records[target.key][target.field];
        if (typeof originalValue !== "string") {
          throw new Error("Owner RLS fixture field was invalid");
        }
        const changedValue = originalValue === target.value
          ? `${target.value} changed`
          : target.value;
        ownerExpected = {
          ...baseline.records,
          [target.key]: {
            ...baseline.records[target.key],
            [target.field]: changedValue,
          },
        };
        const [settled] = await Promise.allSettled([
          b.client.from(target.table).update({ [target.field]: changedValue })
            .eq("id", target.id)
            .eq("user_id", userB.userId)
            .select("*"),
        ]);
        if (settled.status === "rejected") {
          ownerAmbiguous = [target.key];
          throw new Error("Owner RLS update could not be evaluated");
        }
        const result = settled.value;
        if (result.error || !Array.isArray(result.data) || result.data.length !== 1 ||
            !isRecord(result.data[0]) || result.data[0].id !== target.id ||
            result.data[0].user_id !== userB.userId ||
            result.data[0][target.field] !== changedValue ||
            result.data[0][target.field] === originalValue) {
          throw new Error("Owner RLS update did not return the exact changed record");
        }
        ownerReturned = [target.key];
      },
      restore: async (baseline) => restoreSnapshot(
        baseline,
        ownerReturned,
        ownerAmbiguous,
        ownerExpected ?? baseline.records,
      ),
      verifyRestored: verifySnapshot,
      recordCleanupStatus,
    });
  }

  let returnedRecords: RlsRecordKey[] = [];
  let ambiguousRecords: RlsRecordKey[] = [];

  await runRestorableRlsWriteCheck({
    capture: async () => ({
      records: originalRecords,
      sync: await loadSyncState(),
    }),
    attempt: async () => {
      const deniedUpdates = await Promise.allSettled([
        a.client.from("spaces").update({ name: originalRecords.space.name })
          .eq("id", userB.ownedSpaceId).select("id"),
        a.client.from("collections").update({ name: originalRecords.collection.name })
          .eq("id", userB.ownedCollectionId).select("id"),
        a.client.from("links").update({ title: originalRecords.link.title })
          .eq("id", userB.ownedLinkId).select("id"),
      ]);
      const evaluation = evaluateRlsUpdateSettlements(deniedUpdates);
      returnedRecords = [...evaluation.returnedRecords];
      ambiguousRecords = [...evaluation.ambiguousRecords];
      if (evaluation.responseFailure) {
        throw new Error("Cross-user RLS no-op update could not be evaluated");
      }
      if (returnedRecords.length > 0) {
        throw new Error("Cross-user RLS no-op update was not denied");
      }
    },
    restore: async (baseline) => {
      const currentWorkspace = await b.repository.load();
      const current = targetRecords(currentWorkspace);
      if (!current.space || !current.collection || !current.link) {
        throw new ConcurrentFixtureMutationError();
      }
      const currentRecords = {
        space: current.space,
        collection: current.collection,
        link: current.link,
      };
      const currentSync = await loadSyncState();
      const plan = planRlsRestoration({
        baseline,
        current: { records: currentRecords, sync: currentSync },
        returnedRecords,
        ambiguousRecords,
        expectedRecords: baseline.records,
      });
      if (plan.restoreRecords.includes("space")) {
        const restored = await b.client.from("spaces").update({
          name: baseline.records.space.name,
          color: baseline.records.space.color,
          position: baseline.records.space.position,
          created_at: baseline.records.space.created_at,
          updated_at: baseline.records.space.updated_at,
        }).eq("id", current.space.id)
          .eq("user_id", current.space.user_id)
          .eq("name", current.space.name)
          .eq("color", current.space.color)
          .eq("position", current.space.position)
          .eq("created_at", current.space.created_at)
          .eq("updated_at", current.space.updated_at)
          .select("id");
        requireOptimisticRestorationRow(restored, "Space");
      }
      if (plan.restoreRecords.includes("collection")) {
        const restored = await b.client.from("collections").update({
          space_id: baseline.records.collection.space_id,
          name: baseline.records.collection.name,
          position: baseline.records.collection.position,
          created_at: baseline.records.collection.created_at,
          updated_at: baseline.records.collection.updated_at,
        }).eq("id", current.collection.id)
          .eq("user_id", current.collection.user_id)
          .eq("space_id", current.collection.space_id)
          .eq("name", current.collection.name)
          .eq("position", current.collection.position)
          .eq("created_at", current.collection.created_at)
          .eq("updated_at", current.collection.updated_at)
          .select("id");
        requireOptimisticRestorationRow(restored, "Collection");
      }
      if (plan.restoreRecords.includes("link")) {
        let query = b.client.from("links").update({
          collection_id: baseline.records.link.collection_id,
          url: baseline.records.link.url,
          title: baseline.records.link.title,
          description: baseline.records.link.description,
          favicon_url: baseline.records.link.favicon_url,
          position: baseline.records.link.position,
          created_at: baseline.records.link.created_at,
          updated_at: baseline.records.link.updated_at,
        }).eq("id", current.link.id)
          .eq("user_id", current.link.user_id)
          .eq("collection_id", current.link.collection_id)
          .eq("url", current.link.url)
          .eq("title", current.link.title)
          .eq("description", current.link.description)
          .eq("position", current.link.position)
          .eq("created_at", current.link.created_at)
          .eq("updated_at", current.link.updated_at);
        query = current.link.favicon_url === null
          ? query.is("favicon_url", null)
          : query.eq("favicon_url", current.link.favicon_url);
        const restored = await query.select("id");
        requireOptimisticRestorationRow(restored, "Link");
      }
      let observedSyncForRestore = currentSync;
      if (plan.restoreRecords.length > 0) {
        const afterRecordRepairs = await loadSyncState();
        if (afterRecordRepairs.revision !==
              currentSync.revision + plan.restoreRecords.length) {
          throw new ConcurrentFixtureMutationError();
        }
        observedSyncForRestore = afterRecordRepairs;
      }
      if (plan.restoreSync || plan.restoreRecords.length > 0) {
        const restored = await b.client.from("workspace_sync_state").update({
          revision: baseline.sync.revision,
          updated_at: baseline.sync.updated_at,
        }).eq("user_id", userB.userId)
          .eq("revision", observedSyncForRestore.revision)
          .eq("updated_at", observedSyncForRestore.updated_at)
          .select("user_id");
        requireOptimisticRestorationRow(restored, "Workspace sync state");
      }
    },
    verifyRestored: async (baseline) => {
      const restoredWorkspace = await b.repository.load();
      const restoredRecords = targetRecords(restoredWorkspace);
      const restoredSync = await loadSyncState();
      if (JSON.stringify(restoredRecords) !== JSON.stringify(baseline.records) ||
          JSON.stringify(restoredSync) !== JSON.stringify(baseline.sync)) {
        throw new ConcurrentFixtureMutationError();
      }
      assertIsolated(restoredWorkspace, userB, userA);
    },
    recordCleanupStatus,
  });
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
  await verifyActiveBearerControlsAndMismatch({
    resource: fixture.resource,
    userAAccessToken: userAResult.rotated.accessToken,
    userBAccessToken: userBResult.rotated.accessToken,
    mismatchBearer,
  });
}

export async function verifyActiveBearerControlsAndMismatch(input: {
  resource: string;
  userAAccessToken: string;
  userBAccessToken: string;
  mismatchBearer: string;
  request?: typeof probeRequest;
}) {
  const request = input.request ?? probeRequest;
  const call = (accessToken: string, id: number) => request(
    `${input.resource}/api/mcp`,
    {
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
    },
  );
  const userAControl = await call(input.userAAccessToken, 101);
  if (!evaluateMcpServiceStatus(userAControl, 101)) {
    throw new Error("User A active-bearer MCP control failed");
  }
  const userBControl = await call(input.userBAccessToken, 102);
  if (!evaluateMcpServiceStatus(userBControl, 102)) {
    throw new Error("User B active-bearer MCP control failed");
  }
  const mismatch = await call(input.mismatchBearer, 103);
  if (mismatch.status !== 401) {
    throw new Error("Subject mismatch was not rejected while controls were active");
  }
}

export async function completeLiveAcceptancePhases(
  phases: CompletableProbePhase[],
  activeChecks: () => Promise<void>,
  recordCleanupStatus: CleanupStatusRecorder = () => undefined,
) {
  let activeFailure: unknown;
  try {
    await activeChecks();
  } catch (error) {
    activeFailure = error;
  }
  const cleanupFailed = await settleProbeCompletions(
    phases,
    recordCleanupStatus,
  );
  if (activeFailure) throw activeFailure;
  if (cleanupFailed) {
    throw new Error("Post-acceptance cleanup failed");
  }
}

export async function runMcpFacadeLiveAcceptance(options: {
  browser: Browser;
  fixture: LiveAcceptanceFixture;
  signingKeyPath: string;
  repositoryRoot: string;
}) {
  return withLiveCleanupCategory(async (recordCleanupStatus) => {
    const starts = await Promise.allSettled(options.fixture.users.map(async (user) => {
      await verifySupabaseSubject(options.fixture, user);
      return authorizeWithStorageState(
        options.browser,
        user,
        options.fixture.resource,
        recordCleanupStatus,
      );
    }));
    const active = starts.flatMap((start) =>
      start.status === "fulfilled" ? [start.value] : []);
    await completeLiveAcceptancePhases(
      active.map((entry) => entry.phase),
      async () => {
        if (starts.some((start) => start.status === "rejected")) {
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
        const signer = await loadAcceptanceMismatchSigner(
          options.signingKeyPath,
          { repositoryRoot: options.repositoryRoot },
        );
        await verifySubjectMismatch(
          options.fixture,
          results[0]!,
          results[1]!,
          signer,
        );
        await verifyTwoUserRls(options.fixture, recordCleanupStatus);
      },
      recordCleanupStatus,
    );
  });
}
