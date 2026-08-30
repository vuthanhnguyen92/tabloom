export type ToastRegionProps = {
  error: string;
  message: string;
  onDismissError: () => void;
  onDismissMessage: () => void;
};

export function ToastRegion({ error, message, onDismissError, onDismissMessage }: ToastRegionProps) {
  const dismissErrorRef = useRef(onDismissError);
  const dismissMessageRef = useRef(onDismissMessage);

  useEffect(() => {
    dismissErrorRef.current = onDismissError;
  }, [onDismissError]);

  useEffect(() => {
    dismissMessageRef.current = onDismissMessage;
  }, [onDismissMessage]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => dismissMessageRef.current(), 3_000);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => dismissErrorRef.current(), 3_000);
    return () => window.clearTimeout(timer);
  }, [error]);

  if (!message && !error) return null;
  return <div aria-label="Notifications" className="toast-region">
    {message && <p className="ext-toast" role="status"><CircleCheck aria-hidden="true" size={17} /><span>{message}</span></p>}
    {error && <p className="ext-toast error" role="alert"><CircleAlert aria-hidden="true" size={17} /><span>{error}</span><button aria-label="Dismiss notification" onClick={onDismissError}><X size={14} /></button></p>}
  </div>;
}
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";
