import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

describe("landing page visual system", () => {
  it("adapts to the browser color scheme", () => {
    expect(stylesheet).toContain("@media (prefers-color-scheme: dark)");
    expect(stylesheet).toMatch(/\.marketing-page\s*\{/);
  });

  it("provides responsive layouts and motion-safe workflow feedback", () => {
    expect(stylesheet).toContain(".workflow-tab-flight");
    expect(stylesheet).toContain("@keyframes workflow-tab-flight");
    expect(stylesheet).toContain("@media (max-width: 960px)");
    expect(stylesheet).toContain("@media (max-width: 720px)");
    expect(stylesheet).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
