import { describe, expect, it, vi } from "vitest";
import {
  ExtensionOAuthError,
  callbackForTarget,
  isSilentOAuthMiss,
  parseOAuthCallback,
  runExtensionGoogleOAuth,
} from "../extension/auth/oauth";

function client({ authorizationUrl = "https://accounts.example/authorize", session = { user: { id: "user-1" } } } = {}) {
  return {
    auth: {
      signInWithOAuth: vi.fn(async () => ({ data: { provider: "google", url: authorizationUrl }, error: null })),
      exchangeCodeForSession: vi.fn(async () => ({ data: { session, user: session.user }, error: null })),
    },
  };
}

describe("extension OAuth", () => {
  it("uses browser callbacks for Chromium and Firefox and the native scheme for Safari", () => {
    const identity = {
      getRedirectURL: vi.fn((path = "") => `https://stable-id.chromiumapp.org/${path}`),
    };

    expect(callbackForTarget("chromium", identity)).toBe("https://stable-id.chromiumapp.org/auth-callback");
    expect(callbackForTarget("firefox", identity)).toBe("https://stable-id.chromiumapp.org/auth-callback");
    expect(callbackForTarget("safari", identity)).toBe("tabloom://auth-callback");
  });

  it("returns a code only for the exact callback protocol, host, and path", () => {
    const expected = "https://stable-id.chromiumapp.org/auth-callback";

    expect(parseOAuthCallback(`${expected}?code=abc`, expected)).toBe("abc");
    expect(() => parseOAuthCallback("https://attacker.example/auth-callback?code=abc", expected))
      .toThrowError(ExtensionOAuthError);
    expect(() => parseOAuthCallback("https://stable-id.chromiumapp.org/other?code=abc", expected))
      .toThrowError(ExtensionOAuthError);
  });

  it("turns provider errors into a safe message without query values", () => {
    const expected = "tabloom://auth-callback";

    expect(() => parseOAuthCallback(`${expected}?error=access_denied&error_description=sensitive-provider-detail`, expected))
      .toThrow("Google sign-in was not completed.");
    try {
      parseOAuthCallback(`${expected}?error=access_denied&error_description=sensitive-provider-detail`, expected);
    } catch (reason) {
      expect(String(reason)).not.toContain("sensitive-provider-detail");
    }
  });

  it("does not exchange a session when the browser flow is cancelled", async () => {
    const supabase = client();
    const identity = {
      getRedirectURL: () => "https://stable-id.chromiumapp.org/auth-callback",
      launchWebAuthFlow: vi.fn(async () => undefined),
    };

    await expect(runExtensionGoogleOAuth(supabase, identity, "chromium"))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("turns Chrome's generic load failure into an actionable redirect error", async () => {
    const expected = "https://stable-id.chromiumapp.org/auth-callback";
    const supabase = client();
    const identity = {
      getRedirectURL: () => expected,
      launchWebAuthFlow: vi.fn(async () => { throw new Error("Authorization page could not be loaded."); }),
    };

    await expect(runExtensionGoogleOAuth(supabase, identity, "chromium"))
      .rejects.toMatchObject({ code: "redirect_not_allowed", expectedRedirectUrl: expected });
    expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("exchanges a validated code and returns the resulting session", async () => {
    const expected = "https://stable-id.chromiumapp.org/auth-callback";
    const supabase = client();
    const identity = {
      getRedirectURL: () => expected,
      launchWebAuthFlow: vi.fn(async () => `${expected}?code=valid-code`),
    };

    const session = await runExtensionGoogleOAuth(supabase, identity, "chromium");

    expect(session.user.id).toBe("user-1");
    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith("valid-code");
  });

  it("forces Google's account chooser when switching accounts", async () => {
    const expected = "https://stable-id.chromiumapp.org/auth-callback";
    const supabase = client();
    const identity = {
      getRedirectURL: () => expected,
      launchWebAuthFlow: vi.fn(async () => `${expected}?code=valid-code`),
    };

    await runExtensionGoogleOAuth(supabase, identity, "chromium", { selectAccount: true });

    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        queryParams: { prompt: "select_account" },
        redirectTo: expected,
        skipBrowserRedirect: true,
      },
    });
  });

  it("uses prompt none and a hidden browser flow for silent recovery", async () => {
    const expected = "https://stable-id.chromiumapp.org/auth-callback";
    const supabase = client();
    const identity = {
      getRedirectURL: () => expected,
      launchWebAuthFlow: vi.fn(async () => `${expected}?code=silent-code`),
    };

    await runExtensionGoogleOAuth(supabase, identity, "chromium", {
      interactive: false,
    });

    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        queryParams: { prompt: "none" },
        redirectTo: expected,
        skipBrowserRedirect: true,
      },
    });
    expect(identity.launchWebAuthFlow).toHaveBeenCalledWith({
      url: "https://accounts.example/authorize",
      interactive: false,
    });
  });

  it("classifies a provider login requirement as a silent recovery miss", () => {
    const expected = "https://stable-id.chromiumapp.org/auth-callback";

    try {
      parseOAuthCallback(`${expected}?error=login_required`, expected);
      throw new Error("Expected the callback to fail.");
    } catch (reason) {
      expect(isSilentOAuthMiss(reason)).toBe(true);
    }
  });
});
