export interface OrganizerPreferenceStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type DomStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function createWebPreferenceStore(storage: DomStorage): OrganizerPreferenceStore {
  return {
    async get(key) { return storage.getItem(key); },
    async set(key, value) { storage.setItem(key, value); },
    async remove(key) { storage.removeItem(key); },
  };
}

type SpaceIdentity = string | { id: string };

function spaceId(space: SpaceIdentity): string {
  return typeof space === "string" ? space : space.id;
}

function selectedSpaceKey(scope: string): string {
  return `tabloom:selected-space:${scope}`;
}

function collapsedCollectionsKey(scope: string): string {
  return `tabloom:collapsed-collections:${scope}`;
}

function parseCollapsed(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export class SelectedSpacePreference {
  private readonly selected = new Map<string, string>();

  constructor(private readonly store: OrganizerPreferenceStore) {}

  async select(scope: string, selectedSpaceId: string): Promise<void> {
    this.selected.set(scope, selectedSpaceId);
    await this.store.set(selectedSpaceKey(scope), selectedSpaceId);
  }

  async load(scope: string, spaces: readonly SpaceIdentity[]): Promise<string> {
    const key = selectedSpaceKey(scope);
    const stored = await this.store.get(key);
    const preferred = this.selected.get(scope) ?? stored ?? "";
    const available = spaces.map(spaceId);
    const resolved = available.includes(preferred) ? preferred : available[0] ?? "";
    this.selected.set(scope, resolved);
    if (stored !== resolved) await this.store.set(key, resolved);
    return resolved;
  }

  reconcile(scope: string, spaces: readonly SpaceIdentity[]): Promise<string> {
    return this.load(scope, spaces);
  }
}

export class CollectionCollapsePreference {
  private readonly stored = new Map<string, Promise<string[]>>();

  constructor(private readonly store: OrganizerPreferenceStore) {}

  async setCollapsed(scope: string, collectionId: string, collapsed: boolean): Promise<void> {
    const previous = await this.read(scope);
    const next = new Set(previous);
    if (collapsed) next.add(collectionId);
    else next.delete(collectionId);
    const sorted = [...next].sort();
    this.stored.set(scope, Promise.resolve(sorted));
    await this.store.set(collapsedCollectionsKey(scope), JSON.stringify(sorted));
  }

  async load(scope: string, collectionIds: readonly string[]): Promise<Set<string>> {
    const previous = await this.read(scope);
    const available = new Set(collectionIds);
    const next = previous.filter((id) => available.has(id));
    if (next.length !== previous.length) {
      this.stored.set(scope, Promise.resolve(next));
      await this.store.set(collapsedCollectionsKey(scope), JSON.stringify(next));
    }
    return new Set(next);
  }

  reconcile(scope: string, collectionIds: readonly string[]): Promise<Set<string>> {
    return this.load(scope, collectionIds);
  }

  private read(scope: string): Promise<string[]> {
    const stored = this.stored.get(scope) ?? this.store.get(collapsedCollectionsKey(scope)).then(parseCollapsed);
    this.stored.set(scope, stored);
    return stored;
  }
}
