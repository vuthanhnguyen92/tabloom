import { describe, expect, it, vi } from "vitest";

import type { FacadeAuthConfig } from "../../services/tabloom-mcp/src/auth/config";
import { createTabloomRequestContext } from "../../services/tabloom-mcp/src/auth/request-context";

const SUPABASE_URL = "https://exact-project.supabase.co/";
const USER_ID = "4f6f8607-9439-4ce3-a19e-f5a302ef3e68";
const ATTACKER_USER_ID = "c04ebf62-37cc-4419-9f3a-b4e24f796da9";
const CLIENT_ID = "5c177e69-8954-4c57-a777-07c732513bea";

const config = {
  supabaseUrl: new URL(SUPABASE_URL),
  anonKey: "test-anon-key",
} as FacadeAuthConfig;

describe("request-local RLS context", () => {
  it("creates the Supabase client with only public configuration and a fixed inner-token callback", async () => {
    const supabase = { marker: "request-local" };
    const factory = vi.fn().mockReturnValue(supabase);

    const context = createTabloomRequestContext({
      authenticatedUserId: USER_ID,
      authenticatedClientId: CLIENT_ID,
      innerAccessToken: "inner-token-a",
    }, config, factory as never);

    expect(factory).toHaveBeenCalledWith(SUPABASE_URL, "test-anon-key", {
      accessToken: expect.any(Function),
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
    const options = factory.mock.calls[0]![2];
    await expect(options.accessToken()).resolves.toBe("inner-token-a");
    expect(Object.keys(options).sort()).toEqual(["accessToken", "auth"]);
    expect(context).toEqual({
      userId: USER_ID,
      clientId: CLIENT_ID,
      scope: "tabloom:workspace",
      supabase,
    });
  });

  it("ignores a tool-supplied user ID and keeps the authenticated subject", () => {
    const context = createTabloomRequestContext({
      authenticatedUserId: USER_ID,
      authenticatedClientId: CLIENT_ID,
      innerAccessToken: "inner-token",
      userId: ATTACKER_USER_ID,
    } as never, config, vi.fn().mockReturnValue({}));

    expect(context.userId).toBe(USER_ID);
    expect(context.userId).not.toBe(ATTACKER_USER_ID);
  });

  it("binds distinct request contexts to their own inner token", async () => {
    const options: Array<{ accessToken: () => Promise<string | null> }> = [];
    const factory = vi.fn((_url, _key, clientOptions) => {
      options.push(clientOptions);
      return { request: options.length };
    });

    const first = createTabloomRequestContext({
      authenticatedUserId: USER_ID,
      authenticatedClientId: CLIENT_ID,
      innerAccessToken: "inner-token-a",
    }, config, factory as never);
    const second = createTabloomRequestContext({
      authenticatedUserId: USER_ID,
      authenticatedClientId: CLIENT_ID,
      innerAccessToken: "inner-token-b",
    }, config, factory as never);

    expect(first.supabase).not.toBe(second.supabase);
    await expect(options[0]!.accessToken()).resolves.toBe("inner-token-a");
    await expect(options[1]!.accessToken()).resolves.toBe("inner-token-b");
  });
});
