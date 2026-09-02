# Tabloom Landing Page Workflow Story Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tabloom’s outdated marketing page with an adaptive light/dark workflow story that accurately demonstrates the current browser workspace and routes visitors to the correct extension package.

**Architecture:** Keep `/` as a server-rendered composition and isolate its static product demonstrations in landing-only React components. Continue using the existing client-side `BrowserDownloadButton` for browser detection; use CSS classes and media queries for theme, responsive behavior, and reduced motion so the mock scenes do not depend on application state or user data.

**Tech Stack:** Next.js 16, React 19, TypeScript, CSS, Lucide React, Vitest, Testing Library, Vite extension builds, Vercel.

**Spec:** `docs/superpowers/specs/2026-09-02-landing-page-workflow-story-design.md`

## Global Constraints

- The canonical origin remains `https://tabloom.nickvu.dev`.
- `/app`, `/privacy`, `/mcp`, `/oauth/*`, and `/.well-known/*` behavior must remain unchanged.
- The primary action is the existing browser-aware extension download.
- Supported packages are Chromium (Chrome, Arc, and Dia), Firefox, and Safari on macOS; do not imply iPhone or iPad support.
- Tabloom works locally before sign-in; sign-in adds synchronization.
- Retired checkbox selection, “Save selected,” “Save & close,” demo-mode copy, and `tabloom-mcp.nickvu.dev` must not appear.
- Use Poppins, the existing Tabloom brand, Lucide icons, and the coral/violet identity.
- Follow `prefers-color-scheme` and `prefers-reduced-motion`.
- Marketing mock scenes use representative static data and never load an authenticated workspace.
- Preserve the generated extension ZIP routes under `/downloads/`.

---

### Task 1: Lock the new landing-page content contract

**Files:**
- Create: `tests/marketing-page.test.tsx`
- Modify: `tests/marketing-download.test.tsx`
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: `BrowserDownloadButton({ className, iconSize? })` from `app/BrowserDownloadButton.tsx` and `Brand({ compact? })` from `app/components/Brand.tsx`.
- Produces: a landing page with the landmark IDs `features`, `local-first`, `mcp`, and `privacy`, plus the approved hero and final CTA copy.

- [ ] **Step 1: Write failing content-contract tests**

```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "../app/page";

describe("Tabloom landing page", () => {
  it("leads with the browser workspace workflow", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1, name: "Make every new tab your workspace." })).toBeInTheDocument();
    expect(screen.getByText(/drag a live tab into the right context/i)).toBeInTheDocument();
    expect(screen.getByText(/spaces for projects\. collections for context/i)).toBeInTheDocument();
    expect(screen.getByText(/search everything without leaving the new tab/i)).toBeInTheDocument();
  });

  it("presents optional sync and MCP after the core workflow", () => {
    render(<Home />);
    expect(within(document.querySelector("#local-first")!).getByText(/useful before you sign in/i)).toBeInTheDocument();
    expect(within(document.querySelector("#mcp")!).getByRole("link", { name: /connect with mcp/i })).toHaveAttribute("href", "/mcp");
  });

  it("does not advertise retired product behavior", () => {
    render(<Home />);
    expect(screen.queryByText(/save selected|save & close|demo workspace/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the targeted tests and verify the new assertions fail**

Run: `npm run test:unit -- tests/marketing-page.test.tsx tests/marketing-download.test.tsx`

Expected: FAIL because the new headline, workflow copy, IDs, and MCP link are not rendered by the current page.

- [ ] **Step 3: Replace `app/page.tsx` with the semantic page skeleton**

Use this section order and keep every section meaningful before later visual components are added:

```tsx
export default function Home() {
  return <main className="marketing-page">
    <MarketingHeader />
    <section className="story-hero" id="top">...</section>
    <section className="workflow-story" id="features">...</section>
    <section className="local-first-section" id="local-first">...</section>
    <section className="mcp-section" id="mcp">...</section>
    <section className="download-cta">...</section>
    <MarketingFooter />
  </main>;
}
```

The header anchors must target `#features`, `#local-first`, `#mcp`, and `/privacy`. Use `BrowserDownloadButton` in the header, hero, and final CTA so the existing download test continues to find three browser-specific actions.

