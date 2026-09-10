"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import Link from "next/link";
import { createDemoSnapshot } from "../../shared/domain";
import { MemoryWorkspaceRepository, SupabaseWorkspaceRepository, type WebWorkspaceRepository } from "../../shared/repository";
import { SupabaseTrashRepository } from "../../shared/trash-repository";
import { CombinedWorkspaceRepository, SupabaseBookmarkRepository } from "../../shared/bookmark-repository";
import { Brand } from "../components/Brand";
import { getSupabaseBrowserClient } from "../lib/supabase-browser";
import { SupabaseCollectionShareRepository, type CollectionShareClient } from "../../shared/collection-sharing";
import { WorkspaceClient } from "./WorkspaceClient";
import { readCollectionTarget, workspaceCollectionPath } from "./workspace-collection-target";

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
  const [auth, setAuth] = useState<{ client: typeof client; session: Session | null | undefined }>({ client, session: client ? undefined : null });
  const [initialCollectionId, setInitialCollectionId] = useState<string | null>(null);
  // Client changes must recheck authentication before publishing another workspace.
  const session = !client ? null : auth.client === client ? auth.session : undefined;
  const userId = session?.user.id;
  const repositories = useMemo(() => !client ? { repository: demoRepository, trashRepository: undefined } : userId ? createSyncedRepositories(client, userId) : null, [client, userId]);
  const sharingRepository = useMemo(() => client && userId ? new SupabaseCollectionShareRepository(client as unknown as CollectionShareClient) : null, [client, userId]);

  useEffect(() => {
    // The target belongs to the browser URL, not the server-rendered shell.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInitialCollectionId(readCollectionTarget(window.location.search));
    if (!client) return;
    let active = true;
    let authEventReceived = false;
    void client.auth.getSession().then(({ data }) => {
      if (!active || authEventReceived) return;
      setAuth({ client, session: data.session });
    });
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      authEventReceived = true;
      setAuth({ client, session: next });
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [client]);

  if (session === undefined) return <main className="workspace-loading"><Brand /><span>Checking your session…</span></main>;
  if (client && !session) return <main className="signin-page"><div className="signin-card"><Brand /><span className="eyebrow">YOUR LINKS, EVERYWHERE</span><h1>Welcome to your calmer browser.</h1><p>Sign in once to keep spaces and collections synchronized with the Tabloom new-tab extension.</p><button className="button button-primary" onClick={() => void client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}${workspaceCollectionPath(readCollectionTarget(window.location.search))}` } })}>Sign in with Google</button><Link href="/">Back to Tabloom</Link></div></main>;
  if (!repositories) return null;
  return <WorkspaceClient
    key={session?.user.id ?? "demo"}
    initialCollectionId={initialCollectionId}
    repository={repositories.repository}
    trashRepository={repositories.trashRepository}
    mode={client ? "synced" : "demo"}
    userId={session?.user.id ?? "demo-user"}
    email={session?.user.email}
    onSignOut={client ? async () => { const { error } = await client.auth.signOut(); if (error) throw error; } : undefined}
    sharing={sharingRepository ? {
      availability: "ready",
      repository: sharingRepository,
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL || "https://tabloom.nickvu.dev",
      onRequestSignIn: () => undefined,
    } : undefined}
  />;
}
