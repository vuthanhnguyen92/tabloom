import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Tabloom MCP service configuration", () => {
  it("pins the supported MCP server runtime", async () => {
    const manifest = JSON.parse(
      await readFile("services/tabloom-mcp/package.json", "utf8"),
    );

    expect(manifest.engines.node).toBe(">=22.13.0");
    expect(manifest.dependencies).toMatchObject({
      "@modelcontextprotocol/server": "2.0.0",
      "mcp-handler": "2.1.1",
      "jose": "6.2.10",
      "zod": "4.5.2",
    });
  });

  it("exports only domain and repository modules from the shared package", async () => {
    const manifest = JSON.parse(await readFile("shared/package.json", "utf8"));

    expect(Object.keys(manifest.exports)).toEqual([
      "./domain",
      "./repository",
      "./workspace-sync-repository",
    ]);
  });
});
