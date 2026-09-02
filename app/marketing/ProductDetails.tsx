import { ArrowRight, Bot, Cloud, HardDrive, RefreshCw } from "lucide-react";

const browsers = ["Chrome", "Arc", "Dia", "Firefox", "Safari on macOS"] as const;

export function ProductDetails() {
  return (
    <>
      <section className="local-first-section" id="local-first">
        <div className="detail-heading">
          <span className="eyebrow">Local-first by design</span>
          <h2>Useful before you sign in.</h2>
          <p>
            Your spaces stay useful on this device before you sign in. Sign in
            when you want cross-device sync—not before you can start.
          </p>
        </div>
        <div className="local-sync-grid">
          <article>
            <HardDrive aria-hidden="true" size={23} />
            <h3>Start locally</h3>
            <p>Create spaces, collections, and saved links without an account.</p>
          </article>
          <article>
            <RefreshCw aria-hidden="true" size={23} />
            <h3>Sync when ready</h3>
            <p>Bring the same workspace to your other signed-in browsers.</p>
          </article>
          <article>
            <Cloud aria-hidden="true" size={23} />
            <h3>Keep local changes</h3>
            <p>Offline updates stay visible and can be retried when you reconnect.</p>
          </article>
        </div>
      </section>

      <section aria-labelledby="browser-support-heading" className="browser-support">
        <div>
          <span className="eyebrow">One workspace, your browser</span>
          <h2 id="browser-support-heading">Built for the browsers you use.</h2>
        </div>
        <ul aria-label="Supported browsers">
          {browsers.map((browser) => <li key={browser}>{browser}</li>)}
        </ul>
      </section>

      <section className="mcp-section" id="mcp">
        <div className="mcp-icon"><Bot aria-hidden="true" size={28} /></div>
        <div>
          <span className="eyebrow">MCP for AI</span>
          <h2>Connect your workspace to AI.</h2>
          <p>
            Give authorized agents access to the saved context you choose, so
            research and planning can begin where your browser left off.
          </p>
        </div>
        <a href="/mcp">
          Connect with MCP <ArrowRight aria-hidden="true" size={16} />
        </a>
      </section>
    </>
  );
}
