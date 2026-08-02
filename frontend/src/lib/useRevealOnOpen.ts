"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Bring a just-opened inline panel into view and focus its first empty
 * required field.
 *
 * The problem this solves: selecting an API-key integration expands its
 * credential form somewhere below the fold. The page does not move, nothing
 * takes focus, and the click reads as "nothing happened" - the user is still
 * looking at the tile they clicked.
 *
 * Design constraints (all deliberate):
 *  - **No timeouts.** We reveal from a layout effect keyed on the panel's ref
 *    being populated, so it runs when the node genuinely exists. `setTimeout`
 *    guesses, and guesses race with slow renders.
 *  - **Once per open.** Keyed on `key` (the panel's identity), so unrelated
 *    rerenders - a keystroke in the field, a parent state change - never
 *    re-scroll or re-steal focus while the user is typing.
 *  - **Never steals focus from restored state.** Pass `focus: false` when
 *    rendering an already-configured panel; it scrolls but leaves the caret.
 *  - **Respects reduced motion.** `prefers-reduced-motion` gets an instant
 *    jump instead of a smooth scroll.
 *  - **Sticky-header safe.** `scrollIntoView({block:"nearest"})` moves the
 *    minimum needed, so a panel already fully visible does not jump at all.
 *
 * @returns a ref to attach to the panel's outermost element.
 */
export function useRevealOnOpen<T extends HTMLElement = HTMLDivElement>(
  /** Identity of what is open (e.g. the slug). `null` = nothing open. */
  key: string | null,
  opts: { focus?: boolean } = {},
) {
  const { focus = true } = opts;
  const ref = useRef<T | null>(null);
  const revealedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!key) { revealedFor.current = null; return; }
    if (revealedFor.current === key) return; // already revealed this panel
    const node = ref.current;
    if (!node) return;                        // not mounted yet - rerun on the render that mounts it
    revealedFor.current = key;

    const reduced = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });

    if (!focus) return;
    // First EMPTY required control - never clobber a value the user already has.
    const candidates = Array.from(
      node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"),
    ).filter((el) => !el.disabled && el.type !== "hidden");
    const target = candidates.find((el) => !("value" in el) || !el.value) ?? candidates[0];
    // preventScroll: scrollIntoView above already positioned the panel; letting
    // focus() scroll again fights it and lands somewhere else.
    target?.focus({ preventScroll: true });
  });

  /** Call when a validation error should pull focus to the offending field. */
  const focusInvalid = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const invalid = node.querySelector<HTMLElement>("[aria-invalid='true'], :invalid");
    (invalid ?? node.querySelector<HTMLElement>("input, textarea, select"))?.focus({ preventScroll: false });
  }, []);

  return { ref, focusInvalid };
}
