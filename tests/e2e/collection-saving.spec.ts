import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { Session } from "@supabase/supabase-js";

const required = [
  "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "TABLOOM_E2E_WEB_URL",
  "TABLOOM_E2E_USER_EMAIL", "TABLOOM_E2E_USER_PASSWORD",
  "TABLOOM_E2E_RECIPIENT_EMAIL", "TABLOOM_E2E_RECIPIENT_PASSWORD",
];
const intentKey = "tabloom:pending-shared-save:v1";
type Row = { id: string; name: string; space_id: string };
type Copy = { saved_collection_id: string };
type Destination = { status: string; collectionId: string; spaceId: string };
type Rest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

// No dotenv loading: live access requires deliberate process-level opt-in.
test.beforeEach(() => {
  test.skip(process.env.TABLOOM_E2E_LIVE !== "1" || process.env.TABLOOM_E2E_DISPOSABLE !== "1"
    || required.some((name) => !process.env[name]),
  "Use the documented dedicated two-user disposable local/staging setup to run save acceptance.");
});

async function withFixture(browser: Browser, run: (fixture: {
  recipient: Page; owner: Page; ownerRest: Rest; recipientRest: Rest;
  token: string; name: string; collectionId: string; webUrl: string;
}) => Promise<void>) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL!;
  const webUrl = process.env.TABLOOM_E2E_WEB_URL!.replace(/\/$/, "");
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY!;
  const contexts: BrowserContext[] = [];
  async function login(email: string, password: string): Promise<Session> {
    const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) throw new Error(`Save acceptance authentication failed (${response.status}).`);
    return response.json();
  }
  const ownerSession = await login(process.env.TABLOOM_E2E_USER_EMAIL!, process.env.TABLOOM_E2E_USER_PASSWORD!);
  const recipientSession = await login(process.env.TABLOOM_E2E_RECIPIENT_EMAIL!, process.env.TABLOOM_E2E_RECIPIENT_PASSWORD!);
  if (ownerSession.user.id === recipientSession.user.id) throw new Error("Save acceptance requires two distinct dedicated users.");
  function restFor(session: Session): Rest {
    return async <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
      const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        method,
        headers: { apikey: anonKey, Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json", Prefer: "return=representation" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`Save acceptance fixture request failed (${response.status}).`);
      const text = await response.text();
      return text ? JSON.parse(text) as T : null as T;
    };
  }
  const ownerRest = restFor(ownerSession);
  const recipientRest = restFor(recipientSession);
  const existingSpaces = await recipientRest<Row[]>("spaces?select=id");
  if (existingSpaces.length) throw new Error("Recipient must have an empty disposable workspace; acceptance never deletes pre-existing data.");
  const spaceId = crypto.randomUUID();
  const collectionId = crypto.randomUUID();
  const name = `Save acceptance ${collectionId}`;
  async function authenticatedPage(session: Session) {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(webUrl);
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`, value: JSON.stringify(session),
    });
    return page;
  }
  try {
    await ownerRest("spaces", "POST", { id: spaceId, user_id: ownerSession.user.id, name: `Private ${name}`, color: "#7657e8", position: 999 });
    await ownerRest("collections", "POST", { id: collectionId, user_id: ownerSession.user.id, space_id: spaceId, name, position: 0 });
    await ownerRest("links", "POST", [
      { id: crypto.randomUUID(), user_id: ownerSession.user.id, collection_id: collectionId, title: "First saved card", description: "Original note", url: "https://example.com/first", position: 0 },
      { id: crypto.randomUUID(), user_id: ownerSession.user.id, collection_id: collectionId, title: "Second saved card", description: "", url: "https://example.com/second", position: 1 },
    ]);
    const enabled = await ownerRest<{ token: string } | { token: string }[]>("rpc/enable_collection_share", "POST", { target_collection_id: collectionId });
    const token = (Array.isArray(enabled) ? enabled[0] : enabled).token;
    await run({ recipient: await authenticatedPage(recipientSession), owner: await authenticatedPage(ownerSession), ownerRest, recipientRest, token, name, collectionId, webUrl });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    // Resolve only this source's provenance. Never bulk-delete either account's workspace.
    try {
      const copies = await recipientRest<Copy[]>(`collection_saved_copies?source_collection_id=eq.${collectionId}&select=saved_collection_id`);
      for (const copy of copies) {
        const rows = await recipientRest<Row[]>(`collections?id=eq.${copy.saved_collection_id}&select=id,space_id`);
        await recipientRest(`collections?id=eq.${copy.saved_collection_id}`, "DELETE");
        for (const row of rows) {
          const remaining = await recipientRest<Row[]>(`collections?space_id=eq.${row.space_id}&select=id`);
          if (!remaining.length) await recipientRest(`spaces?id=eq.${row.space_id}`, "DELETE");
        }
      }
    } finally {
      await ownerRest(`spaces?id=eq.${spaceId}`, "DELETE");
    }
  }
}

function observeSaves(page: Page) {
  let count = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/rest/v1/rpc/save_shared_collection" && request.method() === "POST") count++;
  });
  return () => count;
}

test("recipient saves an editable private independent copy; repeats, regeneration and owner shortcut", async ({ browser }) => {
  await withFixture(browser, async ({ recipient, owner, ownerRest, recipientRest, token, name, collectionId, webUrl }) => {
    const url = `${webUrl}/s/${token}`;
    await owner.goto(url);
    await expect(owner.getByRole("link", { name: "Open my collection" })).toHaveAttribute("href", `/app?collection=${collectionId}`);
    await recipient.goto(url);
    await recipient.getByRole("button", { name: "Save to my collections", exact: true }).click();
    await expect(recipient.getByText("Saved to your collections", { exact: true })).toBeVisible();
    const state = await recipientRest<Destination>("rpc/get_shared_collection_save_state", "POST", { share_token: token });
    expect(state.status).toBe("saved");
    expect(state.collectionId).not.toBe(collectionId);
    await expect(recipient.getByRole("link", { name: "View collection", exact: true })).toHaveAttribute("href", `/app?collection=${state.collectionId}`);
    const spaces = await recipientRest<Array<{ name: string; color: string }>>(`spaces?id=eq.${state.spaceId}&select=name,color`);
    expect(spaces).toEqual([{ name: "My collections", color: "#f56f72" }]);
    const links = await recipientRest<Array<{ title: string; url: string; description: string; favicon_url: string | null }>>(`links?collection_id=eq.${state.collectionId}&select=title,url,description,favicon_url&order=position.asc`);
    expect(links).toEqual([
      { title: "First saved card", url: "https://example.com/first", description: "Original note", favicon_url: null },
      { title: "Second saved card", url: "https://example.com/second", description: "", favicon_url: null },
    ]);
    expect(await recipientRest<unknown[]>(`collection_shares?collection_id=eq.${state.collectionId}`)).toEqual([]);
    // Retry the mutation itself, in addition to checking the read-only repeat UI.
    expect(await recipientRest<Destination>("rpc/save_shared_collection", "POST", { share_token: token })).toEqual(state);
    await recipient.getByRole("link", { name: "View collection", exact: true }).click();
    await expect(recipient.locator(`#collection-${state.collectionId}`)).toBeFocused();
    await recipient.getByRole("button", { name: `Rename ${name} collection`, exact: true }).click();
    await recipient.getByRole("textbox", { name: "Name", exact: true }).fill("Recipient independent edit");
    await recipient.getByRole("button", { name: "Save", exact: true }).click();
    await expect(recipient.getByRole("heading", { name: "Recipient independent edit" })).toBeVisible();
    await recipient.goto(url);
    await expect(recipient.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(recipient.getByRole("link", { name: "View saved collection" })).toBeVisible();
    await ownerRest(`collections?id=eq.${collectionId}`, "PATCH", { name: "Source changed afterward" });
    const replacement = await ownerRest<{ token: string } | { token: string }[]>("rpc/regenerate_collection_share", "POST", { target_collection_id: collectionId });
    const replacementToken = (Array.isArray(replacement) ? replacement[0] : replacement).token;
    await recipient.goto(`${webUrl}/s/${replacementToken}`);
    await expect(recipient.getByRole("heading", { name: "Source changed afterward" })).toBeVisible();
    await expect(recipient.getByRole("link", { name: "View saved collection" })).toHaveAttribute("href", `/app?collection=${state.collectionId}`);
    expect(await recipientRest<Copy[]>(`collection_saved_copies?source_collection_id=eq.${collectionId}&select=saved_collection_id`)).toEqual([{ saved_collection_id: state.collectionId }]);
    await ownerRest("rpc/disable_collection_share", "POST", { target_collection_id: collectionId });
    await recipient.reload();
    await expect(recipient.getByRole("heading", { name: "This shared collection is unavailable" })).toBeVisible();
    await recipient.goto(`${webUrl}/app?collection=${state.collectionId}`);
    await expect(recipient.getByRole("heading", { name: "Recipient independent edit" })).toBeVisible();
    await expect(recipient.getByText("First saved card", { exact: true })).toBeVisible();
    // Deleting the source must not cascade to the copy/provenance.
    await ownerRest(`collections?id=eq.${collectionId}`, "DELETE");
    await recipient.reload();
    await expect(recipient.getByRole("heading", { name: "Recipient independent edit" })).toBeVisible();
  });
});

