import type { OrganizerPreferenceStore } from "../shared/organizer/preferences";
import type { BrowserAdapter } from "./browser/types";
import { extensionCollectionCollapseStore } from "./collection-collapse-preference";
import { extensionSelectedSpaceStore } from "./selected-space-preference";

/** Preserve the extension's existing scoped storage envelopes. */
export function createExtensionPreferenceStore(storage: BrowserAdapter["storage"]): OrganizerPreferenceStore {
  const selected = extensionSelectedSpaceStore(storage);
  const collapsed = extensionCollectionCollapseStore(storage);
  const direct: OrganizerPreferenceStore = {
    async get(key) { const value = (await storage.get(key))[key]; return typeof value === "string" ? value : null; },
    async set(key, value) { await storage.set({ [key]: value }); },
    async remove(key) { await storage.remove(key); },
  };
  const storeFor = (key: string) => key.startsWith("tabloom:selected-space:") ? selected : key.startsWith("tabloom:collapsed-collections:") ? collapsed : direct;
  return {
    get: (key) => storeFor(key).get(key),
    set: (key, value) => storeFor(key).set(key, value),
    remove: (key) => storeFor(key).remove(key),
  };
}
