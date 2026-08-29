import { createWebExtensionAdapter } from "./webextension";
import type { WebExtensionNamespace } from "./types";

const SAFARI_CALLBACK_URL = "tabloom://auth-callback";

function withTimeout<T>(operation: Promise<T>, milliseconds: number) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Safari sign-in timed out.")), milliseconds);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function createSafariAdapter(api: WebExtensionNamespace, { timeoutMs = 300_000 } = {}) {
  const adapter = createWebExtensionAdapter("safari", api);

  return {
    ...adapter,
    capabilities: { ...adapter.capabilities, identity: Boolean(api.runtime?.sendNativeMessage) },
    identity: {
      getRedirectURL() {
        return SAFARI_CALLBACK_URL;
      },
      async launchWebAuthFlow(details: { url: string; interactive: boolean }) {
        const sendNativeMessage = api.runtime?.sendNativeMessage;
        if (!sendNativeMessage) {
          throw new Error("Safari does not provide the native bridge required for sign-in.");
        }

        const response = await withTimeout(
          sendNativeMessage("app.tabloom.mac", {
            type: "tabloom.oauth.start",
            authorizationUrl: details.url,
            callbackScheme: "tabloom",
          }),
          timeoutMs,
        );
        if (response.type === "tabloom.oauth.result") return response.callbackUrl;
        if (response.type === "tabloom.oauth.cancelled") return undefined;
        if (response.type === "tabloom.oauth.error") throw new Error("Safari could not complete Google sign-in.");
        throw new Error("Safari returned an invalid sign-in response.");
      },
    },
  };
}
