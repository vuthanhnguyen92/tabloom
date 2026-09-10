import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { exportJWK, generateKeyPair } from "jose";

import { GET, POST } from "../../services/tabloom-mcp/app/oauth/consent/route";
import { loadFacadeAuthConfig } from "../../services/tabloom-mcp/src/auth/config";
import { CONSENT_COOKIE_NAME, createConsentCookie } from "../../services/tabloom-mcp/src/oauth/cookies";

const ORIGIN = "https://tabloom.example";

test("consent approval reaches a different client origin under the real CSP", async ({ page, context }) => {
  const callbackServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<h1>Client callback reached</h1>");
  });
  await new Promise<void>((resolve) => callbackServer.listen(0, "127.0.0.1", resolve));
  const CALLBACK = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}/callback`;
  const originalEnvironment = { ...process.env };
  try {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    Object.assign(process.env, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
      TABLOOM_MCP_RESOURCE_URL: `${ORIGIN}/mcp`,
      TABLOOM_OAUTH_ISSUER_URL: ORIGIN,
      TABLOOM_OAUTH_ENABLED: "true",
      TABLOOM_OAUTH_SIGNING_KEYS: JSON.stringify([
        { kid: "test", active: true, privateJwk: { ...await exportJWK(privateKey), alg: "ES256" } },
      ]),
      TABLOOM_OAUTH_ENCRYPTION_KEYS: JSON.stringify([
        { kid: "test", active: true, rootKey: Buffer.alloc(32, 3).toString("base64url") },
      ]),
      TABLOOM_OAUTH_DATABASE_SECRET: Buffer.alloc(32, 9).toString("base64url"),
    });
    const now = Math.floor(Date.now() / 1000);
    const cookie = await createConsentCookie({
      request: {
        client: {
          clientId: "5c177e69-8954-4c57-a777-07c732513bea",
          clientName: "Browser test client",
          redirectUris: [CALLBACK],
          source: "dcr",
        },
        redirectUri: CALLBACK,
        state: "browser-test-state",
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        resource: `${ORIGIN}/mcp`,
        scope: "tabloom:workspace",
      },
      userId: "4f6f8607-9439-4ce3-a19e-f5a302ef3e68",
      supabaseAccessToken: "fake-access-token",
      supabaseRefreshToken: "fake-refresh-token",
      supabaseAccessTokenExpiresAt: now + 3600,
      csrfNonce: "n".repeat(43),
      authorizationCodeJti: "j".repeat(43),
      grantId: "g".repeat(43),
    }, loadFacadeAuthConfig(process.env).encryptionKeys);
    await context.addCookies([{
      name: CONSENT_COOKIE_NAME,
      value: cookie.split(";", 1)[0]!.slice(CONSENT_COOKIE_NAME.length + 1),
      domain: "tabloom.example", path: "/", httpOnly: true, secure: true, sameSite: "Lax",
    }]);
    await page.route(`${ORIGIN}/**`, async (route) => {
      const incoming = route.request();
      const request = new Request(incoming.url(), {
        method: incoming.method(),
        headers: await incoming.allHeaders(),
        ...(incoming.method() === "POST" ? { body: incoming.postData() } : {}),
      });
      const response = await (incoming.method() === "POST" ? POST(request) : GET(request));
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await page.goto(`${ORIGIN}/oauth/consent`);
    await page.locator('button[value="approve"]').click();
    await expect(page.getByRole("heading", { name: "Client callback reached" })).toBeVisible({ timeout: 5000 });
    expect(new URL(page.url()).searchParams.get("state")).toBe("browser-test-state");
    expect(new URL(page.url()).searchParams.get("code")).toBeTruthy();
    expect((await context.cookies(ORIGIN)).some((value) => value.name === CONSENT_COOKIE_NAME)).toBe(false);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TABLOOM_") || key.startsWith("SUPABASE_")) {
        if (originalEnvironment[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnvironment[key];
      }
    }
    await new Promise<void>((resolve, reject) => callbackServer.close((error) => error ? reject(error) : resolve()));
  }
});
