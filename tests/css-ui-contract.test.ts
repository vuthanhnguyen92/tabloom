import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const cssFiles = ["app/globals.css", "extension/style.css", "shared/organizer/organizer.css", "shared/classic-organizer/classic-organizer.css"];

describe("shared UI CSS contract", () => {
  it("does not ship authored font sizes below 12px", () => {
    const violations: string[] = [];
    for (const file of cssFiles) {
      const css = readFileSync(resolve(root, file), "utf8");
      for (const match of css.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)) {
        if (Number(match[1]) < 12) violations.push(`${file}: ${match[0]}`);
      }
      for (const match of css.matchAll(/\bfont\s*:[^;{}]*?(\d+(?:\.\d+)?)px(?:\/[^;\s]+)?/gi)) {
        if (Number(match[1]) < 12) violations.push(`${file}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps saved and shared cards stationary on hover", () => {
    const organizer = readFileSync(resolve(root, "shared/organizer/organizer.css"), "utf8");
    const shared = readFileSync(resolve(root, "app/globals.css"), "utf8");
    expect(organizer.match(/\.ext-link-card\s*>\s*a:hover\s*\{[^}]*\}/)?.[0]).not.toMatch(/translateY/);
    expect(shared.match(/\.shared-link-card:hover[^{]*\{[^}]*\}/)?.[0]).not.toMatch(/translateY/);
  });
});
