import type { BrowserAdapter, BrowserTarget } from "../browser/types";

export type ExtensionOAuthErrorCode =
  | "cancelled"
  | "timeout"
  | "redirect_not_allowed"
  | "provider_error"
  | "platform_unavailable"
  | "invalid_callback";

export class ExtensionOAuthError extends Error {
  constructor(
    readonly code: ExtensionOAuthErrorCode,
    message: string,
    readonly expectedRedirectUrl?: string,
  ) {
    super(message);
    this.name = "ExtensionOAuthError";
  }
}

type OAuthIdentity = Pick<BrowserAdapter["identity"], "getRedirectURL" | "launchWebAuthFlow">;

export type ExtensionOAuthSession = {
  user: {
    id: string;
    email?: string;
    user_metadata?: {
      avatar_url?: string;
      full_name?: string;
      name?: string;
      picture?: string;
    };
  };
};

export type ExtensionOAuthClient = {
  auth: {
    signInWithOAuth(input: {
      provider: "google";
      options: {
        redirectTo: string;
        skipBrowserRedirect: true;
        queryParams?: { prompt: "select_account" };
      };
    }): Promise<{ data: { url: string | null }; error: Error | null }>;
    exchangeCodeForSession(code: string): Promise<{
      data: { session: ExtensionOAuthSession | null };
      error: Error | null;
    }>;
  };
};

export function callbackForTarget(target: BrowserTarget, identity: Pick<OAuthIdentity, "getRedirectURL">) {
  return target === "safari" ? "tabloom://auth-callback" : identity.getRedirectURL("auth-callback");
}

function callbackIdentity(value: string) {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function callbackParameters(url: URL) {
  const parameters = new URLSearchParams(url.search);
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  for (const [key, value] of fragment) if (!parameters.has(key)) parameters.set(key, value);
  return parameters;
}

export function parseOAuthCallback(responseUrl: string, expectedRedirectUrl: string) {
  let response: URL;
  try {
    response = new URL(responseUrl);
  } catch {
    throw new ExtensionOAuthError("invalid_callback", "The authentication callback URL was invalid.");
  }

  if (callbackIdentity(response.href) !== callbackIdentity(expectedRedirectUrl)) {
    throw new ExtensionOAuthError(
      "redirect_not_allowed",
      `Authentication returned to the wrong page. Add ${expectedRedirectUrl} to Supabase Auth redirect URLs.`,
      expectedRedirectUrl,
    );
  }

  const parameters = callbackParameters(response);
  if (parameters.has("error")) {
    throw new ExtensionOAuthError("provider_error", "Google sign-in was not completed.");
  }

  const code = parameters.get("code");
  if (!code) throw new ExtensionOAuthError("invalid_callback", "The authentication callback did not include a code.");
  return code;
}

function normalizeLaunchError(reason: unknown, expectedRedirectUrl: string): ExtensionOAuthError {
  const message = reason instanceof Error ? reason.message.toLowerCase() : "";
  if (message.includes("could not be loaded")) {
    return new ExtensionOAuthError(
      "redirect_not_allowed",
      `Authentication could not return to Tabloom. Add ${expectedRedirectUrl} to Supabase Auth redirect URLs.`,
      expectedRedirectUrl,
    );
  }
  if (message.includes("cancel") || message.includes("approve")) {
    return new ExtensionOAuthError("cancelled", "Google sign-in was cancelled.");
  }
  if (message.includes("timed out") || message.includes("timeout")) {
    return new ExtensionOAuthError("timeout", "Google sign-in timed out. Please retry.");
  }
  return new ExtensionOAuthError("platform_unavailable", "This browser could not start Google sign-in.");
}

export async function runExtensionGoogleOAuth(
  client: ExtensionOAuthClient,
  identity: OAuthIdentity,
  target: BrowserTarget,
  options: { selectAccount?: boolean } = {},
) {
  const redirectTo = callbackForTarget(target, identity);
  const started = await client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo,
      skipBrowserRedirect: true,
      ...(options.selectAccount ? { queryParams: { prompt: "select_account" as const } } : {}),
    },
  });
  if (started.error || !started.data.url) {
    throw new ExtensionOAuthError("provider_error", "Could not start Google sign-in.");
  }

  let responseUrl: string | undefined;
  try {
    responseUrl = await identity.launchWebAuthFlow({ url: started.data.url, interactive: true });
  } catch (reason) {
    throw normalizeLaunchError(reason, redirectTo);
  }
  if (!responseUrl) throw new ExtensionOAuthError("cancelled", "Google sign-in was cancelled.");

  const code = parseOAuthCallback(responseUrl, redirectTo);
  const exchanged = await client.auth.exchangeCodeForSession(code);
  if (exchanged.error || !exchanged.data.session) {
    throw new ExtensionOAuthError("provider_error", "Could not finish Google sign-in.");
  }
  return exchanged.data.session;
}
