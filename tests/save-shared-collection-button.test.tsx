import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SaveSharedCollectionButton } from "../app/s/[token]/SaveSharedCollectionButton";
import { writePendingSharedSave } from "../app/lib/shared-save-intent";
const mocks = vi.hoisted(() => ({ client: vi.fn(), rpc: vi.fn(), session: vi.fn(), oauth: vi.fn(), unsubscribe: vi.fn(), authChange: null as null | ((event: string, session: unknown) => void) }));
vi.mock("../app/lib/supabase-browser", () => ({ getSupabaseBrowserClient: mocks.client }));
const token = "a".repeat(43);
const collectionId = "11111111-1111-4111-8111-111111111111";
const spaceId = "22222222-2222-4222-8222-222222222222";
const signedIn = { user: { id: "recipient" } };
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); window.history.replaceState(null, "", `/s/${token}`);
  mocks.session.mockResolvedValue({ data: { session: signedIn }, error: null });
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name.startsWith("get_") ? { status: "available" } : { status: "created", collectionId, spaceId }, error: null }));
  mocks.oauth.mockResolvedValue({ error: null });
  mocks.client.mockReturnValue({ rpc: mocks.rpc, auth: { getSession: mocks.session, signInWithOAuth: mocks.oauth, onAuthStateChange: (cb: typeof mocks.authChange) => { mocks.authChange = cb; return { data: { subscription: { unsubscribe: mocks.unsubscribe } } }; } } });
});
describe("shared save action", () => {
  it("saves in one click and links to the confirmed destination", async () => {
    render(<SaveSharedCollectionButton token={token} />);
    await userEvent.click(await screen.findByRole("button", { name: "Save to my collections" }));
    expect(await screen.findByText("Saved to your collections")).toBeVisible();
    expect(screen.getByRole("link", { name: "View collection" })).toHaveAttribute("href", `/app?collection=${collectionId}`);
  });
  it.each([["saved", "View saved collection"], ["owned", "Open my collection"]])("renders initial %s", async (status, label) => {
    mocks.rpc.mockResolvedValue({ data: { status, collectionId, spaceId }, error: null });
    render(<SaveSharedCollectionButton token={token} />);
    expect(await screen.findByRole("link", { name: label })).toHaveAttribute("href", `/app?collection=${collectionId}`);
  });
  it("prompts signed-out visitors and persists OAuth intent", async () => {
    mocks.session.mockResolvedValue({ data: { session: null }, error: null });
    render(<SaveSharedCollectionButton token={token} />);
    const button = await screen.findByRole("button", { name: "Save to my collections" });
    await userEvent.click(button);
    expect(screen.getByRole("dialog")).toHaveTextContent("Changes to the original won’t update your copy.");
    await userEvent.keyboard("{Escape}"); expect(button).toHaveFocus();
    await userEvent.click(button); await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(mocks.oauth).toHaveBeenCalledWith({ provider: "google", options: { redirectTo: `${window.location.origin}/auth/shared-save` } });
    expect(JSON.parse(sessionStorage.getItem("tabloom:pending-shared-save:v1")!).token).toBe(token);
  });
  it("disables during a pending save", async () => {
    render(<SaveSharedCollectionButton token={token} />);
    await screen.findByRole("button", { name: "Save to my collections" });
    mocks.rpc.mockReturnValue(new Promise(() => {}));
    await userEvent.click(screen.getByRole("button", { name: "Save to my collections" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });
  it("reports revoked shares", async () => {
    render(<SaveSharedCollectionButton token={token} />);
    await screen.findByRole("button", { name: "Save to my collections" });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "private SQL" } });
    await userEvent.click(screen.getByRole("button", { name: "Save to my collections" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This shared collection is no longer available.");
  });
  it("retries uncertain failures explicitly", async () => {
    render(<SaveSharedCollectionButton token={token} />);
    await screen.findByRole("button", { name: "Save to my collections" });
    mocks.rpc.mockRejectedValueOnce(new Error("network"));
    await userEvent.click(screen.getByRole("button", { name: "Save to my collections" }));
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Saved to your collections")).toBeVisible();
  });
  it("reports configuration failures", async () => {
    mocks.client.mockReturnValue(null); render(<SaveSharedCollectionButton token={token} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Saving is unavailable");
  });
  it("resumes once only with matching intent and signed-in session", async () => {
    const nonce = "33333333-3333-4333-8333-333333333333";
    writePendingSharedSave(sessionStorage, { token, nonce, createdAt: Date.now() });
    window.history.replaceState(null, "", `/s/${token}?resumeSave=${nonce}`);
    render(<SaveSharedCollectionButton token={token} />);
    await screen.findByText("Saved to your collections");
    act(() => mocks.authChange?.("TOKEN_REFRESHED", signedIn));
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "save_shared_collection")).toHaveLength(1);
    expect(sessionStorage.getItem("tabloom:pending-shared-save:v1")).toBeNull();
    expect(window.location.search).toBe("");
  });
  it("does not resume from a bare query", async () => {
    window.history.replaceState(null, "", `/s/${token}?resumeSave=33333333-3333-4333-8333-333333333333`);
    render(<SaveSharedCollectionButton token={token} />);
    await screen.findByRole("button", { name: "Save to my collections" });
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "save_shared_collection")).toHaveLength(0);
  });
  it("ignores an old account response after sign-out", async () => {
    let finish!: (value: unknown) => void;
    render(<SaveSharedCollectionButton token={token} />);
    await screen.findByRole("button", { name: "Save to my collections" });
    mocks.rpc.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await userEvent.click(screen.getByRole("button", { name: "Save to my collections" }));
    act(() => mocks.authChange?.("SIGNED_OUT", null));
    await act(async () => finish({ data: { status: "created", collectionId, spaceId }, error: null }));
    expect(screen.queryByRole("link", { name: "View collection" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save to my collections" })).toBeEnabled());
  });
  it("retries a failed status request without saving", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("network"));
    render(<SaveSharedCollectionButton token={token} />);
    await userEvent.click(await screen.findByRole("button", { name: "Retry status checking" }));
    expect(await screen.findByRole("button", { name: "Save to my collections" })).toBeEnabled();
    expect(mocks.rpc.mock.calls.every(([name]) => name === "get_shared_collection_save_state")).toBe(true);
  });
  it("opens sign-in after an expired-session save", async () => {
    render(<SaveSharedCollectionButton token={token} />);
    await screen.findByRole("button", { name: "Save to my collections" });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "28000", message: "expired" } });
    await userEvent.click(screen.getByRole("button", { name: "Save to my collections" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
  });
  it("clears intent when OAuth initiation fails", async () => {
    mocks.session.mockResolvedValue({ data: { session: null }, error: null });
    mocks.oauth.mockResolvedValueOnce({ error: new Error("failed") });
    render(<SaveSharedCollectionButton token={token} />);
    await userEvent.click(await screen.findByRole("button", { name: "Save to my collections" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t start sign-in");
    expect(sessionStorage.getItem("tabloom:pending-shared-save:v1")).toBeNull();
  });
  it.each(["different-token", "different-nonce", "expired", "signed-out"])("does not resume %s intent", async scenario => {
    const nonce = "33333333-3333-4333-8333-333333333333";
    writePendingSharedSave(sessionStorage, { token: scenario === "different-token" ? "b".repeat(43) : token, nonce, createdAt: Date.now() - (scenario === "expired" ? 31 * 60 * 1000 : 0) });
    window.history.replaceState(null, "", `/s/${token}?resumeSave=${scenario === "different-nonce" ? "44444444-4444-4444-8444-444444444444" : nonce}`);
    if (scenario === "signed-out") mocks.session.mockResolvedValue({ data: { session: null }, error: null });
    render(<SaveSharedCollectionButton token={token} />);
    await screen.findByRole("button", { name: "Save to my collections" });
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "save_shared_collection")).toHaveLength(0);
  });
  it("retains uncertain resume intent and waits for explicit retry", async () => {
    const nonce = "33333333-3333-4333-8333-333333333333";
    writePendingSharedSave(sessionStorage, { token, nonce, createdAt: Date.now() });
    window.history.replaceState(null, "", `/s/${token}?resumeSave=${nonce}`);
    mocks.rpc.mockRejectedValueOnce(new Error("network"));
    render(<StrictMode><SaveSharedCollectionButton token={token} /></StrictMode>);
    await screen.findByRole("button", { name: "Retry" });
    act(() => mocks.authChange?.("TOKEN_REFRESHED", signedIn));
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "save_shared_collection")).toHaveLength(1);
    expect(sessionStorage.getItem("tabloom:pending-shared-save:v1")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Saved to your collections")).toBeVisible();
  });
  it("contains keyboard focus in the sign-in dialog", async () => {
    mocks.session.mockResolvedValue({ data: { session: null }, error: null });
    render(<SaveSharedCollectionButton token={token} />);
    await userEvent.click(await screen.findByRole("button", { name: "Save to my collections" }));
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Continue with Google" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();
  });

});
