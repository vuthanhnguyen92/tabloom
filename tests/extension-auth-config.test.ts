import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAuthReport } from "../extension/scripts/extension-identity.mjs";

describe("extension auth configuration", () => {
  it("allows shared-save callbacks and collection destinations on canonical web origins", () => {
    const config = readFileSync("supabase/config.toml", "utf8");
    for (const origin of ["http://localhost:4173", "https://tabloom.nickvu.dev"]) {
      expect(config).toContain(`${origin}/auth/shared-save`);
      expect(config).toContain(`${origin}/app?collection=*`);
    }
  });
  it("allows every verified callback plus the currently installed Chrome migration callback", () => {
    const config = readFileSync("supabase/config.toml", "utf8");
    const chromiumManifest = JSON.parse(readFileSync("extension/manifests/chromium.json", "utf8"));
    const callbacks = JSON.parse(readFileSync("extension/manifests/auth-callbacks.json", "utf8"));
    const chromium = createAuthReport("chromium", chromiumManifest);

    expect(config).toContain(chromium.callbackUrl);
    expect(config).toContain("https://iogjohbehmaifodconaflnmhpjbaiccl.chromiumapp.org/auth-callback");
    expect(config).toContain(callbacks.firefox);
    expect(config).toContain(callbacks.safari);
    expect(config).toContain("https://tabloom-workspace.nickvu92.chatgpt.site/app");
  });
});
