import { useEffect, useState } from "react";
import { BookMarked, RefreshCw, Save, Trash2 } from "lucide-react";
import type { BookmarkRepository } from "../shared/bookmark-repository";
import type { BookmarkSource } from "../shared/bookmarks";
import type { WorkspaceRepository } from "../shared/repository";
import { readBrowserBookmarks, requestBookmarksPermission } from "./bookmarks-api";
import {
  getOrCreateBookmarkDevice,
  saveBookmarkDevice,
  syncBrowserBookmarks,
  type BookmarkDevice,
  type BookmarkSyncResult,
  type SyncBrowserBookmarksInput,
} from "./bookmark-sync";
import type { ChromeSnapshotCache } from "./storage";

type PanelState =
  | { kind: "idle" }
  | { kind: "naming"; device: BookmarkDevice }
  | { kind: "syncing" }
  | { kind: "success"; result: BookmarkSyncResult }
  | { kind: "error"; message: string };

export type BrowserBookmarksPanelProps = {
  repository: BookmarkRepository;
  workspace: WorkspaceRepository;
  cache: Pick<ChromeSnapshotCache, "writeEnvelope">;
  onWorkspaceReload: () => Promise<void>;
  requestPermission?: () => Promise<boolean>;
  readBookmarks?: SyncBrowserBookmarksInput["read"];
  getDevice?: () => Promise<BookmarkDevice>;
  saveDevice?: (device: BookmarkDevice) => Promise<void>;
  sync?: (input: SyncBrowserBookmarksInput) => Promise<BookmarkSyncResult>;
  confirmForget?: (deviceName: string) => boolean;
};

export function BrowserBookmarksPanel({
  repository,
  workspace,
  cache,
  onWorkspaceReload,
  requestPermission = () => requestBookmarksPermission(),
  readBookmarks = () => readBrowserBookmarks(),
  getDevice = () => getOrCreateBookmarkDevice(),
  saveDevice = (device) => saveBookmarkDevice(device),
  sync = syncBrowserBookmarks,
  confirmForget = (deviceName) => window.confirm(`Forget ${deviceName}? Its uploaded bookmark snapshot will be removed. Chrome bookmarks will not change.`),
}: BrowserBookmarksPanelProps) {
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [sources, setSources] = useState<BookmarkSource[]>([]);
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});

  async function refreshSources() {
    const next = await repository.listSources();
    setSources(next);
    setDraftNames(Object.fromEntries(next.map((source) => [source.id, source.device_name])));
  }

  useEffect(() => {
    void refreshSources().catch((reason) => setState({ kind: "error", message: reason instanceof Error ? reason.message : "Could not load bookmark devices." }));
  }, [repository]);

  async function executeSync(device: BookmarkDevice) {
    setState({ kind: "syncing" });
    try {
      const result = await sync({ repository, workspace, cache, device, read: readBookmarks, batchSize: 200 });
      await saveDevice({ ...device, sourceId: result.sourceId });
      await refreshSources();
      await onWorkspaceReload();
      setState({ kind: "success", result });
    } catch (reason) {
      setState({ kind: "error", message: reason instanceof Error ? reason.message : "Could not sync browser bookmarks." });
    }
  }

  async function beginSync() {
    try {
      if (!(await requestPermission())) {
        setState({ kind: "error", message: "Bookmark permission was not granted." });
        return;
      }
      const device = await getDevice();
      if (device.sourceId && sources.some((source) => source.id === device.sourceId)) await executeSync(device);
      else setState({ kind: "naming", device });
    } catch (reason) {
      setState({ kind: "error", message: reason instanceof Error ? reason.message : "Could not request bookmark access." });
    }
  }

  async function renameSource(source: BookmarkSource) {
    const name = (draftNames[source.id] ?? "").trim();
    if (!name) return setState({ kind: "error", message: "Device name is required." });
    try {
      await repository.renameSource(source.id, name);
      const device = await getDevice();
      if (device.sourceId === source.id) await saveDevice({ ...device, name });
      await refreshSources();
    } catch (reason) {
      setState({ kind: "error", message: reason instanceof Error ? reason.message : "Could not rename this device." });
    }
  }

  async function forgetSource(source: BookmarkSource) {
    const displayName = draftNames[source.id]?.trim() || source.device_name;
    if (!confirmForget(displayName)) return;
    try {
      await repository.forgetSource(source.id);
      const device = await getDevice();
      if (device.sourceId === source.id) await saveDevice({ key: device.key, name: device.name });
      await refreshSources();
      await onWorkspaceReload();
    } catch (reason) {
      setState({ kind: "error", message: reason instanceof Error ? reason.message : "Could not forget this device." });
    }
  }

  const lastSynced = sources.map((source) => source.last_synced_at).filter(Boolean).sort().at(-1);
  return <section className="bookmark-sync-panel" aria-label="Browser bookmark sync">
    <header>
      <div><BookMarked size={18} /><span><b>Browser Bookmarks</b><small>{lastSynced ? `Last synced ${new Date(lastSynced).toLocaleString()}` : "Manual sync from this browser"}</small></span></div>
      <button disabled={state.kind === "syncing"} onClick={() => void beginSync()}><RefreshCw size={15} />{sources.length ? "Sync now" : "Sync browser bookmarks"}</button>
    </header>

    {state.kind === "error" && <p className="bookmark-sync-status error" role="alert">{state.message}</p>}
    {state.kind === "syncing" && <p className="bookmark-sync-status" role="status">Reading and synchronizing bookmarks…</p>}
    {state.kind === "success" && <p className="bookmark-sync-status" role="status">{state.result.bookmarkCount} bookmarks · {state.result.collectionCount} collections · {state.result.deviceOnlyCount} device-only or unknown · {state.result.skipped} skipped</p>}

    {state.kind === "naming" && <form className="bookmark-device-name" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const name = String(data.get("deviceName") ?? "").trim();
      if (!name) return setState({ kind: "error", message: "Device name is required." });
      void executeSync({ ...state.device, name });
    }}>
      <label>Device name<input aria-label="Device name" name="deviceName" defaultValue={state.device.name} maxLength={80} /></label>
      <button type="submit">Start sync</button>
    </form>}

    {!!sources.length && <div className="bookmark-device-list">
      {sources.map((source) => <div key={source.id}>
        <label><span className="sr-only">Device name for {source.device_name}</span><input aria-label={`Device name for ${source.device_name}`} value={draftNames[source.id] ?? source.device_name} maxLength={80} onChange={(event) => setDraftNames((current) => ({ ...current, [source.id]: event.target.value }))} /></label>
        <small>{source.last_synced_at ? new Date(source.last_synced_at).toLocaleString() : "Not synced"}</small>
        <button aria-label={`Save ${draftNames[source.id] ?? source.device_name} name`} onClick={() => void renameSource(source)}><Save size={14} /></button>
        <button aria-label={`Forget ${draftNames[source.id] ?? source.device_name}`} onClick={() => void forgetSource(source)}><Trash2 size={14} /></button>
      </div>)}
    </div>}
  </section>;
}
