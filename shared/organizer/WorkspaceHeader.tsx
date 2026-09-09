import { Children, type ReactNode } from "react";

export type OrganizerStatus = {
  state: "synced" | "syncing" | "failed" | "offline";
  subtitle: ReactNode;
};

export type WorkspaceHeaderProps = {
  actions?: ReactNode;
  className?: string;
  eyebrow?: ReactNode;
  status?: OrganizerStatus;
  title: ReactNode;
};

export function WorkspaceHeader({ actions, className, eyebrow, status, title }: WorkspaceHeaderProps) {
  const classes = ["organizer-workspace-header", className].filter(Boolean).join(" ");
  const hasActions = Children.count(actions) > 0;

  return <header className={classes}>
    <div className="organizer-header-title">
      {eyebrow && <small>{eyebrow}</small>}
      <h1 title={typeof title === "string" ? title : undefined}>{title}</h1>
      {status && <small className={`organizer-status-subtitle sync-state-${status.state}`}>{status.subtitle}</small>}
    </div>
    {hasActions && <div className="organizer-header-actions">{actions}</div>}
  </header>;
}
