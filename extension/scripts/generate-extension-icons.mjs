import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

export const extensionIconSizes = [16, 32, 48, 128];

export async function generateExtensionIcons(outputDirectory, sourcePath) {
  const iconDirectory = resolve(outputDirectory, "icons");
  await mkdir(iconDirectory, { recursive: true });
  await Promise.all(extensionIconSizes.map((size) =>
    sharp(sourcePath)
      .resize(size, size, { fit: "fill" })
      .png({ adaptiveFiltering: false, compressionLevel: 9 })
      .toFile(resolve(iconDirectory, `icon-${size}.png`)),
  ));
}
