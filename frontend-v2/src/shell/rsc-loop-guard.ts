/**
 * ★★ ONE TAB MAY NOT ASK FOR THE SAME PAGE OVER AND OVER (prod, 2026-11-16
 * and again 2026-11-17).
 *
 * A console tab asked for /he/system 4-5 times a second, for an hour one day
 * and twenty minutes the next. Every one of those requests was a server
 * render, and every render read the platform from our single egress address,
 * so the platform's rate limit refused EVERY customer's server calls and a
 * merchant could not sign in. The trigger in the browser is not identified
 * (c5393bec made every unread state inert, and the loop came back).
 *
 * So the guard counts what the router actually sends, whatever sent it: a
 * refresh, a navigation, a prefetch, or a refetch Next decides on itself.
 * Each of those is a fetch whose URL carries Next's `_rsc` token, and the
 * browser reports every one as a resource timing entry (`RscLoopGuard`).
 *
 * ⚠⚠ IT OBSERVES, IT NEVER INTERCEPTS. `window.fetch` is not replaced: the
 *   password flow calls fetch, and nothing in this app may sit in that path
 *   (flow-executor.test.ts, "installs no global fetch interceptor"). A timing
 *   entry carries a URL and times, never a header or a body.
 *
 * Per tab, per page (path and query, without `_rsc`): more than
 * `RSC_LOOP_LIMIT` in `RSC_LOOP_WINDOW_MS` and the page is STOPPED: the
 * shell unmounts what it holds (the looping component, the page's router
 * segments) and says so, with a Try again that is one full load, pressed by
 * a person. A full load of the page counts too, and the count lives in
 * sessionStorage, so a loop that reloads the document is seen across loads.
 *
 * The limit is far above anything a person or the product does: the live
 * inbox refreshes at most once a second (`live-refresh` WINDOW_MS), which is
 * 20 in the window; the loop was 80 to 100.
 */
export const RSC_LOOP_LIMIT = 40;
export const RSC_LOOP_WINDOW_MS = 20_000;

/**
 * ★★ AND ACROSS PAGES (prod, 2026-11-18, 08:16 to 08:25Z): a live inbox's
 * every refresh made each primary nav link prefetch again, so the tab asked
 * for nine pages about 13 times each per window. No page passed 40, and the
 * tab sent about 3,500 requests in 15 minutes.
 *
 * So the tab is stopped, too, when its REPEATS pass `RSC_LOOP_REPEAT_LIMIT`
 * in the window: every request for a page beyond its first
 * `RSC_LOOP_FREE_REPEATS`, summed over all pages. That loop is about 100;
 * one prefetch sweep over a long list (each link asked once or twice) is 0;
 * the live inbox refreshing once a second is 18.
 */
export const RSC_LOOP_FREE_REPEATS = 2;
export const RSC_LOOP_REPEAT_LIMIT = 60;

const STORAGE_KEY = 'gotcha.rscLoop';

type Hits = Record<string, number[]>;

export type GuardStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** Path and query, without Next's cache-busting `_rsc`. */
export function pageKey(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete('_rsc');
  const query = params.toString();
  return query === '' ? url.pathname : `${url.pathname}?${query}`;
}

/**
 * The page a router request was for, or null when `name` (a resource timing
 * entry's URL) is not one: another origin, or no `_rsc` token.
 */
export function routerRequestPage(name: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(name, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !url.searchParams.has('_rsc')) return null;
  return pageKey(url);
}

export type RscLoopCounter = {
  /**
   * One request (or full load) for `page`; true once it is over the limit,
   * or the tab's repeats across every page are.
   */
  readonly note: (page: string) => boolean;
  /** Forget `page`'s count, or every page's with no argument (Try again). */
  readonly clear: (page?: string) => void;
};

export function createRscLoopCounter({
  now = Date.now,
  storage,
}: {
  readonly now?: () => number;
  readonly storage: GuardStorage | null;
}): RscLoopCounter {
  let memory: Hits = {};

  const read = (): Hits => {
    if (!storage) return memory;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Hits) : {};
    } catch {
      return memory;
    }
  };
  const write = (hits: Hits) => {
    memory = hits;
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(hits));
    } catch {
      // A full or blocked storage keeps the count in memory: still one tab's.
    }
  };

  return {
    note: (page) => {
      const at = now();
      const kept: Hits = {};
      for (const [key, times] of Object.entries(read())) {
        if (!Array.isArray(times)) continue;
        const fresh = times.filter(
          (time) => typeof time === 'number' && at - time < RSC_LOOP_WINDOW_MS,
        );
        if (fresh.length > 0) kept[key] = fresh;
      }
      kept[page] = [...(kept[page] ?? []), at];
      write(kept);
      if (kept[page].length > RSC_LOOP_LIMIT) return true;
      let repeats = 0;
      for (const times of Object.values(kept)) {
        repeats += Math.max(0, times.length - RSC_LOOP_FREE_REPEATS);
      }
      return repeats > RSC_LOOP_REPEAT_LIMIT;
    },
    clear: (page) => {
      if (page === undefined) {
        write({});
        return;
      }
      const hits = read();
      delete hits[page];
      write(hits);
    },
  };
}
