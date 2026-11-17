import { describe, expect, it } from 'vitest';

import {
  createRscLoopCounter,
  pageKey,
  routerRequestPage,
  RSC_LOOP_LIMIT,
  RSC_LOOP_WINDOW_MS,
  type GuardStorage,
} from './rsc-loop-guard';

/**
 * ★★ A tab that asks for the same page over and over is stopped (prod,
 * 2026-11-16 and 2026-11-17: /he/system 4-5 times a second, every customer's
 * server calls refused behind it). The counter is fed what the browser
 * reports: one entry per router request.
 */

const ORIGIN = 'https://app.gotcha.co.il';

function memoryStorage(): GuardStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function setup(storage: GuardStorage | null = memoryStorage()) {
  let clock = 1_000_000;
  const counter = createRscLoopCounter({ now: () => clock, storage });
  return {
    counter,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('★★ the loop is seen', () => {
  it('★★ 5 a second: over the limit on the request after it, about 8 s in', () => {
    const { counter, advance } = setup();
    const over: number[] = [];
    for (let i = 1; i <= 150; i += 1) {
      if (counter.note('/he/system')) over.push(i);
      advance(200);
    }
    expect(over[0]).toBe(RSC_LOOP_LIMIT + 1);
  });

  it('★ Try again (clear) starts the page at zero', () => {
    const { counter } = setup();
    for (let i = 0; i <= RSC_LOOP_LIMIT; i += 1) counter.note('/he/system');
    counter.clear('/he/system');
    expect(counter.note('/he/system')).toBe(false);
  });
});

describe('★★ what a person and the product do is never over', () => {
  it('★★ the live inbox refreshing once a second for ten minutes', () => {
    const { counter, advance } = setup();
    for (let i = 0; i < 600; i += 1) {
      expect(counter.note('/he/inbox?view=mine')).toBe(false);
      advance(1_000);
    }
  });

  it('★ many pages, each asked a few times (prefetch, navigation)', () => {
    const { counter } = setup();
    for (let page = 0; page < 60; page += 1) {
      for (let i = 0; i < 3; i += 1) expect(counter.note(`/he/system/tenants/${page}`)).toBe(false);
    }
  });

  it('★ the window slides: the limit spread over more than the window is fine', () => {
    const { counter, advance } = setup();
    const step = Math.ceil(RSC_LOOP_WINDOW_MS / RSC_LOOP_LIMIT) + 1;
    for (let i = 0; i < RSC_LOOP_LIMIT * 4; i += 1) {
      expect(counter.note('/he/system')).toBe(false);
      advance(step);
    }
  });
});

describe('★★ which entries are router requests', () => {
  it('a URL with Next’s _rsc token on this origin, keyed without the token', () => {
    expect(routerRequestPage(`${ORIGIN}/he/system?_rsc=abc`, ORIGIN)).toBe('/he/system');
    expect(routerRequestPage(`${ORIGIN}/he/system?tab=x&_rsc=b`, ORIGIN)).toBe('/he/system?tab=x');
  });

  it('★ anything else is not: a plain call, another origin, junk', () => {
    expect(routerRequestPage(`${ORIGIN}/api/bff/permissions/me`, ORIGIN)).toBeNull();
    expect(routerRequestPage(`${ORIGIN}/_next/static/chunks/a.js`, ORIGIN)).toBeNull();
    expect(routerRequestPage('https://auth.gotcha.co.il/x?_rsc=1', ORIGIN)).toBeNull();
    expect(routerRequestPage('http://[', ORIGIN)).toBeNull();
  });

  it('pageKey keeps the query that names the page', () => {
    expect(pageKey(new URL('https://h/he/inbox?c=1&_rsc=z'))).toBe('/he/inbox?c=1');
  });
});

describe('★★ a loop that reloads the document is seen across loads', () => {
  it('★★ the count lives in the tab’s storage, so each new counter adds to it', () => {
    const storage = memoryStorage();
    for (let load = 0; load < RSC_LOOP_LIMIT; load += 1) {
      expect(setup(storage).counter.note('/he/system')).toBe(false);
    }
    expect(setup(storage).counter.note('/he/system')).toBe(true);
  });

  it('★ storage that throws or holds junk is a count in memory, never a throw', () => {
    const throwing: GuardStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const junk = memoryStorage();
    junk.setItem('gotcha.rscLoop', '[1,2');
    for (const storage of [throwing, junk, null]) {
      const { counter } = setup(storage);
      const results = Array.from({ length: RSC_LOOP_LIMIT + 1 }, () => counter.note('/he/system'));
      expect(results.at(-1)).toBe(true);
      expect(results.at(-2)).toBe(false);
    }
  });
});
