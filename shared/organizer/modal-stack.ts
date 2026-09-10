const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]';

type ModalRegistration = {
  root: HTMLElement;
  owner?: string;
  initialFocus?: string;
  onClose: () => void;
  isBusy: () => boolean;
};
type ModalEntry = ModalRegistration & {
  lastFocused: HTMLElement | null;
  originalZIndex: string;
  originalZPriority: string;
  baseZIndex: number;
};

const stacks = new WeakMap<Document, ModalStack>();

function focusable(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter((node) => node.tabIndex >= 0 && !node.closest('[hidden], [inert], [aria-hidden="true"]') && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden");
}

/** One owner per document captures the background once, regardless of teardown order. */
class ModalStack {
  private entries: ModalEntry[] = [];
  private originalInert = new Map<Element, string | null>();
  private originalOverflow = "";
  private originalOverflowPriority = "";
  private opener: HTMLElement | null = null;

  constructor(private document: Document) {}

  get top() { return this.entries.at(-1); }

  register(registration: ModalRegistration) {
    if (!this.entries.length) {
      this.opener = this.document.activeElement instanceof HTMLElement ? this.document.activeElement : null;
      this.originalOverflow = this.document.body.style.overflow;
      this.originalOverflowPriority = this.document.body.style.getPropertyPriority("overflow");
      this.document.body.style.setProperty("overflow", "hidden");
      this.document.addEventListener("keydown", this.keydown, true);
      this.document.addEventListener("focusin", this.focusin);
    }
    const entry: ModalEntry = {
      ...registration,
      lastFocused: null,
      originalZIndex: registration.root.style.zIndex,
      originalZPriority: registration.root.style.getPropertyPriority("z-index"),
      baseZIndex: Number.parseInt(getComputedStyle(registration.root).zIndex, 10) || 0,
    };
    this.entries.push(entry);
    this.reconcile();
    this.focus(entry);
    return () => this.remove(entry);
  }

  private reconcile() {
    for (const node of Array.from(this.document.body.children)) {
      if (!this.originalInert.has(node)) this.originalInert.set(node, node.getAttribute("inert"));
      if (node === this.top?.root) node.removeAttribute("inert");
      else node.setAttribute("inert", "");
    }
    const base = Math.max(...this.entries.map((entry) => entry.baseZIndex));
    this.entries.forEach((entry, index) => entry.root.style.setProperty("z-index", String(base + index)));
  }

  private focus(entry: ModalEntry) {
    const preferred = entry.lastFocused ?? (entry.initialFocus ? entry.root.querySelector<HTMLElement>(entry.initialFocus) : null);
    if (preferred?.isConnected && entry.root.contains(preferred) && !preferred.matches(":disabled") && !preferred.closest("[inert], [hidden]")) preferred.focus();
    if (!entry.root.contains(this.document.activeElement)) (focusable(entry.root)[0] ?? entry.root).focus();
  }

  private remove(entry: ModalEntry) {
    const index = this.entries.indexOf(entry);
    if (index === -1) return;
    const wasTop = this.top === entry;
    this.entries.splice(index, 1);
    entry.root.style.setProperty("z-index", entry.originalZIndex, entry.originalZPriority);
    if (this.top) {
      this.reconcile();
      if (wasTop) this.focus(this.top);
      return;
    }
    this.document.removeEventListener("keydown", this.keydown, true);
    this.document.removeEventListener("focusin", this.focusin);
    for (const [node, inert] of this.originalInert) {
      if (inert === null) node.removeAttribute("inert");
      else node.setAttribute("inert", inert);
    }
    this.originalInert.clear();
    this.document.body.style.setProperty("overflow", this.originalOverflow, this.originalOverflowPriority);
    if (this.opener?.isConnected && !this.opener.closest("[inert]")) this.opener.focus();
    this.opener = null;
  }

  private keydown = (event: KeyboardEvent) => {
    const top = this.top;
    if (!top) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!top.isBusy()) top.onClose();
    } else if (event.key === "Tab") {
      const items = focusable(top.root);
      const index = items.indexOf(this.document.activeElement as HTMLElement);
      if (!items.length || (event.shiftKey ? index <= 0 : index < 0 || index === items.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? items.at(-1) ?? top.root : items[0] ?? top.root).focus();
      }
    }
  };

  private focusin = (event: FocusEvent) => {
    const top = this.top;
    if (!top) return;
    if (event.target instanceof HTMLElement && top.root.contains(event.target)) top.lastFocused = event.target;
    else this.focus(top);
  };
}

export function registerModal(registration: ModalRegistration) {
  const document = registration.root.ownerDocument;
  let stack = stacks.get(document);
  if (!stack) { stack = new ModalStack(document); stacks.set(document, stack); }
  return stack.register(registration);
}

export function canUseModalShortcut(document: Document, owner: string): boolean {
  const top = stacks.get(document)?.top;
  return !top || top.owner === owner;
}
