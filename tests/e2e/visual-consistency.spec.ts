import { expect, test, type Page } from "@playwright/test";
import { dragCollectionPreview, dragRoadmapPreview, ready, startOrganizerServer, trackPageErrors } from "./helpers/organizer";

let server: Awaited<ReturnType<typeof startOrganizerServer>>;
test.beforeAll(async () => { server = await startOrganizerServer(); });
test.afterAll(async () => { await server?.close(); });

async function screenshot(page: Page, name: string) {
  // Keep review candidates even when baseline creation is deliberately disabled.
  await page.screenshot({ path: test.info().outputPath(name), animations: "disabled", caret: "hide" });
  await expect.soft(page).toHaveScreenshot(name, { animations: "disabled", caret: "hide" });
}

for (const theme of ["light", "dark"] as const) {
  test(`rendered web organizer: ${theme} layout, search, focus, and responsive states`, async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.url);
    await ready(page);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect(page.getByRole("button", { name: "New collection", exact: true })).toHaveCSS("height", "42px");
    await expect(page.getByRole("button", { name: "Search all links" })).toHaveCSS("height", "42px");
    const card = page.locator(".ext-link-card").first();
    await expect(card.locator(".favicon-tile-fallback")).toHaveText("P");
    await expect(card.locator("a")).toHaveCSS("cursor", "pointer");
    await expect(card.locator("b")).toHaveCSS("font-size", "16px");
    await expect(card.locator("b")).toHaveCSS("font-weight", "500");
    const before = await card.boundingBox();
    await card.hover();
    await expect(card.locator(".saved-link-edit")).toHaveCSS("position", "absolute");
    expect(await card.boundingBox()).toEqual(before);
    await page.getByRole("button", { name: "Search all links" }).focus();
    await expect(page.getByRole("button", { name: "Search all links" })).toHaveCSS("outline-style", "solid");
    await expect(page.getByRole("button", { name: "Search all links" })).toHaveCSS("outline-width", "3px");
    await page.mouse.move(0, 0);
    await screenshot(page, `organizer-${theme}.png`);
    await page.getByLabel("Account", { exact: true }).click();
    await expect(page.locator(".web-organizer-account-menu")).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(43, 43, 54)");
    await screenshot(page, `account-${theme}.png`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Search all links" }).click();
    await page.getByRole("searchbox").fill("reference");
    await expect(page.getByRole("link", { name: /Cross-space reference/ })).toBeVisible();
    await screenshot(page, `search-${theme}.png`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(page.locator(".ext-sidebar")).toHaveCSS("width", "230px");
    await expect(page.locator(".sidebar-top .ext-brand-mark")).toHaveCSS("width", "30px");
    expect((await page.locator(".sidebar-top").boundingBox())!.height).toBeLessThanOrEqual(40);
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeInViewport();
    const longSpace = page.getByRole("button", { name: /^Open Research and references/ });
    const span = longSpace.locator("span");
    await expect(span).toHaveCSS("text-overflow", "ellipsis");
    expect(await span.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    const width = (await longSpace.boundingBox())!.width;
    await longSpace.hover();
    expect((await longSpace.boundingBox())!.width).toBe(width);
    await longSpace.click();
    await page.setViewportSize({ width: 760, height: 740 });
    await expect(page.locator(".ext-main h1")).toHaveCSS("text-overflow", "ellipsis");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot(page, `responsive-${theme}.png`);
    expect(errors).toEqual([]);
  });
}

test("rendered drag preview has a real hit target", async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.url);
  await ready(page);
  await dragRoadmapPreview(page);
  await screenshot(page, "drag-preview.png");
  await page.mouse.up();
  await expect(page.getByRole("group", { name: "Plan collection" }).locator(".ext-link-card b")).toHaveText(["Launch checklist", "Product roadmap", "Customer brief"]);
  expect(errors).toEqual([]);
});

test("rendered collection insertion marker accepts native drops", async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.url);
  await ready(page);
  await dragCollectionPreview(page);
  await screenshot(page, "collection-preview.png");
  await page.mouse.up();
  await expect(page.locator(".ext-columns > article").first()).toHaveAttribute("aria-label", "Build collection");
  expect(errors).toEqual([]);
});
