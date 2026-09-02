import { ArrowRight, Check, Sparkles } from "lucide-react";
import { BrowserDownloadButton } from "./BrowserDownloadButton";
import { Brand } from "./components/Brand";
import { WorkspacePreview } from "./marketing/WorkspacePreview";

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
        <article>
          <h3>Drag a live tab into the right context.</h3>
        </article>
        <article>
          <h3>Spaces for projects. Collections for context.</h3>
        </article>
        <article>
          <h3>Search everything without leaving the new tab.</h3>
        </article>
      </section>

      <section className="local-first-section" id="local-first">
        <span className="eyebrow">Local-first</span>
        <h2>Useful before you sign in.</h2>
        <p>Keep working locally, then sign in when you want cross-device sync.</p>
      </section>

      <section className="mcp-section" id="mcp">
        <span className="eyebrow">MCP for AI</span>
        <h2>Connect your workspace to AI.</h2>
        <p>Let authorized agents work with the context you have saved.</p>
        <a href="/mcp">
          Connect with MCP <ArrowRight aria-hidden="true" size={16} />
        </a>
      </section>

      <section className="download-cta">
        <span className="eyebrow">Ready in every new tab</span>
        <h2>Open a new tab. Everything is already there.</h2>
        <BrowserDownloadButton className="button button-dark" />
      </section>

      <MarketingFooter />
    </main>
  );
}
