/**
 * "These two are not the same person" marks (design 04): one TenantSetting
 * row per pair, key identity:not-same:<a>:<b> (ids sorted). See
 * routes/identity.ts. A mark that names a contact which is gone (erased, or
 * merged into another) is removed with it.
 */
export const NOT_SAME = "identity:not-same:";

export function notSameKey(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return `${NOT_SAME}${x}:${y}`;
}

/** The marks that name any of these contacts. */
export function marksNaming(tenantId: string, contactIds: string[]) {
  return {
    tenantId,
    key: { startsWith: NOT_SAME },
    OR: contactIds.flatMap((id) => [{ key: { endsWith: `:${id}` } }, { key: { contains: `:${id}:` } }]),
  };
}
