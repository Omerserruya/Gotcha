'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { ALLOWED, HIDDEN, denied, type Capability } from './capability';
import { EMPTY_PERMISSIONS, PermissionSet, type PermissionString } from './permission-set';

/**
 * Whether the permission set is trustworthy.
 *
 * The distinction matters more than it looks. "Loaded, and you hold nothing"
 * and "we could not find out what you hold" produce the same empty array, and
 * treating them alike is how a backend hiccup turns into an operator staring
 * at a product with no navigation, concluding their access was revoked.
 */
export type PermissionsStatus = 'loaded' | 'unavailable';

interface PermissionsContextValue {
  readonly permissions: PermissionSet;
  readonly status: PermissionsStatus;
  /** Tenant these permissions were resolved for. Guards against stale reads. */
  readonly tenantId: string | null;
  /**
   * Whether a surface should be shown.
   *
   * When the set could not be loaded this answers `true` for everything. That
   * is deliberate: the brief is explicit that "the backend remains the
   * security authority; frontend permission gating is UX, not security". So
   * the failure mode is a control that turns out to be refused — recoverable,
   * and the error says why — rather than a product that appears to have
   * vanished. Hiding on uncertainty is the worse of the two.
   */
  readonly canSee: (permission?: PermissionString) => boolean;
}

const DEFAULT: PermissionsContextValue = {
  permissions: EMPTY_PERMISSIONS,
  status: 'loaded',
  tenantId: null,
  canSee: () => false,
};

const PermissionsContext = createContext<PermissionsContextValue>(DEFAULT);

export function PermissionsProvider({
  permissions,
  roleKey,
  status = 'loaded',
  tenantId,
  children,
}: {
  permissions: readonly PermissionString[];
  /**
   * The effective built-in role. Carried because `SYSTEM_ADMIN` bypasses the
   * permission set entirely on the backend; dropping it here would hide the
   * whole product from the people who administer it.
   */
  roleKey?: string;
  status?: PermissionsStatus;
  tenantId: string | null;
  children: ReactNode;
}) {
  const value = useMemo<PermissionsContextValue>(() => {
    const set = new PermissionSet(permissions, roleKey);
    return {
      permissions: set,
      status,
      tenantId,
      canSee: (permission?: PermissionString) => {
        if (!permission) return true;
        if (status === 'unavailable') return true;
        return set.has(permission);
      },
    };
  }, [permissions, roleKey, status, tenantId]);

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function usePermissions(): PermissionsContextValue {
  return useContext(PermissionsContext);
}

/**
 * Resolves one permission into a capability.
 *
 * `whenMissing` is the interesting parameter. Hiding an action the user cannot
 * perform is right for navigation — a section they will never use is noise.
 * It is wrong for an action inside a workflow they are halfway through, where
 * a disabled control saying "you need the Refunds permission" is the
 * difference between a user who asks their admin and one who files a bug.
 */
export function useCapability(
  permission: PermissionString,
  whenMissing: 'hide' | 'disable' = 'disable',
): Capability {
  const { canSee } = usePermissions();
  return useMemo(() => {
    if (canSee(permission)) return ALLOWED;
    return whenMissing === 'hide' ? HIDDEN : denied('missing_permission');
  }, [canSee, permission, whenMissing]);
}
