import type { BrowserAdapter } from "./browser/types";

type CollapsedByScope = Record<string, string[]>;

const STORAGE_KEY = "tabloom:collapsed-collections:v1";

function parseCollapsedByScope(value: unknown): CollapsedByScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([scope, ids]) =>
    Array.isArray(ids) ? [[scope, ids.filter((id): id is string => typeof id === "string")]] : [],
  ));
}

export class CollectionCollapsePreference {
  private stored: Promise<CollapsedByScope> | null = null;

  constructor(private readonly storage: BrowserAdapter["storage"]) {}

  async setCollapsed(scope: string, collectionId: string, collapsed: boolean): Promise<void> {
    const stored = await this.load();
    const next = new Set(stored[scope] ?? []);
    if (collapsed) next.add(collectionId);
    else next.delete(collectionId);
    stored[scope] = [...next].sort();
    await this.storage.set({ [STORAGE_KEY]: stored });
  }

  async reconcile(scope: string, collectionIds: string[]): Promise<Set<string>> {
    const stored = await this.load();
    const available = new Set(collectionIds);
    const previous = stored[scope] ?? [];
    const next = previous.filter((id) => available.has(id));
    if (next.length !== previous.length) {
      stored[scope] = next;
      await this.storage.set({ [STORAGE_KEY]: stored });
    }
    return new Set(next);
  }

  private load(): Promise<CollapsedByScope> {
    this.stored ??= this.storage.get(STORAGE_KEY).then((result) => parseCollapsedByScope(result[STORAGE_KEY]));
    return this.stored;
  }
}
