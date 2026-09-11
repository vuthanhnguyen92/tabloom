import { ChevronLeft, PanelLeftOpen, Pencil, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { Space } from "../domain";
import { isWritable } from "../organizer/mutation-policy";

export type ClassicSpaceSidebarProps = {
  spaces: Space[];
  activeSpaceId: string;
  collapsed: boolean;
  brand?: ReactNode;
  beforeSpaces?: ReactNode;
  isPending: (space: Space) => boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onSelect: (spaceId: string) => void;
  onCreate: () => void;
  onEdit: (space: Space) => void;
  onDelete?: (space: Space) => void;
};

export function ClassicSpaceSidebar({ spaces, activeSpaceId, collapsed, brand, beforeSpaces, isPending, onCollapsedChange, onSelect, onCreate, onEdit, onDelete }: ClassicSpaceSidebarProps) {
  return <aside aria-label="Spaces" className={`ext-sidebar ${collapsed ? "collapsed" : "expanded"}`}>
    <div className="sidebar-top">
      {!collapsed && brand}
      <button aria-expanded={!collapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} className="sidebar-toggle" type="button" onClick={() => onCollapsedChange(!collapsed)}>
        {collapsed ? <PanelLeftOpen aria-hidden="true" size={18} /> : <ChevronLeft aria-hidden="true" size={17} />}
      </button>
    </div>
    {beforeSpaces}
    <div className="space-sidebar-heading">
      {!collapsed && <span>MY SPACES</span>}
      <button aria-label="Add space" type="button" onClick={onCreate}><Plus aria-hidden="true" size={15} /></button>
    </div>
    <nav aria-label="Spaces" className="space-list">
      {spaces.map((space) => {
        const active = space.id === activeSpaceId;
        const pending = isPending(space);
        const writable = isWritable(space) && !pending;
        return <div className={`space-row${active ? " active" : ""}`} key={space.id}>
          <button aria-current={active ? "page" : undefined} aria-label={`Open ${space.name}`} className="space-select" disabled={pending} title={space.name} type="button" onClick={() => onSelect(space.id)}>
            <i aria-hidden="true" style={{ background: space.color }}>{space.name.trim().charAt(0).toUpperCase() || "•"}</i>
            {!collapsed && <span>{space.name}</span>}
          </button>
          {!collapsed && writable && <div className="space-row-actions">
            <button aria-label={`Edit ${space.name}`} className="space-edit" type="button" onClick={() => onEdit(space)}><Pencil aria-hidden="true" size={13} /></button>
            {onDelete && <button aria-label={`Delete ${space.name}`} className="space-delete" type="button" onClick={() => onDelete(space)}><Trash2 aria-hidden="true" size={13} /></button>}
          </div>}
        </div>;
      })}
    </nav>
  </aside>;
}
