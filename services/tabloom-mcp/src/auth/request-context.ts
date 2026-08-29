import {
  createClient,
  type SupabaseClient,
  type SupabaseClientOptions,
} from "@supabase/supabase-js";

import type { FacadeAuthConfig } from "./config";

export type TabloomRequestContext = {
  userId: string;
  clientId: string;
  scope: "tabloom:workspace";
  supabase: SupabaseClient;
};

export type AuthenticatedContextInput = {
  authenticatedUserId: string;
  authenticatedClientId: string;
  innerAccessToken: string;
};

export type RequestSupabaseClientFactory = (
  url: string,
  anonKey: string,
  options: SupabaseClientOptions<"public">,
) => SupabaseClient;

const createRequestSupabaseClient: RequestSupabaseClientFactory = (
  url,
  anonKey,
  options,
) => createClient(url, anonKey, options);

export function createTabloomRequestContext(
  input: AuthenticatedContextInput,
  config: Pick<FacadeAuthConfig, "supabaseUrl" | "anonKey">,
  factory: RequestSupabaseClientFactory = createRequestSupabaseClient,
): TabloomRequestContext {
  const innerAccessToken = input.innerAccessToken;
  const supabase = factory(config.supabaseUrl.href, config.anonKey, {
    accessToken: async () => innerAccessToken,
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  return {
    userId: input.authenticatedUserId,
    clientId: input.authenticatedClientId,
    scope: "tabloom:workspace",
    supabase,
  };
}
