/**
 * Issue-7 regression: selecting an API-key integration expanded its credential
 * form below the fold with no scroll and no focus, so the click read as
 * "nothing happened". These lock the three behaviours that fix it - and the
 * one that must NOT happen (re-scrolling while the user types).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { useRevealOnOpen } from "../useRevealOnOpen";

const scrollIntoView = vi.fn();
beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
});

function Panel({ focus = true }: { focus?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const { ref } = useRevealOnOpen<HTMLDivElement>(open, { focus });
  return (
    <div>
      <button onClick={() => setOpen("fireberry")}>Select Fireberry</button>
      <button onClick={() => setOpen("airtable")}>Select Airtable</button>
      {open && (
        <div ref={ref} data-testid="panel">
          <input aria-label="API key" value={value} onChange={(e) => setValue(e.target.value)} />
          <button>Connect</button>
        </div>
      )}
    </div>
  );
}

describe("useRevealOnOpen", () => {
  it("scrolls the panel into view and focuses the first empty field when it opens", () => {
    render(<Panel />);
    fireEvent.click(screen.getByText("Select Fireberry"));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });
    expect(document.activeElement).toBe(screen.getByLabelText("API key"));
  });

  it("does not re-scroll or steal focus on unrelated rerenders (typing)", () => {
    render(<Panel />);
    fireEvent.click(screen.getByText("Select Fireberry"));
    scrollIntoView.mockClear();

    const input = screen.getByLabelText("API key");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.change(input, { target: { value: "abc123" } });

    // The reveal is once-per-panel: typing must not yank the page around.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("reveals again when a DIFFERENT integration is selected", () => {
    render(<Panel />);
    fireEvent.click(screen.getByText("Select Fireberry"));
    scrollIntoView.mockClear();
    fireEvent.click(screen.getByText("Select Airtable"));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("respects prefers-reduced-motion with an instant jump", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    render(<Panel />);
    fireEvent.click(screen.getByText("Select Fireberry"));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "nearest" });
  });

  it("scrolls without stealing focus when restoring an existing configuration", () => {
    render(<Panel focus={false} />);
    const trigger = screen.getByText("Select Fireberry");
    fireEvent.click(trigger);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(screen.getByLabelText("API key"));
  });
});
