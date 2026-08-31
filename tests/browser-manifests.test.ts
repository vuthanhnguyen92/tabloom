import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const targets = ["chromium", "firefox", "safari"] as const;
const icons = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
};

describe("browser manifests", () => {
  it.each(targets)("defines a new-tab MV3 build for %s", (target) => {
    const manifest = JSON.parse(readFileSync(resolve("extension/manifests", `${target}.json`), "utf8"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.chrome_url_overrides).toEqual({ newtab: "index.html" });
    expect(manifest.permissions).toEqual(expect.arrayContaining(["tabs", "storage"]));
    expect(manifest.icons).toEqual(icons);
    if (target !== "safari") expect(manifest.permissions).toContain("identity");
    expect(manifest.host_permissions).toContain("https://*.supabase.co/*");
  });

  it("pins a stable Firefox add-on ID for OAuth redirects", () => {
    const manifest = JSON.parse(readFileSync(resolve("extension/manifests/firefox.json"), "utf8"));
    expect(manifest.browser_specific_settings.gecko.id).toBe("tabloom@tabloom.app");
  });

  it("does not request unsupported Safari identity, bookmark, or tab-group access", () => {
    const manifest = JSON.parse(readFileSync(resolve("extension/manifests/safari.json"), "utf8"));
    expect(manifest.permissions).not.toContain("identity");
    expect(manifest.optional_permissions ?? []).not.toEqual(expect.arrayContaining(["bookmarks", "tabGroups"]));
    expect(manifest.web_accessible_resources).toContainEqual({
      resources: ["auth-callback.html"],
      matches: ["https://*.supabase.co/*"],
    });
  });
});
