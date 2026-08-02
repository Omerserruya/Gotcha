"use client";

import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import { getMyAccess, type PermissionScope } from "@/lib/api";

/**
 * Effective-permission context - the single place the UI asks "can the current
 * user do X?". Backed by GET /api/permissions/me (resolver-computed). The UI
 * reacts to permissions; it never hardcodes role checks.
 *
 * SAFE FALLBACK: until permissions load (or if the call fails), `can()` falls
 * back to a coarse legacy-role approximation so the app never renders a blank,
 * over-locked shell during the fetch. Once permissions arrive they are
 * authoritative.
 */

/** Effective built-in role tier, ordered. */
export type RoleKey =
  | "agent"
  | "department_manager"
  | "admin"
  | "owner"
  | "system_admin"
  | null;

const ROLE_RANK: Record<string, number> = {
  agent: 0,
  department_manager: 1,
  admin: 2,
  owner: 3,
  system_admin: 4,
};

interface PermissionsState {
  permissions: Set<string>;
  scope: PermissionScope;
  /** Effective built-in role of the current user. */
  roleKey: RoleKey;
  loading: boolean;
  loaded: boolean;
  /** Does the user hold this permission? Supports `domain:sub:*` / `*` patterns. */
  can: (permission: string) => boolean;
  /** True if the user holds ANY of the given permissions. */
  canAny: (...permissions: string[]) => boolean;
  /** True if the user holds ALL of the given permissions. */
  canAll: (...permissions: string[]) => boolean;
  /**
   * Role-tier check, consistent with the backend requireRole bridge. Use for
   * nav items whose backend is still role-gated, to avoid dead links.
   */
  atLeastRole: (min: "agent" | "department_manager" | "admin" | "owner") => boolean;
  refresh: () => void;
}

const PermissionsContext = createContext<PermissionsState>({
  permissions: new Set(),
  scope: "own",
  roleKey: null,
  loading: true,
  loaded: false,
  can: () => false,
  canAny: () => false,
  canAll: () => false,
  atLeastRole: () => false,
  refresh: () => {},
});

/**
 * Legacy-role fallback used ONLY before permissions load. Mirrors the resolver
 * bridge: ADMIN/SYSTEM_ADMIN → broad; everyone else → deny (real set arrives
 * milliseconds later). Keeps existing admin UX from flickering locked.
 */
function legacyCan(role: string | undefined, _permission: string): boolean {
  return role === "ADMIN" || role === "SYSTEM_ADMIN";
}

function matches(held: Set<string>, permission: string): boolean {
  if (held.has(permission)) return true;
  // Wildcards may be present in the held set (e.g. owner "*").
  if (held.has("*")) return true;
  const [feature, sub] = permission.split(":");
  if (held.has(`${feature}:*`)) return true;
  if (held.has(`${feature}:${sub}:*`)) return true;
  return false;
}

export function PermissionsProvider({ children }: { children: React.ReactNode }) {
  const { token, user, isLoading: authLoading } = useAuth();
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<PermissionScope>("own");
  const [roleKey, setRoleKey] = useState<RoleKey>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (authLoading) return;
    if (!token) {
      setPermissions(new Set());
      setScope("own");
      setRoleKey(null);
      setLoaded(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getMyAccess(token)
      .then((res) => {
        if (cancelled) return;
        setPermissions(new Set(res.data.permissions || []));
        setScope(res.data.scope || "own");
        setRoleKey((res.data.roleKey as RoleKey) ?? null);
        setLoaded(true);
      })
      .catch(() => {
        // Leave permissions empty; can() falls back to legacy role until retry.
        if (!cancelled) setLoaded(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, authLoading, nonce]);

  const value = useMemo<PermissionsState>(() => {
    const can = (permission: string): boolean => {
      if (loaded) return matches(permissions, permission);
      return legacyCan(user?.role, permission);
    };
    // Effective role tier - fall back to a legacy-enum approximation until /me loads.
    const effectiveRoleKey: RoleKey = loaded
      ? roleKey
      : user?.role === "SYSTEM_ADMIN"
        ? "system_admin"
        : user?.role === "ADMIN"
          ? "admin"
          : user?.departmentRole === "MANAGER"
            ? "department_manager"
            : user?.role === "AGENT"
              ? "agent"
              : null;
    const atLeastRole = (min: "agent" | "department_manager" | "admin" | "owner"): boolean => {
      const have = effectiveRoleKey ? ROLE_RANK[effectiveRoleKey] ?? -1 : -1;
      return have >= ROLE_RANK[min];
    };
    return {
      permissions,
      scope,
      roleKey: effectiveRoleKey,
      loading,
      loaded,
      can,
      canAny: (...perms: string[]) => perms.some((p) => can(p)),
      canAll: (...perms: string[]) => perms.every((p) => can(p)),
      atLeastRole,
      refresh,
    };
  }, [permissions, scope, roleKey, loading, loaded, user?.role, user?.departmentRole, refresh]);

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function usePermissions() {
  return useContext(PermissionsContext);
}
