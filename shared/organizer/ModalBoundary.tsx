import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]';

/** One viewport portal owns keyboard focus and temporarily disables its siblings. */
export function ModalBoundary({ children, label, className, onClose, initialFocus, busy = false }: {
  children: ReactNode;
  label: string;
  className: string;
  onClose: () => void;
  initialFocus?: string;
  busy?: boolean;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  useLayoutEffect(() => { closeRef.current = onClose; busyRef.current = busy; });
  useLayoutEffect(() => {
    const root = rootRef.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = Array.from(document.body.children).filter((node) => node !== root);
    const previous = siblings.map((node) => ({ node, inert: node.getAttribute("inert") }));
    previous.forEach(({ node }) => node.setAttribute("inert", ""));
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function focusable() {
      return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter((node) => node.tabIndex >= 0 && !node.closest('[hidden], [inert], [aria-hidden="true"]') && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden");
    }
    function focusFirst() { (focusable()[0] ?? root).focus(); }
    (initialFocus ? root.querySelector<HTMLElement>(initialFocus) : null)?.focus();
    if (!root.contains(document.activeElement)) focusFirst();
    function keydown(event: KeyboardEvent) {
      if (root.hasAttribute("inert")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
      } else if (event.key === "Tab") {
        const items = focusable();
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length || (event.shiftKey ? index <= 0 : index < 0 || index === items.length - 1)) {
          event.preventDefault();
          (event.shiftKey ? items.at(-1) ?? root : items[0] ?? root).focus();
        }
      }
    }
    function focusin(event: FocusEvent) {
      if (!root.hasAttribute("inert") && !root.contains(event.target as Node)) focusFirst();
    }
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      previous.forEach(({ node, inert }) => inert === null ? node.removeAttribute("inert") : node.setAttribute("inert", inert));
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [initialFocus]);
  return createPortal(<section ref={rootRef} role="dialog" aria-modal="true" aria-label={label} aria-busy={busy || undefined} className={className} tabIndex={-1}>{children}</section>, document.body);
}
