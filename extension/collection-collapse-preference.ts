import type { BrowserAdapter } from "./browser/types";
import {
  CollectionCollapsePreference as SharedCollectionCollapsePreference,
  type OrganizerPreferenceStore,
} from "../shared/organizer/preferences";

const STORAGE_KEY = "tabloom:collapsed-collections:v1";
const KEY_PREFIX = "tabloom:collapsed-collections:";

function parseCollapsedByScope(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([scope, ids]) =>
    Array.isArray(ids) ? [[scope, ids.filter((id): id is string => typeof id === "string")]] : [],
  ));
}

export function extensionCollectionCollapseStore(storage: BrowserAdapter["storage"]): OrganizerPreferenceStore {
  let loaded: Promise<Record<string, string[]>> | null = null;
  const collapsed = () => loaded ??= storage.get(STORAGE_KEY).then((result) => parseCollapsedByScope(result[STORAGE_KEY]));
  const scopeFor = (key: string) => key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : key;
  return {
    async get(key) {
      const value = (await collapsed())[scopeFor(key)];
      return value ? JSON.stringify(value) : null;
    },
    async set(key, value) {
      const next = await collapsed();
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = [];
      }
      next[scopeFor(key)] = Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [];
      await storage.set({ [STORAGE_KEY]: next });
    },
    async remove(key) {
      const next = await collapsed();
      delete next[scopeFor(key)];
      await storage.set({ [STORAGE_KEY]: next });
    },
  };
}

export class CollectionCollapsePreference extends SharedCollectionCollapsePreference {
  constructor(storage: BrowserAdapter["storage"]) {
    super(extensionCollectionCollapseStore(storage));
  }
}
