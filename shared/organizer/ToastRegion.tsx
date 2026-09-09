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

type ToastSemantics = {
  actionLabel?: string;
  actionHandler?: () => void;
  message: string;
  tone: "success" | "error";
};

function semanticsFor(toast: OrganizerToast): ToastSemantics {
  return {
    actionLabel: toast.action?.label,
    actionHandler: toast.action?.onAction,
    message: toast.message,
    tone: toast.tone ?? "success",
  };
}

function hasSameSemantics(left: ToastSemantics, right: ToastSemantics): boolean {
  return left.actionLabel === right.actionLabel
    && left.actionHandler === right.actionHandler
    && left.message === right.message
    && left.tone === right.tone;
}

export function ToastRegion({ onDismiss, toasts }: ToastRegionProps) {
  const onDismissRef = useRef(onDismiss);
  const dismissedToastSemanticsRef = useRef(new Map<string, ToastSemantics>());
  const timersRef = useRef(new Map<string, { deadline: number; handle: ReturnType<typeof globalThis.setTimeout>; semantics: ToastSemantics }>());

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
    for (const id of dismissedToastSemanticsRef.current.keys()) {
      if (!transientIds.has(id)) dismissedToastSemanticsRef.current.delete(id);
    }

    for (const toast of transientToasts) {
      const semantics = semanticsFor(toast);
      const dismissedSemantics = dismissedToastSemanticsRef.current.get(toast.id);
      if (dismissedSemantics && hasSameSemantics(dismissedSemantics, semantics)) continue;
      if (dismissedSemantics) dismissedToastSemanticsRef.current.delete(toast.id);

      const existingTimer = timersRef.current.get(toast.id);
      if (existingTimer && !hasSameSemantics(existingTimer.semantics, semantics)) {
        globalThis.clearTimeout(existingTimer.handle);
        timersRef.current.delete(toast.id);
      }
      const currentTimer = timersRef.current.get(toast.id);
      if (currentTimer) {
        if (currentTimer.deadline > Date.now()) continue;
        globalThis.clearTimeout(currentTimer.handle);
        timersRef.current.delete(toast.id);
        dismissedToastSemanticsRef.current.set(toast.id, semantics);
        onDismissRef.current(toast.id);
        continue;
      }
      const deadline = Date.now() + 3_000;
      const handle = globalThis.setTimeout(() => {
        timersRef.current.delete(toast.id);
        dismissedToastSemanticsRef.current.set(toast.id, semantics);
        onDismissRef.current(toast.id);
      }, deadline - Date.now());
      timersRef.current.set(toast.id, { deadline, handle, semantics });
    }
  });

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) globalThis.clearTimeout(timer.handle);
    timersRef.current.clear();
    dismissedToastSemanticsRef.current.clear();
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
