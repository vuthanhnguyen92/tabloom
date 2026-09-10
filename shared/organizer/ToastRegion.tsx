import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

export type OrganizerToast = {
  action?: { label: string; onAction: () => void; disabled?: boolean };
  id: string;
  message: string;
  persistent?: boolean;
  /** Action toasts normally persist; Undo explicitly opts into a short lifetime. */
  expiresAfter?: number;
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

type ToastTimer = {
  deadline: number;
  generation: number;
  handle: ReturnType<typeof globalThis.setTimeout>;
  semantics: ToastSemantics;
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
  const nextTimerGenerationRef = useRef(0);
  const timersRef = useRef(new Map<string, ToastTimer>());

  useLayoutEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useLayoutEffect(() => {
    const transientToasts = toasts.filter((toast) => !toast.persistent && (!toast.action || toast.expiresAfter !== undefined));
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
      const deadline = Date.now() + (toast.expiresAfter ?? 3_000);
      const generation = ++nextTimerGenerationRef.current;
      const handle = globalThis.setTimeout(() => {
        if (timersRef.current.get(toast.id)?.generation !== generation) return;
        timersRef.current.delete(toast.id);
        dismissedToastSemanticsRef.current.set(toast.id, semantics);
        onDismissRef.current(toast.id);
      }, deadline - Date.now());
      const timer = { deadline, generation, handle, semantics };
      timersRef.current.set(toast.id, timer);
    }
  });

  useLayoutEffect(() => () => {
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
        {toast.action && <button onClick={toast.action.onAction} disabled={toast.action.disabled} type="button">{toast.action.label}</button>}
        {error && <button aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)} type="button"><X aria-hidden="true" size={14} /></button>}
      </p>;
    })}
  </section>;
}
