"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Brand } from "../../components/Brand";
import { getSupabaseBrowserClient } from "../../lib/supabase-browser";
import { clearPendingSharedSave, readPendingSharedSave } from "../../lib/shared-save-intent";

type ReturnState = { status: "loading" | "missing" | "failed"; backHref?: string };

export function SharedSaveReturn() {
  const { replace } = useRouter();
  const [state, setState] = useState<ReturnState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let finished = false;
    let unsubscribe: () => void = () => undefined;
    let backHref: string | undefined;

    function fail() {
      if (!active || finished) return;
      finished = true;
      try { clearPendingSharedSave(window.sessionStorage); } catch { /* Storage may be blocked. */ }
      setState({ status: "failed", backHref });
    }

    function start() {
      try {
        const intent = readPendingSharedSave(window.sessionStorage, Date.now());
        backHref = intent ? `/s/${encodeURIComponent(intent.token)}` : undefined;
        const query = new URLSearchParams(window.location.search);
        const hash = new URLSearchParams(window.location.hash.slice(1));
        if (query.has("error") || hash.has("error")) { fail(); return; }
        if (!intent) { setState({ status: "missing" }); return; }
        const client = getSupabaseBrowserClient();
        if (!client) { fail(); return; }

        function complete() {
          if (!active || finished) return;
          finished = true;
          replace(`${backHref}?resumeSave=${encodeURIComponent(intent!.nonce)}`);
        }

        const { data } = client.auth.onAuthStateChange((_event, session) => {
          if (session) complete();
        });
        unsubscribe = () => data.subscription.unsubscribe();
        // Supabase resolves getSession only after processing the OAuth callback.
        void client.auth.getSession().then(({ data, error }) => {
          if (error || !data.session) fail();
          else complete();
        }).catch(fail);
      } catch { fail(); }
    }

    start();
    return () => { active = false; unsubscribe(); };
  }, [replace]);

  return <main className="signin-page"><div className="signin-card">
    <Brand />
    {state.status === "loading" ? <p role="status">Completing sign-in…</p> : <>
      <h1>{state.status === "failed" ? "Sign-in wasn’t completed" : "Return to your collection"}</h1>
      <p role={state.status === "failed" ? "alert" : "status"}>{state.status === "failed"
        ? "Sign-in wasn’t completed. Your collection hasn’t been saved."
        : "Your save request has expired or is no longer available. Open the shared collection to save it again."}</p>
      {state.backHref && <Link className="button button-primary" href={state.backHref}>Back to shared collection</Link>}
      <Link href="/app">Go to my workspace</Link>
    </>}
  </div></main>;
}
