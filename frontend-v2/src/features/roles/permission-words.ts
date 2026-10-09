import type { PermissionDef } from '@/api/contracts/permission-catalog';

/**
 * A permission's name in the reader's language.
 *
 * `GET /permissions/catalog` is English only (`displayName`, `description`;
 * Backend asked for localized ones, 2026-10-08). Its key is
 * `feature:sub-feature:action`, and the role grid already says every
 * `feature:sub-feature` row and every action in Hebrew - so in Hebrew the
 * name is those two ("שיחות · קריאה"); English keeps the platform's own.
 * A key the grid has no words for keeps the platform's name rather than
 * showing a code.
 *
 * `word(key)` reads `roles.<key>` or returns null; `join` is the catalogue's
 * own template for "row · action".
 */
export function permissionName(
  permission: Pick<PermissionDef, 'key' | 'displayName' | 'feature' | 'subFeature' | 'action'>,
  locale: string,
  word: (key: string) => string | null,
  join: (row: string, action: string) => string,
): string {
  const platform = permission.displayName.trim() || permission.key;
  if (locale === 'en') return platform;
  const row = word(`form.row.${permission.feature}:${permission.subFeature}`);
  const action = word(`form.action.${permission.action}`);
  return row && action ? join(row, action) : platform;
}

/** A permission's description - English only on the platform, so shown only in English. */
export function permissionDescription(
  permission: Pick<PermissionDef, 'description'>,
  locale: string,
): string | null {
  return locale === 'en' && permission.description.trim() ? permission.description : null;
}

/**
 * A catalogue area ("conversation") in Hebrew, from the role grid's own words.
 * English keeps the catalogue's heading: the grid's English areas are screen
 * names ("Studio" for `ai`), not the catalogue's.
 */
export function areaName(
  domain: string,
  locale: string,
  word: (key: string) => string | null,
  fallback: string,
): string {
  return (locale === 'en' ? null : word(`form.area.${domain}`)) ?? fallback;
}
