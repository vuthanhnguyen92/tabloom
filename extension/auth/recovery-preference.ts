import type { BrowserAdapter } from "../browser/types";

const AUTH_RECOVERY_KEY = "tabloom-auth-recovery-v1";

type StorageArea = BrowserAdapter["storage"];

export type AuthRecoveryState = "pending" | "suppressed" | null;

export class AuthRecoveryPreference {
  constructor(private readonly area: StorageArea) {}

  async read(): Promise<AuthRecoveryState> {
    const value = (await this.area.get(AUTH_RECOVERY_KEY))[AUTH_RECOVERY_KEY];
    return value === "pending" || value === "suppressed" ? value : null;
  }

  async markPending(): Promise<void> {
    await this.area.set({ [AUTH_RECOVERY_KEY]: "pending" });
  }

  async suppress(): Promise<void> {
    await this.area.set({ [AUTH_RECOVERY_KEY]: "suppressed" });
  }

  async clear(): Promise<void> {
    await this.area.remove(AUTH_RECOVERY_KEY);
  }
}
