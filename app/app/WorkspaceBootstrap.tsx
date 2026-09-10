"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import Link from "next/link";
import { createDemoSnapshot } from "../../shared/domain";
import { MemoryWorkspaceRepository, SupabaseWorkspaceRepository, type WebWorkspaceRepository } from "../../shared/repository";
import { SupabaseTrashRepository, type WorkspaceTrashRepository } from "../../shared/trash-repository";
import { CombinedWorkspaceRepository, SupabaseBookmarkRepository } from "../../shared/bookmark-repository";
import { Brand } from "../components/Brand";
import { getSupabaseBrowserClient } from "../lib/supabase-browser";
import { SupabaseCollectionShareRepository, type CollectionShareClient } from "../../shared/collection-sharing";
import { WorkspaceClient } from "./WorkspaceClient";

const demoRepository = new MemoryWorkspaceRepository("demo-user", createDemoSnapshot());

export function createSyncedRepositories(client: NonNullable<ReturnType<typeof getSupabaseBrowserClient>>, userId: string) {
  const combined = new CombinedWorkspaceRepository(
    new SupabaseWorkspaceRepository(client, userId),
    new SupabaseBookmarkRepository(client, userId),
  );
  const repository: WebWorkspaceRepository = {
    load: combined.load.bind(combined),
    createSpace: combined.createSpace.bind(combined), updateSpace: combined.updateSpace.bind(combined),
    createCollection: combined.createCollection.bind(combined), updateCollection: combined.updateCollection.bind(combined),
    createLink: combined.createLink.bind(combined), createLinks: combined.createLinks.bind(combined), updateLink: combined.updateLink.bind(combined),
    reorderCollections: combined.reorderCollections.bind(combined), reorderLinks: combined.reorderLinks.bind(combined),
    moveLink: combined.moveLink.bind(combined),
  };
  return { repository, trashRepository: new SupabaseTrashRepository(client) };
}

export function WorkspaceBootstrap() {
  const client = getSupabaseBrowserClient();
  const [session, setSession] = useState<Session | null | undefined>(client ? undefined : null);
  const [repositories, setRepositories] = useState<{ repository: WebWorkspaceRepository; trashRepository?: WorkspaceTrashRepository } | null>(client ? null : { repository: demoRepository });

  useEffect(() => {
    if (!client) return;
    let active = true;
    let authEventReceived = false;
    void client.auth.getSession().then(({ data }) => {
      if (!active || authEventReceived) return;
      setSession(data.session);
      setRepositories(data.session ? createSyncedRepositories(client, data.session.user.id) : null);
    });
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      authEventReceived = true;
      setSession(next);
      setRepositories(next ? createSyncedRepositories(client, next.user.id) : null);
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [client]);

  if (session === undefined) return <main className="workspace-loading"><Brand /><span>Checking your session…</span></main>;
  if (client && !session) return <main className="signin-page"><div className="signin-card"><Brand /><span className="eyebrow">YOUR LINKS, EVERYWHERE</span><h1>Welcome to your calmer browser.</h1><p>Sign in once to keep spaces and collections synchronized with the Tabloom new-tab extension.</p><button className="button button-primary" onClick={() => void client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/app` } })}>Sign in with Google</button><Link href="/">Back to Tabloom</Link></div></main>;
  if (!repositories) return null;
  return <WorkspaceClient
    repository={repositories.repository}
    trashRepository={repositories.trashRepository}
    mode={client ? "synced" : "demo"}
    userId={session?.user.id ?? "demo-user"}
    email={session?.user.email}
    onSignOut={client ? async () => { const { error } = await client.auth.signOut(); if (error) throw error; } : undefined}
    sharing={client && session ? {
      availability: "ready",
      repository: new SupabaseCollectionShareRepository(client as unknown as CollectionShareClient),
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL || "https://tabloom.nickvu.dev",
      onRequestSignIn: () => undefined,
    } : undefined}
  />;
}
