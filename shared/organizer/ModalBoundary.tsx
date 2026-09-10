import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { registerModal } from "./modal-stack";

/** One viewport portal owns keyboard focus and temporarily disables its siblings. */
export function ModalBoundary({ children, label, className, onClose, initialFocus, busy = false, owner }: {
  children: ReactNode;
  label: string;
  className: string;
  onClose: () => void;
  initialFocus?: string;
  busy?: boolean;
  owner?: string;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  useLayoutEffect(() => { closeRef.current = onClose; busyRef.current = busy; });
  useLayoutEffect(() => registerModal({
    root: rootRef.current!,
    owner,
    initialFocus,
    onClose: () => closeRef.current(),
    isBusy: () => busyRef.current,
  }), [initialFocus, owner]);
  return createPortal(<section ref={rootRef} role="dialog" aria-modal="true" aria-label={label} aria-busy={busy || undefined} className={className} tabIndex={-1}>{children}</section>, document.body);
}
