import { expect, test } from "@playwright/test";
import { openExtension, openTrash, ready, startOrganizerServer, trackPageErrors } from "./helpers/organizer";
import { organizerIds } from "./fixtures/organizer";

let server: Awaited<ReturnType<typeof startOrganizerServer>>;
test.beforeAll(async () => { server = await startOrganizerServer(); });
test.afterAll(async () => { await server?.close(); });

for (const surface of ["web", "extension"] as const) {
  test(`${surface}: immediate link Undo, human confirmation, persisted Trash and alternate destination`, async ({ page: web }) => {
    const extension = surface === "extension" ? await openExtension() : undefined;
    const page = extension?.page ?? web;
    const errors = extension?.errors ?? trackPageErrors(page);
    try {
      if (!extension) { await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(server.url); await ready(page); }
      const roadmap = page.getByRole("link", { name: /Product roadmap/ });
      await roadmap.hover();
      await page.getByRole("button", { name: "Delete Product roadmap" }).click();
      await expect(roadmap).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(roadmap).toBeVisible();
      await roadmap.hover();
      await page.getByRole("button", { name: "Delete Product roadmap" }).click();
      await expect(roadmap).toHaveCount(0);
      await page.getByRole("button", { name: "Delete Plan", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: "Delete “Plan”?", exact: true });
      await expect(confirmation).toContainText("Plan");
      await expect(page.getByRole("group", { name: "Plan collection", includeHidden: true })).toHaveCount(1);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("group", { name: "Plan collection" })).toBeVisible();
      await page.getByRole("button", { name: "Delete Plan", exact: true }).click();
      await page.getByRole("button", { name: "Delete collection", exact: true }).click();
      await expect(page.getByRole("group", { name: "Plan collection" })).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(() => page.evaluate(async (isExtension) => {
        const key = "tabloom-local-workspace-v2";
        const value = isExtension ? (await chrome.storage.local.get(key))[key] : JSON.parse(localStorage.getItem(key)!);
        return value.snapshot.collections.map((item: { name: string }) => item.name);
      }, Boolean(extension))).not.toContain("Plan");
      await page.reload();
      await expect(page.getByRole("group", { name: "Build collection" })).toBeVisible();
      await openTrash(page, surface);
      const trash = page.getByRole("dialog", { name: "Trash", exact: true });
      await expect(trash).toContainText(`Deleted by ${surface === "web" ? "Web" : "Extension"}`);
      await expect(trash).toContainText("Recover until");
      await page.getByRole("button", { name: "Restore Product roadmap", exact: true }).click();
      const destination = page.getByRole("combobox", { name: "Restore into" });
      await expect(destination).toBeFocused();
      await destination.selectOption(organizerIds.build);
      await page.getByRole("button", { name: "Restore here" }).click();
      await expect(page.getByRole("button", { name: "Restore Product roadmap", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Restore Plan", exact: true }).click();
      await expect(trash).toContainText("Trash is empty.");
      await page.getByRole("button", { name: "Close Trash" }).click();
      await expect(page.getByRole("group", { name: "Build collection" }).getByRole("link", { name: /Product roadmap/ })).toBeVisible();
      await expect(page.getByRole("group", { name: "Plan collection" }).getByRole("link", { name: /Customer brief/ })).toBeVisible();
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await page.getByRole("button", { name: "Delete Product launch", exact: true }).click();
      await expect(page.getByRole("button", { name: "Delete space", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("heading", { name: "Product launch", exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    } finally { await extension?.context.close(); }
  });
}
