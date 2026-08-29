import { createClient } from "@supabase/supabase-js";

import type { FacadeAuthConfig } from "./config";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SupabaseUserResult = {
  data: { user: { id: string } | null };
  error: unknown;
};

export type SupabaseUserValidationClient = {
  auth: {
    getUser(accessToken: string): Promise<SupabaseUserResult>;
  };
};

type SupabaseUserValidationOptions = {
  auth: {
    autoRefreshToken: false;
    detectSessionInUrl: false;
    persistSession: false;
  };
};

export type SupabaseUserValidationClientFactory = (
  url: string,
  anonKey: string,
  options: SupabaseUserValidationOptions,
) => SupabaseUserValidationClient;

const createValidationClient: SupabaseUserValidationClientFactory = (
  url,
  anonKey,
  options,
) => createClient(url, anonKey, options) as SupabaseUserValidationClient;

export function createSupabaseTokenVerifier(
  config: Pick<FacadeAuthConfig, "supabaseUrl" | "anonKey">,
  factory: SupabaseUserValidationClientFactory = createValidationClient,
) {
  const client = factory(config.supabaseUrl.href, config.anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  return async function verifySupabaseToken(
    innerAccessToken: string,
  ): Promise<string | undefined> {
    try {
      const result = await client.auth.getUser(innerAccessToken);
      const userId = result.data.user?.id;
      if (result.error || typeof userId !== "string" || !UUID_PATTERN.test(userId)) {
        return undefined;
      }
      return userId;
    } catch {
      return undefined;
    }
  };
}
