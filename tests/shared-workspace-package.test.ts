import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("shared workspace package", () => {
  it("publishes the domain repositories without UI or browser adapters", async () => {
    const manifest = JSON.parse(await readFile("shared/package.json", "utf8"));

    expect(manifest).toMatchObject({
      name: "@tabloom/workspace",
      version: "0.1.0",
      private: true,
      exports: {
        "./domain": "./domain.ts",
        "./repository": "./repository.ts",
        "./workspace-sync-repository": "./workspace-sync-repository.ts",
      },
      dependencies: {
        "@supabase/supabase-js": "2.112.4",
      },
    });
  });
});
