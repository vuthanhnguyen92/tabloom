import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SyncLoginPrompt } from "../extension/SyncLoginPrompt";
import type { WorkspaceSyncState } from "../extension/workspace-sync-coordinator";

const signedInProps = {
  callbackUrl: "https://stable.chromiumapp.org/auth-callback",
  configured: true,
  onSignIn: vi.fn(async () => undefined),
  onLogout: vi.fn(async () => undefined),
  target: "chromium" as const,
  user: { email: "nick@example.com", user_metadata: { full_name: "Nick Vu" } },
};

describe("SyncLoginPrompt", () => {
  it("offers explicit restoration without starting sign-in automatically", () => {
    const onSignIn = vi.fn(async () => undefined);

    render(<SyncLoginPrompt
      callbackUrl="https://stable.chromiumapp.org/auth-callback"
      configured
      onSignIn={onSignIn}
      recoverySuggested
      target="chromium"
    />);

    expect(screen.getByRole("button", { name: /Reconnect to restore workspace/i })).toBeVisible();
    expect(onSignIn).not.toHaveBeenCalled();
  });

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
      onLogout={vi.fn()}
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

  it("logs out from the signed-in account menu", async () => {
    const onLogout = vi.fn(async () => undefined);
    render(<SyncLoginPrompt
      callbackUrl="https://stable.chromiumapp.org/auth-callback"
      configured
      onSignIn={vi.fn()}
      onLogout={onLogout}
      target="chromium"
      user={{ email: "nick@example.com", user_metadata: {} }}
    />);

    await userEvent.click(screen.getByRole("button", { name: "Open account menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Log out" }));

    await waitFor(() => expect(onLogout).toHaveBeenCalledOnce());
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
  });

  it.each([
    [{ phase: "synced", revision: 3, failed: 0, waiting: 0, lastSyncedAt: new Date().toISOString() }, "Synced", "sync-state-synced"],
    [{ phase: "syncing", activity: "write", revision: 3, failed: 0, waiting: 2 }, "Syncing", "sync-state-syncing"],
    [{ phase: "offline", revision: 3, failed: 0, waiting: 0, error: "Network unavailable" }, "Offline", "sync-state-offline"],
  ] as Array<[WorkspaceSyncState, string, string]>) (
    "shows the %s account sync state",
    async (syncState, label, className) => {
      render(<SyncLoginPrompt {...signedInProps} syncState={syncState} onRetrySync={vi.fn()} />);
      await userEvent.click(screen.getByRole("button", { name: "Open account menu" }));
      expect(screen.getByText(label).closest(".account-sync-status")).toHaveClass(className);
    },
  );

  it("shows failed and waiting counts with an explicit retry action", async () => {
    const onRetrySync = vi.fn(async () => undefined);
    render(<SyncLoginPrompt
      {...signedInProps}
      syncState={{ phase: "failed", revision: 3, failed: 1, waiting: 3, error: "Request timed out" }}
      onRetrySync={onRetrySync}
    />);
    await userEvent.click(screen.getByRole("button", { name: "Open account menu" }));
    expect(screen.getByText("Failed to sync").closest(".account-sync-status")).toHaveClass("sync-state-failed");
    expect(screen.getByText("1 failed · 3 waiting")).toBeInTheDocument();
    expect(screen.getByText("Request timed out")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry sync" }));
    expect(onRetrySync).toHaveBeenCalledOnce();
    const menu = screen.getByRole("menu", { name: "Account" });
    expect(Array.from(menu.children).map((node) => node.className || node.textContent)).toEqual([
      "account-profile",
      expect.stringContaining("account-sync-status"),
      expect.stringContaining("Log out"),
    ]);
  });

  it("does not offer retry while a finite request is active", async () => {
    render(<SyncLoginPrompt
      {...signedInProps}
      syncState={{ phase: "syncing", activity: "write", revision: 3, failed: 0, waiting: 1 }}
      onRetrySync={vi.fn()}
    />);
    await userEvent.click(screen.getByRole("button", { name: "Open account menu" }));
    expect(screen.queryByRole("button", { name: "Retry sync" })).not.toBeInTheDocument();
    expect(screen.getByText("1 change pending")).toBeInTheDocument();
  });
});
