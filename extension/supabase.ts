import { createClient } from "@supabase/supabase-js";
import { browserAuthStorage } from "./storage";
import { browserAdapter, browserTarget } from "./browser";
import { runExtensionGoogleOAuth } from "./auth/oauth";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const extensionSupabase = url && key && !url.includes("your-project")
  ? createClient(url, key, { auth: { storage: browserAuthStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: "pkce" } })
  : null;

export async function signInExtensionWithGoogle() {
  if (!extensionSupabase) throw new Error("Supabase is not configured.");
  return runExtensionGoogleOAuth(extensionSupabase, browserAdapter.identity, browserTarget);
}
