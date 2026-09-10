import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "../shared/domain";
import { WorkspaceBootstrap } from "../app/app/WorkspaceBootstrap";

const transport = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock("../app/lib/supabase-browser", () => ({ getSupabaseBrowserClient: () => transport.client }));

function session(id: string): Session {
  return { access_token: `access-${id}`, refresh_token: `refresh-${id}`, expires_in: 3600, token_type: "bearer", user: { id, email: `${id}@example.com`, app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: "2026-01-01" } };
}

function clientFixture(initial: Session | null, delayed = false) {
  let current = initial;
  let listener!: (event: string, value: Session | null) => void;
  let resolve!: (value: { data: { session: Session | null } }) => void;
  const unsubscribe = vi.fn();
  const signInWithOAuth = vi.fn(async () => ({ data: {}, error: null }));
  const signOut = vi.fn(async () => { current = null; listener("SIGNED_OUT", null); return { error: null }; });
  const client = {
    auth: {
      getSession: vi.fn(() => delayed ? new Promise((done) => { resolve = done; }) : Promise.resolve({ data: { session: current } })),
      onAuthStateChange: vi.fn((callback) => { listener = callback; return { data: { subscription: { unsubscribe } } }; }),
      signInWithOAuth, signOut,
    },
    from: (table: string) => {
      const snapshot = createDemoSnapshot(current?.user.id);
      const rows = table === "spaces" ? snapshot.spaces : table === "collections" ? snapshot.collections : table === "links" ? snapshot.links : [];
      const query = { select: () => query, order: () => query, eq: () => query, then: (done: (result: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(done) };
      return query;
    },
  };
  transport.client = client as unknown as SupabaseClient;
  return { client, signInWithOAuth, signOut, unsubscribe, resolveInitial: (value: Session | null) => resolve({ data: { session: value } }), emit: (value: Session | null) => { current = value; listener(value ? "SIGNED_IN" : "SIGNED_OUT", value); } };
}

beforeEach(() => { localStorage.clear(); transport.client = null; });

describe("web session bootstrap", () => {
  it("keeps the Google OAuth return route and signed-out gate", async () => {
    const fixture = clientFixture(null);
    render(<WorkspaceBootstrap />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect(fixture.signInWithOAuth).toHaveBeenCalledWith({ provider: "google", options: { redirectTo: `${window.location.origin}/app` } });
    expect(screen.queryByTestId("shared-workspace-organizer")).toBeNull();
  });

  it("loads the authenticated repository with scoped preferences and signs out through account actions", async () => {
    const fixture = clientFixture(session("alice"));
    localStorage.setItem("tabloom:selected-space:account:alice", "space-research");
    const view = render(<WorkspaceBootstrap />);
    expect(await screen.findByRole("heading", { name: "Research" })).toBeVisible();
    expect(screen.getByText("Synced")).toBeVisible();
    await userEvent.click(screen.getByLabelText("Account"));
    expect(screen.getByText("alice@example.com")).toBeVisible();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeVisible();
    expect(fixture.signOut).toHaveBeenCalledOnce();
    view.unmount();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not let an older initial session overwrite a newer auth event", async () => {
    const fixture = clientFixture(null, true);
    render(<WorkspaceBootstrap />);
    await act(async () => fixture.emit(session("bob")));
    expect(await screen.findByTestId("shared-workspace-organizer")).toBeVisible();
    await act(async () => fixture.resolveInitial(null));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull());
    await userEvent.click(screen.getByLabelText("Account"));
    expect(screen.getByText("bob@example.com")).toBeVisible();
  });
});