test("controlled authenticated callback resumes exactly the pending save", async ({ browser }) => {
  await withFixture(browser, async ({ recipient, recipientRest, token, collectionId, webUrl }) => {
    const count = observeSaves(recipient);
    await recipient.evaluate(({ key, token }) => sessionStorage.setItem(key, JSON.stringify({ token, nonce: crypto.randomUUID(), createdAt: Date.now() })), { key: intentKey, token });
    await recipient.goto(`${webUrl}/auth/shared-save`);
    await expect(recipient.getByText("Saved to your collections", { exact: true })).toBeVisible();
    await expect(recipient).toHaveURL(`${webUrl}/s/${token}`);
    expect(await recipient.evaluate((key) => sessionStorage.getItem(key), intentKey)).toBeNull();
    expect(count()).toBe(1);
    await recipient.reload();
    await expect(recipient.getByRole("link", { name: "View saved collection" })).toBeVisible();
    expect(count()).toBe(1);
    expect(await recipientRest<Copy[]>(`collection_saved_copies?source_collection_id=eq.${collectionId}&select=saved_collection_id`)).toHaveLength(1);
  });
});

for (const stored of [null, "{malformed-json"] as const) {
  test(`callback with ${stored === null ? "missing" : "malformed"} intent and forged resume query cannot save`, async ({ browser }) => {
    await withFixture(browser, async ({ recipient, recipientRest, token, collectionId, webUrl }) => {
      const count = observeSaves(recipient);
      await recipient.evaluate(({ key, stored }) => {
        if (stored === null) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, stored);
      }, { key: intentKey, stored });
      await recipient.goto(`${webUrl}/auth/shared-save`);
      await expect(recipient.getByRole("link", { name: /workspace/i })).toBeVisible();
      await recipient.goto(`${webUrl}/s/${token}?resumeSave=${crypto.randomUUID()}`);
      await expect(recipient.getByRole("button", { name: "Save to my collections", exact: true })).toBeEnabled();
      expect(count()).toBe(0);
      expect(await recipientRest<Copy[]>(`collection_saved_copies?source_collection_id=eq.${collectionId}&select=saved_collection_id`)).toEqual([]);
    });
  });
}
