import {
  ArrowRight,
  Check,
  Compass,
  Layers3,
  Search,
  Sparkles,
} from "lucide-react";
import { Brand } from "./components/Brand";

const previewLinks = [
  ["Brand system", "figma.com", "#f56f72"],
  ["Launch notes", "notion.so", "#7157d9"],
  ["Product roadmap", "linear.app", "#2bb8a8"],
] as const;

export default function Home() {
  return (
    <main className="marketing-page">
      <header className="marketing-header">
        <a href="#top" className="brand-link">
          <Brand />
        </a>
        <nav aria-label="Primary navigation">
          <a href="#features">Features</a>
          <a href="#workflow">How it works</a>
          <a href="#privacy">Privacy</a>
        </nav>
        <a className="button button-quiet" href="/app">
          Open workspace <ArrowRight size={16} />
        </a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <span className="eyebrow"><Sparkles size={15} /> A calmer home for your browser</span>
          <h1>Turn tab chaos into a <em>clear workspace.</em></h1>
          <p>
            Gather every useful link, arrange your projects visually, and
            return to focused work without hunting through a crowded tab bar.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="/app">
              Start organizing <ArrowRight size={18} />
            </a>
            <span className="no-card"><Check size={15} /> Free personal workspace</span>
          </div>
          <div className="browser-note"><Compass size={22} /> Chrome new-tab extension included</div>
        </div>
        <div className="hero-visual" aria-label="Tabloom workspace preview">
          <div className="orb orb-one" />
          <div className="orb orb-two" />
          <div className="mock-window">
            <div className="mock-topbar"><i /><i /><i /><span>tabloom / launch</span></div>
            <aside>
              <Brand compact />
              <b>My spaces</b>
              <span className="active">✦ Launch</span>
              <span>◌ Research</span>
              <span>◇ Personal</span>
            </aside>
            <div className="mock-board">
              <div className="mock-board-head"><small>LAUNCH SPACE</small><strong>Everything for launch day.</strong></div>
              <div className="mock-column">
                <div className="mock-column-title"><span>Product</span><small>3 links</small></div>
                {previewLinks.map(([title, host, color]) => (
                  <div className="mock-link" key={title}>
                    <i style={{ background: color }}>{title[0]}</i>
                    <span><b>{title}</b><small>{host}</small></span>
                    <em>•••</em>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="floating-chip chip-one">12 tabs captured</div>
          <div className="floating-chip chip-two"><Search size={15} /> Find anything</div>
        </div>
      </section>

      <section className="proof-strip" aria-label="Product benefits">
        <span>Made for deep work</span>
        <strong>One click to clear the clutter</strong>
        <span>Synced across devices</span>
      </section>

      <section className="features" id="features">
        <div className="section-heading">
          <span className="eyebrow">A workspace that works like you do</span>
          <h2>Save the context. Keep the momentum.</h2>
        </div>
        <article className="feature-row" id="workflow">
          <div className="feature-copy"><span className="feature-number">01</span><h3>Capture every useful tab</h3><p>Select the tabs that belong together and sweep them into a collection. Save them only, or close the originals once they are safe.</p><a href="/app">Try the capture flow <ArrowRight size={16} /></a></div>
          <div className="capture-card"><div className="capture-head"><span>Current window</span><small>4 selected</small></div>{["Q3 product brief", "Design critique", "Customer interviews", "Launch checklist"].map((item, index) => <div className="capture-row" key={item}><span className={index < 3 ? "checked" : ""}>{index < 3 && <Check size={13} />}</span><b>{item}</b><small>{index + 1}</small></div>)}<button>Save to Product launch</button></div>
        </article>
        <article className="feature-row reverse">
          <div className="feature-copy"><span className="feature-number">02</span><h3>Shape projects into spaces</h3><p>Keep research, planning, and inspiration in visual collections that make sense at a glance—without flattening your work into bookmarks.</p></div>
          <div className="space-map"><div className="map-card coral"><Layers3 size={20} /><b>Product launch</b><span>18 resources</span></div><div className="map-card violet"><Sparkles size={20} /><b>Fresh ideas</b><span>9 resources</span></div><div className="map-card mint"><Search size={20} /><b>Research</b><span>24 resources</span></div></div>
        </article>
        <article className="feature-row">
          <div className="feature-copy"><span className="feature-number">03</span><h3>Make space for focused work</h3><p>Search titles, notes, URLs, spaces, and collections at once. Open a whole collection when you need the full context back.</p></div>
          <div className="search-demo"><Search size={19} /><span>Search your links</span><kbd>⌘ K</kbd><div><b>Roadmap</b><small>Product launch · linear.app</small></div><div><b>Research notes</b><small>Research · notion.so</small></div></div>
        </article>
      </section>

      <section className="final-cta">
        <div className="cta-bloom" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        <span className="eyebrow">Ready when your next idea arrives</span>
        <h2>Clear the tabs.<br />Keep what matters.</h2>
        <a className="button button-dark" href="/app">Start organizing <ArrowRight size={18} /></a>
      </section>

      <footer id="privacy">
        <div><Brand /><p>Your browser, in full bloom.</p></div>
        <div><strong>Product</strong><a href="#features">Features</a><a href="/app">Web workspace</a><span>Chrome extension</span></div>
        <div><strong>Principles</strong><span>Personal by default</span><span>No ads</span><a href="/privacy">Privacy</a></div>
        <small>© 2026 Tabloom. An independent product.</small>
      </footer>
    </main>
  );
}
