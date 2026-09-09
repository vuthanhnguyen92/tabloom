import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceBootstrap } from "../app/app/WorkspaceBootstrap";
import { createDemoSnapshot } from "../shared/domain";

const target = "12345678-1234-4234-8234-123456789abc";
const mocks = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock("../app/lib/supabase-browser", () => ({ getSupabaseBrowserClient: mocks.getClient }));
vi.mock("../shared/bookmark-repository", async (importOriginal) => {
  const { MemoryWorkspaceRepository } = await import("../shared/repository");
  return {
  ...await importOriginal<typeof import("../shared/bookmark-repository")>(),
  CombinedWorkspaceRepository: class extends MemoryWorkspaceRepository {
    constructor() {
      const snapshot = createDemoSnapshot();
      snapshot.collections[0].id = target;
      snapshot.collections[0].space_id = snapshot.spaces[1].id;
      super("demo-user", snapshot);
    }
  },
}; });
afterEach(() => { window.history.replaceState({}, "", "/"); });

it("does not reopen the destination when the same user's token refreshes", async () => {
  let onAuth: (event: string, session: { user: { id: string } }) => void = () => undefined;
  const session = { user: { id: "recipient" } };
  mocks.getClient.mockReturnValue({ auth: {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange: (callback: typeof onAuth) => {
      onAuth = callback;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    },
  } });
  window.history.replaceState({}, "", `/app?collection=${target}`);
  render(<WorkspaceBootstrap />);
  await screen.findByRole("heading", { name: "Research" });
  await userEvent.click(screen.getByRole("button", { name: "Product launch" }));
  await userEvent.type(screen.getByLabelText("Search your links"), "figma");
  await act(async () => { onAuth("TOKEN_REFRESHED", { ...session }); });
  expect(screen.getByLabelText("Search your links")).toHaveValue("figma");
  expect(screen.getByRole("button", { name: "Product launch" })).toHaveClass("active");
});
