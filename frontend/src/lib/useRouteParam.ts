"use client";

import { useParams, usePathname } from "next/navigation";

const PLACEHOLDER = "_";

/**
 * Resolve a dynamic route segment. Pure, so it can be tested without a router.
 *
 * Under `output: export` our [id]/[slug] routes prerender a SINGLE "_"
 * placeholder (layout.tsx: `generateStaticParams() => [{ id: "_" }]`) and nginx
 * serves every real id from it. The built flight payload binds the segment
 * literally:
 *
 *     ["id","_","d"],{"children":["__PAGE__?{\"id\":\"_"
 *
 * so `useParams().id` is the string "_" for every id, and a page that looks its
 * record up by that id finds nothing. It presents as "that thing no longer
 * exists" for a record that is right there in the database.
 *
 * The browser URL still carries the truth, so we read it from there.
 *
 * `pattern` is REQUIRED for any route with segments AFTER the dynamic one -
 * `/settings/voice-channels/[id]/routing` ends in "routing", not the id, so the
 * last-segment shortcut silently returns the wrong string rather than failing.
 * Leaf routes can omit it.
 */
export function resolveDynamicParam(args: {
  name: string;
  fromParams: string | string[] | undefined;
  pathname: string | null | undefined;
  pattern?: string;
}): string {
  const { name, pathname, pattern } = args;
  const raw = Array.isArray(args.fromParams) ? args.fromParams[0] : args.fromParams;

  // Dev, and any route with real prerendered params: useParams() is correct.
  if (raw && raw !== PLACEHOLDER) return raw;

  const segments = (pathname ?? "").split("/").filter(Boolean);
  if (segments.length === 0) return "";

  if (pattern) {
    const patternSegments = pattern.split("/").filter(Boolean);
    const index = patternSegments.indexOf(`[${name}]`);
    // A pattern that does not contain the segment is a caller mistake; return
    // "" rather than guessing a position and fetching the wrong record.
    if (index < 0) return "";
    const value = segments[index];
    return value && value !== PLACEHOLDER ? decodeURIComponent(value) : "";
  }

  const last = segments[segments.length - 1];
  return last && last !== PLACEHOLDER ? decodeURIComponent(last) : "";
}

/**
 * The dynamic route segment for the current page, correct under `output: export`.
 *
 * Pass `pattern` whenever the dynamic segment is not last, e.g.
 * `useDynamicParam("id", "/settings/voice-channels/[id]/routing")`.
 */
export function useDynamicParam(name: string = "id", pattern?: string): string {
  const params = useParams() as Record<string, string | string[] | undefined>;
  const pathname = usePathname();
  return resolveDynamicParam({ name, fromParams: params?.[name], pathname, pattern });
}
