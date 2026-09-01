import type { ReactNode } from "react";

export function WorkspaceBootBoundary({ children, ready }: { children: ReactNode; ready: boolean }) {
  if (!ready) {
    return <main aria-busy="true" aria-label="Loading Tabloom workspace" className="ext-shell sheet-open workspace-boot-shell">
      <aside className="ext-sidebar collapsed"><div className="sidebar-top" /></aside>
      <section className="ext-main"><div aria-hidden="true" className="workspace-boot-indicator" /></section>
    </main>;
  }
  return children;
}
