import { createClient } from "@supabase/supabase-js";

export type ValidatedSupabaseSession = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
};

export interface UpstreamSupabaseAuth {
  begin(redirectTo: string): Promise<{ providerUrl: string; codeVerifier: string }>;
  exchange(code: string, codeVerifier: string): Promise<ValidatedSupabaseSession>;
}

export interface SupabaseAuthStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

type SupabaseAuthOptions = {
  auth: {
    flowType: "pkce";
    persistSession: false;
    autoRefreshToken: false;
    detectSessionInUrl: false;
    storageKey: string;
    storage: SupabaseAuthStorage;
  };
};

type SupabaseAuthClient = {
  auth: {
    signInWithOAuth(input: {
      provider: "google";
      options: { redirectTo: string; skipBrowserRedirect: true };
    }): Promise<{ data: { url: string | null }; error: unknown }>;
    exchangeCodeForSession(code: string): Promise<{
      data: Record<string, unknown>;
      error: unknown;
    }>;
    getUser(accessToken: string): Promise<{
      data: Record<string, unknown>;
      error: unknown;
    }>;
  };
};

export type SupabaseAuthClientFactory = (
  url: string,
  anonKey: string,
  options: SupabaseAuthOptions,
) => SupabaseAuthClient;

const STORAGE_KEY = "tabloom-upstream-supabase-auth";
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CREDENTIAL_BYTES = 16 * 1024;

export class UpstreamSupabaseAuthError extends Error {
  constructor() {
    super("Upstream authentication failed");
    this.name = "UpstreamSupabaseAuthError";
  }
}

class InMemoryAuthStorage implements SupabaseAuthStorage {
  private readonly values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

const defaultFactory: SupabaseAuthClientFactory = (url, anonKey, options) => {
  const client = createClient(url, anonKey, options);
  // auth-js intentionally replaces custom storage when persistSession is false.
  // Rebind that private, per-client memory slot so PKCE remains server-local and
  // observable to this adapter without enabling session persistence.
  (client.auth as unknown as { storage: SupabaseAuthStorage }).storage = options.auth.storage;
  return client as unknown as SupabaseAuthClient;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCredential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CREDENTIAL_BYTES;
}

function uuidFrom(value: unknown): string | null {
  if (!isRecord(value) || typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) {
    return null;
  }
  return value.id;
}

function decodeStoredCodeVerifier(value: string | null): string | null {
  if (!value) return null;
  try {
    const decoded: unknown = JSON.parse(value);
    return typeof decoded === "string" && PKCE_VERIFIER_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function fixedHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url : null;
  } catch {
    return null;
  }
}

export class SupabaseUpstreamAuth implements UpstreamSupabaseAuth {
  private readonly supabaseOrigin: string;

  constructor(
    private readonly supabaseUrl: string,
    private readonly anonKey: string,
    private readonly factory: SupabaseAuthClientFactory = defaultFactory,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    const url = fixedHttpsUrl(supabaseUrl);
    if (!url || url.pathname !== "/" || url.search) throw new UpstreamSupabaseAuthError();
    this.supabaseOrigin = url.origin;
  }

  private client(storage: SupabaseAuthStorage): SupabaseAuthClient {
    return this.factory(this.supabaseUrl, this.anonKey, {
      auth: {
        flowType: "pkce",
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: STORAGE_KEY,
        storage,
      },
    });
  }

  async begin(redirectTo: string): Promise<{ providerUrl: string; codeVerifier: string }> {
    const redirect = fixedHttpsUrl(redirectTo);
    if (!redirect || redirect.search) throw new UpstreamSupabaseAuthError();
    const storage = new InMemoryAuthStorage();
    try {
      const result = await this.client(storage).auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo, skipBrowserRedirect: true },
      });
      const codeVerifier = decodeStoredCodeVerifier(
        await storage.getItem(`${STORAGE_KEY}-code-verifier`),
      );
      if (result.error || !result.data?.url || !codeVerifier ||
          !PKCE_VERIFIER_PATTERN.test(codeVerifier)) {
        throw new UpstreamSupabaseAuthError();
      }
      const providerUrl = fixedHttpsUrl(result.data.url);
      if (!providerUrl || providerUrl.origin !== this.supabaseOrigin) {
        throw new UpstreamSupabaseAuthError();
      }
      return { providerUrl: providerUrl.href, codeVerifier };
    } catch {
      throw new UpstreamSupabaseAuthError();
    } finally {
      storage.clear();
    }
  }

  async exchange(code: string, codeVerifier: string): Promise<ValidatedSupabaseSession> {
    if (!isCredential(code) || !PKCE_VERIFIER_PATTERN.test(codeVerifier)) {
      throw new UpstreamSupabaseAuthError();
    }
    const storage = new InMemoryAuthStorage();
    await storage.setItem(`${STORAGE_KEY}-code-verifier`, JSON.stringify(codeVerifier));
    try {
      const client = this.client(storage);
      const exchanged = await client.auth.exchangeCodeForSession(code);
      const session = isRecord(exchanged.data) ? exchanged.data.session : null;
      const outerUserId = isRecord(exchanged.data) ? uuidFrom(exchanged.data.user) : null;
      if (exchanged.error || !isRecord(session)) throw new UpstreamSupabaseAuthError();

      const accessToken = session.access_token;
      const refreshToken = session.refresh_token;
      const expiresAt = session.expires_at;
      const sessionUserId = uuidFrom(session.user);
      if (!isCredential(accessToken) || !isCredential(refreshToken) ||
          !Number.isSafeInteger(expiresAt) || (expiresAt as number) <= this.now() ||
          !outerUserId || !sessionUserId || outerUserId !== sessionUserId) {
        throw new UpstreamSupabaseAuthError();
      }

      const validated = await client.auth.getUser(accessToken);
      const validatedUserId = isRecord(validated.data) ? uuidFrom(validated.data.user) : null;
      if (validated.error || !validatedUserId || validatedUserId !== outerUserId) {
        throw new UpstreamSupabaseAuthError();
      }

      return {
        userId: outerUserId,
        accessToken,
        refreshToken,
        accessTokenExpiresAt: expiresAt as number,
      };
    } catch {
      throw new UpstreamSupabaseAuthError();
    } finally {
      storage.clear();
    }
  }
}

export function createUpstreamSupabaseAuth(config: {
  supabaseUrl: URL;
  anonKey: string;
}): UpstreamSupabaseAuth {
  return new SupabaseUpstreamAuth(config.supabaseUrl.href, config.anonKey);
}
