import { ToastRegion as SharedToastRegion, type OrganizerToast } from "../shared/organizer/ToastRegion";

export type ToastRegionProps = {
  error: string;
  message: string;
  onDismissError: () => void;
  onDismissMessage: () => void;
};

export function ToastRegion({ error, message, onDismissError, onDismissMessage }: ToastRegionProps) {
  const toasts: OrganizerToast[] = [
    ...(message ? [{ id: "message", message, tone: "success" as const }] : []),
    ...(error ? [{ id: "error", message: error, tone: "error" as const }] : []),
  ];
  return <SharedToastRegion onDismiss={(id) => { if (id === "message") onDismissMessage(); else onDismissError(); }} toasts={toasts} />;
}
