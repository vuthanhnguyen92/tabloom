import { ChevronDown, GripVertical, Plus, Search, X } from "lucide-react";
import { Brand } from "../components/Brand";

const savedLinks = [
  { title: "Customer notes", host: "notion.so", icon: "N" },
  { title: "Design system", host: "figma.com", icon: "F" },
] as const;

const currentTabs = [
  { title: "Sprint notes", host: "docs.google.com", icon: "S" },
  { title: "Project brief", host: "linear.app", icon: "P" },
] as const;

export function WorkspacePreview() {
  return (
    <div
      aria-label="Tabloom workspace preview"
      className="workspace-preview"
      role="img"
    >
      <div aria-hidden="true" className="preview-browser-bar">
        <span className="preview-window-dots"><i /><i /><i /></span>
        <span>tabloom / My Space</span>
        <span />
      </div>
      <div aria-hidden="true" className="preview-layout">
        <aside className="preview-space-rail">
          <Brand compact />
          <span className="preview-space active">M</span>
          <span className="preview-space">R</span>
          <span className="preview-space add"><Plus size={12} /></span>
        </aside>

        <section className="preview-board">
          <header>
            <div><small>My Space</small><h3>Launch planning</h3></div>
            <span><Search size={13} /> Search</span>
          </header>
          <div className="preview-collection">
            <div className="preview-collection-heading">
              <span><ChevronDown size={14} /><b>Research</b></span>
              <small>2 links</small>
            </div>
            <div className="preview-saved-links">
              {savedLinks.map((link) => (
                <div className="preview-link-card" key={link.title}>
                  <i>{link.icon}</i>
                  <span><b>{link.title}</b><small>{link.host}</small></span>
                  <GripVertical size={13} />
                </div>
              ))}
            </div>
            <strong className="preview-open-all">Open all</strong>
          </div>
        </section>

        <aside className="preview-current-tabs">
          <header><div><small>CURRENT WINDOW</small><b>Current tabs</b></div><span>›</span></header>
          <p>Drag a tab into any collection to save it.</p>
          {currentTabs.map((tab) => (
            <div className="preview-current-tab" key={tab.title}>
              <i>{tab.icon}</i>
              <span><b>{tab.title}</b><small>{tab.host}</small></span>
              <X size={12} />
            </div>
          ))}
          <strong className="preview-save-all"><Plus size={12} /> Save all as collection</strong>
        </aside>
      </div>
    </div>
  );
}
