import {
  ChevronDown,
  CopyMinus,
  GripVertical,
  Layers3,
  Plus,
  Search,
  X,
} from "lucide-react";

const steps = [
  {
    id: "capture",
    number: "01",
    eyebrow: "Capture",
    title: "Drag a live tab into the right context.",
    description:
      "Keep the useful page, close the noise, or sweep the whole window into a new collection.",
  },
  {
    id: "organize",
    number: "02",
    eyebrow: "Organize",
    title: "Spaces for projects. Collections for context.",
    description:
      "Rename, collapse, and reorder collections while every saved link stays easy to recognize.",
  },
  {
    id: "search",
    number: "03",
    eyebrow: "Find and return",
    title: "Search everything without leaving the new tab.",
    description:
      "Find current tabs, saved links, bookmarks, spaces, and collections from one focused view.",
  },
] as const;

function CaptureScene() {
  return (
    <div aria-hidden="true" className="workflow-scene capture-scene">
      <div className="scene-current-tabs">
        <span><b>Current tabs</b><CopyMinus size={14} /></span>
        <div className="workflow-tab-flight"><i>P</i><span><b>Project brief</b><small>linear.app</small></span><X size={12} /></div>
        <div><i>S</i><span><b>Sprint notes</b><small>docs.google.com</small></span><X size={12} /></div>
        <strong><Plus size={12} /> Save all as collection</strong>
      </div>
      <div className="scene-drop-path"><span>Drag to save</span><b>→</b></div>
      <div className="scene-drop-collection"><span><ChevronDown size={13} /><b>Launch planning</b></span><small>Drop here</small></div>
    </div>
  );
}

function OrganizeScene() {
  return (
    <div aria-hidden="true" className="workflow-scene organize-scene">
      <div className="scene-space-list"><span className="active">M</span><span>R</span><span><Plus size={12} /></span></div>
      <div className="scene-collections">
        <small>My Space · Launch planning</small>
        <div className="scene-collection-row"><span><ChevronDown size={13} /><b>Research</b></span><small>2 links</small></div>
        <div className="scene-saved-row"><span><i>N</i><b>Customer notes</b></span><GripVertical size={13} /></div>
        <div className="scene-saved-row"><span><i>F</i><b>Design system</b></span><GripVertical size={13} /></div>
        <strong className="scene-open-all">Open all</strong>
        <div className="scene-tab-group"><Layers3 size={13} /><span><b>Research</b><small>2 tabs grouped</small></span></div>
      </div>
    </div>
  );
}

function SearchScene() {
  return (
    <div aria-hidden="true" className="workflow-scene search-scene">
      <div className="scene-search-backdrop" />
      <div className="scene-search-panel">
        <header><Search size={17} /><b>project</b><kbd>esc</kbd></header>
        <small>ALL SPACES AND COLLECTIONS</small>
        <div><i>P</i><span><b>Project brief</b><small>My Space · Research</small></span><em>Current tab</em></div>
        <div><i>R</i><span><b>Product roadmap</b><small>Work · Planning</small></span><em>Saved link</em></div>
        <div><i>B</i><span><b>Project bookmarks</b><small>Device bookmarks · Laptop</small></span><em>Bookmark</em></div>
      </div>
    </div>
  );
}

const scenes = {
  capture: <CaptureScene />,
  organize: <OrganizeScene />,
  search: <SearchScene />,
} as const;

export function WorkflowStory() {
  return (
    <div className="workflow-steps">
      {steps.map((step) => (
        <article className="workflow-step" data-step={step.id} key={step.id}>
          <div className="workflow-copy">
            <span className="workflow-number">{step.number}</span>
            <small>{step.eyebrow}</small>
            <h3>{step.title}</h3>
            <p>{step.description}</p>
          </div>
          {scenes[step.id]}
        </article>
      ))}
    </div>
  );
}
