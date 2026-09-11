import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let baseUrl: string;
test.beforeAll(async () => {
  server = await createServer({ configFile: false, plugins: [react()], server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  baseUrl = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${baseUrl}tests/e2e/fixtures/organizer-drag.html`);
  await expect(page.getByRole("link", { name: /Product roadmap/ })).toBeVisible();
});

test("a card-body mouse gesture starts link dragging without initiating collection dragging", async ({ page }) => {
  const card = page.getByRole("link", { name: /Product roadmap/ });
  const bounds = (await card.boundingBox())!;
  await page.mouse.move(bounds.x + 80, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 110, bounds.y + 55, { steps: 8 });
  await expect(page.locator(".collection-dragging")).toHaveCount(0);
  await expect(page.locator(".ext-columns.link-dragging")).toHaveCount(1);
  await page.mouse.up();
});

test("dropping at the actual insertion slot coordinates preserves the displayed index", async ({ page }) => {
  const source = (await page.getByRole("link", { name: /Launch checklist/ }).boundingBox())!;
  const target = (await page.getByRole("link", { name: /Product roadmap/ }).boundingBox())!;
  const x = target.x + 70;
  const y = target.y + 45;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x - 30, source.y, { steps: 4 });
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.move(x + 1, y + 1);
  await expect(page.locator('.ext-link-grid > .ext-link-drop-preview:first-child')).toHaveCount(1);
  expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".ext-link-drop-preview")), { x, y })).toBe(true);
  await page.mouse.move(x + 2, y + 1);
  await page.mouse.up();
  await expect(page.getByRole("group", { name: "Plan collection" }).locator(".ext-link-card b")).toHaveText(["Launch checklist", "Product roadmap", "Customer brief"]);
});
