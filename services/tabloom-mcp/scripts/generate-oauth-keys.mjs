#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
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

async function prepareTarget(value, repositoryRoot, inspectParent) {
  if (typeof value !== "string" || !value || value === "-") {
    throw new Error("An explicit file path is required");
  }
  if (!isAbsolute(value)) {
    throw new Error("OAuth key output paths must be absolute");
  }

  const root = await realpath(repositoryRoot);
  const lexicalTarget = resolve(value);
  const parentPath = dirname(lexicalTarget);
  const parentIdentity = await inspectParent(parentPath);
  const canonicalParent = await realpath(parentPath);
  const canonicalTarget = resolve(canonicalParent, basename(lexicalTarget));
  if (isInside(root, lexicalTarget) || isInside(root, canonicalTarget)) {
    throw new Error("OAuth key output paths must be outside the repository");
  }
  try {
    await lstat(lexicalTarget);
    throw new Error("OAuth key output files must not already exist");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        target: lexicalTarget,
        parentPath,
        parentIdentity,
      };
    }
    throw error;
  }
}

function versionedKid(purpose) {
  return `${purpose}-v1-${randomBytes(12).toString("base64url")}`;
}

async function inspectPrivateParent(path) {
  const metadata = await lstat(path, { bigint: true });
  const expectedUid = BigInt(process.getuid?.() ?? -1);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      metadata.uid !== expectedUid || (metadata.mode & 0o777n) !== 0o700n) {
    throw new Error("OAuth key output parent must be an owned mode-0700 directory");
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function inspectCreatedOutput(handle, path) {
  const [handleMetadata, pathMetadata] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
  ]);
  const expectedUid = BigInt(process.getuid?.() ?? -1);
  if (!handleMetadata.isFile() || !pathMetadata.isFile() ||
      handleMetadata.uid !== expectedUid || pathMetadata.uid !== expectedUid ||
      (handleMetadata.mode & 0o777n) !== 0o600n ||
      (pathMetadata.mode & 0o777n) !== 0o600n ||
      !sameIdentity(handleMetadata, pathMetadata)) {
    throw new Error("OAuth key output identity changed");
  }
  return { dev: handleMetadata.dev, ino: handleMetadata.ino };
}

async function inspectCreatedHandle(handle) {
  const metadata = await handle.stat({ bigint: true });
  const expectedUid = BigInt(process.getuid?.() ?? -1);
  if (!metadata.isFile() || metadata.uid !== expectedUid ||
      (metadata.mode & 0o777n) !== 0o600n) {
    throw new Error("OAuth key output handle was invalid");
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

async function closeQuietly(handle) {
  try {
    await handle?.close();
  } catch {
    // Cleanup must not replace the original fixed CLI failure.
  }
}

async function unlinkCreatedQuietly(path, expectedIdentity) {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (!sameIdentity(metadata, expectedIdentity)) return;
    await unlink(path);
  } catch {
    // Only files created exclusively by this invocation are cleanup targets.
  }
}

export async function generateOAuthKeys({
  signingPath,
  encryptionPath,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  closeHandle = (handle) => handle.close(),
  inspectParent = inspectPrivateParent,
  inspectOutput = inspectCreatedOutput,
}) {
  const signing = await prepareTarget(signingPath, repositoryRoot, inspectParent);
  const encryption = await prepareTarget(encryptionPath, repositoryRoot, inspectParent);
  if (signing.target === encryption.target) {
    throw new Error("Signing and encryption outputs must be different files");
  }

  let signingHandle;
  let encryptionHandle;
  let signingIdentity;
  let encryptionIdentity;
  let failure;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW;
    signingHandle = await open(signing.target, flags, 0o600);
    signingIdentity = await inspectCreatedHandle(signingHandle);
    const signingPathIdentity = await inspectOutput(signingHandle, signing.target);
    if (!sameIdentity(signingIdentity, signingPathIdentity)) {
      throw new Error("OAuth key output identity changed");
    }
    encryptionHandle = await open(encryption.target, flags, 0o600);
    encryptionIdentity = await inspectCreatedHandle(encryptionHandle);
    const encryptionPathIdentity = await inspectOutput(
      encryptionHandle,
      encryption.target,
    );
    if (!sameIdentity(encryptionIdentity, encryptionPathIdentity)) {
      throw new Error("OAuth key output identity changed");
    }

    const [signingParentAfter, encryptionParentAfter] = await Promise.all([
      inspectParent(signing.parentPath),
      inspectParent(encryption.parentPath),
    ]);
    if (!sameIdentity(signing.parentIdentity, signingParentAfter) ||
        !sameIdentity(encryption.parentIdentity, encryptionParentAfter)) {
      throw new Error("OAuth key output parent identity changed");
    }
    const [signingOutputAfter, encryptionOutputAfter] = await Promise.all([
      inspectOutput(signingHandle, signing.target),
      inspectOutput(encryptionHandle, encryption.target),
    ]);
    if (!sameIdentity(signingIdentity, signingOutputAfter) ||
        !sameIdentity(encryptionIdentity, encryptionOutputAfter)) {
      throw new Error("OAuth key output identity changed");
    }

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
    failure = error;
  } finally {
    const closeResults = await Promise.allSettled(
      [signingHandle, encryptionHandle]
        .filter(Boolean)
        .map((handle) => Promise.resolve().then(() => closeHandle(handle))),
    );
    if (closeResults.some((result) => result.status === "rejected")) {
      failure ??= new Error("OAuth key output close failed");
      await Promise.all([
        closeQuietly(signingHandle),
        closeQuietly(encryptionHandle),
      ]);
    }
  }
  if (failure) {
    await Promise.all([
      unlinkCreatedQuietly(signing.target, signingIdentity),
      unlinkCreatedQuietly(encryption.target, encryptionIdentity),
    ]);
    throw failure;
  }
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
