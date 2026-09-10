import { expect, test, type Page } from "@playwright/test";
import { buildAccountExtension, dragCollectionPreview, dragRoadmapPreview, openExtension, ready, startOrganizerServer, trackPageErrors } from "./helpers/organizer";

let server: Awaited<ReturnType<typeof startOrganizerServer>>;
test.beforeAll(async () => { server = await startOrganizerServer(); });
test.afterAll(async () => { await server?.close(); });

test("production web and installed extension share geometry and automatic themes", async ({ page: web }) => {
  const errors = trackPageErrors(web);
  await web.setViewportSize({ width: 1080, height: 900 });
  await web.goto(server.url);
  await ready(web);
  await expect(web.locator(".organizer-main h1")).toHaveCSS("font-weight", "700");
  const extension = await openExtension();
  try {
    // Give the organizer equal available width; the extension owns a 360px side panel.
    for (const selector of [".organizer-space-rail", ".organizer-main > header", '.ext-columns > article:first-child', ".ext-link-card:first-child"]) {
      const a = (await web.locator(selector).first().boundingBox())!;
      const b = (await extension.page.locator(selector).first().boundingBox())!;
      for (const dimension of ["x", "y", "width", "height"] as const) expect(b[dimension], `${selector} ${dimension}`).toBeCloseTo(a[dimension], 0);
    }
    await expect(web.getByRole("complementary", { name: "Current tabs" })).toHaveCount(0);
    await expect(web.getByRole("button", { name: /Browser Bookmarks|Sync browser bookmarks/ })).toHaveCount(0);
    await expect(extension.page.getByRole("complementary", { name: "Current tabs" })).toBeVisible();
    for (const name of ["Trash", "Add link to Plan"]) {
      await expect(extension.page.getByRole("button", { name, exact: true })).toHaveCSS("border-top-width", "0px");
      await expect(extension.page.getByRole("button", { name, exact: true })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    for (const page of [web, extension.page]) {
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await expect(page.locator(".organizer-brand")).toHaveCSS("font-weight", "700");
      await expect(page.locator(".ext-brand-mark")).toHaveCSS("width", "30px");
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
    }
    for (const page of [web, extension.page]) {
      const shell = page.locator(".organizer-shell");
      await expect(shell).toHaveCSS("background-color", "rgb(246, 243, 238)");
      await expect(shell).toHaveCSS("font-family", /Poppins/);
      await expect(page.locator(".organizer-main h1")).toHaveCSS("font-size", "26px");
      await expect(page.locator(".ext-link-card b").first()).toHaveCSS("font-weight", "500");
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(shell).not.toHaveCSS("background-color", "rgb(246, 243, 238)");
      await page.emulateMedia({ colorScheme: "light" });
      await expect(shell).toHaveCSS("background-color", "rgb(246, 243, 238)");
    }
    for (const theme of ["light", "dark"] as const) {
      await extension.page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await extension.page.mouse.move(0, 0);
      await extension.page.screenshot({ path: test.info().outputPath(`extension-${theme}.png`), animations: "disabled" });
      await expect.soft(extension.page).toHaveScreenshot(`extension-${theme}.png`, { animations: "disabled" });
    }
    await web.getByLabel("Account", { exact: true }).click();
    await expect(web.getByRole("status", { name: "Workspace sync" })).toContainText("Synced");
    await expect(web.getByRole("status", { name: "Workspace sync" })).toHaveCSS("color", "rgb(54, 179, 126)");
    await extension.page.getByRole("button", { name: "Collapse current tabs" }).click();
    await expect(extension.page.getByRole("complementary", { name: "Current tabs" })).toHaveCSS("width", "54px");
    await extension.page.setViewportSize({ width: 760, height: 740 });
    await expect(extension.page.getByRole("complementary", { name: "Current tabs" })).toHaveCSS("width", "48px");
    await expect(extension.page.getByRole("link", { name: /Product roadmap/ })).toBeVisible();
    expect(await extension.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    expect(extension.errors).toEqual([]);
  } finally { await extension.context.close(); }
});

test("configured extension retains native bookmark controls with isolated account transport", async () => {
  const fixture = await test.step("Build isolated account extension", () => buildAccountExtension());
  const extension = await test.step("Open installed extension with isolated account transport", () => openExtension(fixture.path, fixture.origin));
  try {
    expect(await extension.page.evaluate(() => Boolean(chrome.bookmarks))).toBe(false);
    await extension.page.getByRole("button", { name: /Browser Bookmarks/ }).click();
    await expect(extension.page.getByRole("button", { name: "Sync browser bookmarks" })).toBeVisible();
    await expect.poll(() => fixture.requests).toContain("/rest/v1/bookmark_sources");
    expect(fixture.unexpected).toEqual([]);
    expect(extension.errors).toEqual([]);
  } finally { await extension.context.close(); await fixture.close(); }
});

for (const surface of ["web", "extension"] as const) {
  test(`${surface}: collection preview is a usable drop target`, async ({ page: web }) => {
    const extension = surface === "extension" ? await openExtension() : undefined;
    const page = extension?.page ?? web;
    const errors = extension?.errors ?? trackPageErrors(page);
    try {
      if (!extension) { await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(server.url); await ready(page); }
      await dragCollectionPreview(page);
      await page.mouse.up();
      await expect(page.locator(".collection-drop-preview")).toHaveCount(0);
      await expect(page.locator(".ext-columns > article").first()).toHaveAttribute("aria-label", "Build collection");
      await expect(page.getByRole("button", { name: "Move Build up" })).toBeDisabled();
      expect(errors).toEqual([]);
    } finally { await page.mouse.up().catch(() => undefined); await extension?.context.close(); }
  });

  test(`${surface}: real drag targets, keyboard ordering, search and persisted collapse`, async ({ page: web }) => {
    let extension: Awaited<ReturnType<typeof openExtension>> | undefined;
    let page: Page;
    let errors: string[];
    if (surface === "extension") { extension = await openExtension(); page = extension.page; errors = extension.errors; }
    else { page = web; errors = trackPageErrors(page); await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(server.url); await ready(page); }
    try {
      await dragRoadmapPreview(page);
      await page.mouse.up();
      await expect(page.getByRole("group", { name: "Plan collection" }).locator(".ext-link-card b")).toHaveText(["Launch checklist", "Product roadmap", "Customer brief"]);
      const earlier = page.getByRole("button", { name: "Move Product roadmap earlier" });
      await expect(earlier).toBeEnabled();
      await earlier.focus();
      await expect(earlier).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("group", { name: "Plan collection" }).locator(".ext-link-card b")).toHaveText(["Product roadmap", "Launch checklist", "Customer brief"]);
      const moveCollection = page.getByRole("button", { name: "Move Build up" });
      await moveCollection.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".ext-columns > article").first()).toHaveAttribute("aria-label", "Build collection");
      await page.getByRole("button", { name: "Search all links" }).click();
      const search = page.getByRole("searchbox", { name: "Search all spaces and collections" });
      await expect(search).toBeFocused();
      await search.fill("Cross-space reference");
      await expect(page.getByRole("link", { name: /Cross-space reference/ })).toBeVisible();
      await expect(page.locator(".global-search-backdrop")).toHaveCSS("background-color", "rgba(246, 243, 238, 0.82)");
      expect(await page.locator(".organizer-shell").evaluate((node) => Boolean(node.closest("[inert]")))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Search all links" })).toBeFocused();
      await page.getByRole("button", { name: "Collapse Plan" }).click();
      await page.reload();
      await expect(page.getByRole("button", { name: "Expand Plan" })).toBeVisible();
      await page.getByRole("button", { name: "Expand Plan" }).click();
      await expect(page.getByRole("group", { name: "Plan collection" }).locator(".ext-link-card b")).toHaveText(["Product roadmap", "Launch checklist", "Customer brief"]);
      expect(errors).toEqual([]);
    } finally { await page.mouse.up().catch(() => undefined); await extension?.context.close(); }
  });
}