- [ ] **Step 4: Update the old download test’s accessible-name expectation**

Keep its browser matrix and download URL assertions. Retain the checks that “Open workspace” and “Start organizing” are absent and that `/app` remains available as a footer link named “Web workspace.”

- [ ] **Step 5: Run the targeted tests**

Run: `npm run test:unit -- tests/marketing-page.test.tsx tests/marketing-download.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the page contract**

```bash
git add app/page.tsx tests/marketing-page.test.tsx tests/marketing-download.test.tsx
git commit -m "feat: update landing page product story"
```

---

### Task 2: Build an accurate hero workspace scene

**Files:**
- Create: `app/marketing/WorkspacePreview.tsx`
- Modify: `app/page.tsx`
- Modify: `tests/marketing-page.test.tsx`

**Interfaces:**
- Consumes: `Brand` and Lucide icons; no repository, browser adapter, authentication, or storage state.
- Produces: `WorkspacePreview(): JSX.Element`, a presentation-only scene labeled “Tabloom workspace preview.”

- [ ] **Step 1: Add a failing workspace-scene test**

```tsx
it("shows the real workspace model in the hero", () => {
  render(<Home />);
  const preview = screen.getByLabelText("Tabloom workspace preview");
  expect(within(preview).getByText("My Space")).toBeInTheDocument();
  expect(within(preview).getByText("Launch planning")).toBeInTheDocument();
  expect(within(preview).getByText("Current tabs")).toBeInTheDocument();
  expect(within(preview).getByText("Sprint notes")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run test:unit -- tests/marketing-page.test.tsx`

Expected: FAIL because `WorkspacePreview` is not present.

- [ ] **Step 3: Implement `WorkspacePreview` with presentation-only markup**

```tsx
const savedLinks = [
  { title: "Customer notes", host: "notion.so", icon: "N" },
  { title: "Design system", host: "figma.com", icon: "F" },
];
const currentTabs = ["Sprint notes", "Project brief"];

export function WorkspacePreview() {
  return <div aria-label="Tabloom workspace preview" className="workspace-preview" role="img">
    <div className="preview-browser-bar" aria-hidden="true"><i /><i /><i /><span>tabloom / My Space</span></div>
    <div className="preview-layout" aria-hidden="true">
      <aside className="preview-space-rail"><Brand compact /><span>◆</span><span>＋</span></aside>
      <section className="preview-board">...</section>
      <aside className="preview-current-tabs">...</aside>
    </div>
  </div>;
}
```

Render a collection row rather than the former column layout. Include favicon-like tiles with letter fallbacks, the subtle drag-grip affordance, and close glyphs in Current tabs. Apply `aria-hidden="true"` to the internal mock controls so they never enter the accessibility tree as unusable buttons.

- [ ] **Step 4: Insert `WorkspacePreview` into the hero**

Place it below the hero copy so desktop can overlap it with the hero’s background while mobile receives a normal stacked flow.

- [ ] **Step 5: Run the targeted test**

Run: `npm run test:unit -- tests/marketing-page.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the hero scene**

```bash
git add app/marketing/WorkspacePreview.tsx app/page.tsx tests/marketing-page.test.tsx
git commit -m "feat: add landing workspace preview"
```

---

### Task 3: Implement the connected workflow narrative

**Files:**
- Create: `app/marketing/WorkflowStory.tsx`
- Modify: `app/page.tsx`
- Modify: `tests/marketing-page.test.tsx`

**Interfaces:**
- Consumes: static representative content only.
- Produces: `WorkflowStory(): JSX.Element` with `article[data-step="capture|organize|search"]` and presentation-only scenes.

- [ ] **Step 1: Add failing workflow-structure tests**

```tsx
it("renders capture, organize, and search as one ordered workflow", () => {
  render(<Home />);
  const steps = Array.from(document.querySelectorAll("#features article[data-step]"));
  expect(steps.map((step) => step.getAttribute("data-step"))).toEqual(["capture", "organize", "search"]);
  expect(screen.getByText("Save all as collection")).toBeInTheDocument();
  expect(screen.getByText("Open all")).toBeInTheDocument();
  expect(screen.getByText("My Space · Launch planning")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run test:unit -- tests/marketing-page.test.tsx`

Expected: FAIL because the workflow scenes do not exist.

- [ ] **Step 3: Implement the three scenes**

```tsx
const steps = [
  { id: "capture", number: "01", eyebrow: "Capture", title: "Drag a live tab into the right context." },
  { id: "organize", number: "02", eyebrow: "Organize", title: "Spaces for projects. Collections for context." },
  { id: "search", number: "03", eyebrow: "Find and return", title: "Search everything without leaving the new tab." },
] as const;

export function WorkflowStory() {
  return <div className="workflow-steps">
    {steps.map((step) => <article className="workflow-step" data-step={step.id} key={step.id}>...</article>)}
  </div>;
}
```

The capture scene shows a current tab traveling toward a collection, an individual close affordance, duplicate cleanup, and “Save all as collection.” The organize scene shows collapsible rows, inline naming, drag grips, and “Open all” with a named group label. The search scene shows a full-backdrop search panel containing current-tab and saved-link results with space and collection context.

- [ ] **Step 4: Add the component to `#features`**

Use a section heading that describes a single sequence, then render `<WorkflowStory />` once.

- [ ] **Step 5: Run targeted tests**

Run: `npm run test:unit -- tests/marketing-page.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the workflow story**

```bash
git add app/marketing/WorkflowStory.tsx app/page.tsx tests/marketing-page.test.tsx
git commit -m "feat: demonstrate the Tabloom workflow"
```

---

### Task 4: Add local-first, browser-support, and MCP sections

**Files:**
- Create: `app/marketing/ProductDetails.tsx`
- Modify: `app/page.tsx`
- Modify: `tests/marketing-page.test.tsx`

**Interfaces:**
- Consumes: `BrowserDownloadButton` for the final CTA.
- Produces: `ProductDetails(): JSX.Element` containing `#local-first`, browser-support content, and `#mcp`.

- [ ] **Step 1: Add failing product-detail tests**

```tsx
it("describes local-first use, optional sync, supported browsers, and MCP", () => {
  render(<Home />);
  expect(screen.getByText(/your spaces stay useful on this device before you sign in/i)).toBeInTheDocument();
  expect(screen.getByText(/sign in when you want cross-device sync/i)).toBeInTheDocument();
  for (const browser of ["Chrome", "Arc", "Dia", "Firefox", "Safari on macOS"]) {
    expect(screen.getByText(browser)).toBeInTheDocument();
  }
  expect(screen.queryByText(/iphone|ipad/i)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /connect with mcp/i })).toHaveAttribute("href", "/mcp");
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run test:unit -- tests/marketing-page.test.tsx`

Expected: FAIL because the detailed copy and browser list are missing.

- [ ] **Step 3: Implement `ProductDetails`**

Render a paired local-first/sync panel, a five-browser support strip, and a compact MCP panel. Use the approved heading “Connect your workspace to AI,” a link named “Connect with MCP” pointing to `/mcp`, and plain-language copy about authorized agents. Do not describe token, OAuth, Supabase, or proxy internals.

- [ ] **Step 4: Add the final download CTA and footer**

Use “Open a new tab. Everything is already there.” as the final heading. The footer includes links to `#features`, `/app`, `/privacy`, and `/mcp`, plus “An independent product.”

- [ ] **Step 5: Run marketing tests**

Run: `npm run test:unit -- tests/marketing-page.test.tsx tests/marketing-download.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the supporting sections**

```bash
git add app/marketing/ProductDetails.tsx app/page.tsx tests/marketing-page.test.tsx
git commit -m "feat: explain Tabloom local sync and MCP"
```

---

### Task 5: Apply adaptive themes, responsive layout, and restrained motion

**Files:**
- Modify: `app/globals.css:1-197`
- Create: `tests/marketing-styles.test.ts`

**Interfaces:**
- Consumes: class names from `app/page.tsx` and `app/marketing/*.tsx`.
- Produces: marketing CSS variables, desktop/tablet/mobile layouts, workflow animation, and reduced-motion overrides without changing extension styles.

- [ ] **Step 1: Add a failing stylesheet-contract test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("marketing styles", () => {
  it("supports automatic theme, reduced motion, and narrow screens", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/@media[^\{]*max-width:\s*720px/);
    expect(css).toContain(".workflow-tab-flight");
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run test:unit -- tests/marketing-styles.test.ts`

Expected: FAIL because the landing page does not yet define the new adaptive theme and workflow motion classes.

- [ ] **Step 3: Replace the old marketing block with scoped tokens**

```css
.marketing-page {
  --marketing-bg: #f7f3ed;
  --marketing-panel: #ffffff;
  --marketing-text: #26232f;
  --marketing-muted: #6f6978;
  --marketing-line: #ded8d1;
  --marketing-coral: #ef6273;
  --marketing-violet: #7356df;
  color: var(--marketing-text);
  background: var(--marketing-bg);
}

@media (prefers-color-scheme: dark) {
  .marketing-page {
    --marketing-bg: #191922;
    --marketing-panel: #22212b;
    --marketing-text: #f4f1fa;
    --marketing-muted: #aaa5b7;
    --marketing-line: #3d3a48;
  }
}
```

Scope all redesigned styles under `.marketing-page` to avoid altering the `/app` extension workspace. Remove obsolete `.capture-card`, `.capture-row`, `.space-map`, and old hero-column rules after their markup is gone.

- [ ] **Step 4: Implement layout and motion**

Use a wide centered page, sticky translucent header, centered hero, full-width workspace preview, alternating workflow scene grids, paired detail panels, and a concise closing CTA. Animate `.workflow-tab-flight` with transform and opacity; use scroll-linked entry only as progressive enhancement, leaving all content visible without it.

- [ ] **Step 5: Add responsive and reduced-motion rules**

At `960px`, compress the mock navigation and Current tabs panel. At `720px`, stack scenes, simplify header navigation, ensure product scenes fit without horizontal page scrolling, and retain the download action. In reduced motion, set animation and transition durations to effectively zero and render the traveling tab in its final position.

- [ ] **Step 6: Run style and marketing tests**

Run: `npm run test:unit -- tests/marketing-styles.test.ts tests/marketing-page.test.tsx tests/marketing-download.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit visual behavior**

```bash
git add app/globals.css tests/marketing-styles.test.ts
git commit -m "feat: style adaptive landing workflow"
```

---

### Task 6: Refresh metadata and the social preview

**Files:**
- Modify: `app/layout.tsx:10-23`
- Modify: `tests/site-metadata.test.ts`
- Replace: `public/og.png`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_SITE_URL`, defaulting to `https://tabloom.nickvu.dev`.
- Produces: site-wide Open Graph and X metadata for the new browser-workspace positioning.

- [ ] **Step 1: Update metadata tests first**

```ts
it("describes the new-tab browser workspace", async () => {
  const metadata = await generateMetadata();
  expect(metadata.title).toMatchObject({ default: "Tabloom — Make every new tab your workspace" });
  expect(metadata.description).toContain("new-tab workspace");
  expect(metadata.openGraph).toMatchObject({ url: "/", images: [{ url: "/og.png", width: 1200, height: 630 }] });
});
```

- [ ] **Step 2: Run the metadata test and verify failure**

Run: `npm run test:unit -- tests/site-metadata.test.ts`

Expected: FAIL on the old title and description.

- [ ] **Step 3: Update `generateMetadata`**

Set the title to `Tabloom — Make every new tab your workspace` and the description to `Turn every new tab into an organized browser workspace. Save locally, shape links into spaces and collections, and sync when you choose.` Keep the canonical path, favicon, 1200×630 Open Graph dimensions, and absolute origin handling unchanged.

- [ ] **Step 4: Generate one replacement social card**

Use the project’s image-generation workflow once with this exact brief:

```text
Create a 1200×630 social preview for Tabloom. Use a refined dark charcoal browser-workspace scene with coral and violet accents, the Tabloom logo, and the exact headline “Make every new tab your workspace.” Show a simplified left space rail, horizontal collection row, saved-link cards, and a right current-tabs panel. Keep typography crisp and legible, avoid personal data, other company logos, gradients that reduce legibility, and any Toby branding.
```

Inspect the result for exact text and usable composition, then replace `public/og.png`. If the generated card has incorrect text, retry once; if the retry is still unusable, preserve the current valid image and document the gap rather than shipping incorrect branding.

- [ ] **Step 5: Run metadata tests**

Run: `npm run test:unit -- tests/site-metadata.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit metadata and preview**

```bash
git add app/layout.tsx tests/site-metadata.test.ts public/og.png
git commit -m "feat: refresh Tabloom social preview"
```

---

### Task 7: Validate, preview, deploy, and verify packages

**Files:**
- Modify only if validation reveals a requirement failure in the files from Tasks 1–6.

**Interfaces:**
- Consumes: the complete landing implementation and existing Vercel production configuration.
- Produces: a verified local preview, production build, regenerated browser packages, and live deployment at `https://tabloom.nickvu.dev`.

- [ ] **Step 1: Run focused tests**

Run: `npm run test:unit -- tests/marketing-page.test.tsx tests/marketing-download.test.tsx tests/marketing-styles.test.ts tests/site-metadata.test.ts`

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run repository validation**

Run: `npm run lint`

Expected: exit 0.

Run: `npx tsc --noEmit`

Expected: exit 0.

Run: `npm run test:unit`

Expected: all unit and component tests PASS.

- [ ] **Step 3: Build the extension packages and website**

Run: `npm run build:extension`

Expected: successful Chromium, Firefox, and Safari builds and refreshed ZIPs at:

- `public/downloads/tabloom-chromium.zip`
- `public/downloads/tabloom-firefox.zip`
- `public/downloads/tabloom-safari.zip`

Run: `npm run build:vercel`

Expected: successful Next.js production build containing `/`, `/app`, `/privacy`, and `/oauth/consent`.

- [ ] **Step 4: Perform the first meaningful local preview**

Start the existing development server, request the printed local URL once to ensure compilation, and open that exact URL in Codex. Check the approved first viewport, automatic theme, workflow sequence, keyboard navigation, reduced motion, and desktop/tablet/mobile layouts. Fix only observed requirement failures, then rerun the affected tests and builds.

- [ ] **Step 5: Deploy the verified commit**

Push the implementation commits to `main`. The connected Vercel project must create a production deployment automatically from `vuthanhnguyen92/tabloom` on branch `main`; do not create a second Vercel project.

- [ ] **Step 6: Verify production routes and artifacts**

Require HTTP 200 from:

```text
https://tabloom.nickvu.dev/
https://tabloom.nickvu.dev/app
https://tabloom.nickvu.dev/privacy
https://tabloom.nickvu.dev/mcp/health
https://tabloom.nickvu.dev/downloads/tabloom-chromium.zip
https://tabloom.nickvu.dev/downloads/tabloom-firefox.zip
https://tabloom.nickvu.dev/downloads/tabloom-safari.zip
```

Download the three live ZIPs into a temporary directory, extract them, and compare their contents with `dist-extension/chromium`, `dist-extension/firefox`, and `dist-extension/safari`. Ignore ZIP timestamps but require file contents to match.

- [ ] **Step 7: Check the final repository state**

Run: `git status --short --branch`

Expected: clean `main` synchronized with `origin/main`.
