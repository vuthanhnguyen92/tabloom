import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { isSaveableUrl, type Collection, type SavedLink, type Space } from "../domain";
import { ModalBoundary } from "./ModalBoundary";

type DeleteDialog = { type: "delete-space" | "delete-collection"; id: string; name: string; linkCount: number; collectionCount?: number };
export type WorkspaceDialogState =
  | { type: "create-space" }
  | { type: "edit-space"; space: Space }
  | { type: "create-collection"; spaceId: string }
  | { type: "edit-collection"; collection: Collection }
  | { type: "create-link"; collectionId: string }
  | { type: "edit-link"; link: SavedLink }
  | DeleteDialog
  | { type: "open-many"; name: string; urls: readonly string[] }
  | { type: "duplicate-link"; title: string; actionLabel?: string }
  | null;

export type WorkspaceDialogCommand =
  | { type: "create-space"; name: string; color: string }
  | { type: "edit-space"; id: string; name: string; color: string }
  | { type: "create-collection"; spaceId: string; name: string }
  | { type: "edit-collection"; id: string; name: string }
  | { type: "create-link"; collectionId: string; title: string; url: string; description: string }
  | { type: "edit-link"; id: string; title: string; url: string; description: string }
  | { type: "delete-space" | "delete-collection"; id: string }
  | { type: "open-many"; name: string; urls: readonly string[] }
  | { type: "duplicate-link" };

export type WorkspaceDialogsProps = {
  dialog: WorkspaceDialogState;
  onClose: () => void;
  /** Dispatch only: the controller owns completion, errors, and mutation policy. */
  onSubmit: (command: WorkspaceDialogCommand) => void;
  busy?: boolean;
  error?: string;
};

export function WorkspaceDialogs({ dialog, ...props }: WorkspaceDialogsProps) {
  if (!dialog) return null;
  const identity = "space" in dialog ? dialog.space.id : "collection" in dialog ? dialog.collection.id : "link" in dialog ? dialog.link.id : "id" in dialog ? dialog.id : "collectionId" in dialog ? dialog.collectionId : "spaceId" in dialog ? dialog.spaceId : "";
  return <WorkspaceDialog key={`${dialog.type}:${identity}`} dialog={dialog} {...props} />;
}

