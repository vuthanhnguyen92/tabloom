import type { WorkspaceRepository } from "../shared/repository";
import { captureTabs } from "../shared/capture";
import type { CaptureTab } from "./chrome-api";

export async function saveDroppedTab(_options: {
  tab: CaptureTab;
  collectionId: string;
  closeAfterSave: boolean;
  repository: WorkspaceRepository;
  closeTabs: (ids: number[]) => Promise<void> | void;
}) {
  const { tab, collectionId, closeAfterSave, repository, closeTabs } = _options;
  return captureTabs({
    tabs: [tab],
    collectionId,
    closeAfterSave,
    save: (items) => repository.createLinks(items.map((item) => ({ collection_id: item.collection_id, url: item.url, title: item.title, description: item.description, favicon_url: item.favicon_url }))),
    close: async (ids) => { await closeTabs(ids); },
  });
}
