import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import nextConfig from "../../services/tabloom-mcp/next.config";
import { GET } from "../../services/tabloom-mcp/app/api/health/route";

describe("Tabloom MCP service configuration", () => {
  it("pins the supported MCP server runtime and dependencies", async () => {
    const manifest = JSON.parse(
      await readFile("services/tabloom-mcp/package.json", "utf8"),
    );

    expect(manifest.engines.node).toBe(">=22.13.0");
    expect(manifest.dependencies).toEqual({
      "@modelcontextprotocol/server": "2.0.0",
      "@supabase/supabase-js": "2.112.4",
      "@tabloom/workspace": "file:../../shared",
      "pg": "8.23.0",
      "mcp-handler": "2.1.1",
      "next": "16.3.3",
      "react": "19.2.6",
      "react-dom": "19.2.6",
      "jose": "6.2.10",
      "zod": "4.5.2",
    });
  });

  it("provides the service lifecycle scripts", async () => {
    const manifest = JSON.parse(
      await readFile("services/tabloom-mcp/package.json", "utf8"),
    );

    expect(manifest.scripts).toMatchObject({
      dev: "next dev",
      build: "next build",
      start: "next start",
      "type-check": "tsc --noEmit",
      lint: "eslint .",
    });
  });

  it("installs the TypeScript build toolchain when deployed as an isolated root", async () => {
    const manifest = JSON.parse(
      await readFile("services/tabloom-mcp/package.json", "utf8"),
    );

    expect(manifest.devDependencies).toEqual({
      "@types/node": "22.19.19",
      "@types/react": "19.2.14",
      "@types/react-dom": "19.2.3",
      typescript: "5.9.3",
    });
  });

  it("is included by the root workspace", async () => {
    const rootManifest = JSON.parse(await readFile("package.json", "utf8"));

    expect(rootManifest.workspaces).toEqual(["shared", "services/*"]);
  });

  it("transpiles the local shared workspace package", () => {
    expect(nextConfig.transpilePackages).toEqual(["@tabloom/workspace"]);
  });

  it("serves a non-sensitive, uncached health response", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      service: "tabloom-mcp",
      status: "ok",
    });
  });

  it("exports only domain and repository modules from the shared package", async () => {
    const manifest = JSON.parse(await readFile("shared/package.json", "utf8"));

    expect(Object.keys(manifest.exports)).toEqual([
      "./domain",
      "./repository",
      "./workspace-sync-repository",
      "./collection-sharing",
    ]);
  });
});
