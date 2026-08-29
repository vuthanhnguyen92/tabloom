import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function deriveChromiumExtensionId(publicKeyBase64) {
  if (typeof publicKeyBase64 !== "string" || !publicKeyBase64.length) {
    throw new Error("The Chromium manifest requires a public key.");
  }
  const digest = createHash("sha256")
    .update(Buffer.from(publicKeyBase64, "base64"))
    .digest("hex")
    .slice(0, 32);
  return [...digest]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");
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
    const extensionId = manifest.browser_specific_settings?.gecko?.id;
    if (!extensionId) throw new Error("The Firefox manifest requires a Gecko ID.");
    return { target, extensionId, callbackUrl: null, requiresRuntime: true };
  }

  if (target === "safari") {
    return {
      target,
      extensionId: "app.tabloom.mac.extension",
      callbackUrl: "tabloom://auth-callback",
      requiresRuntime: false,
    };
  }

  throw new Error(`Unsupported extension target: ${target}.`);
}

export function writeAuthReport(reportsDirectory, target, manifest) {
  mkdirSync(reportsDirectory, { recursive: true });
  const destination = join(reportsDirectory, `${target}-auth.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(createAuthReport(target, manifest), null, 2)}\n`);
  renameSync(temporary, destination);
  return destination;
}
