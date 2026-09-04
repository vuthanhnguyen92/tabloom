import type { SharedCollectionSnapshot } from "../../shared/collection-sharing";
import { isSaveableUrl } from "../../shared/domain";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SNAPSHOT_KEYS = ["links", "name"];
const LINK_KEYS = ["description", "favicon_url", "id", "position", "title", "url"];

export class SharedCollectionUnavailableError extends Error {
  constructor() {
    super("This shared collection is unavailable.");
    this.name = "SharedCollectionUnavailableError";
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isPublicUrl(value: unknown): value is string {
  return typeof value === "string" && isSaveableUrl(value);
}

function parseSnapshot(value: unknown): SharedCollectionSnapshot | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SharedCollectionUnavailableError();
  const snapshot = value as Record<string, unknown>;
  if (!hasExactKeys(snapshot, SNAPSHOT_KEYS) || typeof snapshot.name !== "string" || !snapshot.name.trim() || !Array.isArray(snapshot.links)) {
    throw new SharedCollectionUnavailableError();
  }

  const links = snapshot.links.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SharedCollectionUnavailableError();
    const link = value as Record<string, unknown>;
    if (
      !hasExactKeys(link, LINK_KEYS)
      || typeof link.id !== "string"
      || !link.id
      || typeof link.title !== "string"
      || !link.title.trim()
      || typeof link.description !== "string"
      || !isPublicUrl(link.url)
      || (link.favicon_url !== null && !isPublicUrl(link.favicon_url))
      || typeof link.position !== "number"
      || !Number.isSafeInteger(link.position)
      || link.position < 0
    ) throw new SharedCollectionUnavailableError();
    return {
      id: link.id,
      title: link.title,
      description: link.description,
      url: link.url,
      favicon_url: link.favicon_url,
      position: link.position,
    };
  });

  links.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  return { name: snapshot.name, links };
}

export async function loadSharedCollection(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<SharedCollectionSnapshot | null> {
  try {
    if (!TOKEN_PATTERN.test(token)) throw new SharedCollectionUnavailableError();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
    if (!supabaseUrl || !anonKey) throw new SharedCollectionUnavailableError();

    const endpoint = new URL("/rest/v1/rpc/load_shared_collection", supabaseUrl).toString();
    const response = await fetcher(endpoint, {
      method: "POST",
      cache: "no-store",
      headers: {
        apikey: anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ share_token: token }),
    });
    if (!response.ok) throw new SharedCollectionUnavailableError();
    return parseSnapshot(await response.json());
  } catch {
    throw new SharedCollectionUnavailableError();
  }
}
