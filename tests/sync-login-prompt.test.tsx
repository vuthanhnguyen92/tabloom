import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SyncLoginPrompt } from "../extension/SyncLoginPrompt";

describe("SyncLoginPrompt", () => {
  it("opens a login modal without blocking local workspace use when Supabase is unavailable", async () => {
    render(<header style={{ transform: "translateY(0)" }}>
      <SyncLoginPrompt configured={false} onSignIn={vi.fn()} />
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
    render(<SyncLoginPrompt configured onSignIn={onSignIn} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in to sync" }));

    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sync with Tabloom" })).not.toBeInTheDocument());
    expect(onSignIn).toHaveBeenCalledOnce();
  });
});
