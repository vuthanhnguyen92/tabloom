# Tabloom Cross-Browser Local OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce locally installable Tabloom packages for Chrome, Arc, Dia, Firefox, and Safari on macOS with stable browser identities, working Supabase Google OAuth, preserved local-first data, and verified cross-browser synchronization.

**Architecture:** Shared TypeScript owns OAuth URL creation, callback validation, PKCE exchange, and user-facing errors. Chromium and Firefox use their identity APIs; Safari sends the authorization URL through a typed native-message bridge to an Xcode wrapper that runs `ASWebAuthenticationSession`. The existing organizer, local repository, merge coordinator, and Supabase repository remain shared.

**Tech Stack:** TypeScript 5.9, React 19, Vite 8, Vitest 4, Supabase JS 2, Chrome/Firefox WebExtension APIs, `web-ext`, Swift, SafariServices, AuthenticationServices, Xcode.

**Spec:** `docs/superpowers/specs/2026-08-29-cross-browser-local-oauth-design.md`

## Global Constraints

- Local packages only; do not submit or publish to any browser or app store.
- Chrome, Arc, and Dia share one Chromium manifest, public key, extension ID, and OAuth callback.
- Firefox retains the explicit Gecko ID `tabloom@tabloom.app`.
- Safari targets macOS only and uses bundle identifiers `app.tabloom.mac` and `app.tabloom.mac.extension`.
- Safari on iPhone and iPad remains out of scope.
- Local workspaces must remain fully usable before sign-in and after cancellation, timeout, provider errors, expired sessions, or missing Supabase configuration.
- Never commit service-role keys, Google OAuth secrets, auth sessions, access or refresh tokens, Chromium private keys, or Apple signing material.
- Keep the Google OAuth redirect at `https://tctjlsvfufzxhauhywsm.supabase.co/auth/v1/callback`; browser callbacks belong only in Supabase Auth URL Configuration.
- All production behavior changes follow red-green-refactor: write the failing test, verify the intended failure, implement the minimum code, and re-run the focused and full unit suites.

---

### Task 1: Extract a Shared, Safe OAuth Coordinator

**Files:**
- Create: `extension/auth/oauth.ts`
- Create: `tests/extension-oauth.test.ts`
- Modify: `extension/supabase.ts`

**Interfaces:**
- Consumes: `BrowserAdapter["identity"]`, `BrowserTarget`, and a Supabase-compatible auth client.
- Produces: `ExtensionOAuthErrorCode`, `ExtensionOAuthError`, `callbackForTarget`, `parseOAuthCallback`, and `runExtensionGoogleOAuth`.

- [ ] **Step 1: Write the failing callback-validation tests**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  ExtensionOAuthError,
  callbackForTarget,
  parseOAuthCallback,
  runExtensionGoogleOAuth,
} from "../extension/auth/oauth";

