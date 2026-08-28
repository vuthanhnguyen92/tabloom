import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
const supportedTargets = ["chromium", "firefox", "safari"];
const targetArg = process.argv.find((argument) => argument.startsWith("--target="))?.split("=")[1];
const targets = targetArg ? [targetArg] : supportedTargets;

if (targets.some((target) => !supportedTargets.includes(target))) {
  throw new Error(`Unknown browser target. Use one of: ${supportedTargets.join(", ")}.`);
}

for (const target of targets) {
  const result = spawnSync(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "build", "--config", resolve(root, "extension/vite.config.ts")], {
    cwd: root,
    env: { ...process.env, TABLOOM_BROWSER_TARGET: target },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);

  const output = resolve(root, "dist-extension", target);
  mkdirSync(output, { recursive: true });
  copyFileSync(resolve(root, "extension/manifests", `${target}.json`), resolve(output, "manifest.json"));
  copyFileSync(resolve(root, "extension/auth-callback.html"), resolve(output, "auth-callback.html"));
}

if (process.argv.includes("--safari-project")) {
  const candidates = ["safari-web-extension-packager", "safari-web-extension-converter"];
  const packager = candidates.find((candidate) => spawnSync("xcrun", ["--find", candidate], { encoding: "utf8" }).status === 0);
  if (!packager) {
    console.error("Safari resources were built, but the Xcode Safari packager is unavailable. Install full Xcode, then rerun npm run package:safari.");
    process.exit(2);
  }
  const result = spawnSync("xcrun", [
    packager,
    resolve(root, "dist-extension/safari"),
    "--project-location", resolve(root, "dist-extension/safari-xcode"),
    "--app-name", "Tabloom",
    "--bundle-identifier", "app.tabloom.extension",
    "--swift",
    "--macos-only",
    "--copy-resources",
    "--no-open",
    "--no-prompt",
    "--force",
  ], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
