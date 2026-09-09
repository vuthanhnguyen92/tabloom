import type { BrowserAdapter } from "./browser/types";
import {
  SelectedSpacePreference as SharedSelectedSpacePreference,
  type OrganizerPreferenceStore,
} from "../shared/organizer/preferences";

const STORAGE_KEY = "tabloom:selected-spaces:v1";
const KEY_PREFIX = "tabloom:selected-space:";

function parseSelections(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function extensionSelectedSpaceStore(storage: BrowserAdapter["storage"]): OrganizerPreferenceStore {
  let loaded: Promise<Record<string, string>> | null = null;
  const selections = () => loaded ??= storage.get(STORAGE_KEY).then((result) => parseSelections(result[STORAGE_KEY]));
  const scopeFor = (key: string) => key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : key;
  return {
    async get(key) {
      return (await selections())[scopeFor(key)] ?? null;
    },
    async set(key, value) {
      const next = await selections();
      next[scopeFor(key)] = value;
      await storage.set({ [STORAGE_KEY]: next });
    },
    async remove(key) {
      const next = await selections();
      delete next[scopeFor(key)];
      await storage.set({ [STORAGE_KEY]: next });
    },
  };
}

export class SelectedSpacePreference extends SharedSelectedSpacePreference {
  constructor(storage: BrowserAdapter["storage"]) {
    super(extensionSelectedSpaceStore(storage));
  }
}
