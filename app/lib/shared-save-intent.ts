export type PendingSharedSave = { token: string; nonce: string; createdAt: number };
const KEY = "tabloom:pending-shared-save:v1";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function writePendingSharedSave(storage: Storage, intent: PendingSharedSave): void {
  if (!TOKEN.test(intent.token) || !NONCE.test(intent.nonce) || !Number.isSafeInteger(intent.createdAt) || intent.createdAt < 0) throw new Error("Invalid shared save intent");
  storage.setItem(KEY, JSON.stringify(intent));
}
export function clearPendingSharedSave(storage: Storage): void { storage.removeItem(KEY); }
export function readPendingSharedSave(storage: Storage, now: number): PendingSharedSave | null {
  const raw = storage.getItem(KEY);
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { value = null; }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (typeof row.token === "string" && TOKEN.test(row.token) && typeof row.nonce === "string" && NONCE.test(row.nonce) && typeof row.createdAt === "number" && Number.isSafeInteger(row.createdAt) && row.createdAt >= 0 && row.createdAt <= now && now - row.createdAt <= 30 * 60 * 1000) {
      return { token: row.token, nonce: row.nonce, createdAt: row.createdAt };
    }
  }
  clearPendingSharedSave(storage);
  return null;
}