function WorkspaceDialog({ dialog, onClose, onSubmit, busy = false, error }: Omit<WorkspaceDialogsProps, "dialog"> & { dialog: NonNullable<WorkspaceDialogState> }) {
  const [name, setName] = useState(dialog.type === "edit-space" ? dialog.space.name : dialog.type === "edit-collection" ? dialog.collection.name : "");
  const [color, setColor] = useState(dialog.type === "edit-space" ? dialog.space.color : "#f56f72");
  const [title, setTitle] = useState(dialog.type === "edit-link" ? dialog.link.title : "");
  const [url, setUrl] = useState(dialog.type === "edit-link" ? dialog.link.url : "https://");
  const [description, setDescription] = useState(dialog.type === "edit-link" ? dialog.link.description : "");
  const [validation, setValidation] = useState("");
  const isLink = dialog.type === "create-link" || dialog.type === "edit-link";
  const isSpace = dialog.type === "create-space" || dialog.type === "edit-space";
  const isForm = isLink || isSpace || dialog.type === "create-collection" || dialog.type === "edit-collection";
  const heading = dialog.type === "open-many" ? `Open ${dialog.urls.length} tabs?` : dialog.type === "duplicate-link" ? "This link is already saved" : dialog.type === "delete-space" || dialog.type === "delete-collection" ? `Delete “${dialog.name}”?` : `${dialog.type.startsWith("create") ? "New" : "Edit"} ${isLink ? "saved link" : isSpace ? "space" : "collection"}`;
  const confirmLabel = dialog.type === "open-many" ? "Open tabs" : dialog.type === "duplicate-link" ? dialog.actionLabel ?? "Save another copy" : dialog.type === "delete-space" ? "Delete space" : "Delete collection";
  function confirm() {
    if (busy) return;
    if (dialog.type === "delete-space" || dialog.type === "delete-collection") onSubmit({ type: dialog.type, id: dialog.id });
    else if (dialog.type === "open-many") onSubmit({ type: "open-many", name: dialog.name, urls: dialog.urls });
    else if (dialog.type === "duplicate-link") onSubmit({ type: "duplicate-link" });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (isLink) {
      if (!title.trim() || title.trim().length > 300) return setValidation("Enter a title of 1–300 characters.");
      if (!isSaveableUrl(url.trim())) return setValidation("Enter a valid http or https URL.");
      if (description.length > 1000) return setValidation("Keep the note within 1,000 characters.");
      const fields = { title: title.trim(), url: url.trim(), description };
      if (dialog.type === "create-link") onSubmit({ type: dialog.type, collectionId: dialog.collectionId, ...fields });
      else if (dialog.type === "edit-link") onSubmit({ type: dialog.type, id: dialog.link.id, ...fields });
      return;
    }
    if (!name.trim() || name.trim().length > 80) return setValidation("Enter a name of 1–80 characters.");
    if (dialog.type === "create-space") onSubmit({ type: dialog.type, name: name.trim(), color });
    else if (dialog.type === "edit-space") onSubmit({ type: dialog.type, id: dialog.space.id, name: name.trim(), color });
    else if (dialog.type === "create-collection") onSubmit({ type: dialog.type, spaceId: dialog.spaceId, name: name.trim() });
    else if (dialog.type === "edit-collection") onSubmit({ type: dialog.type, id: dialog.collection.id, name: name.trim() });
  }
  const message = validation || error;
  return <ModalBoundary label={heading} className="drop-confirm-backdrop organizer-dialog-backdrop" onClose={onClose} busy={busy} initialFocus={isForm ? '[data-initial-focus]' : '[data-cancel]'}>
    <div className="drop-confirm organizer-dialog">
      <button className="dialog-close" aria-label="Close dialog" type="button" disabled={busy} onClick={onClose}><X size={18} /></button>
      <h2>{heading}</h2>
      {dialog.type === "delete-space" || dialog.type === "delete-collection" ? <p>{dialog.type === "delete-space" ? `${dialog.collectionCount ?? 0} collections and ` : ""}{dialog.linkCount} saved links will move to Trash for 30 days.</p> : dialog.type === "open-many" ? <p>Opening a large collection can make your browser feel busy.</p> : dialog.type === "duplicate-link" ? <p>{dialog.title} already exists in this collection. You can still save another copy.</p> : null}
      {isForm ? <form onSubmit={submit} autoComplete="off">
        {isLink ? <>
          <label>Title<input data-initial-focus name="title" maxLength={300} value={title} onChange={(event) => { setTitle(event.target.value); setValidation(""); }} /></label>
          <label>URL<input name="url" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={url} onChange={(event) => { setUrl(event.target.value); setValidation(""); }} /></label>
          <label>Note<textarea name="description" maxLength={1000} value={description} onChange={(event) => { setDescription(event.target.value); setValidation(""); }} /></label>
        </> : <label>Name<input data-initial-focus name="name" maxLength={80} value={name} onChange={(event) => { setName(event.target.value); setValidation(""); }} /></label>}
        {isSpace && <label>Color<input type="color" name="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>}
        {message && <p role="alert">{message}</p>}
        <div className="organizer-dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="close-after-save" disabled={busy}>{isLink ? "Save link" : "Save"}</button></div>
      </form> : <>
        {message && <p role="alert">{message}</p>}
        <div className="organizer-dialog-actions"><button data-cancel type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="button" disabled={busy} className="close-after-save" onClick={confirm}>{confirmLabel}</button></div>
      </>}
    </div>
  </ModalBoundary>;
}
