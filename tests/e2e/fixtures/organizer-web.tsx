import { createRoot } from "react-dom/client";
import { WorkspaceClient } from "../../../app/app/WorkspaceClient";
import { createLocalWorkspaceRepository } from "../../../extension/storage";
import { LocalTrashRepository } from "../../../extension/local-trash-repository";
import { LOCAL_WORKSPACE_KEY, type StorageArea } from "../../../extension/workspace-cache";
import { organizerSnapshot } from "./organizer";
import "../../../app/globals.css";

// Mount the production web composition, using an explicit local persistence
// boundary. No production credentials, network repository, or fake DOM controls.
const area: StorageArea = {
  async get(key) { const value = localStorage.getItem(key); return value ? { [key]: JSON.parse(value) } : {}; },
  async set(values) { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value)); },
};
if (!localStorage.getItem(LOCAL_WORKSPACE_KEY)) await area.set({ [LOCAL_WORKSPACE_KEY]: { version: 2, snapshot: organizerSnapshot(), bookmarkSources: [], cachedAt: "2026-09-10T00:00:00Z" } });
const repository = await createLocalWorkspaceRepository(area);
if (new URL(location.href).searchParams.has("readOnly")) {
  const load = repository.load.bind(repository);
  repository.load = async () => {
    const snapshot = await load();
    return { ...snapshot, spaces: snapshot.spaces.map((space) => ({ ...space, read_only: true })) };
  };
}
const trashRepository = new LocalTrashRepository(area, repository, "web-acceptance");
createRoot(document.getElementById("root")!).render(<WorkspaceClient repository={repository} trashRepository={trashRepository} mode="synced" userId="local-user" email="acceptance@example.com" />);
