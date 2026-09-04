import { CheckCircle2, ChevronDown, CircleAlert, Cloud, LoaderCircle, LogIn, LogOut, RefreshCw, UserRound, WifiOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BrowserTarget } from "./browser";
import { AuthCallbackDetails } from "./AuthCallbackDetails";
import type { WorkspaceSyncState } from "./workspace-sync-coordinator";

export type SyncLoginPromptProps = {
  callbackUrl: string;
  configured: boolean;
  onSignIn: () => Promise<void>;
  onLogout?: () => Promise<void>;
  target: BrowserTarget;
  user?: SyncUser | null;
  syncState?: WorkspaceSyncState;
  onRetrySync?: () => Promise<void>;
  recoverySuggested?: boolean;
  openRequest?: number;
};

export type SyncUser = {
  email?: string;
  user_metadata?: {
    avatar_url?: string;
    full_name?: string;
    name?: string;
    picture?: string;
  };
};

function accountDetails(user: SyncUser) {
  const email = user.email ?? "";
  const name = user.user_metadata?.full_name
    ?? user.user_metadata?.name
    ?? email.split("@")[0]
    ?? "Tabloom user";
  return {
    email,
    name,
  };
}

export function SyncLoginPrompt({ callbackUrl, configured, onSignIn, onLogout, target, user, syncState, onRetrySync, recoverySuggested = false, openRequest = 0 }: SyncLoginPromptProps) {
  const [open, setOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const accountRef = useRef<HTMLDivElement>(null);
  const handledOpenRequest = useRef(openRequest);

  useEffect(() => {
    if (user || openRequest <= handledOpenRequest.current) return;
    handledOpenRequest.current = openRequest;
    setOpen(true);
  }, [openRequest, user]);

  useEffect(() => {
    if (!accountOpen) return;
    function closeWithPointer(event: MouseEvent) {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    }
    function closeWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") setAccountOpen(false);
    }
    document.addEventListener("mousedown", closeWithPointer);
    document.addEventListener("keydown", closeWithKeyboard);
    return () => {
      document.removeEventListener("mousedown", closeWithPointer);
      document.removeEventListener("keydown", closeWithKeyboard);
    };
  }, [accountOpen]);

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

  async function logout() {
    if (!onLogout || connecting) return;
    setConnecting(true);
    setError("");
    try {
      await onLogout();
      setAccountOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not log out.");
    } finally {
      setConnecting(false);
    }
  }

  async function retrySync() {
    if (!onRetrySync || connecting) return;
    setError("");
    try {
      await onRetrySync();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not retry workspace sync.");
    }
  }

  if (user) {
    const account = accountDetails(user);
    return <div className="account-control" ref={accountRef}>
      <button
        aria-expanded={accountOpen}
        aria-haspopup="menu"
        aria-label="Open account menu"
        className="account-trigger"
        onClick={() => setAccountOpen((current) => !current)}
      >
        <UserRound size={18} />
        <ChevronDown size={14} />
      </button>
      {accountOpen && <div aria-label="Account" className="account-menu" role="menu">
        <div className="account-profile">
          <span aria-hidden="true"><UserRound size={20} /></span>
          <div>
            <strong>{account.name}</strong>
            {account.email && <small>{account.email}</small>}
          </div>
        </div>
        {syncState && <div className={`account-sync-status sync-state-${syncState.phase}`}>
          {syncState.phase === "synced"
            ? <CheckCircle2 aria-hidden="true" size={18} />
            : syncState.phase === "syncing"
              ? <LoaderCircle aria-hidden="true" className="is-spinning" size={18} />
              : syncState.phase === "failed"
                ? <CircleAlert aria-hidden="true" size={18} />
                : <WifiOff aria-hidden="true" size={18} />}
          <span>
            <strong>{syncState.phase === "synced" ? "Synced" : syncState.phase === "syncing" ? "Syncing" : syncState.phase === "failed" ? "Failed to sync" : "Offline"}</strong>
            {syncState.phase === "synced" && <small>Synced just now</small>}
            {syncState.phase === "syncing" && syncState.failed + syncState.waiting > 0 && <small>{syncState.failed + syncState.waiting} {syncState.failed + syncState.waiting === 1 ? "change" : "changes"} pending</small>}
            {syncState.phase === "failed" && <small>{syncState.failed} failed · {syncState.waiting} waiting</small>}
            {syncState.phase === "failed" && syncState.error && <small>{syncState.error}</small>}
            {syncState.phase === "offline" && syncState.error && <small>{syncState.error}</small>}
          </span>
          {syncState.phase === "failed" && onRetrySync && <button aria-label="Retry sync" title="Retry sync" onClick={() => void retrySync()}>
            <RefreshCw size={17} />
          </button>}
        </div>}
        {error && <p className="account-error" role="alert">{error}</p>}
        <button disabled={connecting} onClick={() => void logout()} role="menuitem">
          {connecting ? <RefreshCw className="account-switching" size={16} /> : <LogOut size={16} />}
          {connecting ? "Logging out…" : "Log out"}
        </button>
      </div>}
    </div>;
  }

  return <>
    <button className="sync-login-trigger" onClick={() => setOpen(true)}><Cloud size={15} /> {recoverySuggested ? "Reconnect to restore workspace" : "Sign in to sync"}</button>
    {open && createPortal(<div className="drop-confirm-backdrop">
      <section className="drop-confirm sync-login-modal" role="dialog" aria-modal="true" aria-label="Sync with Tabloom">
        <button className="dialog-close" aria-label="Close sign-in" disabled={connecting} onClick={() => setOpen(false)}><X size={18} /></button>
        <small>CLOUD SYNC</small>
        <h2>Sync with Tabloom</h2>
        <p>Your local workspace stays available on this browser. Sign in to keep spaces, collections, and saved tabs synchronized across devices.</p>
        {!configured && <p className="sync-login-notice">Cloud sign-in is not connected yet. You can continue using every local workspace feature.</p>}
        {error && <p className="sync-login-error" role="alert">{error}</p>}
        <AuthCallbackDetails callbackUrl={callbackUrl} target={target} />
        <div>
          <button disabled={connecting} onClick={() => setOpen(false)}>Not now</button>
          <button className="close-after-save" disabled={!configured || connecting} onClick={() => void connect()}><LogIn size={16} /> {connecting ? "Connecting…" : "Continue with Google"}</button>
        </div>
      </section>
    </div>, document.body)}
  </>;
}
