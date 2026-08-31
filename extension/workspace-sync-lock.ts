import type { StorageArea } from "./workspace-cache";

export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface WorkspaceSyncExclusiveRunner {
  runExclusive<T>(userId: string, task: () => Promise<T>): Promise<T>;
}

type WorkspaceSyncLease = {
  ownerId: string;
  expiresAt: number;
};

export const workspaceSyncLeaseKey = (userId: string) => `tabloom-workspace-sync-lease-v1:${userId}`;

function isLease(value: unknown): value is WorkspaceSyncLease {
  if (!value || typeof value !== "object") return false;
  const lease = value as Partial<WorkspaceSyncLease>;
  return typeof lease.ownerId === "string"
    && lease.ownerId.length > 0
    && typeof lease.expiresAt === "number"
    && Number.isFinite(lease.expiresAt);
}

function defaultLocks(): LockManagerLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { locks?: LockManagerLike }).locks;
}

export class WorkspaceSyncLock implements WorkspaceSyncExclusiveRunner {
  private readonly locks?: LockManagerLike;
  private readonly ownerId: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly waitForLeaseChange?: (key: string, expiresAt: number) => Promise<void>;

  constructor(private readonly input: {
    area: StorageArea;
    locks?: LockManagerLike;
    ownerId?: string;
    now?: () => number;
    leaseMs?: number;
    waitForLeaseChange?: (key: string, expiresAt: number) => Promise<void>;
  }) {
    this.locks = input.locks ?? defaultLocks();
    this.ownerId = input.ownerId ?? crypto.randomUUID();
    this.now = input.now ?? Date.now;
    this.leaseMs = Math.max(100, input.leaseMs ?? 15_000);
    this.waitForLeaseChange = input.waitForLeaseChange;
  }

  runExclusive<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const name = `tabloom-workspace-sync:${userId}`;
    if (this.locks) return this.locks.request(name, task);
    return this.runWithLease(userId, task);
  }

  private async readLease(key: string): Promise<WorkspaceSyncLease | undefined> {
    const value = (await this.input.area.get(key))[key];
    return isLease(value) ? value : undefined;
  }

  private async wait(key: string, expiresAt: number): Promise<void> {
    if (this.waitForLeaseChange) {
      await this.waitForLeaseChange(key, expiresAt);
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, expiresAt - this.now()));
    });
  }

  private async runWithLease<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const key = workspaceSyncLeaseKey(userId);
    const ownerId = `${this.ownerId}:${crypto.randomUUID()}`;

    while (true) {
      const current = await this.readLease(key);
      if (current && current.ownerId !== ownerId && current.expiresAt > this.now()) {
        await this.wait(key, current.expiresAt);
        continue;
      }

      await this.input.area.set({ [key]: { ownerId, expiresAt: this.now() + this.leaseMs } satisfies WorkspaceSyncLease });
      const confirmed = await this.readLease(key);
      if (confirmed?.ownerId !== ownerId) {
        await this.wait(key, confirmed?.expiresAt ?? this.now());
        continue;
      }
      break;
    }

    let stopped = false;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    const renew = async () => {
      if (stopped) return;
      const current = await this.readLease(key);
      if (current?.ownerId !== ownerId) return;
      await this.input.area.set({ [key]: { ownerId, expiresAt: this.now() + this.leaseMs } satisfies WorkspaceSyncLease });
      if (!stopped) renewalTimer = setTimeout(() => void renew(), Math.max(50, Math.floor(this.leaseMs / 2)));
    };
    renewalTimer = setTimeout(() => void renew(), Math.max(50, Math.floor(this.leaseMs / 2)));

    try {
      return await task();
    } finally {
      stopped = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      const current = await this.readLease(key);
      if (current?.ownerId === ownerId) await this.input.area.remove?.(key);
    }
  }
}
