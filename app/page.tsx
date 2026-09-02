import { Check, Sparkles } from "lucide-react";
import { BrowserDownloadButton } from "./BrowserDownloadButton";
import { Brand } from "./components/Brand";
import { WorkflowStory } from "./marketing/WorkflowStory";
import { WorkspacePreview } from "./marketing/WorkspacePreview";
import { ProductDetails } from "./marketing/ProductDetails";

function MarketingHeader() {
  return (
    <header className="marketing-header">
      <a className="brand-link" href="#top">
        <Brand />
      </a>
      <nav aria-label="Primary navigation">
        <a href="#features">Features</a>
        <a href="#local-first">Local-first</a>
        <a href="#mcp">MCP</a>
        <a href="/privacy">Privacy</a>
      </nav>
      <BrowserDownloadButton className="button button-quiet" iconSize={16} />
    </header>
  );
}

function MarketingFooter() {
  return (
    <footer id="privacy">
      <div>
        <Brand />
        <p>Your browser, in full bloom.</p>
      </div>
      <div>
        <strong>Product</strong>
        <a href="#features">Features</a>
        <a href="/app">Web workspace</a>
        <a href="/mcp">MCP</a>
      </div>
      <div>
        <strong>Principles</strong>
        <span>Local by default</span>
        <span>Sync when you choose</span>
        <a href="/privacy">Privacy</a>
      </div>
      <small>© 2026 Tabloom. An independent product.</small>
    </footer>
  );
}

export default function Home() {
  return (
    <main className="marketing-page">
      <MarketingHeader />

      <section className="story-hero" id="top">
        <div className="story-hero-copy">
          <span className="eyebrow">
            <Sparkles aria-hidden="true" size={15} /> Your new tab, in full bloom
          </span>
          <h1>Make every new tab your workspace.</h1>
          <p>
            Collect the pages that matter, shape them into spaces, and return
            to focused work without rebuilding your browser context.
          </p>
          <div className="hero-actions">
            <BrowserDownloadButton className="button button-primary" />
            <span className="no-card">
              <Check aria-hidden="true" size={15} /> Useful before you sign in
            </span>
          </div>
        </div>
        <WorkspacePreview />
      </section>

      <section className="workflow-story" id="features">
        <div className="section-heading">
          <span className="eyebrow">From open tab to useful context</span>
          <h2>Keep your browser moving with your work.</h2>
        </div>
        <WorkflowStory />
      </section>

      <ProductDetails />

      <section className="download-cta">
        <span className="eyebrow">Ready in every new tab</span>
        <h2>Open a new tab. Everything is already there.</h2>
        <BrowserDownloadButton className="button button-dark" />
      </section>

      <MarketingFooter />
    </main>
  );
}
