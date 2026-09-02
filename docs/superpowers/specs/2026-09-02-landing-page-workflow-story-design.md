# Tabloom Landing Page Workflow Story Design

## Objective

Redesign `https://tabloom.nickvu.dev/` so it accurately represents Tabloom as it exists today. The landing page should lead with the browser workspace, demonstrate the core workflow visually, and make the browser-aware extension download the primary action.

The page must not describe retired flows such as checkbox-based tab capture, “Save selected,” or “Save & close.” It must distinguish local use from optional account synchronization and introduce MCP as an advanced capability rather than the main product.

## Audience and positioning

The primary audience is an individual with too many browser tabs who wants to preserve project context without turning every open page into permanent clutter.

The positioning hierarchy is:

1. Tabloom turns the new-tab page into a visual browser workspace.
2. Users drag current tabs into spaces and collections, then reopen a collection as a named tab group.
3. The extension works locally before sign-in; signing in adds cross-device synchronization.
4. Global search, bookmark import, duplicate cleanup, and multi-browser support strengthen the daily workflow.
5. MCP lets advanced users connect saved context to AI agents.

## Visual direction

Use the approved “Interactive workflow story” direction. The page should feel like a guided demonstration of the product rather than a generic SaaS landing page.

- Retain Tabloom’s Poppins typography, coral and violet accents, logo, Lucide icon language, and restrained rounded surfaces.
- Follow `prefers-color-scheme` automatically. Dark mode uses the extension’s charcoal surfaces; light mode uses warm off-white surfaces. Both modes keep identical content, hierarchy, and accent colors.
- Product visuals use original React and CSS mock scenes based on the real extension. Do not use Toby assets or screenshots.
- Prefer borders, layered panels, and modest depth over decorative gradients. Gradients may support the hero and closing call-to-action but must not obscure product UI.
- Maintain accessible contrast, visible focus states, and legible type at every breakpoint.

## Page structure

### Header

Use a sticky, compact header with the Tabloom brand, anchor links for Features, Local-first, MCP, and Privacy, plus a browser-aware download button. Mobile navigation may collapse, but the download action remains prominent.

### Hero

Lead with the eyebrow “Your new tab, in full bloom” and the headline “Make every new tab your workspace.” Supporting copy explains saving useful pages, organizing them into spaces, and returning to focused work.

The primary action downloads the correct package for the detected browser. Supporting text names the other supported families: Chrome, Arc, Dia, Firefox, and Safari on macOS.

The hero’s product scene shows the real spatial model:

- collapsed space navigation on the left;
- collection rows and saved-link cards in the center;
- the open Current tabs sheet on the right;
- recognizable favicons with letter fallbacks;
- representative collection and tab names without personal data.

### Workflow story

Present three connected product scenes:

1. **Capture** — A current-window tab moves into a collection. The scene also shows individual tab closure, duplicate cleanup, and “Save all as collection.”
2. **Organize** — Spaces contain collapsible, reorderable collections with editable names and draggable saved-link cards. “Open all” restores a collection as a named browser tab group when permission is available.
3. **Find and return** — The focused global-search overlay finds current tabs, saved links, bookmarks, collections, and spaces. Results include their space and collection context.

The scenes should read as one continuous workflow rather than unrelated feature cards.

### Local-first and synchronization

Explain that Tabloom is fully useful before sign-in. Local spaces, collections, and links remain available when signed out. Signing in enables synchronization across browsers and devices. Keep this copy concise and avoid technical implementation details.

Show synchronization as a quiet product state—Synced, Syncing, or Offline changes—rather than success banners.

### Browser support

Show Chrome, Arc, Dia, Firefox, and Safari on macOS. The primary button continues to use the existing browser-detection logic and download URLs. Safari on iPhone and iPad remains out of scope and should not be implied.

### MCP

Add one compact advanced section near the bottom: “Connect your workspace to AI.” Explain that authorized agents can work with the user’s saved Tabloom context. Link to the canonical endpoint and setup guidance at `https://tabloom.nickvu.dev/mcp` without making MCP compete with the main download action.

### Final call-to-action and footer

Close with “Open a new tab. Everything is already there.” and a browser-aware download button. The footer includes Features, Privacy, Web workspace, MCP, supported browsers, and the independent-product notice.

## Motion and interaction

- Use a restrained hero sequence that visually moves a current tab into a collection and then shows the collection reopening as a named group.
- Use scroll-triggered reveals to connect the three workflow scenes.
- Use only transform and opacity for decorative motion where practical.
- Pause or avoid repeating motion after the user has already seen it; the page must remain understandable as a static composition.
- Respect `prefers-reduced-motion` by disabling tab travel, parallax-like movement, and animated transitions while retaining final states.
- Do not add inert controls that look interactive. Mock product controls are presentation-only and should not enter the keyboard focus order.

## Responsive behavior

- Desktop uses a wide product scene with left navigation, workspace, and Current tabs sheet visible together.
- Tablet compresses the navigation and Current tabs sheet while keeping the tab-to-collection relationship visible.
- Mobile stacks the workflow into short scenes and avoids horizontal page scrolling. The header keeps brand and download access while secondary anchors move into a compact menu or simplified link row.
- Headline size, mockup density, and motion distance scale down at narrow widths.

## Implementation boundaries

- Rebuild the existing `app/page.tsx` marketing composition and its marketing styles.
- Extract focused landing-only components when that keeps product scenes understandable; do not mix them with the live organizer’s stateful components.
- Reuse the existing Brand component, browser-download component, Poppins assets, Lucide icons, and shared theme values where appropriate.
- Preserve `/app`, `/privacy`, OAuth routes, MCP rewrites, environment contracts, browser packages, and current extension behavior.
- Use representative static data in marketing mock scenes. Do not fetch a real user workspace or require authentication.
- Do not add analytics, tracking, a pricing section, testimonials, teams, billing, or collaboration claims.

## Metadata and social preview

Update page metadata to match the browser-workspace-first positioning. Replace the current social preview because the headline and visual direction change materially. The new preview should use the Tabloom logo, approved coral/violet palette, the new headline, and a simplified product-workflow visual without personal data.

## Validation

- Verify the detected-browser label and URL for Chromium, Firefox, Safari, and fallback cases.
- Verify every public download URL returns the current package.
- Check automatic light and dark themes and accessible contrast.
- Check keyboard navigation, focus visibility, semantic landmarks, and reduced-motion behavior.
- Check desktop, tablet, and mobile layouts without horizontal overflow.
- Ensure retired capture language and legacy MCP domains do not appear.
- Run lint, type checking, relevant marketing component tests, the production web build, and Chromium, Firefox, and Safari extension builds.
- After deployment, verify `/`, `/app`, `/privacy`, `/mcp/health`, and all three package downloads from `https://tabloom.nickvu.dev`.

## Acceptance criteria

A first-time visitor should understand within the first viewport that Tabloom replaces the new-tab page with an organized workspace. Scrolling should demonstrate how a live tab becomes part of a collection and how that context is restored. The visitor should understand that sign-in is optional for local use, know which browsers are supported, and have one obvious browser-appropriate download action. MCP should be discoverable without distracting from this primary flow.
