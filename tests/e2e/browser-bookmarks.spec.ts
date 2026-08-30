import { expect, test, chromium, type BrowserContext, type Page } from "@playwright/test";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { twoDeviceFixture } from "./fixtures/bookmarks";

const extensionPath = resolve("dist-extension");

async function launchExtension(path = extensionPath): Promise<BrowserContext> {
  const profileDir = await mkdtemp(join(tmpdir(), "tabloom-e2e-"));
  return chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
  });
}

async function createBookmarkHarness() {
  const root = await mkdtemp(join(tmpdir(), "tabloom-bookmark-harness-"));
  const path = join(root, "extension");
  await cp(extensionPath, path, { recursive: true });
  const manifestPath = join(path, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.permissions = [...new Set([...(manifest.permissions ?? []), "bookmarks"])];
  manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((permission: string) => permission !== "bookmarks");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

async function signInWithTestSession(page: Page) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL!;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY!;
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.TABLOOM_E2E_USER_EMAIL, password: process.env.TABLOOM_E2E_USER_PASSWORD }),
  });
  if (!response.ok) throw new Error(`Test sign-in failed (${response.status}).`);
  const session = await response.json();
  const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: `sb-${projectRef}-auth-token`, value: JSON.stringify(session) });
  return session as { user: { id: string } };
}

async function installBookmarkFixture(page: Page, entries: readonly { title: string; url: string; folderPath: readonly string[] }[]) {
  await page.evaluate(async (fixture) => {
    const tree = await chrome.bookmarks.getTree();
    const root = tree[0]?.children?.find((node) => node.folderType === "bookmarks-bar") ?? tree[0]?.children?.[0];
    if (!root) throw new Error("Chrome bookmarks bar was not available.");
    const current = await chrome.bookmarks.getChildren(root.id);
    for (const child of current) {
      if (child.url) await chrome.bookmarks.remove(child.id);
      else await chrome.bookmarks.removeTree(child.id);
    }
    const folders = new Map<string, string>();
    for (const entry of fixture) {
      let parentId = root.id;
      let path = "";
      for (const segment of entry.folderPath) {
        path = path ? `${path} / ${segment}` : segment;
        let folderId = folders.get(path);
        if (!folderId) {
          folderId = (await chrome.bookmarks.create({ parentId, title: segment })).id;
          folders.set(path, folderId);
        }
        parentId = folderId;
      }
      await chrome.bookmarks.create({ parentId, title: entry.title, url: entry.url });
    }
  }, entries);
}

test("versioned build overrides Chrome's new-tab page", async () => {
  const manifest = JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8"));
  expect(manifest.version).toBe("0.6.0");
  expect(manifest.optional_permissions).toContain("bookmarks");
  expect(manifest.chrome_url_overrides.newtab).toBe("index.html");

  const context = await launchExtension();
  try {
    const page = await context.newPage();
    await page.goto("chrome://newtab");
    await expect(page.locator(".ext-brand")).toContainText("tabloom");
    await expect(page.getByRole("heading", { name: "Product launch" })).toBeVisible();
    await expect(page.getByText("Current tabs")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("account cache renders while Supabase is offline", async () => {
  const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "TABLOOM_E2E_USER_EMAIL", "TABLOOM_E2E_USER_PASSWORD"];
  test.skip(process.env.TABLOOM_E2E_LIVE !== "1" || required.some((name) => !process.env[name]), "Set the documented TABLOOM_E2E variables to run authenticated cached-startup coverage.");

  const context = await launchExtension();
  try {
    const page = await context.newPage();
    await page.goto("chrome://newtab");
    const session = await signInWithTestSession(page);
    const now = new Date().toISOString();
    const spaceId = "10000000-0000-4000-8000-000000000091";
    const collectionId = "20000000-0000-4000-8000-000000000091";
    const snapshot = {
      spaces: [{ id: spaceId, user_id: session.user.id, name: "Offline Space", color: "#7357e6", position: 0, created_at: now, updated_at: now, origin: "saved", read_only: false }],
      collections: [{ id: collectionId, user_id: session.user.id, space_id: spaceId, name: "Cached Collection", position: 0, created_at: now, updated_at: now, origin: "saved", read_only: false }],
      links: [{ id: "30000000-0000-4000-8000-000000000091", user_id: session.user.id, collection_id: collectionId, url: "https://cached.example/", title: "Cached while offline", description: "", favicon_url: null, position: 0, created_at: now, updated_at: now, origin: "saved", read_only: false, device_label: null }],
    };
    await page.evaluate(async ({ userId, cachedAt, value }) => {
      await chrome.storage.local.set({
        [`tabloom-cloud-workspace-v2:${userId}`]: { version: 2, snapshot: value, revision: 4, cachedAt },
        [`tabloom-sync-outbox-v1:${userId}`]: { version: 1, outbox: [], nextSequence: 1 },
        [`tabloom-sync-state-v2:${userId}`]: { version: 2, phase: "synced", revision: 4 },
      });
    }, { userId: session.user.id, cachedAt: now, value: snapshot });
    await context.route("**/*.supabase.co/**", (route) => route.abort("internetdisconnected"));

    await page.reload();

    await expect(page.getByText("Cached Collection", { exact: true })).toBeVisible();
    await expect(page.getByText("Cached while offline", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("manual bookmark snapshot appears in the extension and web workspace", async () => {
  const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "TABLOOM_E2E_USER_EMAIL", "TABLOOM_E2E_USER_PASSWORD"];
  test.skip(process.env.TABLOOM_E2E_LIVE !== "1" || required.some((name) => !process.env[name]), "Set the documented TABLOOM_E2E variables to run the authenticated headed acceptance test.");

  const harnessPath = await createBookmarkHarness();
  const context = await launchExtension(harnessPath);
  try {
    const extension = await context.newPage();
    await extension.goto("chrome://newtab");
    await signInWithTestSession(extension);
    await installBookmarkFixture(extension, twoDeviceFixture.mac.entries);
    await extension.reload();
    await extension.getByRole("button", { name: "Browser Bookmarks" }).click();
    await extension.getByRole("button", { name: /Sync browser bookmarks|Sync now/ }).click();
    const deviceName = extension.getByLabel("Device name");
    if (await deviceName.isVisible()) {
      await deviceName.fill(twoDeviceFixture.mac.name);
      await extension.getByRole("button", { name: "Start sync" }).click();
    }
    await expect(extension.getByText("Work / Design", { exact: true })).toBeVisible();
    await expect(extension.getByText("Unfiled bookmarks", { exact: true })).toBeVisible();

    const web = await context.newPage();
    await web.goto(process.env.TABLOOM_E2E_WEB_URL || "http://localhost:4173");
    await signInWithTestSession(web);
    await web.goto(`${process.env.TABLOOM_E2E_WEB_URL || "http://localhost:4173"}/app`);
    await web.getByRole("button", { name: "Browser Bookmarks" }).click();
    await expect(web.getByText("Work / Design", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("two-device bookmark fixture keeps shared and device-only records explicit", async () => {
  const shared = twoDeviceFixture.mac.entries.filter((entry) => twoDeviceFixture.home.entries.some((candidate) => candidate.url === entry.url && candidate.folderPath.join(" / ") === entry.folderPath.join(" / ")));
  expect(shared.map((entry) => entry.title)).toEqual(["Chrome docs"]);
  expect(twoDeviceFixture.mac.entries.find((entry) => entry.folderPath.length === 0)?.title).toBe("Direct reference");
  expect(twoDeviceFixture.home.entries.find((entry) => entry.title === "Personal reference")?.folderPath).toEqual(["Personal"]);
});
