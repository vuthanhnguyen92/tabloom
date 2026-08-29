import { describe, expect, it, vi } from "vitest";
import { extensionSupabase } from "../extension/supabase";

vi.mock("../extension/storage", () => ({
  browserAuthStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock("../extension/browser", () => ({
  browserAdapter: { identity: {} },
  browserTarget: "chromium",
}));

describe("extension Supabase client", () => {
  it("uses PKCE so browser identity callbacks contain an authorization code", () => {
    expect(extensionSupabase).not.toBeNull();
    expect((extensionSupabase!.auth as unknown as { flowType: string }).flowType).toBe("pkce");
  });
});
