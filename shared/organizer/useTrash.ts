import { useEffect, useRef, useState } from "react";
import type { WorkspaceSnapshot } from "../domain";
import { CommittedRestoreRefreshError, LocallyCommittedTrashError, WorkspaceCommandError, type WorkspaceTrashEntry } from "../trash";
import type { WorkspaceTrashRepository } from "../trash-repository";

export function useTrash(repository: WorkspaceTrashRepository, open: boolean, onRestored?: (snapshot: WorkspaceSnapshot | undefined, entry: WorkspaceTrashEntry, destinationId?: string, pendingSync?: boolean) => void) {
  const [entries, setEntries] = useState<WorkspaceTrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState<{ entry: WorkspaceTrashEntry; type: "space" | "collection" } | null>(null);
  const session = useRef({ active: true });
  const inFlight = useRef(false);
  useEffect(() => {
    const current = { active: true };
    session.current = current;
    if (open) {
      void repository.list().then((items) => { if (current.active) { setEntries(items); setError(""); setLoading(false); } }, () => { if (current.active) { setError("Trash could not be loaded. Please reopen and try again."); setLoading(false); } });
    }
    return () => { current.active = false; };
  }, [open, repository]);
  async function restore(entry: WorkspaceTrashEntry, destinationId?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = session.current;
    setBusy(true); setError("");
    try {
      const snapshot = await repository.restore(entry.id, destinationId);
      if (!current.active) return;
      setEntries((items) => items.filter((item) => item.id !== entry.id)); setDestination(null);
      onRestored?.(snapshot, entry, destinationId);
    } catch (reason) {
      if (!current.active) return;
      if (reason instanceof WorkspaceCommandError && reason.code === "destination_required") {
        setDestination({ entry, type: reason.details.destinationType === "space" ? "space" : "collection" });
      } else if (reason instanceof LocallyCommittedTrashError) {
        setEntries((items) => items.filter((item) => item.id !== entry.id)); setDestination(null);
        onRestored?.(reason.snapshot, entry, destinationId, true);
      } else if (reason instanceof CommittedRestoreRefreshError) {
        setEntries((items) => items.filter((item) => item.id !== entry.id)); setDestination(null);
        onRestored?.(undefined, entry, destinationId);
        setError("Restored. Refresh the workspace to see the latest changes.");
      } else setError(reason instanceof WorkspaceCommandError ? reason.message : "Restore could not be completed. Please retry.");
    } finally { inFlight.current = false; if (current.active) setBusy(false); }
  }
  return { entries, loading, error, busy, destination, restore, cancelDestination: () => setDestination(null), chooseDestination: (entry: WorkspaceTrashEntry) => setDestination({ entry, type: entry.rootType === "collection" ? "space" : "collection" }) };
}
