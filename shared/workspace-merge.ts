import type {
  Collection,
  SavedLink,
  Space,
  WorkspaceSnapshot,
} from "./domain";
import { isSaveableUrl, normalizeUrlForDuplicate } from "./domain";

export type VersionedWorkspaceSnapshot = {
  snapshot: WorkspaceSnapshot;
  revision: number;
};

export type WorkspaceIdentityMap = {
  spaces: Record<string, string>;
  collections: Record<string, string>;
  links: Record<string, string>;
};

export type WorkspaceMergeSummary = {
  addedSpaces: number;
  addedCollections: number;
  addedLinks: number;
  matchedSpaces: number;
  matchedCollections: number;
  matchedLinksById: number;
  matchedLinksByUrl: number;
  remappedIds: number;
  skippedUnsupportedLinks: number;
};

export type WorkspaceMergePlan = {
  expectedRevision: number;
  merged: WorkspaceSnapshot;
  identityMap: WorkspaceIdentityMap;
  summary: WorkspaceMergeSummary;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeWorkspaceName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function isEffectivelyEmptyLocalWorkspace(
  snapshot: WorkspaceSnapshot,
): boolean {
  if (
    snapshot.spaces.length === 0 &&
    snapshot.collections.length === 0 &&
    snapshot.links.length === 0
  ) {
    return true;
  }
  if (
    snapshot.spaces.length !== 1 ||
    snapshot.collections.length !== 1 ||
    snapshot.links.length !== 0
  ) {
    return false;
  }
  const [onlySpace] = snapshot.spaces;
  const [onlyCollection] = snapshot.collections;
  return (
    normalizeWorkspaceName(onlySpace.name) === "my space" &&
    normalizeWorkspaceName(onlyCollection.name) === "my collection" &&
    onlyCollection.space_id === onlySpace.id
  );
}

export function isEmptyCloudWorkspace(snapshot: WorkspaceSnapshot): boolean {
  return (
    snapshot.spaces.length === 0 &&
    snapshot.collections.length === 0 &&
    snapshot.links.length === 0
  );
}

function stableOrder<T extends { position: number; created_at: string; id: string }>(
  rows: T[],
): T[] {
  return [...rows].sort(
    (left, right) =>
      left.position - right.position ||
      left.created_at.localeCompare(right.created_at) ||
      left.id.localeCompare(right.id),
  );
}

function nextPosition(rows: Array<{ position: number }>): number {
  return rows.reduce((maximum, row) => Math.max(maximum, row.position), -1) + 1;
}

function chooseId(
  requestedId: string,
  usedIds: Set<string>,
  summary: WorkspaceMergeSummary,
): string {
  if (UUID_PATTERN.test(requestedId) && !usedIds.has(requestedId)) {
    usedIds.add(requestedId);
    return requestedId;
  }
  let generated = crypto.randomUUID();
  while (usedIds.has(generated)) generated = crypto.randomUUID();
  usedIds.add(generated);
  summary.remappedIds += 1;
  return generated;
}

function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

export function planWorkspaceMerge(
  local: WorkspaceSnapshot,
  cloud: WorkspaceSnapshot,
  expectedRevision: number,
): WorkspaceMergePlan {
  const merged: WorkspaceSnapshot = {
    spaces: stableOrder(cloud.spaces).map((row) => ({ ...row })),
    collections: stableOrder(cloud.collections).map((row) => ({ ...row })),
    links: stableOrder(cloud.links).map((row) => ({ ...row })),
  };
  const identityMap: WorkspaceIdentityMap = {
    spaces: {},
    collections: {},
    links: {},
  };
  const summary: WorkspaceMergeSummary = {
    addedSpaces: 0,
    addedCollections: 0,
    addedLinks: 0,
    matchedSpaces: 0,
    matchedCollections: 0,
    matchedLinksById: 0,
    matchedLinksByUrl: 0,
    remappedIds: 0,
    skippedUnsupportedLinks: 0,
  };
  const cloudUserId =
    merged.spaces[0]?.user_id ??
    merged.collections[0]?.user_id ??
    merged.links[0]?.user_id ??
    local.spaces[0]?.user_id ??
    local.collections[0]?.user_id ??
    local.links[0]?.user_id ??
    "";

  const usedSpaceIds = new Set(merged.spaces.map((row) => row.id));
  for (const localSpace of stableOrder(local.spaces)) {
    const sameId = merged.spaces.find((row) => row.id === localSpace.id);
    const idMatch =
      sameId &&
      normalizeWorkspaceName(sameId.name) ===
        normalizeWorkspaceName(localSpace.name)
        ? sameId
        : undefined;
    const nameMatch = merged.spaces.find(
      (row) =>
        normalizeWorkspaceName(row.name) ===
        normalizeWorkspaceName(localSpace.name),
    );
    const match = idMatch ?? nameMatch;
    if (match) {
      identityMap.spaces[localSpace.id] = match.id;
      summary.matchedSpaces += 1;
      continue;
    }

    const id = chooseId(localSpace.id, usedSpaceIds, summary);
    identityMap.spaces[localSpace.id] = id;
    merged.spaces.push({
      ...localSpace,
      id,
      user_id: cloudUserId,
      position: nextPosition(merged.spaces),
    });
    summary.addedSpaces += 1;
  }

  const usedCollectionIds = new Set(merged.collections.map((row) => row.id));
  for (const localCollection of stableOrder(local.collections)) {
    const targetSpaceId = identityMap.spaces[localCollection.space_id];
    if (!targetSpaceId) continue;
    const sameId = merged.collections.find(
      (row) => row.id === localCollection.id,
    );
    const idMatch =
      sameId &&
      sameId.space_id === targetSpaceId &&
      normalizeWorkspaceName(sameId.name) ===
        normalizeWorkspaceName(localCollection.name)
        ? sameId
        : undefined;
    const nameMatch = merged.collections.find(
      (row) =>
        row.space_id === targetSpaceId &&
        normalizeWorkspaceName(row.name) ===
          normalizeWorkspaceName(localCollection.name),
    );
    const match = idMatch ?? nameMatch;
    if (match) {
      identityMap.collections[localCollection.id] = match.id;
      summary.matchedCollections += 1;
      continue;
    }

    const siblings = merged.collections.filter(
      (row) => row.space_id === targetSpaceId,
    );
    const id = chooseId(localCollection.id, usedCollectionIds, summary);
    identityMap.collections[localCollection.id] = id;
    merged.collections.push({
      ...localCollection,
      id,
      user_id: cloudUserId,
      space_id: targetSpaceId,
      position: nextPosition(siblings),
    });
    summary.addedCollections += 1;
  }

  const usedLinkIds = new Set(merged.links.map((row) => row.id));
  for (const localLink of stableOrder(local.links)) {
    if (!isSaveableUrl(localLink.url)) {
      summary.skippedUnsupportedLinks += 1;
      continue;
    }
    const targetCollectionId = identityMap.collections[localLink.collection_id];
    if (!targetCollectionId) continue;

    const idMatch = merged.links.find((row) => row.id === localLink.id);
    const normalizedUrl = normalizeUrlForDuplicate(localLink.url);
    const urlMatch = idMatch
      ? undefined
      : merged.links.find(
          (row) =>
            row.collection_id === targetCollectionId &&
            normalizeUrlForDuplicate(row.url) === normalizedUrl,
        );
    const match = idMatch ?? urlMatch;
    if (match) {
      identityMap.links[localLink.id] = match.id;
      if (idMatch) summary.matchedLinksById += 1;
      else summary.matchedLinksByUrl += 1;
      if (isBlank(match.title) && !isBlank(localLink.title)) {
        match.title = localLink.title;
      }
      if (isBlank(match.description) && !isBlank(localLink.description)) {
        match.description = localLink.description;
      }
      if (isBlank(match.favicon_url) && !isBlank(localLink.favicon_url)) {
        match.favicon_url = localLink.favicon_url;
      }
      continue;
    }

    const siblings = merged.links.filter(
      (row) => row.collection_id === targetCollectionId,
    );
    const id = chooseId(localLink.id, usedLinkIds, summary);
    identityMap.links[localLink.id] = id;
    merged.links.push({
      ...localLink,
      id,
      user_id: cloudUserId,
      collection_id: targetCollectionId,
      position: nextPosition(siblings),
    });
    summary.addedLinks += 1;
  }

  return { expectedRevision, merged, identityMap, summary };
}
