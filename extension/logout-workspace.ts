import type { WorkspaceSnapshot } from "../shared/domain";
import { planWorkspaceMerge } from "../shared/workspace-merge";

const LOCAL_USER_ID = "local-user";

function savedAccountWorkspace(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const spaces = snapshot.spaces
    .filter((space) => space.origin === "saved" && !space.read_only)
    .map((space) => ({ ...space, user_id: LOCAL_USER_ID }));
  const spaceIds = new Set(spaces.map((space) => space.id));
  const collections = snapshot.collections
    .filter((collection) => collection.origin === "saved" && !collection.read_only && spaceIds.has(collection.space_id))
    .map((collection) => ({ ...collection, user_id: LOCAL_USER_ID }));
  const collectionIds = new Set(collections.map((collection) => collection.id));
  const links = snapshot.links
    .filter((link) => link.origin === "saved" && !link.read_only && collectionIds.has(link.collection_id))
    .map((link) => ({ ...link, user_id: LOCAL_USER_ID }));
  return { spaces, collections, links };
}

export function mergeAccountWorkspaceIntoLocal(
  local: WorkspaceSnapshot,
  account: WorkspaceSnapshot,
): WorkspaceSnapshot {
  const merged = planWorkspaceMerge(savedAccountWorkspace(account), local, 0).merged;
  return {
    spaces: merged.spaces.map((space) => ({ ...space, user_id: LOCAL_USER_ID })),
    collections: merged.collections.map((collection) => ({ ...collection, user_id: LOCAL_USER_ID })),
    links: merged.links.map((link) => ({ ...link, user_id: LOCAL_USER_ID })),
  };
}
