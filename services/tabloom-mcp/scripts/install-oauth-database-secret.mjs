#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../../..");
const UPSERT_SECRET = `insert into oauth_private.facade_secret (singleton, secret)
values (true, $1::bytea)
on conflict (singleton) do update set secret = excluded.secret
returning encode(extensions.digest(secret, 'sha256'), 'hex') as fingerprint`;

function installationFailure() {
  return new Error("OAuth database secret installation failed");
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function requirePrivateRegularFile(metadata) {
  const expectedUid = BigInt(process.getuid?.() ?? -1);
  if (!metadata.isFile() || metadata.uid !== expectedUid ||
      (metadata.mode & 0o777n) !== 0o600n) {
    throw installationFailure();
  }
}

async function readCanonicalSecret(secretPath, repositoryRoot) {
  if (typeof secretPath !== "string" || !isAbsolute(secretPath)) {
    throw installationFailure();
  }
  const root = await realpath(repositoryRoot).catch(() => {
    throw installationFailure();
  });
  const canonicalParent = await realpath(dirname(secretPath)).catch(() => {
    throw installationFailure();
  });
  const canonicalPath = resolve(canonicalParent, basename(secretPath));
  if (isInside(root, canonicalPath)) throw installationFailure();

  let handle;
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [handleMetadata, pathMetadata] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(canonicalPath, { bigint: true }),
    ]);
    requirePrivateRegularFile(handleMetadata);
    requirePrivateRegularFile(pathMetadata);
    if (!sameIdentity(handleMetadata, pathMetadata)) throw installationFailure();

    const fileBytes = await handle.readFile();
    if (fileBytes.length !== 43) throw installationFailure();
    const value = fileBytes.toString("utf8");
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw installationFailure();
    const secret = Buffer.from(value, "base64url");
    if (secret.length !== 32 || secret.toString("base64url") !== value) {
      throw installationFailure();
    }
    return secret;
  } catch (error) {
    if (error?.message === "OAuth database secret installation failed") throw error;
    throw installationFailure();
  } finally {
    try {
      await handle?.close();
    } catch {
      // The fixed failure below never reveals a local file detail.
    }
  }
}

async function connectPostgres(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  client.on("error", () => {
    // pg emits connection errors asynchronously; never let it emit unhandled.
  });
  try {
    await client.connect();
    return client;
  } catch {
    try {
      await client.end();
    } catch {
      // The caller receives one fixed, non-sensitive installation failure.
    }
    throw installationFailure();
  }
}

/**
 * @param {{
 *   secretPath: string,
 *   databaseUrl: string,
 *   connect: (databaseUrl: string) => Promise<{ query(query: string | { text: string, values: Buffer[] }): Promise<{ rows: Array<{ fingerprint?: unknown }> }>, end(): Promise<void> }>,
 *   repositoryRoot?: string,
 * }} options
 * @returns {Promise<{ fingerprint: string }>}
 */
export async function installOAuthDatabaseSecret({
  secretPath,
  databaseUrl,
  connect = connectPostgres,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
}) {
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0 ||
      typeof connect !== "function") {
    throw installationFailure();
  }

  const secret = await readCanonicalSecret(secretPath, repositoryRoot);
  let client;
  let transactionStarted = false;
  try {
    client = await connect(databaseUrl);
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await client.query({ text: UPSERT_SECRET, values: [secret] });
    const fingerprint = result?.rows?.[0]?.fingerprint;
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw installationFailure();
    }
    await client.query("COMMIT");
    transactionStarted = false;
    return { fingerprint };
  } catch {
    if (transactionStarted) {
      try {
        await client?.query("ROLLBACK");
      } catch {
        // Preserve the same non-sensitive failure for every database error.
      }
    }
    throw installationFailure();
  } finally {
    try {
      await client?.end();
    } catch {
      // The connection cannot leak its detail through this installer.
    }
  }
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--secret-file" ||
      typeof argv[1] !== "string" || argv[1].length === 0) {
    throw installationFailure();
  }
  return { secretPath: argv[1] };
}

export async function runOAuthDatabaseSecretInstallerCli({
  argv = process.argv.slice(2),
  env = process.env,
  connect = connectPostgres,
  stdout = console.log,
  stderr = console.error,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
} = {}) {
  try {
    const { secretPath } = parseArguments(argv);
    const { fingerprint } = await installOAuthDatabaseSecret({
      secretPath,
      databaseUrl: env.TABLOOM_OAUTH_DATABASE_URL,
      connect,
      repositoryRoot,
    });
    stdout(fingerprint);
    return 0;
  } catch {
    stderr("OAuth database secret installation failed.");
    return 1;
  }
}

const isEntrypoint = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  runOAuthDatabaseSecretInstallerCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
