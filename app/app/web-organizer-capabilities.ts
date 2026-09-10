import type { OrganizerCapabilities } from "../../shared/organizer/capabilities";

export const webOrganizerCapabilities: OrganizerCapabilities = {
  async openLink({ url, newTab }) {
    if (newTab) window.open(url, "_blank", "noopener,noreferrer");
    else window.location.assign(url);
  },
  async openCollection(_name, urls) {
    // Keep all opens in the initiating user gesture; yielding between tabs can lose activation.
    for (const url of urls) window.open(url, "_blank", "noopener,noreferrer");
  },
  async resolveFavicon(_url, source) { return source ?? null; },
};
