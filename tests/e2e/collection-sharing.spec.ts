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

  async function rpc(name: string) {
    const value = await rest(`rpc/${name}`, { method: "POST", body: JSON.stringify({ target_collection_id: collectionId }) });
    return (Array.isArray(value) ? value[0] : value) as { token: string };
  }

  await rest("spaces", { method: "POST", body: JSON.stringify({ id: spaceId, user_id: session.user.id, name: "Private owner space", color: "#7657e8", position: 999 }) });
  await rest("collections", { method: "POST", body: JSON.stringify({ id: collectionId, user_id: session.user.id, space_id: spaceId, name: "Share acceptance", position: 0 }) });
  await rest("links", { method: "POST", body: JSON.stringify([
    { id: firstLinkId, user_id: session.user.id, collection_id: collectionId, title: "First shared card", description: "Initial note", url: "https://example.com/first", favicon_url: null, position: 0 },
    { id: secondLinkId, user_id: session.user.id, collection_id: collectionId, title: "Second shared card", description: "", url: "https://example.com/second", favicon_url: null, position: 1 },
  ]) });

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const original = await rpc("enable_collection_share");
    await page.goto(`${webUrl}/s/${original.token}`);
    await expect(page.getByRole("heading", { name: "Share acceptance" })).toBeVisible();
    await expect(page.getByText("First shared card")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(session.user.email ?? "owner-email-not-present");
    expect(await page.locator("body").innerText()).not.toContain("Private owner space");

    await rest(`collections?id=eq.${collectionId}`, { method: "PATCH", body: JSON.stringify({ name: "Updated acceptance" }) });
    await rest(`links?id=eq.${firstLinkId}`, { method: "PATCH", body: JSON.stringify({ title: "Edited shared card", position: 1 }) });
    await rest(`links?id=eq.${secondLinkId}`, { method: "DELETE" });
    await rest("links", { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), user_id: session.user.id, collection_id: collectionId, title: "New shared card", description: "", url: "https://example.com/new", favicon_url: null, position: 0 }) });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Updated acceptance" })).toBeVisible();
    await expect(page.getByText("New shared card")).toBeVisible();
    await expect(page.getByText("Edited shared card")).toBeVisible();
    await expect(page.getByText("Second shared card")).not.toBeVisible();

    const replacement = await rpc("regenerate_collection_share");
    await page.goto(`${webUrl}/s/${original.token}`);
    await expect(page.getByRole("heading", { name: "This shared collection is unavailable" })).toBeVisible();
    await page.goto(`${webUrl}/s/${replacement.token}`);
    await expect(page.getByRole("heading", { name: "Updated acceptance" })).toBeVisible();
    await rpc("disable_collection_share");
    await page.reload();
    await expect(page.getByRole("heading", { name: "This shared collection is unavailable" })).toBeVisible();
  } finally {
    await context.close();
    await rest(`spaces?id=eq.${spaceId}`, { method: "DELETE" });
  }
});
