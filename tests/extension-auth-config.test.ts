import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAuthReport } from "../extension/scripts/extension-identity.mjs";

describe("extension auth configuration", () => {
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
