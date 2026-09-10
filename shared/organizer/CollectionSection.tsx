import type { HTMLAttributes, ReactNode } from "react";
import type { Collection, SavedLink } from "../domain";
import { SavedLinkCard } from "./SavedLinkCard";

export type CollectionSectionProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  collection: Collection;
  links: SavedLink[];
  writable: boolean;
  collapsed?: boolean;
  header?: ReactNode;
  children?: ReactNode;
  onOpenCollection?: (collection: Collection, links: SavedLink[]) => void | Promise<void>;
};

/** The section owns row layout; controller-supplied header and cards own commands. */
export function CollectionSection({ collection, links, writable, collapsed = false, header, children, onOpenCollection, ...articleProps }: CollectionSectionProps) {
  return <article {...articleProps} id={`collection-${collection.id}`} tabIndex={-1} data-organizer-layout-id={`collection:${collection.id}`} role="group" aria-label={`${collection.name} collection`}>
    <div className="collection-content">
      {header ?? <div className="ext-col-head"><b>{collection.name}</b><span>{links.length} links</span></div>}
      <div aria-hidden={collapsed} className="collection-body" id={`collection-body-${collection.id}`} inert={collapsed}>
        <div className="collection-body-inner">
          <div className="ext-link-grid">{children ?? links.map((link) => <SavedLinkCard key={link.id} link={link} writable={writable && collection.origin === "saved" && !collection.read_only} favicon={link.favicon_url} />)}</div>
          {onOpenCollection && <button className="open-links" onClick={() => void onOpenCollection(collection, links)}>Open all</button>}
        </div>
      </div>
    </div>
  </article>;
}
