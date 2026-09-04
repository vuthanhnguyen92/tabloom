import { expect, test } from "@playwright/test";

const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "TABLOOM_E2E_USER_EMAIL", "TABLOOM_E2E_USER_PASSWORD", "TABLOOM_E2E_WEB_URL"];

test("an anonymous live collection follows edits, regeneration, and revocation", async ({ browser }) => {
  test.skip(process.env.TABLOOM_E2E_LIVE !== "1" || required.some((name) => !process.env[name]), "Set the documented TABLOOM_E2E variables to run live sharing acceptance coverage.");

  const supabaseUrl = process.env.VITE_SUPABASE_URL!;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY!;
  const webUrl = process.env.TABLOOM_E2E_WEB_URL!;
  const auth = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.TABLOOM_E2E_USER_EMAIL, password: process.env.TABLOOM_E2E_USER_PASSWORD }),
  });
  expect(auth.ok).toBe(true);
  const session = await auth.json() as { access_token: string; user: { id: string; email?: string } };
  const headers = { apikey: anonKey, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", Prefer: "return=representation" };
  const spaceId = crypto.randomUUID();
  const collectionId = crypto.randomUUID();
  const firstLinkId = crypto.randomUUID();
  const secondLinkId = crypto.randomUUID();

  async function rest(path: string, init: RequestInit) {
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
    if (!response.ok) throw new Error(`Sharing fixture request failed (${response.status}).`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  await rest("spaces", { method: "POST", body: JSON.stringify({ id: spaceId, user_id: session.user.id, name: "Private owner space", color: "#7657e8", position: 999 }) });
  await rest("collections", { method: "POST", body: JSON.stringify({ id: collectionId, user_id: session.user.id, space_id: spaceId, name: "Share acceptance", position: 0 }) });
  await rest("links", { method: "POST", body: JSON.stringify([
    { id: firstLinkId, user_id: session.user.id, collection_id: collectionId, title: "First shared card", description: "Initial note", url: "https://example.com/first", favicon_url: null, position: 0 },
    { id: secondLinkId, user_id: session.user.id, collection_id: collectionId, title: "Second shared card", description: "", url: "https://example.com/second", favicon_url: null, position: 1 },
  ]) });

  const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await owner.goto(webUrl);
  await owner.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: `sb-${projectRef}-auth-token`, value: JSON.stringify(session) });
  await owner.goto(`${webUrl}/app`);
  await owner.getByRole("button", { name: "Share Share acceptance" }).click();
  await owner.getByRole("button", { name: "Enable sharing" }).click();
  const originalUrl = await owner.getByLabel("Share URL").inputValue();
  const original = { token: originalUrl.split("/").at(-1)! };

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${webUrl}/s/${original.token}`);
    await expect(page.getByRole("heading", { name: "Share acceptance" })).toBeVisible();
    await expect(page.getByText("First shared card")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(session.user.email ?? "owner-email-not-present");
    expect(await page.locator("body").innerText()).not.toContain("Private owner space");

    await rest(`collections?id=eq.${collectionId}`, { method: "PATCH", body: JSON.stringify({ name: "Updated acceptance" }) });
    await rest(`links?id=eq.${firstLinkId}`, { method: "PATCH", body: JSON.stringify({ title: "Edited shared card", position: 1 }) });
    await rest(`links?id=eq.${secondLinkId}`, { method: "DELETE" });
    await rest("links", { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), user_id: session.user.id, collection_id: collectionId, title: "New shared card", description: "", url: "https://example.com/new", favicon_url: null, position: 0 }) });
    await expect(page.getByRole("heading", { name: "Share acceptance" })).toBeVisible();
    await expect(page.getByText("First shared card")).toBeVisible();
    await expect(page.getByText("New shared card")).not.toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Updated acceptance" })).toBeVisible();
    await expect(page.getByText("New shared card")).toBeVisible();
    await expect(page.getByText("Edited shared card")).toBeVisible();
    await expect(page.getByText("Second shared card")).not.toBeVisible();

    await page.evaluate(() => {
      Reflect.set(window, "__openedTabs", []);
      window.open = ((url?: string | URL) => {
        (Reflect.get(window, "__openedTabs") as string[]).push(String(url));
        return window;
      }) as typeof window.open;
    });
    await page.getByRole("button", { name: "Open all" }).click();
    expect(await page.evaluate(() => Reflect.get(window, "__openedTabs"))).toEqual(["https://example.com/new", "https://example.com/first"]);

    await rest("links", { method: "POST", body: JSON.stringify(Array.from({ length: 9 }, (_, index) => ({ id: crypto.randomUUID(), user_id: session.user.id, collection_id: collectionId, title: `Extra ${index}`, description: "", url: `https://example.com/extra-${index}`, favicon_url: null, position: index + 2 }))) });
    await page.reload();
    await page.getByRole("button", { name: "Open all" }).click();
    await expect(page.getByRole("dialog", { name: "Open 11 tabs?" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    await owner.getByRole("button", { name: "Regenerate link" }).click();
    await owner.getByRole("button", { name: "Confirm regenerate" }).click();
    const replacementUrl = await owner.getByLabel("Share URL").inputValue();
    const replacement = { token: replacementUrl.split("/").at(-1)! };
    await page.goto(`${webUrl}/s/${original.token}`);
    await expect(page.getByRole("heading", { name: "This shared collection is unavailable" })).toBeVisible();
    await page.goto(`${webUrl}/s/${replacement.token}`);
    await expect(page.getByRole("heading", { name: "Updated acceptance" })).toBeVisible();
    await owner.getByRole("button", { name: "Disable sharing" }).click();
    await owner.getByRole("button", { name: "Confirm disable" }).click();
    await page.reload();
    await expect(page.getByRole("heading", { name: "This shared collection is unavailable" })).toBeVisible();
  } finally {
    await context.close();
    await ownerContext.close();
    await rest(`spaces?id=eq.${spaceId}`, { method: "DELETE" });
  }
});
