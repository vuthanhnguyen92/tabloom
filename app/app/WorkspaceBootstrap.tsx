"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import Link from "next/link";
import { createDemoSnapshot } from "../../shared/domain";
import { MemoryWorkspaceRepository, SupabaseWorkspaceRepository, type WorkspaceRepository } from "../../shared/repository";
import { CombinedWorkspaceRepository, SupabaseBookmarkRepository } from "../../shared/bookmark-repository";
import { Brand } from "../components/Brand";
import { getSupabaseBrowserClient } from "../lib/supabase-browser";
import { WorkspaceClient } from "./WorkspaceClient";

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

  useEffect(() => {
    if (!client) return;
    void client.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setRepository(data.session ? createSyncedRepository(client, data.session.user.id) : null);
    });
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setRepository(next ? createSyncedRepository(client, next.user.id) : null);
    });
    return () => data.subscription.unsubscribe();
  }, [client]);

  if (session === undefined) return <main className="workspace-loading"><Brand /><span>Checking your session…</span></main>;
  if (client && !session) return <main className="signin-page"><div className="signin-card"><Brand /><span className="eyebrow">YOUR LINKS, EVERYWHERE</span><h1>Welcome to your calmer browser.</h1><p>Sign in once to keep spaces and collections synchronized with the Tabloom new-tab extension.</p><button className="button button-primary" onClick={() => void client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/app` } })}>Sign in with Google</button><Link href="/">Back to Tabloom</Link></div></main>;
  if (!repository) return null;
  return <WorkspaceClient repository={repository} mode={client ? "synced" : "demo"} initialSnapshot={client ? undefined : createDemoSnapshot()} onSignOut={client ? () => void client.auth.signOut() : undefined} />;
}
