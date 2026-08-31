import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { extensionIconSizes, generateExtensionIcons } from "../extension/scripts/generate-extension-icons.mjs";

const temporaryDirectories: string[] = [];
const readImage = sharp as unknown as (input: string) => {
  metadata(): Promise<{ format?: string; height?: number; width?: number }>;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("extension icon generation", () => {
  it("writes a square PNG at every manifest size", async () => {
    const output = await mkdtemp(join(tmpdir(), "tabloom-icons-"));
    temporaryDirectories.push(output);

    await generateExtensionIcons(output, resolve("shared/assets/tabloom-mark.svg"));

    expect(extensionIconSizes).toEqual([16, 32, 48, 128]);
    for (const size of extensionIconSizes) {
      const metadata = await readImage(join(output, "icons", `icon-${size}.png`)).metadata();
      expect(metadata).toMatchObject({ format: "png", height: size, width: size });
    }
  });
});
