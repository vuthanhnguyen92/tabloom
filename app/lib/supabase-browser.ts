"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type SupabaseBrowserConfig = {
  url?: string;
  anonKey?: string;
};

const TEMPLATE_VALUE =
  /(?:\$\{[^}]+\}|<[^>]+>|\byour[-_ ]|replace[-_ ]?with|change[-_ ]?me|placeholder)/i;

let client: SupabaseClient | undefined;
let clientConfig: { url: string; anonKey: string } | undefined;

function validConfig(config?: SupabaseBrowserConfig) {
  const url = (config?.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL)?.trim();
  const anonKey = (
    config?.anonKey ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();
  if (!url || !anonKey || TEMPLATE_VALUE.test(url) || TEMPLATE_VALUE.test(anonKey)) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }

  return { url, anonKey };
}

export function getSupabaseBrowserClient(
  config?: SupabaseBrowserConfig,
): SupabaseClient | null {
  const resolved = validConfig(config);
  if (!resolved) return null;
  if (
    client &&
    clientConfig?.url === resolved.url &&
    clientConfig.anonKey === resolved.anonKey
  ) {
    return client;
  }

  client = createClient(resolved.url, resolved.anonKey);
  clientConfig = resolved;
  return client;
}
