"use client";

import { useParams, usePathname } from "next/navigation";

/**
 * Returns a dynamic route segment that is correct under Next.js `output: export`.
 *
 * Our [id]/[slug] routes prerender a single "_" placeholder
 * (layout.tsx: `generateStaticParams() => [{ id: "_" }]`), so on the deployed
 * static site `useParams()` yields the literal "_" instead of the real value -
 * which made pages fetch `/api/.../_` and 404. We fall back to the live URL's
 * last path segment, which is always the dynamic segment for these leaf routes.
 * In dev (non-export / real params) `useParams()` is correct and used as-is.
 */
export function useDynamicParam(name: string = "id"): string {
  const params = useParams() as Record<string, string | string[] | undefined>;
  const pathname = usePathname();
  const raw = params?.[name];
  const fromParams = Array.isArray(raw) ? raw[0] : raw;
  if (fromParams && fromParams !== "_") return fromParams;
  return pathname?.split("/").filter(Boolean).pop() ?? "";
}
