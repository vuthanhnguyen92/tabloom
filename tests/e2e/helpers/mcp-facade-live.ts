import type { Browser, BrowserContext } from "@playwright/test";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { SupabaseWorkspaceRepository } from "../../../shared/repository";
import { probeRequest, runProbe } from "../../../scripts/probe-mcp-oauth.mjs";
import { createTabloomRequestContext } from "../../../services/tabloom-mcp/src/auth/request-context";

const LIVE_RESOURCE = "https://tabloom-mcp.vercel.app";
const MAX_FIXTURE_BYTES = 64 * 1024;
const MAX_STORAGE_STATE_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonRecord = Record<string, unknown>;

export type LiveAcceptanceUser = {
  label: string;
  userId: string;
  storageStatePath: string;
  supabaseAccessToken: string;
  ownedSpaceId: string;
};

export type LiveAcceptanceFixture = {
  version: 1;
  resource: typeof LIVE_RESOURCE;
  supabaseUrl: string;
  supabaseAnonKey: string;
  subjectMismatchBearer: string;
  users: [LiveAcceptanceUser, LiveAcceptanceUser];
};

type ParseOptions = { repositoryRoot: string };

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function parseUser(value: unknown, repositoryRoot: string): LiveAcceptanceUser {
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
): LiveAcceptanceFixture {
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
  if (supabaseUrl.protocol !== "https:" || supabaseUrl.origin !== supabaseUrl.href.replace(/\/$/, "")) {
    throw new Error("Supabase URL must be an HTTPS origin");
  }
  const users = value.users.map((user) => parseUser(user, repositoryRoot)) as [
    LiveAcceptanceUser,
    LiveAcceptanceUser,
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
    supabaseUrl: supabaseUrl.origin,
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
): Promise<unknown> {
  const requested = externalAbsolutePath(path, repositoryRoot, "fixture path");
  const metadata = await lstat(requested);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
      metadata.size < 2 || metadata.size > maxBytes) {
    throw new Error("Live acceptance input must be a private regular file");
  }
  const canonicalParent = await realpath(dirname(requested));
  const canonical = await realpath(requested);
  if (canonical !== resolve(canonicalParent, requested.split(sep).at(-1)!) ||
      isInside(await realpath(repositoryRoot), canonical)) {
    throw new Error("Live acceptance input resolved inside the repository");
  }
  try {
    return JSON.parse(await readFile(canonical, "utf8"));
  } catch {
    throw new Error("Live acceptance input must be valid JSON");
  }
}

function validateStorageState(value: unknown) {
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
  const fixture = parseLiveAcceptanceFixture(raw, options);
  for (const user of fixture.users) {
    const storageState = await readPrivateExternalJson(
      user.storageStatePath,
      options.repositoryRoot,
      MAX_STORAGE_STATE_BYTES,
    );
    validateStorageState(storageState);
  }
  return fixture;
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
  try {
    context = await browser.newContext({ storageState: user.storageStatePath });
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
      log: () => undefined,
    });
    if (reports.at(-1)?.pass !== true) throw new Error("Probe did not pass");
  } finally {
    await context?.close();
  }
}

async function verifySupabaseSubject(fixture: LiveAcceptanceFixture, user: LiveAcceptanceUser) {
  const response = await probeRequest(`${fixture.supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: fixture.supabaseAnonKey,
      authorization: `Bearer ${user.supabaseAccessToken}`,
    },
  });
  if (response.status !== 200 || !isRecord(response.body) || response.body.id !== user.userId) {
    throw new Error("Supabase subject did not match fixture user");
  }
}

function repositoryFor(fixture: LiveAcceptanceFixture, user: LiveAcceptanceUser) {
  const context = createTabloomRequestContext({
    authenticatedUserId: user.userId,
    authenticatedClientId: "live-acceptance",
    innerAccessToken: user.supabaseAccessToken,
  }, {
    supabaseUrl: new URL(fixture.supabaseUrl),
    anonKey: fixture.supabaseAnonKey,
  });
  return new SupabaseWorkspaceRepository(context.supabase, context.userId);
}

async function verifyTwoUserRls(fixture: LiveAcceptanceFixture) {
  const [userA, userB] = fixture.users;
  const [workspaceA, workspaceB] = await Promise.all([
    repositoryFor(fixture, userA).load(),
    repositoryFor(fixture, userB).load(),
  ]);
  const aIds = new Set(workspaceA.spaces.map((space) => space.id));
  const bIds = new Set(workspaceB.spaces.map((space) => space.id));
  if (!aIds.has(userA.ownedSpaceId) || aIds.has(userB.ownedSpaceId) ||
      !bIds.has(userB.ownedSpaceId) || bIds.has(userA.ownedSpaceId) ||
      workspaceA.spaces.some((space) => space.user_id !== userA.userId) ||
      workspaceB.spaces.some((space) => space.user_id !== userB.userId)) {
    throw new Error("Two-user RLS isolation failed");
  }
}

async function verifySubjectMismatch(fixture: LiveAcceptanceFixture) {
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
    await Promise.all(options.fixture.users.map(async (user) => {
      await verifySupabaseSubject(options.fixture, user);
      await authorizeWithStorageState(
        options.browser,
        user,
        options.fixture.resource,
      );
    }));
    await verifySubjectMismatch(options.fixture);
    await verifyTwoUserRls(options.fixture);
  });
}
