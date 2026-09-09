import '@testing-library/jest-dom/vitest';

import { beforeAll } from 'vitest';

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
