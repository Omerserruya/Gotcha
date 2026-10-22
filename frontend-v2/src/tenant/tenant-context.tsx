'use client';

import { createContext, useContext, type ReactNode } from 'react';

interface TenantContextValue {
  /** The active workspace, or null before one is chosen. */
  readonly tenantId: string | null;
}

const TenantContext = createContext<TenantContextValue>({ tenantId: null });

/**
 * The single authoritative source for "which workspace am I in".
 *
 * Provided once, from the session, at the top of the authenticated tree. No
 * component reads a tenant from a URL segment, a prop drilled through five
 * layers, or its own fetch - because when two places disagree about the
 * current tenant, the result is one workspace's data rendered inside another.
 */
export function TenantProvider({
  tenantId,
  children,
}: {
  tenantId: string | null;
  children: ReactNode;
}) {
  return <TenantContext.Provider value={{ tenantId }}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantContextValue {
  return useContext(TenantContext);
}
