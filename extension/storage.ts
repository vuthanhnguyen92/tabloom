import type { WorkspaceSnapshot } from "../shared/domain";

const SNAPSHOT_KEY = "tabloom-workspace-snapshot";

type StorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
};

export class ChromeSnapshotCache {
  constructor(private readonly area: StorageArea = chrome.storage.local) {}
  async read(): Promise<WorkspaceSnapshot | null> {
    const result = await this.area.get(SNAPSHOT_KEY);
    return (result[SNAPSHOT_KEY] as WorkspaceSnapshot | undefined) ?? null;
  }
  async write(snapshot: WorkspaceSnapshot): Promise<void> {
    await this.area.set({ [SNAPSHOT_KEY]: snapshot });
  }
}

export const chromeAuthStorage = {
  async getItem(key: string) {
    const result = await chrome.storage.local.get(key);
    return typeof result[key] === "string" ? result[key] : null;
  },
  async setItem(key: string, value: string) { await chrome.storage.local.set({ [key]: value }); },
  async removeItem(key: string) { await chrome.storage.local.remove(key); },
};
