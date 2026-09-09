import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPendingSharedSave, readPendingSharedSave, writePendingSharedSave } from "../app/lib/shared-save-intent";
const key = "tabloom:pending-shared-save:v1";
const intent = { token: "a".repeat(43), nonce: "11111111-1111-4111-8111-111111111111", createdAt: 10000 };
beforeEach(() => sessionStorage.clear());
describe("pending shared save", () => {
  it("round trips and removes", () => {
    writePendingSharedSave(sessionStorage, intent);
    expect(readPendingSharedSave(sessionStorage, 10001)).toEqual(intent);
    clearPendingSharedSave(sessionStorage);
    expect(readPendingSharedSave(sessionStorage, 10001)).toBeNull();
  });
  it.each([{ ...intent, token: "bad" }, { ...intent, nonce: "bad" }, { ...intent, createdAt: 10002 }, { ...intent, createdAt: -2000000 }, { ...intent, createdAt: "10000" }, null])("removes invalid intent %j", value => {
    sessionStorage.setItem(key, JSON.stringify(value));
    expect(readPendingSharedSave(sessionStorage, 10001)).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it("removes malformed JSON", () => {
    sessionStorage.setItem(key, "{");
    expect(readPendingSharedSave(sessionStorage, 10001)).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it("surfaces storage failure", () => {
    const storage = { getItem: vi.fn(() => { throw new Error("blocked"); }) } as unknown as Storage;
    expect(() => readPendingSharedSave(storage, 10001)).toThrow("blocked");
  });
  it("surfaces write and removal failures", () => {
    const storage = { setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(() => writePendingSharedSave(storage, intent)).toThrow("blocked");
    expect(() => clearPendingSharedSave(storage)).toThrow("blocked");
  });

});
