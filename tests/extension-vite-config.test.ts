import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../extension/vite.config";

describe("extension Vite configuration", () => {
  it("loads VITE variables from the repository root", () => {
    expect(config).toMatchObject({
      root: resolve(import.meta.dirname, "../extension"),
      envDir: resolve(import.meta.dirname, ".."),
    });
  });
});