describe("extension OAuth", () => {
  it("uses the browser callback for Chromium and Firefox and the native scheme for Safari", () => {
    const identity = { getRedirectURL: vi.fn(() => "https://stable-id.chromiumapp.org/auth-callback") };
    expect(callbackForTarget("chromium", identity)).toBe("https://stable-id.chromiumapp.org/auth-callback");
    expect(callbackForTarget("firefox", identity)).toBe("https://stable-id.chromiumapp.org/auth-callback");
    expect(callbackForTarget("safari", identity)).toBe("tabloom://auth-callback");
  });

  it("returns a code only for an exact callback protocol, host, and path", () => {
    const expected = "https://stable-id.chromiumapp.org/auth-callback";
    expect(parseOAuthCallback(`${expected}?code=abc`, expected)).toBe("abc");
    expect(() => parseOAuthCallback("https://attacker.example/auth-callback?code=abc", expected))
      .toThrowError(ExtensionOAuthError);
  });

  it("turns provider errors into safe messages without query values", () => {
    const expected = "tabloom://auth-callback";
    expect(() => parseOAuthCallback(`${expected}?error=access_denied&error_description=sensitive`, expected))
      .toThrow("Google sign-in was not completed");
  });

  it("turns Chrome's generic load failure into an actionable redirect error", async () => {
    const expected = "https://stable-id.chromiumapp.org/auth-callback";
    const client = {
      auth: {
        signInWithOAuth: vi.fn(async () => ({ data: { url: "https://accounts.example" }, error: null })),
        exchangeCodeForSession: vi.fn(),
      },
    };
    const identity = {
      getRedirectURL: () => expected,
      launchWebAuthFlow: vi.fn(async () => { throw new Error("Authorization page could not be loaded."); }),
    };
    await expect(runExtensionGoogleOAuth(client, identity, "chromium"))
      .rejects.toMatchObject({ code: "redirect_not_allowed", expectedRedirectUrl: expected });
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run tests/extension-oauth.test.ts`

Expected: FAIL because `extension/auth/oauth.ts` does not exist.

- [ ] **Step 3: Implement callback identity and typed errors**

```ts
import type { Session } from "@supabase/supabase-js";
import type { BrowserAdapter, BrowserTarget } from "../browser/types";

export type ExtensionOAuthErrorCode =
  | "cancelled"
  | "timeout"
  | "redirect_not_allowed"
  | "provider_error"
  | "platform_unavailable"
  | "invalid_callback";

export class ExtensionOAuthError extends Error {
  constructor(
    readonly code: ExtensionOAuthErrorCode,
    message: string,
    readonly expectedRedirectUrl?: string,
  ) {
    super(message);
    this.name = "ExtensionOAuthError";
  }
}

type OAuthIdentity = Pick<BrowserAdapter["identity"], "getRedirectURL" | "launchWebAuthFlow">;

export function callbackForTarget(target: BrowserTarget, identity: Pick<OAuthIdentity, "getRedirectURL">) {
  return target === "safari" ? "tabloom://auth-callback" : identity.getRedirectURL("auth-callback");
}

function callbackIdentity(value: string) {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

export function parseOAuthCallback(responseUrl: string, expectedRedirectUrl: string) {
  if (callbackIdentity(responseUrl) !== callbackIdentity(expectedRedirectUrl)) {
    throw new ExtensionOAuthError(
      "redirect_not_allowed",
      `Authentication returned to the wrong page. Add ${expectedRedirectUrl} to Supabase Auth redirect URLs.`,
      expectedRedirectUrl,
    );
  }
  const url = new URL(responseUrl);
  if (url.searchParams.has("error")) {
    throw new ExtensionOAuthError("provider_error", "Google sign-in was not completed.");
  }
  const code = url.searchParams.get("code");
  if (!code) throw new ExtensionOAuthError("invalid_callback", "The authentication callback did not include a code.");
  return code;
}
```

- [ ] **Step 4: Add coordinator tests for cancellation and exchange ordering**

```ts
it("does not exchange a session when the browser flow is cancelled", async () => {
  const exchangeCodeForSession = vi.fn();
  const client = {
    auth: {
      signInWithOAuth: vi.fn(async () => ({ data: { url: "https://accounts.example" }, error: null })),
      exchangeCodeForSession,
    },
  };
  const identity = {
    getRedirectURL: () => "https://stable-id.chromiumapp.org/auth-callback",
    launchWebAuthFlow: vi.fn(async () => undefined),
  };

  await expect(runExtensionGoogleOAuth(client, identity, "chromium")).rejects.toMatchObject({ code: "cancelled" });
  expect(exchangeCodeForSession).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Verify the new test fails for the missing coordinator**

Run: `npx vitest run tests/extension-oauth.test.ts`

Expected: FAIL because `runExtensionGoogleOAuth` is not implemented.

- [ ] **Step 6: Implement `runExtensionGoogleOAuth` and delegate from `extension/supabase.ts`**

```ts
export type ExtensionOAuthClient = {
  auth: {
    signInWithOAuth(input: {
      provider: "google";
      options: { redirectTo: string; skipBrowserRedirect: true };
    }): Promise<{ data: { url: string | null }; error: Error | null }>;
    exchangeCodeForSession(code: string): Promise<{
      data: { session: Session | null };
      error: Error | null;
    }>;
  };
};

export async function runExtensionGoogleOAuth(
  client: ExtensionOAuthClient,
  identity: OAuthIdentity,
  target: BrowserTarget,
) {
  const redirectTo = callbackForTarget(target, identity);
  const started = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (started.error || !started.data.url) {
    throw new ExtensionOAuthError("provider_error", "Could not start Google sign-in.");
  }
  let responseUrl: string | undefined;
  try {
    responseUrl = await identity.launchWebAuthFlow({ url: started.data.url, interactive: true });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message.toLowerCase() : "";
    if (message.includes("could not be loaded")) {
      throw new ExtensionOAuthError(
        "redirect_not_allowed",
        `Authentication could not return to Tabloom. Add ${redirectTo} to Supabase Auth redirect URLs.`,
        redirectTo,
      );
    }
    if (message.includes("cancel") || message.includes("approve")) {
      throw new ExtensionOAuthError("cancelled", "Google sign-in was cancelled.");
    }
    if (message.includes("timed out") || message.includes("timeout")) {
      throw new ExtensionOAuthError("timeout", "Google sign-in timed out. Please retry.");
    }
    throw new ExtensionOAuthError("platform_unavailable", "This browser could not start Google sign-in.");
  }
  if (!responseUrl) throw new ExtensionOAuthError("cancelled", "Google sign-in was cancelled.");
  const code = parseOAuthCallback(responseUrl, redirectTo);
  const exchanged = await client.auth.exchangeCodeForSession(code);
  if (exchanged.error || !exchanged.data.session) {
    throw new ExtensionOAuthError("provider_error", "Could not finish Google sign-in.");
  }
  return exchanged.data.session;
}
```

Replace the body of `signInExtensionWithGoogle` with a configuration guard followed by `runExtensionGoogleOAuth(extensionSupabase, browserAdapter.identity, browserTarget)`.

- [ ] **Step 7: Run focused and full unit tests**

Run: `npx vitest run tests/extension-oauth.test.ts tests/browser-adapter.test.ts && npm run test:unit`

Expected: PASS with no token, code, or callback query value in output.

- [ ] **Step 8: Commit the coordinator**

```bash
git add extension/auth/oauth.ts extension/supabase.ts tests/extension-oauth.test.ts
git commit -m "feat: normalize extension OAuth callbacks"
```

---

### Task 2: Replace Safari Tab Watching with a Typed Native Bridge

**Files:**
- Modify: `extension/browser/types.ts`
- Modify: `extension/browser/safari.ts`
- Modify: `tests/browser-adapter.test.ts`
- Modify: `extension/manifests/safari.json`

**Interfaces:**
- Consumes: `WebExtensionNamespace.runtime.sendNativeMessage`.
- Produces: `SafariNativeAuthRequest`, `SafariNativeAuthResponse`, and a Safari `BrowserAdapter.identity` implementation returning `tabloom://auth-callback` results.

- [ ] **Step 1: Replace the old Safari browser-tab test with native-message tests**

```ts
it("completes Safari OAuth through the native bridge", async () => {
  const namespace = createNamespace();
  namespace.identity = undefined;
  namespace.runtime = {
    getURL: (path = "") => `safari-web-extension://tabloom/${path}`,
    sendNativeMessage: vi.fn(async (_applicationId, message) => ({
      type: "tabloom.oauth.result",
      callbackUrl: "tabloom://auth-callback?code=safari-code",
      request: message,
    })),
  };
  const adapter = createSafariAdapter(namespace);

  expect(adapter.identity.getRedirectURL()).toBe("tabloom://auth-callback");
  await expect(adapter.identity.launchWebAuthFlow({ url: "https://accounts.example", interactive: true }))
    .resolves.toBe("tabloom://auth-callback?code=safari-code");
  expect(namespace.runtime.sendNativeMessage).toHaveBeenCalledWith("app.tabloom.mac", {
    type: "tabloom.oauth.start",
    authorizationUrl: "https://accounts.example",
    callbackScheme: "tabloom",
  });
});

it("normalizes a Safari native cancellation", async () => {
  const namespace = createNamespace();
  namespace.identity = undefined;
  namespace.runtime = {
    getURL: vi.fn(),
    sendNativeMessage: vi.fn(async () => ({ type: "tabloom.oauth.cancelled" })),
  };
  const adapter = createSafariAdapter(namespace);
  await expect(adapter.identity.launchWebAuthFlow({ url: "https://accounts.example", interactive: true }))
    .resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the adapter test and verify RED**

Run: `npx vitest run tests/browser-adapter.test.ts`

Expected: FAIL because `runtime.sendNativeMessage` is absent and Safari still watches tab events.

- [ ] **Step 3: Add native-message types and implement the Safari adapter**

```ts
export type SafariNativeAuthRequest = {
  type: "tabloom.oauth.start";
  authorizationUrl: string;
  callbackScheme: "tabloom";
};

export type SafariNativeAuthResponse =
  | { type: "tabloom.oauth.result"; callbackUrl: string }
  | { type: "tabloom.oauth.cancelled" }
  | { type: "tabloom.oauth.error"; code: string; message: string };
```

Extend `WebExtensionNamespace.runtime` with:

```ts
sendNativeMessage(
  applicationId: string,
  message: SafariNativeAuthRequest,
): Promise<SafariNativeAuthResponse>;
```

Implement `createSafariAdapter(api, { timeoutMs = 300_000 } = {})` so `getRedirectURL` always returns `tabloom://auth-callback`, `launchWebAuthFlow` calls `sendNativeMessage("app.tabloom.mac", request)`, cancellation resolves `undefined`, invalid responses reject with a safe platform error, and a `Promise.race` timeout rejects after `timeoutMs`.

- [ ] **Step 4: Add the Safari manifest permission**

Change Safari permissions to:

```json
"permissions": ["tabs", "storage", "nativeMessaging"]
```

Keep `identity` absent from the Safari manifest because Safari uses the native bridge.

- [ ] **Step 5: Run focused and full unit tests**

Run: `npx vitest run tests/browser-adapter.test.ts tests/extension-oauth.test.ts && npm run test:unit`

Expected: PASS.

- [ ] **Step 6: Commit the adapter contract**

```bash
git add extension/browser/types.ts extension/browser/safari.ts extension/manifests/safari.json tests/browser-adapter.test.ts
git commit -m "feat: add Safari native OAuth bridge"
```

---

### Task 3: Create a Stable Chromium Development Identity and Public Reports

**Files:**
- Create: `extension/scripts/extension-identity.mjs`
- Create: `tests/extension-identity.test.ts`
- Modify: `extension/scripts/build-extension.mjs`
- Modify: `extension/manifests/chromium.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `deriveChromiumExtensionId(publicKeyBase64)`, `createAuthReport(target, manifest)`, and the exact files `dist-extension/reports/chromium-auth.json`, `dist-extension/reports/firefox-auth.json`, and `dist-extension/reports/safari-auth.json`.
- Report schema: `{ target, extensionId, callbackUrl, requiresRuntime }` with public values only.

- [ ] **Step 1: Write failing deterministic-ID and report tests**

```ts
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createAuthReport, deriveChromiumExtensionId } from "../extension/scripts/extension-identity.mjs";

describe("extension identity reports", () => {
  it("maps the first 16 SHA-256 bytes to Chrome's a-p alphabet", () => {
    const key = Buffer.from("tabloom-public-key-fixture").toString("base64");
    const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
    const expected = [...digest].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
    expect(deriveChromiumExtensionId(key)).toBe(expected);
  });

  it("reports runtime discovery for Firefox without inventing a callback", () => {
    expect(createAuthReport("firefox", { browser_specific_settings: { gecko: { id: "tabloom@tabloom.app" } } }))
      .toEqual({ target: "firefox", extensionId: "tabloom@tabloom.app", callbackUrl: null, requiresRuntime: true });
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run tests/extension-identity.test.ts`

Expected: FAIL because `extension-identity.mjs` does not exist.

- [ ] **Step 3: Implement identity derivation and report generation**

```js
import { createHash } from "node:crypto";

export function deriveChromiumExtensionId(publicKeyBase64) {
  const hex = createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

export function createAuthReport(target, manifest) {
  if (target === "chromium") {
    const extensionId = deriveChromiumExtensionId(manifest.key);
    return {
      target,
      extensionId,
      callbackUrl: `https://${extensionId}.chromiumapp.org/auth-callback`,
      requiresRuntime: false,
    };
  }
  if (target === "firefox") {
    return {
      target,
      extensionId: manifest.browser_specific_settings.gecko.id,
      callbackUrl: null,
      requiresRuntime: true,
    };
  }
  return { target, extensionId: "app.tabloom.mac.extension", callbackUrl: "tabloom://auth-callback", requiresRuntime: false };
}
```

- [ ] **Step 4: Verify GREEN before touching manifests**

Run: `npx vitest run tests/extension-identity.test.ts`

Expected: PASS for the pure identity helpers.

- [ ] **Step 5: Generate the one-time Chromium key pair without committing the private key**

Run:

```bash
mkdir -p .local/extension-keys
openssl genrsa -out .local/extension-keys/tabloom-chromium.pem 2048
openssl rsa -in .local/extension-keys/tabloom-chromium.pem -pubout -outform DER | openssl base64 -A
```

Add `/.local/extension-keys/` to `.gitignore`. Insert the single-line public command output as the `key` property in `extension/manifests/chromium.json` using `apply_patch`. Never print or commit the private PEM.

- [ ] **Step 6: Make the build write reports atomically**

Import `readFileSync` and `writeFileSync`, load each source manifest after a successful Vite build, validate required identity fields, and write `JSON.stringify(createAuthReport(target, manifest), null, 2)` to the matching `chromium-auth.json`, `firefox-auth.json`, or `safari-auth.json` report. Fail the build when Chromium has no valid manifest key or Firefox has no Gecko ID.

- [ ] **Step 7: Add manifest-level tests and verify builds**

Extend `tests/extension-identity.test.ts` to read the real manifests, assert a deterministic 32-character Chromium ID, assert `tabloom@tabloom.app`, and assert no report field name matches `/token|secret|session|code/i` except the literal public callback path `auth-callback`.

Run: `npx vitest run tests/extension-identity.test.ts && npm run build:extension`

Expected: PASS and three report files under `dist-extension/reports`.

- [ ] **Step 8: Commit stable identity support**

```bash
git add .gitignore extension/manifests/chromium.json extension/scripts/extension-identity.mjs extension/scripts/build-extension.mjs tests/extension-identity.test.ts
git commit -m "build: stabilize local extension identities"
```

---

### Task 4: Package and Diagnose Firefox Locally

**Files:**
- Create: `extension/AuthCallbackDetails.tsx`
- Create after runtime capture: `extension/manifests/auth-callbacks.json`
- Create: `tests/auth-callback-details.test.tsx`
- Modify: `extension/SyncLoginPrompt.tsx`
- Modify: `extension/src.tsx`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- `AuthCallbackDetailsProps = { callbackUrl: string; target: BrowserTarget }`.
- `SyncLoginPrompt` gains `callbackUrl` and `target` props.

- [ ] **Step 1: Write a failing callback-details component test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuthCallbackDetails } from "../extension/AuthCallbackDetails";

it("reveals and copies the public Firefox callback", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<AuthCallbackDetails target="firefox" callbackUrl="https://firefox.example/auth-callback" />);
  await userEvent.click(screen.getByRole("button", { name: "Show OAuth callback" }));
  await userEvent.click(screen.getByRole("button", { name: "Copy callback" }));
  expect(writeText).toHaveBeenCalledWith("https://firefox.example/auth-callback");
});
```

- [ ] **Step 2: Run the component test and verify RED**

Run: `npx vitest run tests/auth-callback-details.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the opt-in diagnostic and wire it to the sign-in modal**

Render a collapsed **Show OAuth callback** button. When expanded, show the browser target, the public callback in a read-only code element, and a **Copy callback** button. Do not render authorization URLs, query strings, fragments, codes, or tokens.

In `extension/src.tsx`, calculate the callback once with `callbackForTarget(browserTarget, browserAdapter.identity)` and pass it to `SyncLoginPrompt`. Keep the sign-in button and local-first copy unchanged.

- [ ] **Step 4: Install the current `web-ext` package and add Firefox scripts**

Run: `npm install --save-dev web-ext@latest`

Add:

```json
"package:firefox": "npm run build:extension:firefox && web-ext build --source-dir dist-extension/firefox --artifacts-dir dist-extension/packages --overwrite-dest",
"run:firefox": "npm run build:extension:firefox && web-ext run --source-dir dist-extension/firefox --firefox /Applications/Firefox.app/Contents/MacOS/firefox"
```

- [ ] **Step 5: Run tests and build the Firefox artifact**

Run: `npx vitest run tests/auth-callback-details.test.tsx tests/extension-oauth.test.ts && npm run package:firefox`

Expected: PASS and a Firefox ZIP in `dist-extension/packages`.

- [ ] **Step 6: Capture and retain the exact Firefox callback**

Run `npm run run:firefox`, open Tabloom's sign-in modal, expand **Show OAuth callback**, and copy the exact public URL. Restart Firefox with the same Gecko ID and verify the URL is identical. Use `apply_patch` to create `extension/manifests/auth-callbacks.json` with exactly two string properties: `firefox` set to the captured runtime URL and `safari` set to `tabloom://auth-callback`. Update `build-extension.mjs` to read this registry and emit the verified Firefox report with `requiresRuntime: false`.

- [ ] **Step 7: Commit Firefox packaging and diagnostics**

```bash
git add extension/AuthCallbackDetails.tsx extension/SyncLoginPrompt.tsx extension/src.tsx extension/manifests/auth-callbacks.json tests/auth-callback-details.test.tsx package.json package-lock.json extension/scripts/build-extension.mjs
git commit -m "feat: package and diagnose Firefox OAuth"
```

---

### Task 5: Generate the Safari Wrapper and Implement the Swift OAuth Bridge

**Files:**
- Generate: `extension/safari/Tabloom/Tabloom.xcodeproj/**`
- Modify generated: `extension/safari/Tabloom/Tabloom Extension/SafariWebExtensionHandler.swift`
- Create: `extension/safari/Tabloom/Tabloom ExtensionTests/SafariOAuthBridgeTests.swift`
- Modify: `extension/scripts/build-extension.mjs`
- Modify: `package.json`

**Interfaces:**
- Native request: `{ type: "tabloom.oauth.start", authorizationUrl: string, callbackScheme: "tabloom" }`.
- Native responses: `tabloom.oauth.result`, `tabloom.oauth.cancelled`, or `tabloom.oauth.error`.
- `SafariOAuthBridge.validateAuthorizationURL` accepts only HTTPS Supabase authorization URLs for project `tctjlsvfufzxhauhywsm`.
- `SafariOAuthBridge.validateCallbackURL` accepts only `tabloom://auth-callback`.

- [ ] **Step 1: Install full Xcode and activate it**

Install Xcode from the Mac App Store. Immediately before the App Store install action, obtain the required user confirmation. After installation, run:

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
xcodebuild -version
xcrun --find safari-web-extension-converter
```

Expected: Xcode and the converter paths are printed. The user handles any macOS password prompt.

- [ ] **Step 2: Generate the retained macOS wrapper**

Change the converter destination from `dist-extension/safari-xcode` to `extension/safari/Tabloom`, use containing-app bundle ID `app.tabloom.mac`, and keep `--macos-only --swift --copy-resources --no-open --no-prompt --force`.

Run: `npm run package:safari`

Expected: a retained Xcode project under `extension/safari/Tabloom`.

- [ ] **Step 3: Add a failing Swift callback-validation test target**

```swift
import XCTest
@testable import Tabloom_Extension

final class SafariOAuthBridgeTests: XCTestCase {
    func testAcceptsOnlyTheTabloomCallback() throws {
        XCTAssertNoThrow(try SafariOAuthBridge.validateCallbackURL(URL(string: "tabloom://auth-callback?code=abc")!))
        XCTAssertThrowsError(try SafariOAuthBridge.validateCallbackURL(URL(string: "https://attacker.example/auth-callback?code=abc")!))
    }

    func testAcceptsOnlyTheConfiguredSupabaseProject() throws {
        XCTAssertNoThrow(try SafariOAuthBridge.validateAuthorizationURL(URL(string: "https://tctjlsvfufzxhauhywsm.supabase.co/auth/v1/authorize?provider=google")!))
        XCTAssertThrowsError(try SafariOAuthBridge.validateAuthorizationURL(URL(string: "https://other.supabase.co/auth/v1/authorize")!))
    }
}
```

- [ ] **Step 4: Run the Swift test and verify RED**

Run:

```bash
xcodebuild test -project "extension/safari/Tabloom/Tabloom.xcodeproj" -scheme "Tabloom" -destination "platform=macOS" CODE_SIGNING_ALLOWED=NO
```

Expected: FAIL because `SafariOAuthBridge` is not implemented.

- [ ] **Step 5: Implement URL validation and native responses in Swift**

Add a focused `SafariOAuthBridge` type to `SafariWebExtensionHandler.swift`:

```swift
enum SafariOAuthBridgeError: Error {
    case invalidAuthorizationURL
    case invalidCallbackURL
    case invalidMessage
}

enum SafariOAuthBridge {
    static func validateAuthorizationURL(_ url: URL) throws {
        guard url.scheme == "https",
              url.host == "tctjlsvfufzxhauhywsm.supabase.co",
              url.path == "/auth/v1/authorize" else {
            throw SafariOAuthBridgeError.invalidAuthorizationURL
        }
    }

    static func validateCallbackURL(_ url: URL) throws {
        guard url.scheme == "tabloom", url.host == "auth-callback" else {
            throw SafariOAuthBridgeError.invalidCallbackURL
        }
    }
}
```

In `beginRequest(with:)`, decode only `tabloom.oauth.start`, validate the authorization URL, retain an `ASWebAuthenticationSession`, use `.customScheme("tabloom")`, validate the returned callback, and reply through `SFExtensionMessageKey`. Map `ASWebAuthenticationSessionError.canceledLogin` to `tabloom.oauth.cancelled`; map all other failures to `tabloom.oauth.error` without embedding URLs or native error descriptions.

- [ ] **Step 6: Add the macOS callback scheme and local signing settings**

Add `tabloom` to the containing app's `CFBundleURLTypes`. Set the app and extension targets to **Sign to Run Locally**, Team None, with bundle IDs `app.tabloom.mac` and `app.tabloom.mac.extension`.

- [ ] **Step 7: Run Swift, TypeScript, and package builds**

Run:

```bash
xcodebuild test -project "extension/safari/Tabloom/Tabloom.xcodeproj" -scheme "Tabloom" -destination "platform=macOS" CODE_SIGNING_ALLOWED=NO
npx vitest run tests/browser-adapter.test.ts tests/extension-oauth.test.ts
npm run package:safari
```

Expected: all commands PASS.

- [ ] **Step 8: Commit the Safari wrapper**

```bash
git add extension/safari extension/scripts/build-extension.mjs package.json extension/manifests/safari.json
git commit -m "feat: package Safari native OAuth"
```

---

### Task 6: Apply Exact Supabase Redirects and Document Local Installation

**Files:**
- Modify: `supabase/config.toml`
- Modify: `docs/cross-browser-extension.md`
- Create: `tests/extension-auth-config.test.ts`

**Interfaces:**
- Consumes: generated Chromium report, runtime-captured Firefox report, and fixed Safari callback.
- Produces: one canonical documented list of exact Supabase redirect URLs.

- [ ] **Step 1: Write a failing configuration test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAuthReport } from "../extension/scripts/extension-identity.mjs";

describe("extension auth configuration", () => {
  it("contains every verified browser-family callback", () => {
    const config = readFileSync("supabase/config.toml", "utf8");
    const chromiumManifest = JSON.parse(readFileSync("extension/manifests/chromium.json", "utf8"));
    const callbacks = JSON.parse(readFileSync("extension/manifests/auth-callbacks.json", "utf8"));
    const chromium = createAuthReport("chromium", chromiumManifest);
    expect(config).toContain(chromium.callbackUrl);
    expect(config).toContain(callbacks.firefox);
    expect(config).toContain("tabloom://auth-callback");
    expect(config).toContain("https://tabloom-workspace.nickvu92.chatgpt.site/app");
  });
});
```

- [ ] **Step 2: Build reports and verify RED**

Run: `npx vitest run tests/extension-auth-config.test.ts`

Expected: FAIL because the canonical config does not yet contain every verified callback.

- [ ] **Step 3: Replace the transient Chromium callback with exact verified values**

Use `apply_patch` to set `additional_redirect_urls` to the localhost app URL, active Sites app URL, generated stable Chromium callback, captured stable Firefox callback, and `tabloom://auth-callback`. Remove the earlier path-derived callback `https://iogjohbehmaifodconaflnmhpjbaiccl.chromiumapp.org/auth-callback` unless the newly generated stable ID is identical.

- [ ] **Step 4: Update the live Supabase allowlist**

Open Supabase **Authentication → URL Configuration**. Immediately before adding and saving redirect URLs, request confirmation because this changes the live authentication allowlist. Add the exact five canonical URLs and save. Do not use browser-family wildcards.

- [ ] **Step 5: Document each local installation flow**

Update `docs/cross-browser-extension.md` with:

- Chrome: load `dist-extension/chromium` from `chrome://extensions`.
- Arc: load the same directory from `arc://extensions`.
- Dia: load the same directory from its Chromium extensions page.
- Firefox: run `npm run run:firefox` or load the package through `about:debugging`.
- Safari: run the Xcode containing app, enable Safari **Develop → Allow Unsigned Extensions**, then enable Tabloom under Safari Extensions settings.
- A callback table copied from the generated reports.
- A warning that every browser has its own local cache and Supabase is the synchronization channel.

- [ ] **Step 6: Verify config and commit**

Run: `npx vitest run tests/extension-auth-config.test.ts && rtk git diff --check`

Expected: PASS.

```bash
git add supabase/config.toml docs/cross-browser-extension.md tests/extension-auth-config.test.ts
git commit -m "docs: configure local browser OAuth callbacks"
```

---

### Task 7: Add Repeatable Package and Browser Smoke Checks

**Files:**
- Create: `tests/extension-package.test.ts`
- Create: `extension/scripts/verify-local-packages.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run verify:extension-packages` and a public-only verification summary.

- [ ] **Step 1: Write failing package-verifier tests**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectPackage, scanForbiddenSecrets } from "../extension/scripts/verify-local-packages.mjs";

describe("local package verifier", () => {
  it("rejects a package missing its new-tab entry", () => {
    const root = mkdtempSync(join(tmpdir(), "tabloom-package-"));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ manifest_version: 3 }));
    expect(() => inspectPackage(root, "chromium")).toThrow("new-tab entry");
  });

  it("detects forbidden credential names without echoing their values", () => {
    expect(scanForbiddenSecrets('{"refresh_token":"redacted"}')).toEqual(["refresh_token"]);
  });
});
```

- [ ] **Step 2: Run before building and verify RED**

Run: `npx vitest run tests/extension-package.test.ts`

Expected: FAIL because `verify-local-packages.mjs` does not exist.

- [ ] **Step 3: Implement the package verifier**

Export `inspectPackage(root, target)` and `scanForbiddenSecrets(text)`. The verifier must run all extension builds, validate manifest JSON, assert required files (`index.html`, built JS/CSS, `manifest.json`), assert the same `index.html` new-tab override for every target, enforce `identity` only for Chromium/Firefox and `nativeMessaging` only for Safari, validate public reports, scan outputs for forbidden key names (`service_role`, `client_secret`, `refresh_token`, `access_token`), and print only target, version, extension ID, callback, and artifact path.

Add:

```json
"verify:extension-packages": "node extension/scripts/verify-local-packages.mjs",
"test:extension": "vitest run tests/extension-oauth.test.ts tests/browser-adapter.test.ts tests/extension-identity.test.ts tests/auth-callback-details.test.tsx tests/extension-auth-config.test.ts tests/extension-package.test.ts"
```

- [ ] **Step 4: Verify GREEN**

Run: `npm run verify:extension-packages && npm run test:extension`

Expected: PASS with no console errors and no secret-like output.

- [ ] **Step 5: Execute browser smoke checks**

For Chrome, Arc, and Dia, load `dist-extension/chromium`, verify the ID matches `chromium-auth.json`, open a new tab, create a local link, cancel sign-in once, then complete Google sign-in and sync. For Firefox, use `npm run run:firefox` and perform the same sequence. For Safari, run the Xcode app and verify the native sign-in sheet, cancellation, retry, and sync.

Record pass/fail and browser versions in the public verification summary without recording account identifiers, URLs from the user's workspace, or auth data.

- [ ] **Step 6: Commit package verification**

```bash
git add tests/extension-package.test.ts extension/scripts/verify-local-packages.mjs package.json
git commit -m "test: verify local browser packages"
```

---

### Task 8: Run Cross-Browser Synchronization Acceptance and Final Verification

**Files:**
- Modify: `docs/cross-browser-extension.md`
- Generated but not committed: `dist-extension/**`

**Interfaces:**
- Acceptance invariant: the same Supabase user sees identical stable space, collection, link IDs, and canonical ordering after synchronization in two browser packages.

- [ ] **Step 1: Run static and automated verification**

Run:

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run build
npm run verify:extension-packages
npm run test:supabase
xcodebuild test -project "extension/safari/Tabloom/Tabloom.xcodeproj" -scheme "Tabloom" -destination "platform=macOS" CODE_SIGNING_ALLOWED=NO
```

Expected: every command exits 0.

- [ ] **Step 2: Run the cross-browser data test**

Use Chrome and Firefox first:

1. Start with local data in Chrome and an empty local workspace in Firefox.
2. Sign in to Chrome and complete the existing first-sync confirmation when required.
3. Sign in to Firefox; because its local workspace is empty, import without a confirmation.
4. Verify the same space, collection, and link IDs through repository snapshots.
5. Reorder a saved link in Firefox, synchronize, refresh Chrome, and verify canonical order.
6. Repeat the empty-browser import in Safari after its native OAuth flow succeeds.

- [ ] **Step 3: Verify failure preservation**

For each browser family, create one local-only saved link, then cancel OAuth and simulate an unregistered redirect. Confirm the local link remains present and writable and no cloud merge starts.

- [ ] **Step 4: Finalize installation documentation**

Add the verified browser versions, exact package locations, callback table, Xcode setup, and known limitation that Firefox developer installs are temporary until Mozilla signs the package. Do not include account emails or session details.

- [ ] **Step 5: Check repository cleanliness and commit final documentation**

Run: `rtk git diff --check && rtk git status --short --branch`

Expected: only intentional documentation changes are present; `dist-extension`, local keys, Xcode DerivedData, and authenticated state remain ignored.

```bash
git add docs/cross-browser-extension.md
git commit -m "docs: finish local cross-browser installation"
```

- [ ] **Step 6: Push only after the user requests or confirms pushing**

Run `rtk git log --oneline origin/main..HEAD` and present the commits. Do not push automatically unless the user explicitly asks.
