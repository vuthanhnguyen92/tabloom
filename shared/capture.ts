import { isSaveableUrl, type CaptureResult, type SavedLink } from "./domain";

export type BrowserTab = { id?: number; title?: string; url?: string; favIconUrl?: string };

type CaptureOptions = {
  tabs: BrowserTab[];
  collectionId: string;
  closeAfterSave: boolean;
  save: (links: Array<Pick<SavedLink, "collection_id" | "url" | "title" | "favicon_url" | "description" | "position">>) => Promise<void>;
  close: (tabIds: number[]) => Promise<void>;
};

export async function captureTabs(options: CaptureOptions): Promise<CaptureResult> {
  const valid = options.tabs.filter((tab) => isSaveableUrl(tab.url));
  const links = valid.map((tab, position) => ({
    collection_id: options.collectionId,
    url: tab.url!,
    title: tab.title?.trim() || new URL(tab.url!).hostname,
    description: "",
    favicon_url: tab.favIconUrl || null,
    position,
  }));
  if (links.length) await options.save(links);
  const closableIds = valid.flatMap((tab) => typeof tab.id === "number" ? [tab.id] : []);
  if (options.closeAfterSave && closableIds.length) await options.close(closableIds);
  return {
    saved: links.length,
    skipped: options.tabs.length - links.length,
    closed: options.closeAfterSave ? closableIds.length : 0,
  };
}
