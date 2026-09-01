import { describe, expect, it, vi } from "vitest";
import { AuthRecoveryPreference } from "../extension/auth/recovery-preference";

function area() {
  const state: Record<string, unknown> = {};
  return {
    state,
    get: vi.fn(async (key: string) => ({ [key]: state[key] })),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(state, value);
    }),
    remove: vi.fn(async (key: string) => {
      delete state[key];
    }),
  };
}

describe("AuthRecoveryPreference", () => {
  it("records pending recovery without credentials", async () => {
    const storage = area();
    const preference = new AuthRecoveryPreference(storage);

    await preference.markPending();

    expect(await preference.read()).toBe("pending");
    expect(JSON.stringify(storage.state)).not.toMatch(/access_token|refresh_token/i);
  });

  it("suppresses automatic recovery after logout until manual sign-in", async () => {
    const storage = area();
    const preference = new AuthRecoveryPreference(storage);

    await preference.suppress();
    expect(await preference.read()).toBe("suppressed");

    await preference.clear();
    expect(await preference.read()).toBeNull();
  });
});
