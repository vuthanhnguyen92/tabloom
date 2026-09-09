import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ModalBoundary } from "../shared/organizer/ModalBoundary";

function Modal({ name, onClose = () => undefined }: { name: string; onClose?: () => void }) {
  return <ModalBoundary label={name} className="test-modal" onClose={onClose} initialFocus="input">
    <label>{name} input<input /></label><button onClick={onClose}>Close {name}</button>
  </ModalBoundary>;
}

describe("organizer modal stack", () => {
  it("keeps the active modal visually above lower modals with higher default stacking levels", () => {
    const style = document.createElement("style");
    style.textContent = ".lower-modal { position: fixed; z-index: 110; } .upper-modal { position: fixed; z-index: 100; }";
    document.head.appendChild(style);
    const { unmount } = render(<>
      <ModalBoundary label="Lower" className="lower-modal" onClose={() => undefined}><button>Lower action</button></ModalBoundary>
      <ModalBoundary label="Upper" className="upper-modal" onClose={() => undefined}><button>Upper action</button></ModalBoundary>
    </>);
    try {
      const lower = screen.getByRole("dialog", { name: "Lower" });
      const upper = screen.getByRole("dialog", { name: "Upper" });
      expect(Number(getComputedStyle(upper).zIndex)).toBeGreaterThan(Number(getComputedStyle(lower).zIndex));
      expect(screen.getByRole("button", { name: "Upper action" })).toHaveFocus();
      unmount();
      expect(lower.style.zIndex).toBe("");
      expect(upper.style.zIndex).toBe("");
    } finally { unmount(); style.remove(); }
  });

  it("makes the last simultaneously mounted modal active and wraps focus only inside it", async () => {
    const user = userEvent.setup();
    const closeA = vi.fn();
    const closeB = vi.fn();
    const { container } = render(<><Modal name="A" onClose={closeA} /><Modal name="B" onClose={closeB} /></>);
    expect(screen.getByRole("dialog", { name: "A" })).toHaveAttribute("inert");
    expect(screen.getByRole("dialog", { name: "B" })).not.toHaveAttribute("inert");
    expect(screen.getByLabelText("B input")).toHaveFocus();
    expect(container).toHaveAttribute("inert");
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Close B" })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("B input")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(closeB).toHaveBeenCalledOnce();
    expect(closeA).not.toHaveBeenCalled();
  });

  it("restores the lower modal's last focused control after a sequentially opened modal closes", async () => {
    function Harness() {
      const [outer, setOuter] = useState(false);
      const [inner, setInner] = useState(false);
      return <><button onClick={() => setOuter(true)}>Open outer</button>
        {outer && <ModalBoundary label="Outer" className="test-modal" onClose={() => setOuter(false)}>
          <button onClick={() => setInner(true)}>Open inner</button><button onClick={() => setOuter(false)}>Close outer</button>
        </ModalBoundary>}
        {inner && <Modal name="Inner" onClose={() => setInner(false)} />}
      </>;
    }
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open outer" });
    await user.click(opener);
    const innerOpener = screen.getByRole("button", { name: "Open inner" });
    await user.click(innerOpener);
    expect(screen.getByLabelText("Inner input")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Outer" })).not.toHaveAttribute("inert");
    expect(innerOpener).toHaveFocus();
    expect(container).toHaveAttribute("inert");
    await user.keyboard("{Escape}");
    expect(container).not.toHaveAttribute("inert");
    expect(opener).toHaveFocus();
  });

  it("retains top-modal ownership on non-LIFO removal and restores original background state at final cleanup", () => {
    const preserved = document.createElement("div");
    preserved.setAttribute("inert", "original");
    document.body.appendChild(preserved);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "scroll";
    function Stack({ lower, upper }: { lower: boolean; upper: boolean }) {
      return <><button>Workspace opener</button>{lower && <Modal name="Lower" />}{upper && <Modal name="Upper" />}</>;
    }
    const { container, rerender, unmount } = render(<Stack lower={false} upper={false} />);
    const opener = screen.getByRole("button", { name: "Workspace opener" });
    opener.focus();
    try {
      rerender(<Stack lower upper={false} />);
      rerender(<Stack lower upper />);
      const input = screen.getByLabelText("Upper input");
      rerender(<Stack lower={false} upper />);
      expect(input).toHaveFocus();
      expect(screen.getByRole("dialog", { name: "Upper" })).not.toHaveAttribute("inert");
      expect(container).toHaveAttribute("inert");
      expect(document.body.style.overflow).toBe("hidden");
      rerender(<Stack lower={false} upper={false} />);
      expect(container).not.toHaveAttribute("inert");
      expect(preserved).toHaveAttribute("inert", "original");
      expect(document.body.style.overflow).toBe("scroll");
      expect(opener).toHaveFocus();
      // No stale focus listener may reclaim focus after every modal is gone.
      opener.blur();
      fireEvent.focusIn(opener);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
      unmount();
      preserved.remove();
      document.body.style.overflow = originalOverflow;
    }
  });

  it("cleans up simultaneously mounted modals under StrictMode and leaves unrelated controls focusable", () => {
    const { container, rerender } = render(<StrictMode><button>Outside action</button></StrictMode>);
    const opener = screen.getByRole("button", { name: "Outside action" });
    opener.focus();
    const overflow = document.body.style.overflow;
    rerender(<StrictMode><button>Outside action</button><Modal name="A" /><Modal name="B" /></StrictMode>);
    expect(screen.getByLabelText("B input")).toHaveFocus();
    rerender(<StrictMode><button>Outside action</button></StrictMode>);
    expect(container).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe(overflow);
    expect(opener).toHaveFocus();
    opener.blur();
    opener.focus();
    expect(opener).toHaveFocus();
  });
});
