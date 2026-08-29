#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportJWK, generateKeyPair } from "jose";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../..");

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function targetPath(value, repositoryRoot) {
  if (typeof value !== "string" || !value || value === "-") {
    throw new Error("An explicit file path is required");
  }
  if (!isAbsolute(value)) {
    throw new Error("OAuth key output paths must be absolute");
  }

  const root = await realpath(repositoryRoot);
  const lexicalTarget = resolve(value);
  const parent = await realpath(dirname(lexicalTarget));
  const canonicalTarget = resolve(parent, basename(lexicalTarget));
  if (isInside(root, lexicalTarget) || isInside(root, canonicalTarget)) {
    throw new Error("OAuth key output paths must be outside the repository");
  }
  try {
    await lstat(lexicalTarget);
    throw new Error("OAuth key output files must not already exist");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return canonicalTarget;
    }
    throw error;
  }
}

function versionedKid(purpose) {
  return `${purpose}-v1-${randomBytes(12).toString("base64url")}`;
}

async function closeQuietly(handle) {
  try {
    await handle?.close();
  } catch {
    // Cleanup must not replace the original fixed CLI failure.
  }
}

async function unlinkQuietly(path) {
  try {
    await unlink(path);
  } catch {
    // Only files created exclusively by this invocation are cleanup targets.
  }
}

export async function generateOAuthKeys({
  signingPath,
  encryptionPath,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
}) {
  const signingTarget = await targetPath(signingPath, repositoryRoot);
  const encryptionTarget = await targetPath(encryptionPath, repositoryRoot);
  if (signingTarget === encryptionTarget) {
    throw new Error("Signing and encryption outputs must be different files");
  }

  let signingHandle;
  let encryptionHandle;
  let signingCreated = false;
  let encryptionCreated = false;
  try {
    signingHandle = await open(signingTarget, "wx", 0o600);
    signingCreated = true;
    encryptionHandle = await open(encryptionTarget, "wx", 0o600);
    encryptionCreated = true;

    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = {
      ...await exportJWK(privateKey),
      alg: "ES256",
    };
    const signingRing = [{
      kid: versionedKid("signing"),
      active: true,
      privateJwk,
    }];
    const encryptionRing = [{
      kid: versionedKid("encryption"),
      active: true,
      rootKey: randomBytes(32).toString("base64url"),
    }];

    await signingHandle.writeFile(`${JSON.stringify(signingRing)}\n`, "utf8");
    await signingHandle.chmod(0o600);
    await signingHandle.sync();
    await encryptionHandle.writeFile(`${JSON.stringify(encryptionRing)}\n`, "utf8");
    await encryptionHandle.chmod(0o600);
    await encryptionHandle.sync();
  } catch (error) {
    await closeQuietly(signingHandle);
    await closeQuietly(encryptionHandle);
    if (signingCreated) await unlinkQuietly(signingTarget);
    if (encryptionCreated) await unlinkQuietly(encryptionTarget);
    throw error;
  }
  await signingHandle.close();
  await encryptionHandle.close();
}

function parseArguments(argv) {
  if (argv.length !== 4) throw new Error("Invalid arguments");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (
      (flag !== "--signing-out" && flag !== "--encryption-out") ||
      values.has(flag)
    ) {
      throw new Error("Invalid arguments");
    }
    values.set(flag, argv[index + 1]);
  }
  if (!values.has("--signing-out") || !values.has("--encryption-out")) {
    throw new Error("Invalid arguments");
  }
  return {
    signingPath: values.get("--signing-out"),
    encryptionPath: values.get("--encryption-out"),
  };
}

export async function runKeyGeneratorCli({
  argv = process.argv.slice(2),
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  void stdout;
  try {
    const paths = parseArguments(argv);
    await generateOAuthKeys({ ...paths, repositoryRoot });
    return 0;
  } catch {
    stderr(
      "OAuth key generation failed. Supply two new absolute paths outside the repository.",
    );
    return 1;
  }
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  runKeyGeneratorCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
