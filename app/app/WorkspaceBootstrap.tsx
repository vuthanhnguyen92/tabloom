"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import Link from "next/link";
import { createDemoSnapshot } from "../../shared/domain";
import { MemoryWorkspaceRepository, SupabaseWorkspaceRepository, type WorkspaceRepository } from "../../shared/repository";
import { CombinedWorkspaceRepository, SupabaseBookmarkRepository } from "../../shared/bookmark-repository";
import { Brand } from "../components/Brand";
import { getSupabaseBrowserClient } from "../lib/supabase-browser";
import { SupabaseCollectionShareRepository, type CollectionShareClient } from "../../shared/collection-sharing";
import { WorkspaceClient } from "./WorkspaceClient";
import { readCollectionTarget, workspaceCollectionPath } from "./workspace-collection-target";

const demoRepository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());

function createSyncedRepository(client: NonNullable<ReturnType<typeof getSupabaseBrowserClient>>, userId: string) {
  return new CombinedWorkspaceRepository(
    new SupabaseWorkspaceRepository(client, userId),
    new SupabaseBookmarkRepository(client, userId),
  );
}

export function WorkspaceBootstrap() {
  const client = getSupabaseBrowserClient();
  const [session, setSession] = useState<Session | null | undefined>(client ? undefined : null);
  const [repository, setRepository] = useState<WorkspaceRepository | null>(client ? null : demoRepository);
  const [initialCollectionId, setInitialCollectionId] = useState<string | null>(null);

  useEffect(() => {
    // The target belongs to the browser URL, not the server-rendered shell.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInitialCollectionId(readCollectionTarget(window.location.search));
    if (!client) return;
    let active = true;
    let authChanged = false;
    let repositoryUserId: string | null | undefined;
    function acceptSession(next: Session | null) {
      setSession(next);
      const userId = next?.user.id ?? null;
      if (repositoryUserId !== userId) {
        repositoryUserId = userId;
        setRepository(next ? createSyncedRepository(client!, next.user.id) : null);
      }
    }
    void client.auth.getSession().then(({ data }) => {
      if (!active || authChanged) return;
      acceptSession(data.session);
    });
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      authChanged = true;
      acceptSession(next);
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [client]);

  if (session === undefined) return <main className="workspace-loading"><Brand /><span>Checking your session…</span></main>;
  if (client && !session) return <main className="signin-page"><div className="signin-card"><Brand /><span className="eyebrow">YOUR LINKS, EVERYWHERE</span><h1>Welcome to your calmer browser.</h1><p>Sign in once to keep spaces and collections synchronized with the Tabloom new-tab extension.</p><button className="button button-primary" onClick={() => void client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}${workspaceCollectionPath(readCollectionTarget(window.location.search))}` } })}>Sign in with Google</button><Link href="/">Back to Tabloom</Link></div></main>;
  if (!repository) return null;
  return <WorkspaceClient
    key={session?.user.id ?? "demo"}
    initialCollectionId={initialCollectionId}
    repository={repository}
    mode={client ? "synced" : "demo"}
    initialSnapshot={client ? undefined : createDemoSnapshot()}
    onSignOut={client ? () => void client.auth.signOut() : undefined}
    sharing={client && session ? {
      availability: "ready",
      repository: new SupabaseCollectionShareRepository(client as unknown as CollectionShareClient),
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL || "https://tabloom.nickvu.dev",
      onRequestSignIn: () => undefined,
    } : undefined}
  />;
}
