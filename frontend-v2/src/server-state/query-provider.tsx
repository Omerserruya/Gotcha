'use client';

import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { createQueryClient } from './query-client';

/**
 * Provides the query cache, and clears it when the tenant changes.
 *
 * `tenantId` is passed in rather than read from a context so that the cache
 * boundary is explicit and testable. Keys are already tenant-scoped, so a
 * switch cannot show the wrong data; clearing on top of that stops the old
 * tenant's payloads from lingering in memory after the user has moved on.
 */
export function QueryProvider({
  tenantId,
  children,
}: {
  tenantId: string | null;
  children: ReactNode;
}) {
  const [client] = useState<QueryClient>(createQueryClient);
  const previousTenant = useRef(tenantId);

  useEffect(() => {
    if (previousTenant.current !== tenantId) {
      previousTenant.current = tenantId;
      client.clear();
    }
  }, [client, tenantId]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
