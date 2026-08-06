"use client";

import { usePathname } from "next/navigation";

/**
 * One shape for the current path, because production and development do not
 * agree on it.
 *
 * `next.config.js` sets `trailingSlash: true` for the static export, and ONLY
 * for the static export - which is production. So `next/link` renders
 * `href="/conversations/"`, the URL keeps that slash, and `usePathname()`
 * returns `/conversations/`. In development (`next dev`, standalone) the very
 * same navigation yields `/conversations`. A hand-typed URL has no slash in
 * either environment.
 *
 * Every `pathname === "/somewhere"` in the app is therefore true in
 * development and false in production. That is not cosmetic: the guided tour
 * compares the path to decide whether the user has ARRIVED on a step's page,
 * and while it believes they have not, it holds an invisible full-screen
 * click-blocker over the app with no popup behind it - no Skip, no Next. On
 * production the comparison could never be true, so the first customer who
 * followed the tour's "click Inbox" instruction got a dead product.
 *
 * Measured on the live production bundle, same page, only the URL shape
 * differing:
 *   /conversations/  -> blocker up, no popup   (frozen)
 *   /conversations   -> popup renders normally
 *
 * Rather than fix that one comparison, compare normalized paths everywhere.
 * `useAppPathname()` is a drop-in replacement for `usePathname()`.
 */
export function normalizePath(p: string | null | undefined): string {
  if (!p) return "/";
  // Defensive: usePathname() excludes query and hash, but callers sometimes
  // pass a whole href.
  const path = p.split("?")[0].split("#")[0];
  if (path === "/") return "/";
  return path.replace(/\/+$/, "") || "/";
}

/** True when two paths point at the same route, whatever their slashes. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizePath(a) === normalizePath(b);
}

/**
 * True when `pathname` IS `prefix` or lives under it. Deliberately segment
 * aware: `/settings-extra` is not under `/settings`, which a bare
 * `startsWith` would get wrong.
 */
export function isUnder(pathname: string | null | undefined, prefix: string | null | undefined): boolean {
  const p = normalizePath(pathname);
  const q = normalizePath(prefix);
  return p === q || p.startsWith(q === "/" ? "/" : `${q}/`);
}

/** `usePathname()` with the environment difference normalized away. */
export function useAppPathname(): string {
  return normalizePath(usePathname());
}
