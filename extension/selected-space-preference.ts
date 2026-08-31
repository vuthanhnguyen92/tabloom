import type { BrowserAdapter } from "./browser/types";

type SpaceIdentity = { id: string };
type Selections = Record<string, string>;

const STORAGE_KEY = "tabloom:selected-spaces:v1";

function parseSelections(value: unknown): Selections {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export class SelectedSpacePreference {
  private readonly selected = new Map<string, string>();
  private stored: Promise<Selections> | null = null;

  constructor(private readonly storage: BrowserAdapter["storage"]) {}

  async select(scope: string, spaceId: string): Promise<void> {
    this.selected.set(scope, spaceId);
    const selections = await this.load();
    selections[scope] = this.selected.get(scope) ?? spaceId;
    await this.storage.set({ [STORAGE_KEY]: selections });
  }

  async reconcile(scope: string, spaces: SpaceIdentity[]): Promise<string> {
    const selections = await this.load();
    const preferred = this.selected.get(scope) ?? selections[scope] ?? "";
    const resolved = spaces.some((space) => space.id === preferred) ? preferred : spaces[0]?.id ?? "";
    this.selected.set(scope, resolved);
    if (selections[scope] !== resolved) {
      selections[scope] = resolved;
      await this.storage.set({ [STORAGE_KEY]: selections });
    }
    return resolved;
  }

  private load(): Promise<Selections> {
    this.stored ??= this.storage.get(STORAGE_KEY).then((result) => parseSelections(result[STORAGE_KEY]));
    return this.stored;
  }
}
