import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useOnlineStatus } from "../extension/online-status";

describe("useOnlineStatus", () => {
  it("reacts to browser offline and online events", () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);

    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    act(() => window.dispatchEvent(new Event("offline")));
    expect(result.current).toBe(false);

    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    act(() => window.dispatchEvent(new Event("online")));
    expect(result.current).toBe(true);
  });
});
