import { Pencil, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { TabloomMark } from "../TabloomMark";
import { ControllerCollections } from "./ControllerCollections";
import { type CollectionListProps } from "./CollectionList";
import { GlobalSearch } from "./GlobalSearch";
import { type OrganizerFaviconResolver } from "./SavedLinkCard";
import { SpaceRail } from "./SpaceRail";
import { ToastRegion } from "./ToastRegion";
import { TrashDialog } from "./TrashDialog";
import { WorkspaceDialogs } from "./WorkspaceDialogs";
import { WorkspaceHeader, type OrganizerStatus } from "./WorkspaceHeader";
import { WorkspaceShell } from "./WorkspaceShell";
import { isWritable } from "./mutation-policy";
import { useWorkspaceController, type WorkspaceController, type WorkspaceControllerOptions } from "./useWorkspaceController";
import { ClassicWorkspaceOrganizerView } from "../classic-organizer/ClassicWorkspaceOrganizer";

export type WorkspaceOrganizerProps = WorkspaceControllerOptions & {
  accountControls?: ReactNode;
  currentTabs?: ReactNode;
  headerActions?: ReactNode;
  mainContentBefore?: ReactNode;
  railBeforeSpaces?: ReactNode;
  status?: OrganizerStatus;
  share?: CollectionListProps["share"];
  externalDrop?: CollectionListProps["externalDrop"];
  onBookmarkDrop?: CollectionListProps["onBookmarkDrop"];
  resolveFavicon?: OrganizerFaviconResolver;
  savedLinkNewTab?: boolean;
  highlightedLinkId?: string;
  trashInAccount?: boolean;
  bookmarkImport?: { importIntoSpace: (spaceId: string) => Promise<{ imported: number; skipped: number }> };
};

export function WorkspaceOrganizer(props: WorkspaceOrganizerProps) {
  const controller = useWorkspaceController(props);
  return <ClassicWorkspaceOrganizerView {...props} controller={controller} />;
}

/** Compositions that also coordinate platform sync may retain and supply the controller. */
export function WorkspaceOrganizerView({ controller: c, accountControls, currentTabs, headerActions, railBeforeSpaces, status, ...props }: WorkspaceOrganizerProps & { controller: WorkspaceController }) {
  if (!c.ready) return <>
    <WorkspaceShell ready={false} rail={null}>{null}</WorkspaceShell>
    {c.bootError && <p role="alert">Workspace could not be loaded. Please reload and try again.</p>}
  </>;
  const active = c.activeSpace;
  return <div data-testid="shared-workspace-organizer">
    <WorkspaceShell rail={<SpaceRail spaces={[...c.snapshot.spaces].sort((a, b) => a.position - b.position)} activeSpaceId={c.selectedSpaceId} collapsed={c.railCollapsed} onCollapsedChange={c.setRailCollapsed} onSelect={c.selectSpace} isPending={(space) => c.isPending(space.id)}
      brand={<span className="organizer-brand ext-brand"><TabloomMark className="ext-brand-mark" />tabloom</span>} beforeSpaces={railBeforeSpaces}
      actions={<button aria-label="New space" onClick={() => c.openDialog({ type: "create-space" })}><Plus size={16} /></button>}
      spaceActions={(space) => isWritable(space) && !c.isPending(space.id) ? <div className="space-row-actions">
        <button aria-label={`Edit ${space.name}`} onClick={() => c.openDialog({ type: "edit-space", space })}><Pencil size={14} /></button>
        {props.trashRepository && <button aria-label={`Delete ${space.name}`} onClick={() => { void c.requestDelete("space", space.id); }}><Trash2 size={14} /></button>}
      </div> : null}
    />} sidePanel={currentTabs} header={<WorkspaceHeader title={active?.name ?? "Your workspace"} status={status} onOpenTrash={props.trashRepository && !props.trashInAccount ? () => c.setTrashOpen(true) : undefined} actions={<>
      {active && isWritable(active) && !c.isPending(active.id) && <button className="organizer-new-collection" onClick={() => c.openDialog({ type: "create-collection", spaceId: active.id })}><Plus size={15} />New collection</button>}
      <GlobalSearch snapshot={c.snapshot} capabilities={props.capabilities} open={c.searchOpen} onOpenChange={c.setSearchOpen} savedLinkNewTab={props.savedLinkNewTab} resolveFavicon={props.resolveFavicon} onError={(message) => c.notify(message, "error")} />
      {headerActions}{accountControls}
    </>} />}>
      {props.mainContentBefore}
      <ControllerCollections {...props} controller={c} />
      {!active && <p>Create a space to start organizing your links.</p>}
    </WorkspaceShell>
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
  </div>;
}
