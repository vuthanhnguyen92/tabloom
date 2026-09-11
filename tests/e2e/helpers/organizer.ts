import { chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { organizerSnapshot } from "../fixtures/organizer";

export async function startOrganizerServer() {
  const server = await createServer({ configFile: false, plugins: [react()], define: { "process.env": "{}" }, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  return { url: `${server.resolvedUrls!.local[0]}tests/e2e/fixtures/organizer-web.html`, close: () => server.close() };
}

export function trackPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${message.text()} (${message.location().url})`); });
  return errors;
}

export async function ready(page: Page) {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect(page.getByRole("link", { name: /Product roadmap/ })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

export async function openExtension(extensionPath = resolve(process.env.TABLOOM_E2E_EXTENSION_PATH ?? "dist-extension/chromium"), accountOrigin?: string): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const profile = await mkdtemp(join(tmpdir(), "tabloom-organizer-acceptance-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const page = await context.newPage();
  const errors = trackPageErrors(page);
  const manifest = JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8"));
  const extensionId = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
  // Seed through the inert callback document before application bootstrap, so a
  // configured fixture never starts an unsolicited OAuth recovery attempt.
  await page.goto(`chrome-extension://${extensionId}/auth-callback.html`);
  await page.evaluate(async (snapshot) => {
    await chrome.storage.local.set({ "tabloom-local-workspace-v2": { version: 2, snapshot, bookmarkSources: [], cachedAt: "2026-09-10T00:00:00Z" } });
  }, organizerSnapshot());
  if (accountOrigin) await installAccountFixture(page, accountOrigin);
  await page.goto("chrome://newtab");
  await ready(page);
  return { context, page, errors };
}

export async function openTrash(page: Page, surface: "web" | "extension") {
  if (surface === "web") await page.getByLabel("Account", { exact: true }).click();
  else await page.getByRole("button", { name: "Open account menu", exact: true }).click();
  await page.getByRole(surface === "web" ? "button" : "menuitem", { name: "Trash", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Trash", exact: true })).toBeVisible();
}

export async function buildAccountExtension() {
  const requests: string[] = [];
  const unexpected: string[] = [];
  const { user, snapshot } = accountFixture();
  // Serve the synthetic API on loopback. Native extension requests are not
  // consistently intercepted by Playwright's Chromium context routing.
  const server = createHttpServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    const pathname = new URL(request.url!, "http://127.0.0.1").pathname;
    requests.push(pathname);
    let body: unknown;
    if (pathname === "/auth/v1/user") body = user;
    else if (pathname === "/rest/v1/rpc/get_workspace_revision") body = { revision: 4, serverTime: "2026-09-10T00:00:00Z" };
    else if (pathname === "/rest/v1/rpc/load_workspace_snapshot") body = { revision: 4, snapshot, tombstones: [] };
    else if (pathname === "/rest/v1/bookmark_sources") body = [];
    else { unexpected.push(pathname); response.writeHead(500).end(); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const path = await mkdtemp(join(tmpdir(), "tabloom-account-fixture-"));
  await promisify(execFile)("rtk", ["proxy", process.execPath, "node_modules/vite/bin/vite.js", "build", "--config", "extension/vite.config.ts", "--outDir", path], { env: { ...process.env, TABLOOM_BROWSER_TARGET: "chromium", VITE_SUPABASE_URL: origin, VITE_SUPABASE_ANON_KEY: "local-fixture-only" } });
  for (const name of ["manifest.json", "auth-callback.html", "icons"]) await cp(resolve("dist-extension/chromium", name), join(path, name), { recursive: true });
  const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
  manifest.host_permissions = [`${origin}/*`];
  manifest.content_security_policy.extension_pages = `script-src 'self'; object-src 'self'; connect-src 'self' ${origin}`;
  await writeFile(join(path, "manifest.json"), JSON.stringify(manifest));
  return { path, origin, requests, unexpected, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

function accountFixture() {
  const userId = "40000000-0000-4000-8000-000000000001";
  const snapshot = organizerSnapshot();
  for (const row of [...snapshot.spaces, ...snapshot.collections, ...snapshot.links]) row.user_id = userId;
  const user = { id: userId, email: "acceptance@example.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-10T00:00:00Z" };
  return { userId, snapshot, user };
}

async function installAccountFixture(page: Page, origin: string) {
  const { userId, snapshot, user } = accountFixture();
  // Accepted only by the loopback fixture, never a hosted account.
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const accessToken = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: userId, aud: "authenticated", role: "authenticated", exp: expiresAt })).toString("base64url")}.fixture-signature`;
  const session = { access_token: accessToken, refresh_token: "local-fixture-only", token_type: "bearer", expires_in: 3600, expires_at: expiresAt, user };
  const authKey = `sb-${new URL(origin).hostname.split(".")[0]}-auth-token`;
  await page.evaluate(async ({ authKey, session, userId, snapshot }) => {
    await chrome.storage.local.set({
      [authKey]: JSON.stringify(session),
      [`tabloom-cloud-workspace-v2:${userId}`]: { version: 2, snapshot, revision: 4, cachedAt: "2026-09-10T00:00:00Z" },
      [`tabloom-sync-outbox-v1:${userId}`]: { version: 1, outbox: [], nextSequence: 1 },
      [`tabloom-sync-state-v2:${userId}`]: { version: 2, phase: "synced", revision: 4 },
    });
  }, { authKey, session, userId, snapshot });
}

export async function dragRoadmapPreview(page: Page) {
  const source = (await page.getByRole("button", { name: "Drag Launch checklist", exact: true }).boundingBox())!;
  const target = (await page.getByRole("link", { name: /Product roadmap/ }).boundingBox())!;
  const x = target.x + 70;
  const y = target.y + 45;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x - 30, source.y, { steps: 4 });
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.move(x + 1, y + 1);
  await expect(page.locator(".ext-link-grid > .ext-link-drop-preview:first-child")).toHaveCount(1);
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".ext-link-drop-preview")), { x, y })).toBe(true);
  await page.mouse.move(x + 2, y + 1);
}

export async function dragCollectionPreview(page: Page) {
  const source = (await page.getByRole("button", { name: "Drag Build collection" }).boundingBox())!;
  const target = (await page.getByRole("group", { name: "Plan collection" }).boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x - 30, source.y, { steps: 4 });
  await page.mouse.move(target.x + 80, target.y + 10, { steps: 8 });
  await page.mouse.move(target.x + 81, target.y + 10);
  await expect.poll(async () => (await page.locator(".collection-drop-preview").boundingBox())?.y).toBeCloseTo(target.y, 0);
  await expect(page.locator(".collection-drop-preview")).toBeVisible();
  const slot = (await page.locator(".collection-drop-preview").boundingBox())!;
  const point = { x: slot.x + slot.width / 2, y: slot.y + slot.height / 2 };
  await page.mouse.move(point.x, point.y, { steps: 5 });
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".collection-drop-preview")), point)).toBe(true);
  await page.mouse.move(point.x + 1, point.y);
}
