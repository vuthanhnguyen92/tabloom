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
  assert.match(html, /Turn tab chaos into a/);
  assert.match(html, /clear workspace\./);
  assert.match(html, /Capture every useful tab/);
  assert.match(html, /Make space for focused work/);
  assert.match(html, /Download Tabloom/);
  assert.match(html, /\/downloads\/tabloom-chromium\.zip/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("app route renders an accessible workspace shell", async () => {
  const response = await render("/app");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Your workspace/);
  assert.match(html, /Search your links|Checking your session/);
  assert.match(html, /Sign in with Google|Demo workspace|Checking your session/);
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
