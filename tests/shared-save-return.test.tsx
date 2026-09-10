import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedSaveReturn } from "../app/auth/shared-save/SharedSaveReturn";
import { readPendingSharedSave, writePendingSharedSave } from "../app/lib/shared-save-intent";

const mocks = vi.hoisted(() => ({ getClient: vi.fn(), replace: vi.fn() }));
vi.mock("../app/lib/supabase-browser", () => ({ getSupabaseBrowserClient: mocks.getClient }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
const intent = { token: "a".repeat(43), nonce: "12345678-1234-4234-8234-123456789abc", createdAt: 0 };

function authClient(session: { user: { id: string } } | null = { user: { id: "recipient" } }) {
  const unsubscribe = vi.fn();
  let changed: (event: string, session: unknown) => void = () => undefined;
  const client = { auth: {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    onAuthStateChange: vi.fn((callback) => { changed = callback; return { data: { subscription: { unsubscribe } } }; }),
  } };
  mocks.getClient.mockReturnValue(client);
  return { client, unsubscribe, emit: (value: unknown) => changed("SIGNED_IN", value) };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/auth/shared-save");
  writePendingSharedSave(sessionStorage, { ...intent, createdAt: Date.now() });
});
afterEach(() => { sessionStorage.clear(); window.history.replaceState({}, "", "/"); });

describe("shared save authentication return", () => {
  it("returns an authenticated session to the exact pending share", async () => {
    const { unsubscribe } = authClient();
    const { unmount } = render(<SharedSaveReturn />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(`/s/${intent.token}?resumeSave=${intent.nonce}`));
    expect(readPendingSharedSave(sessionStorage, Date.now())).not.toBeNull();
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not redirect before authentication resolves", async () => {
    const { client, emit } = authClient();
    client.auth.getSession.mockReturnValue(new Promise(() => undefined));
    render(<SharedSaveReturn />);
    expect(screen.getByText("Completing sign-in…")).toBeVisible();
    expect(mocks.replace).not.toHaveBeenCalled();
    act(() => emit({ user: { id: "recipient" } }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledOnce());
  });

  it("shows cancellation and clears the automatic intent even with an old session", async () => {
    authClient();
    window.history.replaceState({}, "", "/auth/shared-save#error=access_denied");
    render(<SharedSaveReturn />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in wasn’t completed");
    expect(screen.getByRole("link", { name: "Back to shared collection" })).toHaveAttribute("href", `/s/${intent.token}`);
    expect(readPendingSharedSave(sessionStorage, Date.now())).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("handles expired or missing intent without trusting a next URL", async () => {
    authClient();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/auth/shared-save?next=https://attacker.test");
    render(<SharedSaveReturn />);
    expect(await screen.findByRole("link", { name: "Go to my workspace" })).toHaveAttribute("href", "/app");
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("clears intent if authentication finishes with no session", async () => {
    authClient(null);
    render(<SharedSaveReturn />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in wasn’t completed");
    expect(readPendingSharedSave(sessionStorage, Date.now())).toBeNull();
  });

  it("surfaces session lookup failures", async () => {
    const { client } = authClient();
    client.auth.getSession.mockRejectedValue(new Error("network error"));
    render(<SharedSaveReturn />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in wasn’t completed");
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("ignores a late session after unmount", async () => {
    const { client, emit } = authClient();
    client.auth.getSession.mockReturnValue(new Promise(() => undefined));
    const { unmount } = render(<SharedSaveReturn />);
    unmount();
    act(() => emit({ user: { id: "recipient" } }));
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
