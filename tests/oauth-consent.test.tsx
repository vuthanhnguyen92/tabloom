import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OAuthAuthorizationDetails } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { OAuthConsent } from "../app/oauth/consent/OAuthConsent";

const details: OAuthAuthorizationDetails = {
  authorization_id: "authorization-1",
  redirect_uri: "https://client.example/callback",
  client: {
    id: "client-1",
    name: "Codex",
    uri: "https://client.example",
    logo_uri: "https://client.example/logo.svg",
  },
  user: { id: "user-1", email: "person@example.com" },
  scope: "workspace.read workspace.write",
};

function oauthClient(authorizationDetails: OAuthAuthorizationDetails) {
  return {
    auth: {
      getSession: vi.fn<() => Promise<{ data: { session: unknown }; error: null }>>(async () => ({ data: { session: { user: { id: "user-1" } } }, error: null })),
      signInWithOAuth: vi.fn<() => Promise<{ data: { provider: string; url: string | null }; error: { message: string } | null }>>(async () => ({ data: { provider: "google", url: "https://accounts.example/authorize" }, error: null })),
      oauth: {
        getAuthorizationDetails: vi.fn<() => Promise<{ data: OAuthAuthorizationDetails | { redirect_url: string }; error: null }>>(async () => ({ data: authorizationDetails, error: null })),
        approveAuthorization: vi.fn(async () => ({ data: { redirect_url: "https://client.example/callback?approve=1" }, error: null })),
        denyAuthorization: vi.fn(async () => ({ data: { redirect_url: "https://client.example/callback?deny=1" }, error: null })),
      },
    },
  };
}

function signedOutOAuthClient() {
  const client = oauthClient(details);
  client.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  return client;
}

function signedInOAuthClient(authorizationDetails: OAuthAuthorizationDetails, redirectUrl: string) {
  const client = oauthClient(authorizationDetails);
  client.auth.oauth.approveAuthorization.mockResolvedValue({ data: { redirect_url: redirectUrl }, error: null });
  client.auth.oauth.denyAuthorization.mockResolvedValue({ data: { redirect_url: redirectUrl }, error: null });
  return client;
}

describe("OAuthConsent", () => {
  it("explains when the authorization request is missing", () => {
    render(<OAuthConsent authorizationId="" client={oauthClient(details)} />);

    expect(screen.getByRole("heading", { name: "Authorization request unavailable" })).toBeInTheDocument();
    expect(screen.getByText(/start the connection from the app that requested access/i)).toBeInTheDocument();
  });

  it("shows the requesting client and whole-workspace permission", async () => {
    render(<OAuthConsent authorizationId="authorization-1" client={oauthClient(details)} />);

    expect(await screen.findByRole("heading", { name: "Connect Codex to Tabloom" })).toBeInTheDocument();
    expect(screen.getByText(/read and modify all synchronized spaces/i)).toBeInTheDocument();
    expect(screen.getByText("https://client.example/callback")).toBeInTheDocument();
  });

  it("preserves authorization_id when Google sign-in is required", async () => {
    const client = signedOutOAuthClient();
    render(<OAuthConsent authorizationId="authorization-1" client={client} />);

    await userEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));

    expect(client.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: expect.stringContaining("/oauth/consent?authorization_id=authorization-1") },
    });
  });

  it("redirects an already-approved request using Supabase's returned URL", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { assign } });
    const client = signedInOAuthClient(details, "https://client.example/callback?approved=1");
    client.auth.oauth.getAuthorizationDetails.mockResolvedValue({ data: { redirect_url: "https://client.example/callback?already=1" }, error: null });

    render(<OAuthConsent authorizationId="authorization-1" client={client} />);

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://client.example/callback?already=1"));
  });

  it.each(["approve", "deny"] as const)("returns the %s decision to the OAuth client", async (decision) => {
    const client = signedInOAuthClient(details, `https://client.example/callback?${decision}=1`);
    render(<OAuthConsent authorizationId="authorization-1" client={client} />);

    await userEvent.click(await screen.findByRole("button", { name: decision === "approve" ? "Approve access" : "Deny" }));

    expect(client.auth.oauth[decision === "approve" ? "approveAuthorization" : "denyAuthorization"])
      .toHaveBeenCalledWith("authorization-1", { skipBrowserRedirect: true });
  });

  it("shows a safe sign-in failure summary", async () => {
    const client = signedOutOAuthClient();
    client.auth.signInWithOAuth.mockResolvedValue({ data: { provider: "google", url: null }, error: { message: "sensitive provider metadata" } });
    render(<OAuthConsent authorizationId="authorization-1" client={client} />);

    await userEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));

    expect(await screen.findByText("Unable to continue with Google sign-in.")).toBeInTheDocument();
    expect(screen.queryByText(/sensitive provider metadata/i)).not.toBeInTheDocument();
  });
});
