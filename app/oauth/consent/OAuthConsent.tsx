"use client";

import "@fontsource/poppins/400.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import { useEffect, useState } from "react";
import type { OAuthAuthorizationDetails } from "@supabase/supabase-js";
import { Brand } from "../../components/Brand";
import { getSupabaseBrowserClient } from "../../lib/supabase-browser";

type OAuthConsentClient = {
  auth: {
    getSession: () => Promise<{ data: { session: unknown | null }; error?: unknown }>;
    signInWithOAuth: (credentials: {
      provider: "google";
      options: { redirectTo: string };
    }) => Promise<{ data?: { url?: string | null }; error?: unknown }>;
    oauth: {
      getAuthorizationDetails: (authorizationId: string) => Promise<{
        data: OAuthAuthorizationDetails | { redirect_url: string } | null;
        error?: unknown;
      }>;
      approveAuthorization: (authorizationId: string, options: { skipBrowserRedirect: true }) => Promise<{
        data: { redirect_url: string } | null;
        error?: unknown;
      }>;
      denyAuthorization: (authorizationId: string, options: { skipBrowserRedirect: true }) => Promise<{
        data: { redirect_url: string } | null;
        error?: unknown;
      }>;
    };
  };
};

type ConsentState =
  | { kind: "checking-session" }
  | { kind: "signed-out" }
  | { kind: "loading-request" }
  | { kind: "ready"; details: OAuthAuthorizationDetails }
  | { kind: "submitting"; details: OAuthAuthorizationDetails }
  | { kind: "error"; message: string };

function safeMessage(message: string) {
  return <main className="oauth-consent-page"><section className="oauth-consent-card oauth-consent-message" aria-live="polite"><Brand /><h1>{message}</h1><p>Start the connection from the app that requested access, then try again.</p></section></main>;
}

export function OAuthConsent({ authorizationId, client = getSupabaseBrowserClient() }: {
  authorizationId: string;
  client?: OAuthConsentClient | null;
}) {
  const [state, setState] = useState<ConsentState>(() => authorizationId ? { kind: "checking-session" } : { kind: "error", message: "Authorization request unavailable" });

  useEffect(() => {
    let active = true;
    if (!authorizationId) return () => { active = false; };
    if (!client) {
      void Promise.resolve().then(() => {
        if (active) setState({ kind: "error", message: "Authorization request unavailable" });
      });
      return () => { active = false; };
    }

    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setState({ kind: "error", message: "Unable to check your Tabloom session." });
        return;
      }
      if (!data.session) {
        setState({ kind: "signed-out" });
        return;
      }

      setState({ kind: "loading-request" });
      void client.auth.oauth.getAuthorizationDetails(authorizationId).then(({ data: details, error: requestError }) => {
        if (!active) return;
        if (requestError || !details) {
          setState({ kind: "error", message: "Unable to load this authorization request." });
        } else if ("redirect_url" in details) {
          window.location.assign(details.redirect_url);
        } else if ("authorization_id" in details && details.authorization_id === authorizationId) {
          setState({ kind: "ready", details });
        } else {
          setState({ kind: "error", message: "Authorization request unavailable" });
        }
      });
    });

    return () => { active = false; };
  }, [authorizationId, client]);

  if (state.kind === "error") return safeMessage(state.message);
  if (state.kind === "checking-session" || state.kind === "loading-request") {
    return <main className="oauth-consent-page"><section className="oauth-consent-card oauth-consent-message" aria-live="polite"><Brand /><p>Checking your authorization request…</p></section></main>;
  }
  if (state.kind === "signed-out") {
    return <main className="oauth-consent-page"><section className="oauth-consent-card oauth-consent-message"><Brand /><span className="eyebrow">CONNECT TABLOOM</span><h1>Sign in to continue</h1><p>Sign in to review the access this app is requesting for your synchronized Tabloom workspace.</p><button className="button button-primary" onClick={() => {
      const redirectTo = `${window.location.origin}/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
      void client?.auth.signInWithOAuth({ provider: "google", options: { redirectTo } }).then(({ error, data }) => {
        if (error || !data?.url) setState({ kind: "error", message: "Unable to continue with Google sign-in." });
      });
    }}>Sign in with Google</button></section></main>;
  }

  const { details } = state;
  const submitting = state.kind === "submitting";
  const submit = (decision: "approve" | "deny") => {
    if (submitting || details.authorization_id !== authorizationId || !client) return;
    setState({ kind: "submitting", details });
    const request = decision === "approve" ? client.auth.oauth.approveAuthorization : client.auth.oauth.denyAuthorization;
    void request(authorizationId, { skipBrowserRedirect: true }).then(({ data, error }) => {
      if (error || !data?.redirect_url) {
        setState({ kind: "error", message: "Unable to submit your authorization decision." });
        return;
      }
      window.location.assign(data.redirect_url);
    });
  };

  return <main className="oauth-consent-page"><section className="oauth-consent-card"><Brand /><span className="eyebrow">TABLOOM CONNECTION</span><h1>Connect {details.client.name} to Tabloom</h1><p className="oauth-consent-intro"><strong>{details.client.name}</strong> is requesting access to your complete synchronized Tabloom workspace.</p><section className="oauth-consent-permission" aria-label="Requested permission"><h2>It will be able to:</h2><p>Read and modify all synchronized spaces, collections, and saved links.</p><small>Local current tabs remain only on this browser and are not included.</small></section><dl className="oauth-consent-details"><div><dt>Redirects to</dt><dd>{details.redirect_uri}</dd></div></dl><div className="oauth-consent-actions"><button className="button button-quiet" disabled={submitting} onClick={() => submit("deny")}>Deny</button><button className="button button-primary" disabled={submitting} onClick={() => submit("approve")}>{submitting ? "Submitting…" : "Approve access"}</button></div></section></main>;
}
