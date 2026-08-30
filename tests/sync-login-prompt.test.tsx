import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SyncLoginPrompt } from "../extension/SyncLoginPrompt";
import type { SyncEngineState } from "../extension/workspace-sync-engine";

const signedInProps = {
  callbackUrl: "https://stable.chromiumapp.org/auth-callback",
  configured: true,
  onSignIn: vi.fn(async () => undefined),
  onSwitchAccount: vi.fn(async () => undefined),
  target: "chromium" as const,
  user: { email: "nick@example.com", user_metadata: { full_name: "Nick Vu" } },
};

describe("SyncLoginPrompt", () => {
  it("opens a login modal without blocking local workspace use when Supabase is unavailable", async () => {
    render(<header style={{ transform: "translateY(0)" }}>
      <SyncLoginPrompt callbackUrl="https://stable.chromiumapp.org/auth-callback" configured={false} onSignIn={vi.fn()} target="chromium" />
    </header>);

    await userEvent.click(screen.getByRole("button", { name: "Sign in to sync" }));

    expect(screen.getByRole("dialog", { name: "Sync with Tabloom" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Sync with Tabloom" }).closest("header")).toBeNull();
    expect(screen.getByText(/local workspace stays available on this browser/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeDisabled();
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
  });

  it("runs the configured login flow and closes after success", async () => {
    const onSignIn = vi.fn(async () => undefined);
    render(<SyncLoginPrompt callbackUrl="https://stable.chromiumapp.org/auth-callback" configured onSignIn={onSignIn} target="chromium" />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in to sync" }));

    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sync with Tabloom" })).not.toBeInTheDocument());
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("shows the signed-in account details instead of the sign-in prompt", async () => {
    render(<SyncLoginPrompt
      callbackUrl="https://stable.chromiumapp.org/auth-callback"
      configured
      onSignIn={vi.fn()}
      onSwitchAccount={vi.fn()}
      target="chromium"
      user={{
        email: "nick@example.com",
        user_metadata: {
          avatar_url: "https://example.com/nick.png",
          full_name: "Nick Vu",
        },
      }}
    />);

    const accountTrigger = screen.getByRole("button", { name: "Open account menu" });
    await userEvent.click(accountTrigger);

    expect(screen.getByRole("menu", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByText("Nick Vu")).toBeInTheDocument();
    expect(screen.getByText("nick@example.com")).toBeInTheDocument();
    expect(accountTrigger.querySelector(".lucide-user-round")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in to sync" })).not.toBeInTheDocument();
  });

  it("switches accounts from the signed-in account menu", async () => {
    const onSwitchAccount = vi.fn(async () => undefined);
    render(<SyncLoginPrompt
      callbackUrl="https://stable.chromiumapp.org/auth-callback"
      configured
      onSignIn={vi.fn()}
      onSwitchAccount={onSwitchAccount}
      target="chromium"
      user={{ email: "nick@example.com", user_metadata: {} }}
    />);

    await userEvent.click(screen.getByRole("button", { name: "Open account menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Switch account" }));

    await waitFor(() => expect(onSwitchAccount).toHaveBeenCalledOnce());
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
  });

  it.each([
    [{ phase: "synced", revision: 3, pending: 0, lastSyncedAt: new Date().toISOString() }, "Synced", "sync-state-synced"],
    [{ phase: "syncing", revision: 3, pending: 2 }, "Syncing", "sync-state-syncing"],
    [{ phase: "offline", revision: 3, pending: 3 }, "Offline", "sync-state-offline"],
  ] as Array<[SyncEngineState, string, string]>) (
    "shows the %s account sync state",
    async (syncState, label, className) => {
      render(<SyncLoginPrompt {...signedInProps} syncState={syncState} onSyncNow={vi.fn()} />);
      await userEvent.click(screen.getByRole("button", { name: "Open account menu" }));
      expect(screen.getByText(label).closest(".account-sync-status")).toHaveClass(className);
      expect(screen.getByRole("button", { name: "Sync now" })).toHaveAttribute("title", "Sync now");
    },
  );

  it("shows pending offline work and keeps profile, status, then switch account order", async () => {
    render(<SyncLoginPrompt
      {...signedInProps}
      syncState={{ phase: "offline", revision: 3, pending: 3 }}
      onSyncNow={vi.fn()}
    />);
    await userEvent.click(screen.getByRole("button", { name: "Open account menu" }));
    expect(screen.getByText("3 changes waiting to sync")).toBeInTheDocument();
    const menu = screen.getByRole("menu", { name: "Account" });
    expect(Array.from(menu.children).map((node) => node.className || node.textContent)).toEqual([
      "account-profile",
      expect.stringContaining("account-sync-status"),
      expect.stringContaining("Switch account"),
    ]);
  });

  it("runs manual sync once and animates refresh only while syncing", async () => {
    const onSyncNow = vi.fn(async () => undefined);
    const { rerender } = render(<SyncLoginPrompt
      {...signedInProps}
      syncState={{ phase: "synced", revision: 3, pending: 0, lastSyncedAt: new Date().toISOString() }}
      onSyncNow={onSyncNow}
    />);
    await userEvent.click(screen.getByRole("button", { name: "Open account menu" }));
    const syncButton = screen.getByRole("button", { name: "Sync now" });
    expect(syncButton.querySelector(".lucide-refresh-cw")).not.toHaveClass("is-spinning");
    await userEvent.click(syncButton);
    expect(onSyncNow).toHaveBeenCalledOnce();

    rerender(<SyncLoginPrompt
      {...signedInProps}
      syncState={{ phase: "syncing", revision: 3, pending: 1 }}
      onSyncNow={onSyncNow}
    />);
    expect(screen.getByRole("button", { name: "Sync now" }).querySelector(".lucide-refresh-cw")).toHaveClass("is-spinning");
  });
});
