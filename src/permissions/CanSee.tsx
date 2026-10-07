'use client';

import type { ReactNode } from 'react';

import { usePermissions } from './permissions-context';
import type { PermissionString } from './permission-set';

/**
 * Static parts that only someone holding a permission should see - known
 * before any data arrives (the layout loaded the set), so they draw at once
 * rather than wait on a read. An unread set shows them (the backend refuses
 * what it must - `canSee`'s own rule).
 */
export function CanSee({
  permission,
  children,
}: {
  readonly permission: PermissionString;
  readonly children: ReactNode;
}) {
  const { canSee } = usePermissions();
  return canSee(permission) ? children : null;
}
