import { expect } from 'vitest';

import rowLink from '@/design-system/styles/row-link.module.css';

/**
 * Settings' clickable rows (`design-system/styles/row-link.module.css`),
 * asserted the same way on every screen.
 *
 * ⚠ A TAB STOP HERE IS ANY `<a>`, href or not. Several suites mock `Link`
 *   without passing `href` on; counting only `a[href]` would read such a row
 *   as having no stop at all, and pass a row with two.
 */
const FOCUSABLE = 'a, button, input, select, textarea, [tabindex]';

export function tabStops(row: Element): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1',
  );
}

function isAbove(el: Element, row: Element): boolean {
  for (let at: Element | null = el; at && at !== row; at = at.parentElement) {
    if (at.classList.contains(rowLink.above!)) return true;
  }
  return false;
}

/**
 * The row is clickable across its width through its ONE link: that link is
 * stretched over the row, and is the row's only tab stop - or, in a row with
 * `controls` other controls (a switch, a menu), each of those keeps its own
 * stop and sits above the overlay. Answers the link.
 */
export function expectStretchedRow(row: HTMLElement, { controls = 0 } = {}): HTMLElement {
  expect(row.classList.contains(rowLink.row!), 'the row is the hit area').toBe(true);
  const stops = tabStops(row);
  const links = stops.filter((el) => el.classList.contains(rowLink.link!));
  expect(links, 'exactly one stretched link').toHaveLength(1);
  const others = stops.filter((el) => !el.classList.contains(rowLink.link!));
  expect(others, 'the other tab stops').toHaveLength(controls);
  for (const other of others) expect(isAbove(other, row), 'a control above the overlay').toBe(true);
  return links[0]!;
}

/** A row left as it was: nothing in it is stretched over it. */
export function expectPlainRow(row: HTMLElement): void {
  expect(row.classList.contains(rowLink.row!)).toBe(false);
  expect(tabStops(row).some((el) => el.classList.contains(rowLink.link!))).toBe(false);
}
