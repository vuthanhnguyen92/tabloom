"use client";

import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";

import { LogOut, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import type { WorkspaceSnapshot } from "../../shared/domain";
import type { WebWorkspaceRepository } from "../../shared/repository";
import type { WorkspaceTrashRepository } from "../../shared/trash-repository";
import type { CollectionShareRepository, ShareAvailability } from "../../shared/collection-sharing";
import { WorkspaceOrganizerView } from "../../shared/organizer/WorkspaceOrganizer";
import { useWorkspaceController } from "../../shared/organizer/useWorkspaceController";
import { createWebPreferenceStore } from "../../shared/organizer/preferences";
import { webOrganizerCapabilities } from "./web-organizer-capabilities";

type WorkspaceSharing = {
  availability: ShareAvailability;
  repository: CollectionShareRepository | null;
  siteUrl: string;
  onRequestSignIn: () => void;
};

export function WorkspaceClient({ repository, trashRepository, mode, userId = "demo-user", email, onSignOut, sharing, initialCollectionId }: {
  repository: WebWorkspaceRepository;
  trashRepository?: WorkspaceTrashRepository;
  mode: "demo" | "synced";
  userId?: string;
  email?: string;
  onSignOut?: () => void | Promise<void>;
  /** Compatibility only: canonical data and preferences load together in the controller. */
  initialSnapshot?: WorkspaceSnapshot;
  sharing?: WorkspaceSharing;
  initialCollectionId?: string | null;
}) {
  // Storage is accessed only when the controller boots on the client, never during SSR.
  const preferenceStore = useMemo(() => createWebPreferenceStore({
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  }), []);
  const options = { repository, trashRepository, userId, preferenceStore, preferenceScope: mode === "synced" ? `account:${userId}` : "demo", capabilities: webOrganizerCapabilities, mutationPolicy: "rollbackOnFailure" as const, deleteSource: "web" as const };
  const controller = useWorkspaceController(options);
  const account = useRef<HTMLDetailsElement>(null);
  const handledTarget = useRef<{ repository: WebWorkspaceRepository; id: string } | null>(null);

  useEffect(() => {
    if (!controller.ready || !initialCollectionId) return;
    if (handledTarget.current?.repository === repository && handledTarget.current.id === initialCollectionId) return;
    handledTarget.current = { repository, id: initialCollectionId };
    const target = controller.snapshot.collections.find((collection) => collection.id === initialCollectionId);
    if (!target) {
      controller.notify("This collection is no longer in your workspace.", "error");
      return;
    }
    controller.selectSpace(target.space_id);
    requestAnimationFrame(() => {
      const article = document.getElementById(`collection-${target.id}`);
      article?.focus({ preventScroll: true });
      article?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
  }, [controller, initialCollectionId, repository]);

  useEffect(() => {
    function closeAccount(event: KeyboardEvent | PointerEvent) {
      const menu = account.current;
      if (!menu?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        menu.open = false;
        menu.querySelector("summary")?.focus();
      } else if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    }
    document.addEventListener("keydown", closeAccount);
    document.addEventListener("pointerdown", closeAccount);
    return () => { document.removeEventListener("keydown", closeAccount); document.removeEventListener("pointerdown", closeAccount); };
  }, []);
  const status = controller.refreshRequired ? { state: "failed" as const, subtitle: "Refresh required" } : controller.busy ? { state: "syncing" as const, subtitle: "Saving…" } : { state: "synced" as const, subtitle: mode === "synced" ? "Synced" : "Demo workspace" };
  return <WorkspaceOrganizerView {...options} controller={controller} savedLinkNewTab={false} trashInAccount
    share={sharing ? { ...sharing, onRequestSyncRetry: () => { void controller.reload(); }, onToast: (message) => controller.notify(message) } : undefined}
    accountControls={<details className="web-organizer-account" ref={account}>
      <summary aria-label="Account"><UserRound size={18} /></summary>
      <div className="web-organizer-account-menu">
        <span>{email || (mode === "synced" ? "Your account" : "Demo workspace")}</span>
        <div role="status" aria-label="Workspace sync" className={`web-organizer-sync sync-state-${status.state}`}>
          <strong>{status.state === "syncing" ? "Syncing" : status.state === "failed" ? "Refresh required" : mode === "synced" ? "Synced" : "Local demo"}</strong>
          <small>{status.state === "synced" ? "All changes saved" : status.subtitle}</small>
        </div>
        <Link href="/">Home</Link>
        {trashRepository && <button onClick={() => { if (account.current) { account.current.open = false; account.current.querySelector("summary")?.focus(); } controller.setTrashOpen(true); }}>Trash</button>}
        {onSignOut && <button onClick={() => {
          if (account.current) account.current.open = false;
          void Promise.resolve().then(onSignOut).catch(() => controller.notify("Could not sign out. Please try again.", "error"));
        }}><LogOut size={15} />Sign out</button>}
      </div>
    </details>}
  />;
}
