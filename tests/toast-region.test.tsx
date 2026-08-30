import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastRegion } from "../extension/ToastRegion";

function MessageHarness() {
  const [message, setMessage] = useState("Task deleted");
  return <ToastRegion error="" message={message} onDismissError={() => undefined} onDismissMessage={() => setMessage("")} />;
}

function ErrorHarness() {
  const [error, setError] = useState("Could not delete task");
  return <ToastRegion error={error} message="" onDismissError={() => setError("")} onDismissMessage={() => undefined} />;
}

describe("ToastRegion", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a compact status toast for three seconds", () => {
    vi.useFakeTimers();
    render(<MessageHarness />);

    expect(screen.getByRole("status")).toHaveTextContent("Task deleted");
    act(() => vi.advanceTimersByTime(2_999));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("uses the same timed toast surface for errors and still allows dismissal", () => {
    vi.useFakeTimers();
    render(<ErrorHarness />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not delete task");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
