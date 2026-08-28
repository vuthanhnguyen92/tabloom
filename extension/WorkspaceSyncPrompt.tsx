import { Cloud, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceMergePlan } from "../shared/workspace-merge";

export type WorkspaceSyncPromptProps = {
  plan: WorkspaceMergePlan;
  busy: boolean;
  error: string | null;
  onConfirm(): void | Promise<void>;
  onCancel(): void | Promise<void>;
};

function noun(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function WorkspaceSyncPrompt({
  plan,
  busy,
  error,
  onConfirm,
  onCancel,
}: WorkspaceSyncPromptProps) {
  const titleId = useId();
  const descriptionId = useId();
  const safeAction = useRef<HTMLButtonElement>(null);
  const summary = plan.summary;
  const matchedItems =
    summary.matchedSpaces +
    summary.matchedCollections +
    summary.matchedLinksById +
    summary.matchedLinksByUrl;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    safeAction.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      void onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [busy, onCancel]);

  return createPortal(
    <div className="drop-confirm-backdrop workspace-sync-backdrop">
      <section
        className="drop-confirm workspace-sync-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <button
          className="dialog-close"
          aria-label="Close sync dialog"
          disabled={busy}
          onClick={() => void onCancel()}
        >
          <X size={18} />
        </button>
        <small><Cloud size={13} /> WORKSPACE SYNC</small>
        <h2 id={titleId}>Combine local and synced tabs?</h2>
        <p id={descriptionId}>
          Tabloom found saved tabs in this browser and in your synced workspace.
        </p>
        <ul className="workspace-sync-summary">
          <li>
            {noun(summary.addedSpaces, "space")}, {noun(summary.addedCollections, "collection")}, and {noun(summary.addedLinks, "link")} will be added.
          </li>
          <li>{noun(matchedItems, "existing item")} matched.</li>
          {summary.skippedUnsupportedLinks > 0 && (
            <li>{noun(summary.skippedUnsupportedLinks, "unsupported link")} will be skipped.</li>
          )}
        </ul>
        {error && <p className="workspace-sync-error" role="alert">{error}</p>}
        {busy && <p className="workspace-sync-progress" role="status">Combining workspaces…</p>}
        <div>
          <button
            ref={safeAction}
            disabled={busy}
            onClick={() => void onCancel()}
          >
            Keep using local
          </button>
          <button
            className="close-after-save"
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            {busy ? "Combining…" : error ? "Try combine again" : "Combine and sync"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
