import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  projects: [
    { name: "chromium", testIgnore: /visual-consistency\.spec\.ts/, use: { browserName: "chromium" } },
    { name: "chromium-visual", testMatch: /visual-consistency\.spec\.ts/, use: { browserName: "chromium" } },
    { name: "firefox-visual", testMatch: /visual-consistency\.spec\.ts/, use: { browserName: "firefox" } },
    { name: "webkit-visual", testMatch: /visual-consistency\.spec\.ts/, use: { browserName: "webkit" } },
  ],
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}",
});
