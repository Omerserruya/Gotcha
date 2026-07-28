import type { DiscoveryTechItem } from "@/lib/api";

/**
 * Client-side shape guards for the discovery record.
 *
 * The server normalizes these collections now (see
 * packages/shared/src/lib/business-discovery-shape.ts), so in normal
 * operation everything arriving here is already an array. This exists
 * because the setup page is the last thing between a half-written record
 * and a blank screen, and the record lives in a Json column that several
 * writers populate at different points in a scan.
 *
 * It is not a second normalizer: it does not repair or invent entries. It
 * only refuses to let a missing collection become a thrown TypeError.
 * A review screen that shows less is recoverable; one that crashes takes
 * the whole of onboarding down with it.
 *
 * This module is deliberately tiny and dependency-free so it can be tested
 * on its own - the page it serves is far too large to render in a unit
 * test, which is exactly why the guard used to live inline and go
 * unverified.
 */

/**
 * A detected-technology collection, guaranteed to be an array.
 *
 * Accepts `undefined`/`null` so `techList(tech?.tools)` type-checks with no
 * cast, and re-checks with `Array.isArray` so a non-array value coming from
 * a Json column cannot get through either.
 */
export function techList(value: DiscoveryTechItem[] | undefined | null): DiscoveryTechItem[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Entries that can actually be rendered.
 *
 * A row with no name would render as an empty chip, which reads as a bug
 * to a customer looking at "what we found on your site". Dropping it is
 * honest; substituting a placeholder would put a technology on screen that
 * the scan never detected.
 */
export function renderableTech(value: DiscoveryTechItem[] | undefined | null): DiscoveryTechItem[] {
  return techList(value).filter(
    (item): item is DiscoveryTechItem =>
      !!item && typeof item === "object" && typeof item.name === "string" && item.name.trim().length > 0,
  );
}
