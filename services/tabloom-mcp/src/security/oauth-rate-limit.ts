import { createHash } from "node:crypto";
import { isIP } from "node:net";

export type OAuthRateLimitedRoute = "register" | "authorize" | "token" | "revoke";

export interface OAuthRateLimitStorage {
  increment(key: string, windowStartMs: number, expiresAtMs: number): Promise<number>;
}

type Entry = { count: number; expiresAtMs: number };

/** Best-effort, per-process abuse damping. Durable replay and revocation remain authoritative. */
export class InMemoryOAuthRateLimitStorage implements OAuthRateLimitStorage {
  private readonly entries = new Map<string, Entry>();
  private lastSweepWindowStartMs = -1;

  async increment(key: string, windowStartMs: number, expiresAtMs: number): Promise<number> {
    if (windowStartMs !== this.lastSweepWindowStartMs) {
      for (const [storedKey, entry] of this.entries) {
        if (entry.expiresAtMs <= windowStartMs) this.entries.delete(storedKey);
      }
      this.lastSweepWindowStartMs = windowStartMs;
    }
    const existing = this.entries.get(key);
    if (!existing || existing.expiresAtMs <= windowStartMs) {
      this.entries.set(key, { count: 1, expiresAtMs });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }
}

const WINDOW_MS = 60_000;
const LIMITS: Record<OAuthRateLimitedRoute, number> = {
  register: 20,
  authorize: 30,
  token: 30,
  revoke: 60,
};
const defaultStorage = new InMemoryOAuthRateLimitStorage();

export function trustedVercelClientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const first = forwarded.split(",", 1)[0]?.trim() ?? "";
  return isIP(first) === 0 ? null : first;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function checkOAuthRateLimit(input: {
  route: OAuthRateLimitedRoute;
  request: Request;
  clientId?: string;
  storage?: OAuthRateLimitStorage;
  nowMs?: number;
}): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const nowMs = input.nowMs ?? Date.now();
  const windowStartMs = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  const expiresAtMs = windowStartMs + WINDOW_MS;
  const identity = input.route === "token"
    ? `client:${hash(input.clientId ?? "unknown")}`
    : `ip:${hash(trustedVercelClientIp(input.request.headers) ?? "unknown")}`;
  const key = `${input.route}:${windowStartMs}:${identity}`;
  let count: number;
  try {
    count = await (input.storage ?? defaultStorage).increment(key, windowStartMs, expiresAtMs);
  } catch {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (count <= LIMITS[input.route]) return { allowed: true, retryAfterSeconds: 0 };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1_000)),
  };
}
