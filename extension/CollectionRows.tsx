import { CollectionList, type CollectionListProps } from "../shared/organizer/CollectionList";
import { openCollectionTabs, type CaptureTab } from "./chrome-api";
import { BROWSER_TAB_MIME } from "./CurrentTabsSheet";

export type CollectionRowsProps = Omit<CollectionListProps, "externalDrop"> & {
  browserTabDragSession?: number;
  onBrowserTabDrop?: (tab: CaptureTab, collectionId: string) => void;
};

/** Extension boundary: browser drag payloads and native tab opening stay here. */
export function CollectionRows({ browserTabDragSession = 0, onBrowserTabDrop, onOpenCollection, ...props }: CollectionRowsProps) {
  return <CollectionList {...props}
    onOpenCollection={onOpenCollection ?? (async (collection, links) => {
      await openCollectionTabs(collection.name, links.map((link) => link.url));
    })}
    externalDrop={{
      session: browserTabDragSession,
      isDrag: (event) => Array.from(event.dataTransfer.types ?? []).includes(BROWSER_TAB_MIME),
      accept: (event, collection) => {
        const payload = event.dataTransfer?.getData?.(BROWSER_TAB_MIME);
        if (!payload || !onBrowserTabDrop) return false;
        try {
          onBrowserTabDrop(JSON.parse(payload) as CaptureTab, collection.id);
          return true;
        } catch { return false; }
      },
    }}
  />;
}
