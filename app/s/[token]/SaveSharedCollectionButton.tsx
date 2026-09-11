"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CollectionSaveError, SupabaseCollectionSaveRepository, type SharedCollectionSaveResult } from "../../../shared/collection-saving";
import { clearPendingSharedSave, readPendingSharedSave, writePendingSharedSave } from "../../lib/shared-save-intent";
import { getSupabaseBrowserClient } from "../../lib/supabase-browser";

type ActionState = { phase: "loading" | "ready" | "saving" | "saved" | "existing" | "error" | "unavailable"; result?: SharedCollectionSaveResult; error?: string; retry?: "save" | "status" };
export const sharedSaveExplanation = "Save a copy to your account. Changes to the original won’t update your copy.";

export function SaveSharedCollectionButton({ token, showExplanation = true }: { token: string; showExplanation?: boolean }) {
  const [state, setState] = useState<ActionState>({ phase: "loading" });
  const [dialog, setDialog] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const actions = useRef({ save: () => {}, status: () => {} });

  useEffect(() => {
    const client = getSupabaseBrowserClient();
    if (!client) {
      let active = true;
      queueMicrotask(() => { if (active) setState({ phase: "error", error: "Saving is unavailable right now. Please try again later." }); });
      return () => { active = false; };
    }
    const repository = new SupabaseCollectionSaveRepository(client);
    let active = true;
    let generation = 0;
    let userId: string | null | undefined;
    let busy = false;
    let attemptedResume: string | undefined;
    const current = (version: number) => active && generation === version;
    function clearIntent() {
      const intent = readPendingSharedSave(window.sessionStorage, Date.now());
      if (intent?.token === token) clearPendingSharedSave(window.sessionStorage);
      const url = new URL(window.location.href);
      url.searchParams.delete("resumeSave");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    function finishIntent() {
      try { clearIntent(); } catch { /* The confirmed server result remains authoritative. */ }
    }
    async function save() {
      if (!active || busy) return;
      if (!userId) { setDialog(true); return; }
      const version = generation;
      busy = true;
      setState({ phase: "saving" });
      try {
        const result = await repository.save(token);
        if (!current(version)) return;
        finishIntent();
        setState({ phase: result.status === "owned" ? "existing" : "saved", result });
      } catch (error) {
        if (!current(version)) return;
        if (error instanceof CollectionSaveError && error.code === "auth-required") {
          setState({ phase: "ready" }); setDialog(true);
        } else if (error instanceof CollectionSaveError && error.code === "unavailable") {
          finishIntent(); setState({ phase: "unavailable", error: error.message });
        } else {
          setState({ phase: "error", error: "Couldn’t save this collection. Try again.", retry: "save" });
        }
      } finally { if (current(version)) busy = false; }
    }
    async function status() {
      if (!active || busy) return;
      const version = generation;
      if (!userId) { setState({ phase: "ready" }); return; }
      setState({ phase: "loading" });
      try {
        const intent = readPendingSharedSave(window.sessionStorage, Date.now());
        const nonce = new URLSearchParams(window.location.search).get("resumeSave");
        if (intent && intent.token === token && intent.nonce === nonce && attemptedResume !== nonce) {
          attemptedResume = nonce;
          await save();
          return;
        }
      } catch {
        setState({ phase: "error", error: "Browser storage is unavailable. Enable session storage, then try again.", retry: "status" });
        return;
      }
      try {
        const result = await repository.getState(token);
        if (!current(version) || busy) return;
        if (result.status === "owned" || result.status === "saved") setState({ phase: "existing", result });
        else if (result.status === "unavailable") { finishIntent(); setState({ phase: "unavailable", error: "This shared collection is no longer available." }); }
        else setState({ phase: "ready" });
      } catch {
        if (current(version) && !busy) setState({ phase: "error", error: "Couldn’t check whether this collection is saved. Try again.", retry: "status" });
      }
    }
    function acceptSession(id: string | null) {
      if (!active || userId === id) return;
      userId = id;
      generation += 1;
      busy = false;
      setDialog(false);
      setState({ phase: "loading" });
      // Leave the Supabase auth callback before making another authenticated request.
      queueMicrotask(() => { if (active) void status(); });
    }
    actions.current = { save: () => { void save(); }, status: () => { void status(); } };
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => acceptSession(session?.user.id ?? null));
    const initialGeneration = generation;
    void client.auth.getSession().then(({ data, error }) => {
      if (!active || generation !== initialGeneration) return;
      if (error) setState({ phase: "error", error: "Couldn’t check your sign-in. Reload this page to try again." });
      else acceptSession(data.session?.user.id ?? null);
    }).catch(() => {
      if (active && generation === initialGeneration) setState({ phase: "error", error: "Couldn’t check your sign-in. Reload this page to try again." });
    });
    return () => { active = false; generation += 1; subscription.unsubscribe(); };
  }, [token]);

  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialogRef.current;
    element?.querySelector<HTMLButtonElement>("button")?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); setDialog(false); }
      if (event.key === "Tab") {
        const controls = Array.from(element?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]') ?? []);
        const first = controls[0]; const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [dialog]);

  async function signIn() {
    const client = getSupabaseBrowserClient();
    if (!client) { setDialogError("Sign-in is unavailable right now. Please try again later."); return; }
    setSigningIn(true); setDialogError("");
    try {
      writePendingSharedSave(window.sessionStorage, { token, nonce: crypto.randomUUID(), createdAt: Date.now() });
    } catch {
      setDialogError("Browser storage is unavailable. Enable session storage, then try again."); setSigningIn(false); return;
    }
    try {
      const { error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/auth/shared-save` } });
      if (error) throw error;
    } catch {
      try { clearPendingSharedSave(window.sessionStorage); } catch { /* Display the sign-in failure below. */ }
      setDialogError("Couldn’t start sign-in. Try again."); setSigningIn(false);
    }
  }

  const destination = state.result ? `/app?collection=${encodeURIComponent(state.result.collectionId)}` : null;
  return <div className="shared-save-action">
    {destination ? <div role="status">{state.phase === "saved" && <p>Saved to your collections</p>}<Link className="button button-primary" href={destination}>{state.result?.status === "owned" ? "Open my collection" : state.phase === "saved" ? "View collection" : "View saved collection"}</Link></div> : <>
      {(state.phase === "ready" || state.phase === "loading" || state.phase === "saving") && <button className="button button-primary" disabled={state.phase !== "ready"} onClick={() => actions.current.save()}>{state.phase === "saving" ? "Saving…" : state.phase === "loading" ? "Checking saved collection…" : "Save to my collections"}</button>}
      {state.error && <p role="alert">{state.error}</p>}
      {state.retry && <button className="button" onClick={() => state.retry === "save" ? actions.current.save() : actions.current.status()}>{state.retry === "status" ? "Retry status checking" : "Retry"}</button>}
    </>}
    {showExplanation && <p className="shared-save-explanation">{sharedSaveExplanation}</p>}
    {dialog && <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setDialog(false); }}><section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="shared-save-dialog-title" aria-describedby="shared-save-dialog-description" className="dialog shared-save-dialog"><button className="dialog-close" aria-label="Close dialog" onClick={() => setDialog(false)}>×</button><h2 id="shared-save-dialog-title">Sign in to save this collection</h2><p id="shared-save-dialog-description">{sharedSaveExplanation}</p>{dialogError && <p role="alert">{dialogError}</p>}<div className="dialog-actions"><button onClick={() => setDialog(false)}>Cancel</button><button className="button-primary" disabled={signingIn} onClick={() => { void signIn(); }}>{signingIn ? "Opening sign-in…" : "Continue with Google"}</button></div></section></div>}
  </div>;
}
