import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Tabloom marketing experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Tabloom/);
  assert.match(html, /Make every new tab your workspace\./);
  assert.match(html, /Drag a live tab into the right context\./);
  assert.match(html, /Spaces for projects\. Collections for context\./);
  assert.match(html, /Search everything without leaving the new tab\./);
  assert.match(html, /Download Tabloom/);
  assert.match(html, /\/downloads\/tabloom-chromium\.zip/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("app route renders an accessible workspace shell", async () => {
  const response = await render("/app");
  assert.equal(response.status, 200);
  const html = await response.text();
  const main = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/)?.[0] ?? "";
  // No repository data exists during SSR: publish the accessible boot boundary,
  // not a fake editable workspace or a premature signed-out screen.
  if (main.includes("Checking your session")) assert.match(main, /workspace-loading/);
  else {
    assert.match(main, /aria-busy="true"/);
    assert.match(main, /aria-label="Loading workspace"/);
    assert.match(main, /organizer-boot-indicator/);
  }
  assert.doesNotMatch(main, /New collection|Sign in with Google/);
});

test("privacy route explains Tabloom data handling", async () => {
  const response = await render("/privacy");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Privacy at Tabloom/);
  assert.match(html, /Supabase/);
  assert.match(html, /Chrome permissions/);
  assert.match(html, /bookmark titles, URLs, folder paths, ordering/i);
  assert.match(html, /only when you choose to sync/i);
  assert.match(html, /device name and sync status/i);
});

test("invalid shared collection routes render a generic private state", async () => {
  const response = await render("/s/not-a-valid-token");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /private, no-store/i);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex, nofollow/i);
  const html = await response.text();
  const visibleHtml = html.slice(html.indexOf("<body"), html.indexOf("<!--$-->"));
  assert.match(visibleHtml, /This shared collection is unavailable/);
  assert.doesNotMatch(visibleHtml, /not-a-valid-token/);
});
