const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readCollectionTarget(search: string): string | null {
  const values = new URLSearchParams(search).getAll("collection");
  return values.length === 1 && UUID.test(values[0]) ? values[0].toLowerCase() : null;
}

export function workspaceCollectionPath(collectionId: string | null): string {
  return collectionId && UUID.test(collectionId)
    ? `/app?collection=${encodeURIComponent(collectionId.toLowerCase())}`
    : "/app";
}
