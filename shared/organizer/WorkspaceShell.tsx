import type { ReactNode } from "react";

export type WorkspaceShellProps = {
  children: ReactNode;
  className?: string;
  header?: ReactNode;
  rail: ReactNode;
  ready?: boolean;
  sidePanel?: ReactNode;
};

export function WorkspaceShell({ children, className, header, rail, ready = true, sidePanel }: WorkspaceShellProps) {
  const classes = ["organizer-shell", className].filter(Boolean).join(" ");
  if (!ready) {
    return <main aria-busy="true" aria-label="Loading workspace" className={`${classes} organizer-shell-boot`}>
      <aside aria-hidden="true" className="organizer-space-rail collapsed" />
      <section className="organizer-main"><div aria-hidden="true" className="organizer-boot-indicator" /></section>
    </main>;
  }
  return <main className={classes}>
    {rail}
    <section className="organizer-main">
      {header}
      {children}
    </section>
    {sidePanel}
  </main>;
}
