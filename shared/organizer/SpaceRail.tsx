import { ChevronLeft, PanelLeftOpen } from "lucide-react";
import type { ReactNode } from "react";
import type { Space } from "../domain";

export type SpaceRailProps = {
  activeSpaceId: string;
  actions?: ReactNode;
  beforeSpaces?: ReactNode;
  brand?: ReactNode;
  className?: string;
  collapsed: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onSelect: (spaceId: string) => void;
  renderSpace?: (space: Space, defaultRow: ReactNode) => ReactNode;
  spaceActions?: (space: Space) => ReactNode;
  selectionLabel?: (space: Space) => string;
  spaces: Space[];
};

export function SpaceRail({
  activeSpaceId,
  actions,
  beforeSpaces,
  brand,
  className,
  collapsed,
  onCollapsedChange,
  onSelect,
  renderSpace,
  spaceActions,
  selectionLabel = (space) => `Open ${space.name}`,
  spaces,
}: SpaceRailProps) {
  const classes = ["organizer-space-rail", collapsed ? "collapsed" : "expanded", className].filter(Boolean).join(" ");

  return <aside aria-label="Spaces" className={classes}>
    <div className="organizer-rail-top sidebar-top">
      {!collapsed && brand}
      <button aria-expanded={!collapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} className="organizer-rail-toggle sidebar-toggle" type="button" onClick={() => onCollapsedChange?.(!collapsed)}>
        {collapsed ? <PanelLeftOpen aria-hidden="true" size={18} /> : <ChevronLeft aria-hidden="true" size={17} />}
      </button>
    </div>
    {actions && <div className="organizer-rail-actions space-sidebar-heading">{!collapsed && <span>MY SPACES</span>}{actions}</div>}
    {beforeSpaces}
    <nav aria-label="Spaces" className="organizer-space-list space-list">
      {spaces.map((space) => {
        const defaultRow = <div className={`organizer-space-row space-row ${space.id === activeSpaceId ? "active" : ""}`} key={space.id}>
          <button aria-label={selectionLabel(space)} aria-current={space.id === activeSpaceId ? "page" : undefined} className="organizer-space-select space-select" title={space.name} type="button" onClick={() => onSelect(space.id)}>
            <i aria-hidden="true" style={{ background: space.color }}>{space.name.trim().charAt(0).toUpperCase() || "•"}</i>
            {!collapsed && <span>{space.name}</span>}
          </button>
          {!collapsed && spaceActions?.(space)}
        </div>;
        return renderSpace ? renderSpace(space, defaultRow) : defaultRow;
      })}
    </nav>
  </aside>;
}
