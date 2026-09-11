import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceSnapshot } from "../domain";
import type { WorkspaceTrashRepository } from "../trash-repository";
import { registerModal } from "./modal-stack";
import { isWritable } from "./mutation-policy";
import { useTrash } from "./useTrash";

type Props = { repository: WorkspaceTrashRepository; snapshot?: WorkspaceSnapshot; open: boolean; onClose: () => void; onRestored?: Parameters<typeof useTrash>[2]; onRestore?: Parameters<typeof useTrash>[3] };
export function TrashDialog(props: Props) { return props.open ? <OpenTrashDialog {...props} /> : null; }
function OpenTrashDialog({ repository, snapshot = { spaces: [], collections: [], links: [] }, onClose, onRestored, onRestore }: Props) {
  const trash = useTrash(repository, true, onRestored, onRestore);
  const root = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onClose, busy: trash.busy });
  useLayoutEffect(() => { callbacks.current = { onClose, busy: trash.busy }; });
  useLayoutEffect(() => registerModal({ root: root.current!, owner: "trash", onClose: () => callbacks.current.onClose(), isBusy: () => callbacks.current.busy }), []);
  useLayoutEffect(() => { if (trash.destination) root.current?.querySelector("select")?.focus(); }, [trash.destination]);
  const [destinationId, setDestinationId] = useState("");
  const spaces = snapshot.spaces.filter(isWritable);
  const choices = trash.destination?.type === "space" ? spaces : snapshot.collections.filter((item) => isWritable(item) && spaces.some((space) => space.id === item.space_id));
  return createPortal(<div className="organizer-trash-overlay classic-trash-overlay" ref={root} tabIndex={-1}>
    <section role="dialog" aria-modal="true" aria-labelledby="trash-title" className="organizer-trash-dialog">
      <header><h2 id="trash-title">Trash</h2><button aria-label="Close Trash" disabled={trash.busy} onClick={onClose}>Close</button></header>
      <p>Deleted items can be recovered for 30 days.</p>
      {trash.error && <p role="alert">{trash.error}</p>}
      {trash.loading ? <p role="status">Loading Trash…</p> : trash.destination ? <form onSubmit={(event) => { event.preventDefault(); if (destinationId) void trash.restore(trash.destination!.entry, destinationId); }}>
        <p>Choose a destination for {trash.destination.entry.rootName}.</p>
        <label>Restore into<select value={destinationId} disabled={trash.busy} onChange={(event) => setDestinationId(event.target.value)}><option value="">Choose a {trash.destination.type}</option>{choices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {!choices.length && <p>Create a writable {trash.destination.type} first.</p>}
        <button type="button" disabled={trash.busy} onClick={trash.cancelDestination}>Back</button><button type="submit" disabled={!destinationId || trash.busy}>Restore here</button>
      </form> : !trash.entries.length ? <p>Trash is empty.</p> : <ul>{trash.entries.map((entry) => <li key={entry.id}>
        <div><small>{entry.rootType}</small><h3>{entry.rootName}</h3><p>Deleted by {entry.source === "mcp" ? "MCP" : entry.source === "web" ? "Web" : "Extension"}</p><p>Deleted <time dateTime={entry.deletedAt}>{new Date(entry.deletedAt).toLocaleString()}</time></p><p>Recover until <time dateTime={entry.expiresAt}>{new Date(entry.expiresAt).toLocaleString()}</time></p></div>
        <div>{entry.restorePending && <p>Restored locally · sync pending</p>}<button disabled={trash.busy} aria-label={`Restore ${entry.rootName}`} onClick={() => { setDestinationId(""); void trash.restore(entry); }}>{entry.restorePending ? "Retry restore" : "Restore"}</button>
          {entry.restorePending && entry.rootType !== "space" && <button disabled={trash.busy} onClick={() => { setDestinationId(""); trash.chooseDestination(entry); }}>Choose destination</button>}
        </div>
      </li>)}</ul>}
    </section>
  </div>, document.body);
}
