import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useEffect } from "react";

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
  useEffect(() => {
    const timers = toasts
      .filter((toast) => !toast.persistent && !toast.action)
      .map((toast) => window.setTimeout(() => onDismiss(toast.id), 3_000));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [onDismiss, toasts]);

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
