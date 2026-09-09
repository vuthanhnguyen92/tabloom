import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const extensionCss = readFileSync("shared/organizer/organizer.css", "utf8") + readFileSync("extension/style.css", "utf8");
const poppinsFaces = [400, 500, 600, 700].map((weight) => {
  const data = readFileSync(`node_modules/@fontsource/poppins/files/poppins-latin-${weight}-normal.woff2`).toString("base64");
  return `@font-face { font-family: "Poppins"; font-style: normal; font-display: block; font-weight: ${weight}; src: url(data:font/woff2;base64,${data}) format("woff2"); }`;
}).join("\n");

test("matches the shared Chrome-reference workspace", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setContent(`
    <main class="ext-shell sheet-open">
      <aside class="ext-sidebar collapsed">
        <div class="sidebar-top"><button aria-label="Expand sidebar" class="sidebar-toggle"><svg aria-hidden="true" fill="none" height="18" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="18"><rect height="18" rx="2" width="18" x="3" y="3"></rect><path d="M9 3v18"></path><path d="m14 9 3 3-3 3"></path></svg></button></div>
        <div class="space-sidebar-heading"><button aria-label="Add space">+</button></div>
        <div class="space-list">
          <div class="space-row active"><button class="space-select"><i style="background:#f56f72">M</i></button></div>
          <div class="space-row"><button class="space-select"><i style="background:#7157d9">R</i></button></div>
        </div>
      </aside>
      <section class="ext-main">
        <header>
          <div><h1>My Space</h1></div>
          <div class="ext-header-tools">
            <button class="new-collection-trigger">New collection</button>
            <button aria-label="Search all links" class="global-search-trigger"><span>⌕</span><span>Search</span><kbd>⌘ F</kbd></button>
            <div class="account-control">
              <button aria-label="Account" class="account-trigger"><svg aria-hidden="true" fill="none" height="18" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" width="18"><circle cx="12" cy="8" r="5"></circle><path d="M20 21a8 8 0 0 0-16 0"></path></svg></button>
              <div aria-label="Account" class="account-menu" role="menu">
                <div class="account-profile"><span>♙</span><div><strong>Nick Vu</strong><small>nick@example.com</small></div></div>
                <div class="account-sync-status sync-state-synced"><span>✓</span><span><strong>Synced</strong><small>Synced just now</small></span></div>
                <button role="menuitem">↪ <span>Log out</span></button>
              </div>
            </div>
          </div>
        </header>
        <div class="ext-columns">
          <article>
            <div class="ext-col-head"><b>Product</b><span>3 links</span></div>
            <div class="ext-link-grid">
              <a href="#"><i>P</i><span><b>Product roadmap</b><small>linear.app</small></span></a>
              <a href="#"><i>D</i><span><b>Design system</b><small>figma.com</small></span></a>
              <a href="#"><i>N</i><span><b>Project notes</b><small>notion.so</small></span></a>
            </div>
            <button class="open-links">Open all</button>
          </article>
          <article>
            <div class="ext-col-head"><b>Engineering</b><span>2 links</span></div>
            <div class="ext-link-grid">
              <a href="#"><i>G</i><span><b>Repository</b><small>github.com</small></span></a>
              <a href="#"><i>V</i><span><b>Deployments</b><small>vercel.com</small></span></a>
            </div>
          </article>
        </div>
      </section>
      <aside class="current-tabs-sheet">
        <header><div><small>CURRENT WINDOW</small><h2>Current tabs</h2></div><button>↻</button></header>
        <p class="current-tabs-hint">Drag a tab into any saved collection.</p>
        <div class="current-tab-list">
          <div><i>T</i><span><b>Tabloom</b><small>tabloom.app</small></span></div>
          <div><i>D</i><span><b>Documentation</b><small>developer.mozilla.org</small></span></div>
        </div>
      </aside>
    </main>
  `);
  await page.addStyleTag({ content: `${poppinsFaces}\n${extensionCss}` });
  await page.evaluate(() => document.fonts.ready);

  const controls = page.locator("button, input");
  await expect(controls.first()).toHaveCSS("appearance", "none");
  await expect(page.locator(".new-collection-trigger")).toHaveCSS("height", "42px");
  await expect(page.locator(".global-search-trigger")).toHaveCSS("height", "42px");
  await expect(page.locator(".account-menu")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator(".account-sync-status")).toHaveCSS("color", "rgb(54, 179, 126)");
  const syncStatus = page.locator(".account-sync-status");
  await syncStatus.evaluate((node) => {
    node.setAttribute("class", "account-sync-status sync-state-syncing");
    node.querySelector("small")!.textContent = "2 changes pending";
  });
  await expect(syncStatus.locator("small")).toHaveCSS("color", "rgb(230, 185, 74)");
  await syncStatus.evaluate((node) => {
    node.setAttribute("class", "account-sync-status sync-state-failed");
    node.querySelector("small")!.textContent = "1 failed · 2 waiting";
    node.insertAdjacentHTML("beforeend", '<button aria-label="Retry sync" title="Retry sync">↻</button>');
  });
  await expect(page.getByRole("button", { name: "Retry sync" })).toHaveCSS("width", "36px");
  await expect(page.getByRole("button", { name: "Retry sync" })).toHaveCSS("height", "36px");
  await syncStatus.evaluate((node) => {
    node.setAttribute("class", "account-sync-status sync-state-synced");
    node.querySelector("small")!.textContent = "Synced just now";
    node.querySelector("button")?.remove();
  });
  await expect(page).toHaveScreenshot("workspace.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.01,
  });

  await page.locator("body").evaluate((body) => body.insertAdjacentHTML("beforeend", `
    <section aria-label="Search Tabloom" aria-modal="true" class="global-search-overlay" role="dialog">
      <button aria-label="Close search backdrop" class="global-search-backdrop"></button>
      <div class="global-search-shell">
        <header><span>⌕</span><input aria-label="Search all spaces and collections" placeholder="Search all spaces and collections" type="search"><button aria-label="Close search">×</button></header>
        <div class="global-search-content">
          <div aria-label="Search results" class="global-search-results" role="listbox">
            <section class="global-search-section">
              <h2>Current tabs</h2>
              <div aria-selected="true" class="global-search-result" role="option"><button><span class="global-search-favicon">D</span><span class="global-search-copy"><strong>Documentation</strong><span>developer.mozilla.org</span><small>Current window</small></span><span class="global-search-url">developer.mozilla.org</span></button></div>
            </section>
            <section class="global-search-section">
              <h2>Saved links</h2>
              <div aria-selected="false" class="global-search-result" role="option"><a href="#"><span class="global-search-favicon">P</span><span class="global-search-copy"><strong>Product roadmap</strong><span>My Space › Product</span><small>Tabloom</small></span><span class="global-search-url">linear.app</span></a></div>
            </section>
          </div>
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>esc</kbd> Close</span></footer>
      </div>
    </section>
  `));
  await expect(page.locator(".global-search-backdrop")).toHaveCSS("background-color", "rgba(246, 243, 238, 0.82)");
  await expect(page).toHaveScreenshot("global-search.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.01,
  });
});

test("uses available header width before truncating the active space name", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.setContent(`
    <main class="ext-shell sheet-open">
      <aside class="ext-sidebar collapsed"></aside>
      <section class="ext-main">
        <header>
          <div><h1>My Space</h1></div>
          <div class="ext-header-tools">
            <button class="new-collection-trigger">New collection</button>
            <button class="global-search-trigger"><span>Search</span><kbd>⌘ F</kbd></button>
            <button class="sync-login-trigger">Sign in to sync</button>
          </div>
        </header>
      </section>
      <aside class="current-tabs-sheet"></aside>
    </main>
  `);
  await page.addStyleTag({ content: `${poppinsFaces}\n${extensionCss}` });
  await page.evaluate(() => document.fonts.ready);

  const heading = page.locator(".ext-main > header h1");
  await expect.poll(async () => (await heading.boundingBox())?.height).toBeLessThan(40);

  await heading.evaluate((node) => {
    node.textContent = "A very long workspace name that cannot fit beside the header actions";
  });
  await expect(heading).toHaveCSS("white-space", "nowrap");
  await expect(heading).toHaveCSS("text-overflow", "ellipsis");
  await expect.poll(() => heading.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
});
