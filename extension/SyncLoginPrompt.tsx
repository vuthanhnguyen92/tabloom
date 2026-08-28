import { Cloud, LogIn, X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

export type SyncLoginPromptProps = {
  configured: boolean;
  onSignIn: () => Promise<void>;
};

export function SyncLoginPrompt({ configured, onSignIn }: SyncLoginPromptProps) {
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  async function connect() {
    if (!configured || connecting) return;
    setConnecting(true);
    setError("");
    try {
      await onSignIn();
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign in.");
    } finally {
      setConnecting(false);
    }
  }

  return <>
    <button className="sync-login-trigger" onClick={() => setOpen(true)}><Cloud size={15} /> Sign in to sync</button>
    {open && createPortal(<div className="drop-confirm-backdrop">
      <section className="drop-confirm sync-login-modal" role="dialog" aria-modal="true" aria-label="Sync with Tabloom">
        <button className="dialog-close" aria-label="Close sign-in" disabled={connecting} onClick={() => setOpen(false)}><X size={18} /></button>
        <small>CLOUD SYNC</small>
        <h2>Sync with Tabloom</h2>
        <p>Your local workspace stays available on this browser. Sign in to keep spaces, collections, and saved tabs synchronized across devices.</p>
        {!configured && <p className="sync-login-notice">Cloud sign-in is not connected yet. You can continue using every local workspace feature.</p>}
        {error && <p className="sync-login-error" role="alert">{error}</p>}
        <div>
          <button disabled={connecting} onClick={() => setOpen(false)}>Not now</button>
          <button className="close-after-save" disabled={!configured || connecting} onClick={() => void connect()}><LogIn size={16} /> {connecting ? "Connecting…" : "Continue with Google"}</button>
        </div>
      </section>
    </div>, document.body)}
  </>;
}
