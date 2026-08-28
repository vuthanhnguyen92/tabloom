import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const extensionStyles = readFileSync(resolve(process.cwd(), "extension/style.css"), "utf8");

function mountExtensionStyles() {
  const style = document.createElement("style");
  style.textContent = extensionStyles;
  document.head.appendChild(style);
  return style;
}

describe("extension motion system", () => {
  afterEach(() => {
    document.head.querySelectorAll("style").forEach((style) => style.remove());
    document.body.replaceChildren();
  });

  it("animates transient surfaces and interactive rows with balanced motion", () => {
    const style = mountExtensionStyles();
    const rules = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSStyleRule => "selectorText" in rule);
    const rulesFor = (selector: string) => rules.filter((rule) => rule.selectorText === selector);

    expect(rulesFor(".ext-message, .demo-note").some((rule) => rule.style.getPropertyValue("animation-name") === "motion-toast-in")).toBe(true);
    expect(rulesFor(".current-tab-list > div").some((rule) => rule.style.getPropertyValue("transition").includes("180ms"))).toBe(true);
    expect(rulesFor(".drop-confirm-backdrop").some((rule) => rule.style.getPropertyValue("animation-name") === "motion-backdrop-in")).toBe(true);
    expect(rulesFor(".drop-confirm").some((rule) => rule.style.getPropertyValue("animation-name") === "motion-dialog-in")).toBe(true);
  });

  it("gives collection-form actions the same comfortable height as modal actions", () => {
    const style = mountExtensionStyles();
    const rules = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSStyleRule => "selectorText" in rule);
    const actionRule = rules.find((rule) => rule.selectorText === ".save-window form button");

    expect(actionRule?.style.getPropertyValue("min-height")).toBe("40px");
  });

  it("matches the search-field height and centers the collection-form cancel icon", () => {
    const style = mountExtensionStyles();
    const rules = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSStyleRule => "selectorText" in rule);
    const inputRule = [...rules].reverse().find((rule) => rule.selectorText === ".save-window input");
    const cancelRule = rules.find((rule) => rule.selectorText === '.save-window form button[type="button"]');

    expect(inputRule?.style.getPropertyValue("height")).toBe("42px");
    expect(cancelRule?.style.getPropertyValue("width")).toBe("40px");
    expect(cancelRule?.style.getPropertyValue("height")).toBe("40px");
    expect(cancelRule?.style.getPropertyValue("display")).toBe("grid");
    expect(cancelRule?.style.getPropertyValue("place-items")).toBe("center");
    expect(cancelRule?.style.getPropertyValue("padding")).toBe("0px");
  });

});
