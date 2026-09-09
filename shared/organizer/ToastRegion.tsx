import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";

export type OrganizerToast = {
  action?: { label: string; onAction: () => void };
  id: string;
  message: string;
  persistent?: boolean;
  tone?: "success" | "error";
};

export type ToastRegionProps = {
  onDismiss: (id: string) => void;
  toasts: OrganizerToast[];
};

export function ToastRegion({ onDismiss, toasts }: ToastRegionProps) {
  const onDismissRef = useRef(onDismiss);
  const dismissedToastIdsRef = useRef(new Set<string>());
  const timersRef = useRef(new Map<string, { deadline: number; handle: ReturnType<typeof globalThis.setTimeout> }>());

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const transientToasts = toasts.filter((toast) => !toast.persistent && !toast.action);
    const transientIds = new Set(transientToasts.map((toast) => toast.id));

    for (const [id, timer] of timersRef.current) {
      if (transientIds.has(id)) continue;
      globalThis.clearTimeout(timer.handle);
      timersRef.current.delete(id);
    }
    for (const id of dismissedToastIdsRef.current) {
      if (!transientIds.has(id)) dismissedToastIdsRef.current.delete(id);
    }

    for (const toast of transientToasts) {
      if (dismissedToastIdsRef.current.has(toast.id)) continue;
      const existingTimer = timersRef.current.get(toast.id);
      if (existingTimer) {
        if (existingTimer.deadline > Date.now()) continue;
        globalThis.clearTimeout(existingTimer.handle);
        timersRef.current.delete(toast.id);
        dismissedToastIdsRef.current.add(toast.id);
        onDismissRef.current(toast.id);
        continue;
      }
      const deadline = Date.now() + 3_000;
      const handle = globalThis.setTimeout(() => {
        timersRef.current.delete(toast.id);
        dismissedToastIdsRef.current.add(toast.id);
        onDismissRef.current(toast.id);
      }, deadline - Date.now());
      timersRef.current.set(toast.id, { deadline, handle });
    }
  });

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) globalThis.clearTimeout(timer.handle);
    timersRef.current.clear();
    dismissedToastIdsRef.current.clear();
  }, []);

  if (!toasts.length) return null;
  return <section aria-label="Notifications" className="organizer-toast-region toast-region">
    {toasts.map((toast) => {
      const error = toast.tone === "error";
      return <p className={`organizer-toast ${error ? "error" : ""}`} key={toast.id} role={error ? "alert" : "status"}>
        {error ? <CircleAlert aria-hidden="true" size={17} /> : <CircleCheck aria-hidden="true" size={17} />}
        <span>{toast.message}</span>
        {toast.action && <button onClick={toast.action.onAction} type="button">{toast.action.label}</button>}
        {error && <button aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)} type="button"><X aria-hidden="true" size={14} /></button>}
      </p>;
    })}
  </section>;
}
