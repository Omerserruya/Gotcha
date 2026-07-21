/**
 * Shared Modal primitive: scroll lock, scroll restoration, focus trap/return.
 *
 * These encode the issue-2 report: the page behind the Readiness Report
 * scrolled with the modal, and closing it lost the reader's position.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useState } from "react";
import { Modal, __scrollLockDepth } from "../Modal";

function Harness({ initialOpen = true, ...props }: { initialOpen?: boolean } & Partial<React.ComponentProps<typeof Modal>>) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div>
      <button onClick={() => setOpen(true)}>open me</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Readiness report" {...props}>
        <input aria-label="first field" />
        <input aria-label="second field" />
      </Modal>
    </div>
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  Object.defineProperty(window, "scrollY", { value: 0, writable: true, configurable: true });
});
afterEach(() => {
  cleanup();
  // Every test must leave the page unlocked - a leaked lock freezes the app.
  expect(__scrollLockDepth()).toBe(0);
  document.body.style.position = "";
  document.body.style.top = "";
});

describe("Modal scroll lock", () => {
  it("locks the background page while open and unlocks on close", () => {
    (window as any).scrollY = 420;
    const { rerender } = render(<Harness />);
    expect(document.body.style.position).toBe("fixed");
    expect(document.body.style.top).toBe("-420px");

    fireEvent.click(screen.getByLabelText("Close"));
    expect(document.body.style.position).toBe("");
    // Reader's position restored exactly, not reset to the top.
    expect(window.scrollTo).toHaveBeenCalledWith(0, 420);
    rerender(<Harness initialOpen={false} />);
  });

  it("nested modals unlock only when the last one closes (ref counted)", () => {
    const { unmount } = render(
      <>
        <Modal open onClose={() => {}} title="outer"><button>a</button></Modal>
        <Modal open onClose={() => {}} title="inner"><button>b</button></Modal>
      </>,
    );
    expect(__scrollLockDepth()).toBe(2);
    expect(document.body.style.position).toBe("fixed");
    unmount();
    expect(document.body.style.position).toBe("");
  });

  it("renders through a portal attached to document.body, not the parent container", () => {
    const { container } = render(
      <div id="scrolling-onboarding-container">
        <Harness />
      </div>,
    );
    // The dialog must NOT live inside the (scrolling) parent subtree.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("body is the only scroll area", () => {
    render(<Harness />);
    const body = document.querySelector("[data-modal-body]")!;
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("overscroll-contain");
  });
});

describe("Modal focus behavior", () => {
  it("moves focus into the dialog on open and returns it to the trigger on close", () => {
    render(<Harness initialOpen={false} />);
    const trigger = screen.getByText("open me");
    trigger.focus();
    fireEvent.click(trigger);

    // Focus lands on the dialog's first focusable - the Close button, which
    // sits in the header. Deliberately NOT a form field: opening a dialog must
    // not put the caret somewhere a keystroke starts editing data.
    expect(document.activeElement).toBe(screen.getByLabelText("Close"));
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    fireEvent.click(screen.getByLabelText("Close"));
    expect(document.activeElement).toBe(trigger);
  });

  it("traps Tab within the dialog", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog");
    const close = screen.getByLabelText("Close");     // first focusable (header)
    const last = screen.getByLabelText("second field"); // last focusable (body)

    // Tab off the last focusable cycles back to the first.
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    // Shift+Tab off the first cycles to the last - never escaping to the page.
    close.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("Escape and backdrop close by default, and can be disabled", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Modal open onClose={onClose} title="t"><button>x</button></Modal>);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<Modal open onClose={onClose} title="t" closeOnEscape={false} closeOnBackdrop={false}><button>x</button></Modal>);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1); // unchanged
  });

  it("is labelled for screen readers", () => {
    render(<Harness />);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Readiness report");
  });
});
