import { Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceRepository } from "../shared/repository";

interface CreateCollectionPromptProps {
  activeSpaceId?: string;
  repository: WorkspaceRepository;
  onCreated(): Promise<void>;
  onError(message: string): void;
}

export function CreateCollectionPrompt({ activeSpaceId, repository, onCreated, onError }: CreateCollectionPromptProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const trimmedName = name.trim();

  function close() {
    if (saving) return;
    setOpen(false);
    setName("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeSpaceId || !trimmedName || saving) return;
    setSaving(true);
    try {
      await repository.createCollection({ space_id: activeSpaceId, name: trimmedName });
      await onCreated();
      setOpen(false);
      setName("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not create this collection.");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <button className="new-collection-trigger" disabled={!activeSpaceId} onClick={() => setOpen(true)}><Plus size={15} /> New collection</button>
    {open && createPortal(<div className="drop-confirm-backdrop">
      <section className="drop-confirm create-collection-modal" role="dialog" aria-modal="true" aria-label="Create a collection">
        <button className="dialog-close" aria-label="Close collection form" disabled={saving} onClick={close}><X size={18} /></button>
        <small>NEW COLLECTION</small>
        <h2>Create a collection</h2>
        <p>Add an empty collection to the current space, then drag saved links or current tabs into it.</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="new-collection-name">Collection name</label>
          <input id="new-collection-name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
          <div>
            <button type="button" disabled={saving} onClick={close}>Cancel</button>
            <button className="close-after-save" type="submit" disabled={!trimmedName || saving}>{saving ? "Creating…" : "Create collection"}</button>
          </div>
        </form>
      </section>
    </div>, document.body)}
  </>;
}
