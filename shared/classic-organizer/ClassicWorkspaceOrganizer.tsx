import { Plus, Trash2 } from "lucide-react";
import { TabloomMark } from "../TabloomMark";
import { ControllerCollections } from "../organizer/ControllerCollections";
import { GlobalSearch } from "../organizer/GlobalSearch";
import { ToastRegion } from "../organizer/ToastRegion";
import { TrashDialog } from "../organizer/TrashDialog";
import { WorkspaceDialogs } from "../organizer/WorkspaceDialogs";
import { isWritable } from "../organizer/mutation-policy";
import { useWorkspaceController, type WorkspaceController } from "../organizer/useWorkspaceController";
import type { WorkspaceOrganizerProps } from "../organizer/WorkspaceOrganizer";
import { ClassicSpaceSidebar } from "./ClassicSpaceSidebar";

export type ClassicWorkspaceOrganizerProps = WorkspaceOrganizerProps;

export function ClassicWorkspaceOrganizer(props: ClassicWorkspaceOrganizerProps) {
  const controller = useWorkspaceController(props);
  return <ClassicWorkspaceOrganizerView {...props} controller={controller} />;
}

export function ClassicWorkspaceOrganizerView({ controller: c, accountControls, currentTabs, headerActions, railBeforeSpaces, status, ...props }: ClassicWorkspaceOrganizerProps & { controller: WorkspaceController }) {
  if (!c.ready) return <main aria-busy="true" aria-label="Loading workspace" className="classic-organizer ext-shell workspace-boot-shell">
    <aside aria-hidden="true" className="ext-sidebar collapsed" />
    <section className="ext-main"><div aria-hidden="true" className="workspace-boot-indicator" /></section>
    {c.bootError && <p role="alert">Workspace could not be loaded. Please reload and try again.</p>}
  </main>;

  const active = c.activeSpace;
  return <main className={`classic-organizer ext-shell${currentTabs ? "" : " without-side-panel"}`} data-testid="classic-workspace-organizer">
    <ClassicSpaceSidebar
      activeSpaceId={c.selectedSpaceId}
      beforeSpaces={railBeforeSpaces}
      brand={<span className="ext-brand"><TabloomMark className="ext-brand-mark" />tabloom</span>}
      collapsed={c.railCollapsed}
      isPending={(space) => c.isPending(space.id)}
      onCollapsedChange={c.setRailCollapsed}
      onCreate={() => c.openDialog({ type: "create-space" })}
      onDelete={props.trashRepository ? (space) => { void c.requestDelete("space", space.id); } : undefined}
      onEdit={(space) => c.openDialog({ type: "edit-space", space })}
      onSelect={c.selectSpace}
      spaces={[...c.snapshot.spaces].sort((left, right) => left.position - right.position)}
    />
    <section className="ext-main">
      <header>
        <div className="classic-header-title">
          {status && <small className={`sync-state-${status.state}`}>{status.subtitle}</small>}
          <div className="classic-active-space-heading">
            <h1 title={active?.name}>{active?.name ?? "Your workspace"}</h1>
            {active && props.trashRepository && isWritable(active) && !c.isPending(active.id) && <button
              aria-label={`Delete ${active.name} space`}
              className="active-space-delete"
              onClick={() => { void c.requestDelete("space", active.id); }}
              type="button"
            ><Trash2 aria-hidden="true" size={17} /></button>}
          </div>
        </div>
        <div className="ext-header-tools">
          {active && isWritable(active) && !c.isPending(active.id) && <button aria-label="New collection" className="new-collection-trigger" type="button" onClick={() => c.openDialog({ type: "create-collection", spaceId: active.id })}><Plus aria-hidden="true" size={15} />New collection</button>}
          <GlobalSearch snapshot={c.snapshot} capabilities={props.capabilities} open={c.searchOpen} onOpenChange={c.setSearchOpen} savedLinkNewTab={props.savedLinkNewTab} resolveFavicon={props.resolveFavicon} onError={(message) => c.notify(message, "error")} />
          {headerActions}
          {accountControls}
        </div>
      </header>
      {props.mainContentBefore}
      <ControllerCollections {...props} controller={c} />
      {!active && <p>Create a space to start organizing your links.</p>}
    </section>
    {currentTabs}
    <WorkspaceDialogs allowBookmarkImport={Boolean(props.bookmarkImport)} dialog={c.dialog} onClose={c.closeDialog} onSubmit={(command) => { void (async () => {
      const result = await c.submitDialog(command);
      if (command.type !== "create-space" || !command.importBookmarks || !props.bookmarkImport || !result || typeof result !== "object" || !("id" in result)) return;
      try {
        const summary = await props.bookmarkImport.importIntoSpace(String(result.id));
        await c.reload();
        c.notify(`${summary.imported} bookmarks imported${summary.skipped ? ` · ${summary.skipped} skipped` : ""}`);
      } catch (reason) {
        c.notify(reason instanceof Error ? reason.message : "Bookmarks could not be imported. Your new space is still available.", "error");
      }
    })(); }} busy={c.busy} />
    {props.trashRepository && <TrashDialog repository={props.trashRepository} snapshot={c.snapshot} open={c.trashOpen} onClose={() => c.setTrashOpen(false)} onRestore={c.restoreTrashEntry} />}
    <ToastRegion toasts={c.toasts} onDismiss={c.dismissToast} />
  </main>;
}
