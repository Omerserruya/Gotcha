"use client";

import React from "react";
import { usePermissions } from "@/context/PermissionsContext";

/**
 * Declarative permission gate for UI fragments (buttons, sections, menu items).
 *
 *   <Can perm="settings:members:manage"><InviteButton /></Can>
 *   <Can anyOf={["approvals:requests:approve","approvals:requests:reject"]}>...</Can>
 *
 * Renders `fallback` (default: nothing) when the user lacks the permission.
 */
export function Can({
  perm,
  anyOf,
  allOf,
  fallback = null,
  children,
}: {
  perm?: string;
  anyOf?: string[];
  allOf?: string[];
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { can, canAny, canAll } = usePermissions();
  let ok = true;
  if (perm) ok = ok && can(perm);
  if (anyOf && anyOf.length) ok = ok && canAny(...anyOf);
  if (allOf && allOf.length) ok = ok && canAll(...allOf);
  return <>{ok ? children : fallback}</>;
}

/** Hook form for imperative checks. */
export function useCan(permission: string): boolean {
  return usePermissions().can(permission);
}
