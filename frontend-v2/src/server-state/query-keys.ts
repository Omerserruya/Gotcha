/**
 * Query key construction.
 *
 * Every key begins with the tenant. This is not tidiness - it is the
 * mechanism that stops one workspace's data appearing in another. A user who
 * switches from Acme to Globex must not see Acme's conversations for the
 * fraction of a second before a refetch lands, and a key that omits the tenant
 * makes that leak inevitable.
 *
 * Features build their keys from `tenantScope`, never by hand.
 */
export type QueryKey = readonly unknown[];

/** Root of every tenant-scoped key. */
export function tenantScope(tenantId: string | null): QueryKey {
  return ['tenant', tenantId ?? 'none'] as const;
}

/**
 * Builds a namespaced key factory for one feature.
 *
 *   const inboxKeys = featureKeys('inbox');
 *   inboxKeys(tenantId, 'conversations', { status: 'open' })
 *   → ['tenant', 't_1', 'inbox', 'conversations', { status: 'open' }]
 */
export function featureKeys(feature: string) {
  return (tenantId: string | null, ...segments: readonly unknown[]): QueryKey => [
    ...tenantScope(tenantId),
    feature,
    ...segments,
  ];
}

/** Keys that are genuinely tenant-independent, e.g. the membership list. */
export const identityKeys = {
  memberships: () => ['identity', 'memberships'] as const,
  me: (tenantId: string | null) => [...tenantScope(tenantId), 'identity', 'me'] as const,
  permissions: (tenantId: string | null) =>
    [...tenantScope(tenantId), 'identity', 'permissions'] as const,
};
