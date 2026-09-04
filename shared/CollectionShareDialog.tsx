"use client";

import { Check, Copy, Link2, RefreshCw, RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Collection } from "./domain";
import {
  collectionShareUrl,
  type CollectionShare,
  type CollectionShareRepository,
  type ShareAvailability,
} from "./collection-sharing";

export type CollectionShareDialogProps = {
  collection: Collection;
  repository: CollectionShareRepository | null;
  siteUrl: string;
  availability: ShareAvailability;
  onRequestSignIn: () => void;
  onRequestSyncRetry: () => void;
  onToast: (message: string) => void;
  onClose: () => void;
};

type Confirmation = "regenerate" | "disable" | null;
type FailedAction = "load" | "enable" | "regenerate" | "disable" | "copy" | null;

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Sharing could not be updated.";
}

export function CollectionShareDialog({
  availability,
  collection,
  onClose,
  onRequestSignIn,
  onRequestSyncRetry,
  onToast,
  repository,
  siteUrl,
}: CollectionShareDialogProps) {
  const [share, setShare] = useState<CollectionShare | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [error, setError] = useState("");
  const [failedAction, setFailedAction] = useState<FailedAction>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (availability !== "ready" || !repository) return;
    setBusy(true);
    setError("");
    setFailedAction(null);
    try {
      setShare(await repository.get(collection.id));
    } catch (reason) {
      setShare(null);
      setError(messageFor(reason));
      setFailedAction("load");
    } finally {
      setBusy(false);
    }
  }, [availability, collection.id, repository]);

  useEffect(() => {
    closeRef.current?.focus();
    if (availability === "ready") void load();
  }, [availability, load]);

  useEffect(() => {
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (confirmation) setConfirmation(null);
      else onClose();
    }
    document.addEventListener("keydown", closeWithEscape);
    return () => document.removeEventListener("keydown", closeWithEscape);
  }, [confirmation, onClose]);

  async function enable() {
    if (!repository) return;
    setBusy(true);
    setError("");
    setFailedAction(null);
    try {
      setShare(await repository.enable(collection.id));
      onToast("Sharing enabled");
    } catch (reason) {
      setError(messageFor(reason));
      setFailedAction("enable");
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    if (!repository) return;
    setBusy(true);
    setError("");
    setFailedAction(null);
    try {
      setShare(await repository.regenerate(collection.id));
      setConfirmation(null);
      onToast("Share link regenerated");
    } catch (reason) {
      setConfirmation(null);
      setError(messageFor(reason));
      setFailedAction("regenerate");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!repository) return;
    setBusy(true);
    setError("");
    setFailedAction(null);
    try {
      await repository.disable(collection.id);
      setShare(null);
      setConfirmation(null);
      onToast("Sharing disabled");
    } catch (reason) {
      setConfirmation(null);
      setError(messageFor(reason));
      setFailedAction("disable");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!share) return;
    setError("");
    setFailedAction(null);
    try {
      await navigator.clipboard.writeText(collectionShareUrl(siteUrl, share.token));
      onToast("Share link copied");
    } catch (reason) {
      setError(messageFor(reason));
      setFailedAction("copy");
    }
  }

  function retry() {
    if (failedAction === "load") void load();
    if (failedAction === "enable") void enable();
    if (failedAction === "regenerate") void regenerate();
    if (failedAction === "disable") void disable();
    if (failedAction === "copy") void copyLink();
  }

  const content = <div
    className="collection-share-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}
  >
    <section
      aria-label={`Share ${collection.name}`}
      aria-modal="true"
      className="collection-share-dialog"
      role="dialog"
    >
      <button
        aria-label="Close sharing"
        className="dialog-close"
        disabled={busy}
        onClick={onClose}
        ref={closeRef}
      >
        <X size={18} />
      </button>
      <small>LIVE COLLECTION</small>
      <h2>Share {collection.name}</h2>

      {availability === "sign-in-required" && <div className="collection-share-gate">
        <Link2 aria-hidden="true" size={24} />
        <p>Sign in and sync this collection before creating a live share link.</p>
        <button className="collection-share-primary" onClick={() => { onClose(); onRequestSignIn(); }}>Sign in to sync</button>
      </div>}

      {availability === "sync-required" && <div className="collection-share-gate">
        <RefreshCw aria-hidden="true" size={24} />
        <p>This collection must finish syncing before it can be shared.</p>
        <button className="collection-share-primary" onClick={onRequestSyncRetry}>Retry sync</button>
      </div>}

      {availability === "offline" && <div className="collection-share-gate">
        <Link2 aria-hidden="true" size={24} />
        <p>An internet connection is required to check or change sharing.</p>
      </div>}

      {availability === "ready" && <>
        {share === undefined && !error && <p className="collection-share-loading" aria-live="polite">Checking sharing…</p>}

        {share === null && failedAction !== "load" && <div className="collection-share-unshared">
          <p>Create a read-only link that always shows the latest synced cards in this collection.</p>
          <button className="collection-share-primary" disabled={busy} onClick={() => void enable()}>
            <Link2 aria-hidden="true" size={16} />
            {busy ? "Enabling…" : "Enable sharing"}
          </button>
        </div>}

        {share && <div className="collection-share-active">
          <label>
            Share URL
            <span>
              <input aria-label="Share URL" readOnly value={collectionShareUrl(siteUrl, share.token)} />
              <button aria-label="Copy link" disabled={busy} onClick={() => void copyLink()}>
                <Copy aria-hidden="true" size={16} />
              </button>
            </span>
          </label>
          <p><Check aria-hidden="true" size={15} /> Anyone with this link can view the collection.</p>
          <div className="collection-share-actions">
            <button disabled={busy} onClick={() => setConfirmation("regenerate")}>
              <RotateCw aria-hidden="true" size={15} /> Regenerate link
            </button>
            <button className="danger" disabled={busy} onClick={() => setConfirmation("disable")}>
              <Trash2 aria-hidden="true" size={15} /> Disable sharing
            </button>
          </div>
        </div>}

        {confirmation === "regenerate" && <div className="collection-share-confirmation">
          <h3>Regenerate this link?</h3>
          <p>The previous link will stop working immediately.</p>
          <div>
            <button disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>
            <button className="collection-share-primary" disabled={busy} onClick={() => void regenerate()}>
              {busy ? "Regenerating…" : "Confirm regenerate"}
            </button>
          </div>
        </div>}

        {confirmation === "disable" && <div className="collection-share-confirmation">
          <h3>Disable sharing?</h3>
          <p>The public page will become unavailable immediately.</p>
          <div>
            <button disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>
            <button className="danger" disabled={busy} onClick={() => void disable()}>
              {busy ? "Disabling…" : "Confirm disable"}
            </button>
          </div>
        </div>}

        {error && <div className="collection-share-error" role="alert">
          <span>{error}</span>
          {failedAction && <button disabled={busy} onClick={retry}>Retry</button>}
        </div>}
      </>}
    </section>
  </div>;

  return createPortal(content, document.body);
}
