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
  const workspaces = new Map<string, ReturnType<typeof createDemoSnapshot>>();
  const removed = new Map<string, ReturnType<typeof createDemoSnapshot>>();
  const receipts = new Map<string, object>();
  let loseDeleteResponse = false;
  function workspace() {
    const owner = current?.user.id ?? "signed-out";
    if (!workspaces.has(owner)) {
      const snapshot = createDemoSnapshot(owner);
      snapshot.links[0].id = "50000000-0000-4000-8000-000000000001";
      workspaces.set(owner, snapshot);
    }
    return workspaces.get(owner)!;
  }
  let listener!: (event: string, value: Session | null) => void;
  let resolve!: (value: { data: { session: Session | null } }) => void;
  const unsubscribe = vi.fn();
  const signInWithOAuth = vi.fn(async () => ({ data: {}, error: null }));
  const signOut = vi.fn(async () => { current = null; listener("SIGNED_OUT", null); return { error: null }; });
  const rpc = vi.fn(async (name: string, args: Record<string, string>) => {
    if (name === "load_workspace_snapshot") return { data: { revision: 3, snapshot: workspace() }, error: null };
    if (name === "trash_workspace_entity") {
      const previous = receipts.get(args.p_operation_id);
      if (previous) return { data: previous, error: null };
      const snapshot = workspace();
      const trashId = "60000000-0000-4000-8000-000000000001";
      removed.set(trashId, structuredClone(snapshot));
      snapshot.links = snapshot.links.filter((link) => link.id !== args.p_root_id);
      const data = { operationId: args.p_operation_id, trashId, rootType: "link", rootId: args.p_root_id, restoreUntil: "2099-01-01T00:00:00Z" };
      receipts.set(args.p_operation_id, data);
      if (loseDeleteResponse) { loseDeleteResponse = false; throw new Error("Response lost after commit"); }
      return { data, error: null };
    }
    if (name === "restore_workspace_trash") {
      workspaces.set(current!.user.id, removed.get(args.p_trash_id)!);
      return { data: { status: "restored", trashId: args.p_trash_id, rootType: "link", rootId: "50000000-0000-4000-8000-000000000001", revision: 3 }, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  });
  const client = {
    rpc,
    auth: {
      getSession: vi.fn(() => delayed ? new Promise((done) => { resolve = done; }) : Promise.resolve({ data: { session: current } })),
      onAuthStateChange: vi.fn((callback) => { listener = callback; return { data: { subscription: { unsubscribe } } }; }),
      signInWithOAuth, signOut,
    },
    from: vi.fn((table: string) => {
      const snapshot = workspace();
      const rows = table === "spaces" ? snapshot.spaces : table === "collections" ? snapshot.collections : table === "links" ? snapshot.links : [];
      const query = { select: () => query, order: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: null }), then: (done: (result: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(done) };
      return query;
    }),
  };
  transport.client = client as unknown as SupabaseClient;
  return { client, signInWithOAuth, signOut, unsubscribe, loseNextDeleteResponse: () => { loseDeleteResponse = true; }, resolveInitial: (value: Session | null) => resolve({ data: { session: value } }), emit: (value: Session | null, event = value ? "SIGNED_IN" : "SIGNED_OUT") => { current = value; listener(event, value); } };
}

beforeEach(() => { localStorage.clear(); transport.client = null; });

describe("web session bootstrap", () => {
  it("retains a pending delete operation and its Undo receipt across refocus/token refresh", async () => {
    const fixture = clientFixture(session("alice"));
    fixture.loseNextDeleteResponse();
    render(<WorkspaceBootstrap />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Product roadmap" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Changes could not be saved");
    await act(async () => fixture.emit(session("alice"), "SIGNED_IN"));
    await userEvent.click(screen.getByRole("button", { name: "Delete Product roadmap" }));
    const attempts = fixture.client.rpc.mock.calls.filter(([name]) => name === "trash_workspace_entity");
    expect(attempts).toHaveLength(2);
    expect(attempts[1][1].p_operation_id).toBe(attempts[0][1].p_operation_id);
    expect(await screen.findByRole("button", { name: "Undo" })).toBeVisible();
    await act(async () => fixture.emit(session("alice"), "TOKEN_REFRESHED"));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Product roadmap")).toBeVisible();
    expect(fixture.client.rpc.mock.calls.filter(([name]) => name === "restore_workspace_trash")).toEqual([["restore_workspace_trash", { p_trash_id: "60000000-0000-4000-8000-000000000001", p_destination_id: null }]]);
  });

  it("keeps an open share dialog and its repository stable through token refresh", async () => {
    const fixture = clientFixture(session("alice"));
    render(<WorkspaceBootstrap />);
    await userEvent.click(await screen.findByRole("button", { name: "Share Plan" }));
    const dialog = await screen.findByRole("dialog", { name: "Share Plan" });
    await waitFor(() => expect(fixture.client.from.mock.calls.filter(([name]) => name === "collection_shares")).toHaveLength(1));
    await act(async () => fixture.emit(session("alice"), "TOKEN_REFRESHED"));
    expect(screen.getByRole("dialog", { name: "Share Plan" })).toBe(dialog);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(fixture.client.from.mock.calls.filter(([name]) => name === "collection_shares")).toHaveLength(1);
  });

  it.each(["SIGNED_IN", "TOKEN_REFRESHED", "SIGNED_IN after refocus"])("keeps in-progress forms and search through same-user %s", async (event) => {
    const fixture = clientFixture(session("alice"));
    render(<WorkspaceBootstrap />);
    await userEvent.click(await screen.findByRole("button", { name: "New collection" }));
    await userEvent.type(screen.getByLabelText("Name"), "Unfinished idea");
    await act(async () => fixture.emit(session("alice"), event.startsWith("SIGNED_IN") ? "SIGNED_IN" : event));
    expect(screen.getByLabelText("Name")).toHaveValue("Unfinished idea");
    expect(screen.getByLabelText("Name")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Search all links" }));
    await userEvent.type(screen.getByRole("searchbox"), "roadmap");
    await act(async () => fixture.emit(session("alice"), event.startsWith("SIGNED_IN") ? "SIGNED_IN" : event));
    expect(screen.getByRole("searchbox")).toHaveValue("roadmap");
    expect(screen.getByRole("link", { name: "Product roadmap, Product launch, Plan" })).toBeVisible();
  });

  it("switches identities on account/client changes and ignores stale client completions", async () => {
    const first = clientFixture(session("alice"));
    localStorage.setItem("tabloom:selected-space:account:bob", "space-research");
    const view = render(<WorkspaceBootstrap />);
    await userEvent.click(await screen.findByRole("button", { name: "New collection" }));
    await act(async () => first.emit(session("bob")));
    expect(await screen.findByRole("heading", { name: "Research" })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    const delayed = clientFixture(null, true);
    view.rerender(<WorkspaceBootstrap />);
    expect(screen.queryByTestId("shared-workspace-organizer")).toBeNull();
    const final = clientFixture(session("carol"));
    view.rerender(<WorkspaceBootstrap />);
    expect(await screen.findByTestId("shared-workspace-organizer")).toBeVisible();
    await act(async () => { delayed.resolveInitial(session("alice")); first.emit(session("alice")); });
    await userEvent.click(screen.getByLabelText("Account"));
    expect(screen.getByText("carol@example.com")).toBeVisible();
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    expect(delayed.unsubscribe).toHaveBeenCalledOnce();
    view.unmount();
    expect(final.unsubscribe).toHaveBeenCalledOnce();
  });

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
    expect(screen.getByText("Synced")).not.toBeVisible();
    await userEvent.click(screen.getByLabelText("Account"));
    expect(screen.getByText("Synced")).toBeVisible();
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
