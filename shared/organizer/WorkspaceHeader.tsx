import { Children, Fragment, isValidElement, type ReactNode } from "react";

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

function renderableChildren(children: ReactNode): ReactNode[] {
  const rendered: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (child === null || typeof child === "boolean") return;
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      rendered.push(...renderableChildren(child.props.children));
      return;
    }
    rendered.push(child);
  });
  return rendered;
}

export function WorkspaceHeader({ actions, className, eyebrow, status, title }: WorkspaceHeaderProps) {
  const classes = ["organizer-workspace-header", className].filter(Boolean).join(" ");
  const renderedActions = renderableChildren(actions);

  return <header className={classes}>
    <div className="organizer-header-title">
      {eyebrow && <small>{eyebrow}</small>}
      <h1 title={typeof title === "string" ? title : undefined}>{title}</h1>
      {status && <small className={`organizer-status-subtitle sync-state-${status.state}`}>{status.subtitle}</small>}
    </div>
    {!!renderedActions.length && <div className="organizer-header-actions">{renderedActions}</div>}
  </header>;
}
