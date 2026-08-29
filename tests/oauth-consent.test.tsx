import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OAuthAuthorizationDetails } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthConsent } from "../app/oauth/consent/OAuthConsent";
import ConsentPage from "../app/oauth/consent/page";

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

const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location");

function mockLocation() {
  const assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { assign } });
  return assign;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function oauthClient(authorizationDetails: OAuthAuthorizationDetails) {
  return {
    auth: {
      getSession: vi.fn<() => Promise<{ data: { session: unknown }; error: null }>>(async () => ({ data: { session: { user: { id: "user-1" } } }, error: null })),
      signInWithOAuth: vi.fn<() => Promise<{ data: { provider: string; url: string | null }; error: { message: string } | null }>>(async () => ({ data: { provider: "google", url: "https://accounts.example/authorize" }, error: null })),
      oauth: {
        getAuthorizationDetails: vi.fn<(authorizationId: string) => Promise<{ data: OAuthAuthorizationDetails | { redirect_url: string }; error: null }>>(async () => ({ data: authorizationDetails, error: null })),
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
  afterEach(() => {
    vi.unstubAllEnvs();
    if (locationDescriptor) Object.defineProperty(window, "location", locationDescriptor);
  });

  it("explains when the authorization request is missing", () => {
    render(<OAuthConsent authorizationId="" client={oauthClient(details)} />);

    expect(screen.getByRole("heading", { name: "Authorization request unavailable" })).toBeInTheDocument();
    expect(screen.getByText(/start the connection from the app that requested access/i)).toBeInTheDocument();
  });

  it("keeps consent unavailable when public Supabase configuration is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    render(<OAuthConsent authorizationId="authorization-1" />);

    expect(
      await screen.findByRole("heading", {
        name: "Authorization request unavailable",
      }),
    ).toBeInTheDocument();
  });

  it("creates the consent client from explicit runtime configuration", async () => {
    render(
      <OAuthConsent
        authorizationId="authorization-1"
        supabaseConfig={{
          url: "https://runtime-config.supabase.co",
          anonKey: "runtime-public-anon-key",
        }}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Sign in to continue" }),
    ).toBeInTheDocument();
  });

  it("passes public Supabase runtime configuration from the server page", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://runtime-config.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "runtime-public-anon-key");

    const page = await ConsentPage({
      searchParams: Promise.resolve({ authorization_id: "authorization-1" }),
    });

    expect(page.props).toEqual({
      authorizationId: "authorization-1",
      supabaseConfig: {
        url: "https://runtime-config.supabase.co",
        anonKey: "runtime-public-anon-key",
      },
    });
  });

  it("omits incomplete public runtime configuration from the server page", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://runtime-config.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    const page = await ConsentPage({ searchParams: Promise.resolve({}) });

    expect(page.props).toEqual({
      authorizationId: "",
      supabaseConfig: undefined,
    });
  });

  it("rejects template-valued explicit runtime configuration", async () => {
    render(
      <OAuthConsent
        authorizationId="authorization-1"
        supabaseConfig={{
          url: "https://your-project.supabase.co",
          anonKey: "your-public-anon-key",
        }}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Authorization request unavailable",
      }),
    ).toBeInTheDocument();
  });

  it.each([
    {
      explicit: { url: "https://explicit.supabase.co" },
      missing: "anon key",
    },
    {
      explicit: { anonKey: "explicit-public-anon-key" },
      missing: "URL",
    },
  ])(
    "does not fill a missing explicit $missing from the environment",
    async ({ explicit }) => {
      vi.stubEnv(
        "NEXT_PUBLIC_SUPABASE_URL",
        "https://environment.supabase.co",
      );
      vi.stubEnv(
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "environment-public-anon-key",
      );

      render(
        <OAuthConsent
          authorizationId="authorization-1"
          supabaseConfig={explicit}
        />,
      );

      expect(
        await screen.findByRole("heading", {
          name: "Authorization request unavailable",
        }),
      ).toBeInTheDocument();
    },
  );

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
    const assign = mockLocation();
    const client = signedInOAuthClient(details, "https://client.example/callback?approved=1");
    client.auth.oauth.getAuthorizationDetails.mockResolvedValue({ data: { redirect_url: "https://client.example/callback?already=1" }, error: null });

    render(<OAuthConsent authorizationId="authorization-1" client={client} />);

    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://client.example/callback?already=1"));
  });

  it.each(["approve", "deny"] as const)("returns the %s decision to the OAuth client", async (decision) => {
    const assign = mockLocation();
    const client = signedInOAuthClient(details, `https://client.example/callback?${decision}=1`);
    render(<OAuthConsent authorizationId="authorization-1" client={client} />);

    await userEvent.click(await screen.findByRole("button", { name: decision === "approve" ? "Approve access" : "Deny" }));

    expect(client.auth.oauth[decision === "approve" ? "approveAuthorization" : "denyAuthorization"])
      .toHaveBeenCalledWith("authorization-1", { skipBrowserRedirect: true });
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`https://client.example/callback?${decision}=1`));
  });

  it("rejects authorization details for a different request", async () => {
    const client = oauthClient({ ...details, authorization_id: "authorization-2" });
    render(<OAuthConsent authorizationId="authorization-1" client={client} />);

    expect(await screen.findByRole("heading", { name: "Authorization request unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect Codex to Tabloom" })).not.toBeInTheDocument();
  });

  it("disables both decisions while a decision is pending", async () => {
    mockLocation();
    const pending = deferred<{ data: { redirect_url: string }; error: null }>();
    const client = signedInOAuthClient(details, "https://client.example/callback?approve=1");
    client.auth.oauth.approveAuthorization.mockImplementation(() => pending.promise);
    render(<OAuthConsent authorizationId="authorization-1" client={client} />);

    await userEvent.click(await screen.findByRole("button", { name: "Approve access" }));

    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    pending.resolve({ data: { redirect_url: "https://client.example/callback?approve=1" }, error: null });
  });

  it("invalidates visible consent state when the request changes or is removed", async () => {
    const nextDetails: OAuthAuthorizationDetails = { ...details, authorization_id: "authorization-2", client: { ...details.client, name: "Another client" } };
    const client = oauthClient(details);
    client.auth.oauth.getAuthorizationDetails.mockImplementation(async (requestId) => ({ data: requestId === "authorization-2" ? nextDetails : details, error: null }));
    const { rerender } = render(<OAuthConsent authorizationId="authorization-1" client={client} />);

    expect(await screen.findByRole("heading", { name: "Connect Codex to Tabloom" })).toBeInTheDocument();
    rerender(<OAuthConsent authorizationId="authorization-2" client={client} />);
    expect(screen.queryByRole("heading", { name: "Connect Codex to Tabloom" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Connect Another client to Tabloom" })).toBeInTheDocument();

    rerender(<OAuthConsent authorizationId="" client={client} />);
    expect(screen.getByRole("heading", { name: "Authorization request unavailable" })).toBeInTheDocument();
  });

  it("does not redirect after a pending decision becomes stale", async () => {
    const assign = mockLocation();
    const pending = deferred<{ data: { redirect_url: string }; error: null }>();
    const client = signedInOAuthClient(details, "https://client.example/callback?approve=1");
    client.auth.oauth.approveAuthorization.mockImplementation(() => pending.promise);
    const { rerender } = render(<OAuthConsent authorizationId="authorization-1" client={client} />);

    await userEvent.click(await screen.findByRole("button", { name: "Approve access" }));
    rerender(<OAuthConsent authorizationId="authorization-2" client={client} />);
    pending.resolve({ data: { redirect_url: "https://client.example/callback?stale=1" }, error: null });

    expect(await screen.findByRole("heading", { name: "Authorization request unavailable" })).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
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
