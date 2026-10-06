import '@testing-library/jest-dom/vitest';

import { toHaveTextContent } from '@testing-library/jest-dom/matchers';
import { beforeAll, expect } from 'vitest';

/**
 * Text as a person reads it: without the four Unicode direction isolates
 * (U+2066–U+2069). Sentences carry a customer's name or an order number
 * wrapped in FSI…PDI so Hebrew cannot reorder them (`approvals/isolate.ts`);
 * they are invisible, so an assertion about what the screen SAYS ignores them.
 * Anything else — a missing element, `.not` — behaves as jest-dom's own.
 */
const ISOLATES = /[\u2066-\u2069]/g;
// Not the /g one: `.test` on a global regex keeps `lastIndex` between calls.
const HAS_ISOLATE = /[\u2066-\u2069]/;
expect.extend({
  toHaveTextContent(element: unknown, ...rest: unknown[]) {
    if (!(element instanceof Element) || !HAS_ISOLATE.test(element.textContent ?? '')) {
      return (toHaveTextContent as (...a: unknown[]) => unknown).call(
        this,
        element,
        ...rest,
      ) as never;
    }
    const read = document.createElement('div');
    read.textContent = (element.textContent ?? '').replace(ISOLATES, '');
    return (toHaveTextContent as (...a: unknown[]) => unknown).call(this, read, ...rest) as never;
  },
});

/**
 * The minimum environment the app needs that jsdom does not provide.
 * Kept small on purpose: a large shim file is a place where tests quietly stop
 * resembling a browser.
 */
beforeAll(() => {
  // Server-side modules are tested under the `node` environment, where none of
  // these browser shims apply and `window` does not exist.
  if (typeof window === 'undefined') return;

  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }),
    });
  }

  // Radix measures elements it positions; jsdom implements neither.
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});
