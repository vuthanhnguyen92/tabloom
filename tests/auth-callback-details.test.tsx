import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuthCallbackDetails } from "../extension/AuthCallbackDetails";

describe("AuthCallbackDetails", () => {
  it("reveals and copies only the public Firefox callback", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<AuthCallbackDetails target="firefox" callbackUrl="https://firefox.example/auth-callback" />);

    expect(screen.queryByText("https://firefox.example/auth-callback")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show OAuth callback" }));
    expect(screen.getByText("Firefox OAuth callback")).toBeInTheDocument();
    expect(screen.getByText("https://firefox.example/auth-callback")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Copy callback" }));
    expect(writeText).toHaveBeenCalledWith("https://firefox.example/auth-callback");
  });
});
