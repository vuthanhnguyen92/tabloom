"use client";

import "@fontsource/poppins/400.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  | { requestId: string; kind: "checking-session" }
  | { requestId: string; kind: "signed-out" }
  | { requestId: string; kind: "loading-request" }
  | { requestId: string; kind: "ready"; details: OAuthAuthorizationDetails }
  | { requestId: string; kind: "submitting"; details: OAuthAuthorizationDetails }
  | { requestId: string; kind: "error"; message: string };

function safeMessage(message: string) {
  return <main className="oauth-consent-page"><section className="oauth-consent-card oauth-consent-message" aria-live="polite"><Brand /><h1>{message}</h1><p>Start the connection from the app that requested access, then try again.</p></section></main>;
}

export function OAuthConsent({ authorizationId, client = getSupabaseBrowserClient() }: {
  authorizationId: string;
  client?: OAuthConsentClient | null;
}) {
  const [state, setState] = useState<ConsentState>(() => authorizationId ? { requestId: authorizationId, kind: "checking-session" } : { requestId: "", kind: "error", message: "Authorization request unavailable" });
  const mountedRef = useRef(true);
  const requestRef = useRef({ authorizationId, version: 0 });
  useLayoutEffect(() => {
    mountedRef.current = true;
    if (requestRef.current.authorizationId !== authorizationId) {
      requestRef.current = { authorizationId, version: requestRef.current.version + 1 };
    }
    return () => { mountedRef.current = false; };
  }, [authorizationId]);

  useEffect(() => {
    const request = requestRef.current;
    let active = true;
    const isCurrent = () => active
      && mountedRef.current
      && requestRef.current.authorizationId === request.authorizationId
      && requestRef.current.version === request.version;

    void Promise.resolve().then(() => {
      if (isCurrent()) {
        setState(request.authorizationId
          ? { requestId: request.authorizationId, kind: "checking-session" }
          : { requestId: request.authorizationId, kind: "error", message: "Authorization request unavailable" });
      }
    });

    if (!authorizationId) return () => { active = false; };
    if (!client) {
      void Promise.resolve().then(() => {
        if (isCurrent()) setState({ requestId: request.authorizationId, kind: "error", message: "Authorization request unavailable" });
      });
      return () => { active = false; };
    }

    void client.auth.getSession().then(({ data, error }) => {
      if (!isCurrent()) return;
      if (error) {
        setState({ requestId: request.authorizationId, kind: "error", message: "Unable to check your Tabloom session." });
        return;
      }
      if (!data.session) {
        setState({ requestId: request.authorizationId, kind: "signed-out" });
        return;
      }

      setState({ requestId: request.authorizationId, kind: "loading-request" });
      void client.auth.oauth.getAuthorizationDetails(request.authorizationId).then(({ data: details, error: requestError }) => {
        if (!isCurrent()) return;
        if (requestError || !details) {
          setState({ requestId: request.authorizationId, kind: "error", message: "Unable to load this authorization request." });
        } else if ("redirect_url" in details) {
          if (isCurrent()) window.location.assign(details.redirect_url);
        } else if ("authorization_id" in details && details.authorization_id === request.authorizationId) {
          setState({ requestId: request.authorizationId, kind: "ready", details });
        } else {
          setState({ requestId: request.authorizationId, kind: "error", message: "Authorization request unavailable" });
        }
      });
    });

    return () => { active = false; };
  }, [authorizationId, client]);

  if (!authorizationId) return safeMessage("Authorization request unavailable");
  if (state.requestId !== authorizationId || state.kind === "checking-session" || state.kind === "loading-request") {
    return <main className="oauth-consent-page"><section className="oauth-consent-card oauth-consent-message" aria-live="polite"><Brand /><p>Checking your authorization request…</p></section></main>;
  }
  if (state.kind === "error") return safeMessage(state.message);
  if (state.kind === "signed-out") {
    return <main className="oauth-consent-page"><section className="oauth-consent-card oauth-consent-message"><Brand /><span className="eyebrow">CONNECT TABLOOM</span><h1>Sign in to continue</h1><p>Sign in to review the access this app is requesting for your synchronized Tabloom workspace.</p><button className="button button-primary" onClick={() => {
      const redirectTo = `${window.location.origin}/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
      const request = requestRef.current;
      void client?.auth.signInWithOAuth({ provider: "google", options: { redirectTo } }).then(({ error, data }) => {
        if (mountedRef.current && requestRef.current.authorizationId === request.authorizationId && requestRef.current.version === request.version && (error || !data?.url)) {
          setState({ requestId: request.authorizationId, kind: "error", message: "Unable to continue with Google sign-in." });
        }
      });
    }}>Sign in with Google</button></section></main>;
  }

  const { details } = state;
  const submitting = state.kind === "submitting";
  const submit = (decision: "approve" | "deny") => {
    const requestIdentity = requestRef.current;
    const isCurrent = () => mountedRef.current
      && requestRef.current.authorizationId === requestIdentity.authorizationId
      && requestRef.current.version === requestIdentity.version;
    if (submitting || details.authorization_id !== authorizationId || !client || !isCurrent()) return;
    setState({ requestId: requestIdentity.authorizationId, kind: "submitting", details });
    const request = decision === "approve" ? client.auth.oauth.approveAuthorization : client.auth.oauth.denyAuthorization;
    void request(authorizationId, { skipBrowserRedirect: true }).then(({ data, error }) => {
      if (!isCurrent()) return;
      if (error || !data?.redirect_url) {
        setState({ requestId: requestIdentity.authorizationId, kind: "error", message: "Unable to submit your authorization decision." });
        return;
      }
      if (isCurrent()) window.location.assign(data.redirect_url);
    });
  };

  return <main className="oauth-consent-page"><section className="oauth-consent-card"><Brand /><span className="eyebrow">TABLOOM CONNECTION</span><h1>Connect {details.client.name} to Tabloom</h1><p className="oauth-consent-intro"><strong>{details.client.name}</strong> is requesting access to your complete synchronized Tabloom workspace.</p><section className="oauth-consent-permission" aria-label="Requested permission"><h2>It will be able to:</h2><p>Read and modify all synchronized spaces, collections, and saved links.</p><small>Local current tabs remain only on this browser and are not included.</small></section><dl className="oauth-consent-details"><div><dt>Redirects to</dt><dd>{details.redirect_uri}</dd></div></dl><div className="oauth-consent-actions"><button className="button button-quiet" disabled={submitting} onClick={() => submit("deny")}>Deny</button><button className="button button-primary" disabled={submitting} onClick={() => submit("approve")}>{submitting ? "Submitting…" : "Approve access"}</button></div></section></main>;
}
