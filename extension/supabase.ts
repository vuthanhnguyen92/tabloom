import { createClient } from "@supabase/supabase-js";
import { chromeAuthStorage } from "./storage";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const extensionSupabase = url && key && !url.includes("your-project")
  ? createClient(url, key, { auth: { storage: chromeAuthStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } })
  : null;

export async function signInExtensionWithGoogle() {
  if (!extensionSupabase) throw new Error("Supabase is not configured.");
  const redirectTo = chrome.identity.getRedirectURL("auth-callback");
  const { data, error } = await extensionSupabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo, skipBrowserRedirect: true } });
  if (error || !data.url) throw error ?? new Error("Could not start Google sign-in.");
  const responseUrl = await chrome.identity.launchWebAuthFlow({ url: data.url, interactive: true });
  if (!responseUrl) throw new Error("Google sign-in was cancelled.");
  const code = new URL(responseUrl).searchParams.get("code");
  if (!code) throw new Error("The sign-in callback did not include a code.");
  const result = await extensionSupabase.auth.exchangeCodeForSession(code);
  if (result.error) throw result.error;
  return result.data.session;
}
