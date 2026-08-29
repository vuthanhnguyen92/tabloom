import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  installOAuthDatabaseSecret,
  runOAuthDatabaseSecretInstallerCli,
} from "../../services/tabloom-mcp/scripts/install-oauth-database-secret.mjs";

const SECRET = Buffer.alloc(32, 0x42).toString("base64url");
const DATABASE_URL = "postgres://operator:private-password@db.example.test:5432/tabloom";
const FINGERPRINT = createHash("sha256")
  .update(Buffer.from(SECRET, "base64url"))
  .digest("hex");

type Query = string | { text: string; values: unknown[] };

function database(options: { fingerprint?: string; failQuery?: boolean } = {}) {
  const queries: Query[] = [];
  let closed = false;
  return {
    queries,
    get closed() { return closed; },
    client: {
      async query(query: Query) {
        queries.push(query);
        if (options.failQuery && typeof query !== "string") {
          throw new Error(`${DATABASE_URL} ${SECRET}`);
        }
        if (typeof query !== "string") {
          return { rows: [{ fingerprint: options.fingerprint ?? FINGERPRINT }] };
        }
        return { rows: [] };
      },
      async end() { closed = true; },
    },
  };
}

describe("OAuth database secret installer", () => {
  it("installs decoded bytes through one parameterized transactional upsert", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-db-secret-"));
    const secretPath = join(directory, "database-proof-v1.txt");
    const connection = database();
    try {
      await writeFile(secretPath, SECRET, { mode: 0o600 });
      const result = await installOAuthDatabaseSecret({
        secretPath,
        databaseUrl: DATABASE_URL,
        connect: async (url: string) => {
          expect(url).toBe(DATABASE_URL);
          return connection.client;
        },
      });

      expect(result).toEqual({ fingerprint: FINGERPRINT });
      expect(connection.closed).toBe(true);
      expect(connection.queries).toEqual([
        "BEGIN",
        {
          text: `insert into oauth_private.facade_secret (singleton, secret)
values (true, $1::bytea)
on conflict (singleton) do update set secret = excluded.secret
returning encode(extensions.digest(secret, 'sha256'), 'hex') as fingerprint`,
          values: [Buffer.from(SECRET, "base64url")],
        },
        "COMMIT",
      ]);
      expect(connection.queries[1]).toMatchObject({
        values: [Buffer.from(SECRET, "base64url")],
      });
      expect(String((connection.queries[1] as { text: string }).text)).not.toContain(SECRET);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing file", async (path: string) => path],
    ["symlink", async (path: string) => {
      const target = `${path}-target`;
      await writeFile(target, SECRET, { mode: 0o600 });
      await symlink(target, path);
      return path;
    }],
    ["non-regular file", async (path: string) => {
      await mkdir(path, { mode: 0o700 });
      return path;
    }],
    ["group-readable file", async (path: string) => {
      await writeFile(path, SECRET, { mode: 0o600 });
      await chmod(path, 0o640);
      return path;
    }],
    ["world-readable file", async (path: string) => {
      await writeFile(path, SECRET, { mode: 0o600 });
      await chmod(path, 0o604);
      return path;
    }],
    ["newline", async (path: string) => {
      await writeFile(path, `${SECRET}\n`, { mode: 0o600 });
      return path;
    }],
    ["whitespace", async (path: string) => {
      await writeFile(path, ` ${SECRET}`, { mode: 0o600 });
      return path;
    }],
    ["non-canonical base64url", async (path: string) => {
      await writeFile(path, `${SECRET}=`, { mode: 0o600 });
      return path;
    }],
    ["wrong decoded length", async (path: string) => {
      await writeFile(path, Buffer.alloc(31, 0x42).toString("base64url"), { mode: 0o600 });
      return path;
    }],
  ])("rejects an unsafe %s without connecting", async (_name, setup) => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-db-secret-"));
    const secretPath = join(directory, "database-proof-v1.txt");
    let connections = 0;
    try {
      await expect(installOAuthDatabaseSecret({
        secretPath: await setup(secretPath),
        databaseUrl: DATABASE_URL,
        connect: async () => { connections += 1; return database().client; },
      })).rejects.toThrow("OAuth database secret installation failed");
      expect(connections).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an artifact path inside the repository", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "tabloom-oauth-repository-"));
    const secretPath = join(repositoryRoot, "database-proof-v1.txt");
    let connections = 0;
    try {
      await writeFile(secretPath, SECRET, { mode: 0o600 });
      await expect(installOAuthDatabaseSecret({
        secretPath,
        databaseUrl: DATABASE_URL,
        repositoryRoot,
        connect: async () => { connections += 1; return database().client; },
      })).rejects.toThrow("OAuth database secret installation failed");
      expect(connections).toBe(0);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("rolls back and closes when the upsert or returned fingerprint is invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-db-secret-"));
    const secretPath = join(directory, "database-proof-v1.txt");
    try {
      await writeFile(secretPath, SECRET, { mode: 0o600 });
      for (const connection of [
        database({ failQuery: true }),
        database({ fingerprint: "not-a-sha256" }),
      ]) {
        await expect(installOAuthDatabaseSecret({
          secretPath,
          databaseUrl: DATABASE_URL,
          connect: async () => connection.client,
        })).rejects.toThrow("OAuth database secret installation failed");
        expect(connection.queries).toContain("ROLLBACK");
        expect(connection.closed).toBe(true);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes missing connection details and failures without leaking sensitive inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-db-secret-"));
    const secretPath = join(directory, "database-proof-v1.txt");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const errors: string[] = [];
    try {
      await writeFile(secretPath, SECRET, { mode: 0o600 });
      await installOAuthDatabaseSecret({
        secretPath,
        databaseUrl: "",
        connect: async () => database().client,
      }).catch((error: unknown) => { errors.push(String(error)); });
      expect(errors).toEqual(["Error: OAuth database secret installation failed"]);
      const failure = await runOAuthDatabaseSecretInstallerCli({
        argv: ["--secret-file", secretPath],
        env: { TABLOOM_OAUTH_DATABASE_URL: DATABASE_URL },
        connect: async () => { throw new Error(`${DATABASE_URL} ${SECRET}`); },
        stdout: (message: string) => { stdout.push(message); },
        stderr: (message: string) => { stderr.push(message); },
      });
      expect(failure).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual(["OAuth database secret installation failed."]);
      expect(JSON.stringify(stderr)).not.toContain(SECRET);
      expect(JSON.stringify(stderr)).not.toContain(DATABASE_URL);
      expect(JSON.stringify(errors)).not.toContain(SECRET);
      expect(JSON.stringify(errors)).not.toContain(DATABASE_URL);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prints only the database fingerprint and rejects unknown CLI flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabloom-oauth-db-secret-"));
    const secretPath = join(directory, "database-proof-v1.txt");
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      await writeFile(secretPath, SECRET, { mode: 0o600 });
      const exitCode = await runOAuthDatabaseSecretInstallerCli({
        argv: ["--secret-file", secretPath],
        env: { TABLOOM_OAUTH_DATABASE_URL: DATABASE_URL },
        connect: async () => database().client,
        stdout: (message: string) => { stdout.push(message); },
        stderr: (message: string) => { stderr.push(message); },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toEqual([FINGERPRINT]);
      expect(stderr).toEqual([]);
      await expect(runOAuthDatabaseSecretInstallerCli({
        argv: ["--unknown", secretPath],
        env: { TABLOOM_OAUTH_DATABASE_URL: DATABASE_URL },
        connect: async () => database().client,
      })).resolves.toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
