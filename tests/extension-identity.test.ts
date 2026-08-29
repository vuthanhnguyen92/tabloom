import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAuthReport,
  deriveChromiumExtensionId,
  writeAuthReport,
} from "../extension/scripts/extension-identity.mjs";

describe("extension identity reports", () => {
  it("derives Chrome's deterministic a-p extension ID from a public key", () => {
    const publicKeyBase64 = "dGFibG9vbS1wdWJsaWMta2V5LWZpeHR1cmU=";

    expect(deriveChromiumExtensionId(publicKeyBase64)).toBe("jdmlnnfinjhokdpmihdpeajhladkamaf");
  });

  it("reports the exact public Chromium callback", () => {
    const report = createAuthReport("chromium", {
      key: "dGFibG9vbS1wdWJsaWMta2V5LWZpeHR1cmU=",
    });

    expect(report).toEqual({
      target: "chromium",
      extensionId: "jdmlnnfinjhokdpmihdpeajhladkamaf",
      callbackUrl: "https://jdmlnnfinjhokdpmihdpeajhladkamaf.chromiumapp.org/auth-callback",
      requiresRuntime: false,
    });
  });

  it("requires runtime callback discovery for an explicitly identified Firefox package", () => {
    expect(createAuthReport("firefox", {
      browser_specific_settings: { gecko: { id: "tabloom@tabloom.app" } },
    })).toEqual({
      target: "firefox",
      extensionId: "tabloom@tabloom.app",
      callbackUrl: null,
      requiresRuntime: true,
    });
  });

  it("reports Safari's fixed native callback", () => {
    expect(createAuthReport("safari", {})).toEqual({
      target: "safari",
      extensionId: "app.tabloom.mac.extension",
      callbackUrl: "tabloom://auth-callback",
      requiresRuntime: false,
    });
  });

  it("keeps the checked-in Chromium manifest identity deterministic", () => {
    const manifest = JSON.parse(readFileSync("extension/manifests/chromium.json", "utf8"));
    const first = createAuthReport("chromium", manifest);
    const second = createAuthReport("chromium", manifest);

    expect(first.extensionId).toMatch(/^[a-p]{32}$/);
    expect(second).toEqual(first);
  });

  it("writes a public report to the target-specific JSON file", () => {
    const reportsDirectory = mkdtempSync(join(tmpdir(), "tabloom-auth-reports-"));

    const path = writeAuthReport(reportsDirectory, "safari", {});

    expect(path).toBe(join(reportsDirectory, "safari-auth.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      target: "safari",
      extensionId: "app.tabloom.mac.extension",
      callbackUrl: "tabloom://auth-callback",
      requiresRuntime: false,
    });
  });
});
