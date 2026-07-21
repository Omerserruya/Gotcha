"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { getMe, postSwitchTenant } from "@/lib/api";
import { connectSocket, disconnectSocket } from "@/lib/socket";
import { beginLogin, refreshTokens, logoutUrl, type TokenSet } from "@/lib/oidc";
import {
  installTenantFetchInterceptor,
  getActiveTenantId,
  setActiveTenantId,
} from "@/lib/active-tenant";

// Stamp X-Tenant-Id onto every /api call BEFORE any authenticated fetch can
// fire (module scope runs ahead of the first render's effects).
installTenantFetchInterceptor();

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string;
  departmentId?: string;
  departmentRole?: string;
  departmentName?: string;
}

/** One tenant this identity can enter (from /api/auth/me). */
export interface Membership {
  userId: string;
  role: string;
  lastActiveAt: string | null;
  memberSince: string;
  tenant: { id: string; name: string; slug: string; status: string; isActive: boolean };
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  /** Every workspace this identity belongs to. length > 1 → show switcher. */
  memberships: Membership[];
  /** Name of the ACTIVE tenant (for the switcher trigger). */
  tenantName: string | null;
  /** Multi-workspace identity with no chosen workspace yet → picker gates the app. */
  needsTenantSelection: boolean;
  /** Validate + persist a workspace choice, then reload the app into it. */
  switchTenant: (tenantId: string) => Promise<void>;
  /** Send the browser to Authentik. There is no in-app credential form. */
  login: (returnTo?: string, loginHint?: string) => void;
  /** Adopt a token set obtained by the OIDC callback. */
  adoptSession: (tokens: TokenSet) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  token: null,
  isLoading: true,
  memberships: [],
  tenantName: null,
  needsTenantSelection: false,
  switchTenant: async () => {},
  login: () => {},
  adoptSession: async () => {},
  logout: () => {},
});

const TOKEN_KEY = "token";
const REFRESH_KEY = "refreshToken";
const EXPIRY_KEY = "tokenExpiresAt";

/**
 * Token storage.
 *
 * Tokens live in localStorage, matching how every API call in this app already
 * sends a Bearer header. That is the standard public-client SPA tradeoff: it
 * is XSS-exposed, and the durable fix is a backend-for-frontend holding an
 * HttpOnly cookie session. That is an architecture change beyond this
 * migration - see docs/security/authentik-architecture.md.
 */
function storeTokens(t: TokenSet) {
  localStorage.setItem(TOKEN_KEY, t.accessToken);
  localStorage.setItem(EXPIRY_KEY, String(t.expiresAt));
  if (t.refreshToken) localStorage.setItem(REFRESH_KEY, t.refreshToken);
}

function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(EXPIRY_KEY);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantName, setTenantName] = useState<string | null>(null);
  const [needsTenantSelection, setNeedsTenantSelection] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Adopt a /me response: user + memberships + which-tenant bookkeeping.
   * A multi-workspace identity with NO remembered choice is gated behind the
   * tenant picker; a single-workspace identity auto-enters (and we remember
   * the tenant so the switcher + header plumbing agree).
   */
  const adoptMe = useCallback((res: { user: User; memberships?: Membership[]; tenantName?: string | null }) => {
    setUser(res.user);
    const list = res.memberships ?? [];
    setMemberships(list);
    setTenantName(res.tenantName ?? null);
    const stored = getActiveTenantId();
    if (list.length > 1 && !stored) {
      setNeedsTenantSelection(true);
    } else {
      setNeedsTenantSelection(false);
      if (!stored && res.user?.tenantId) setActiveTenantId(res.user.tenantId);
    }
  }, []);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  // Broadcast token transitions so providers that live OUTSIDE AuthProvider
  // (e.g., I18nProvider - kept above us so it doesn't remount the voice
  // tree on locale re-renders) can re-hydrate without subscribing to this
  // context.
  useEffect(() => {
    try { window.dispatchEvent(new Event("auth:token-changed")); } catch { /* SSR/no window */ }
  }, [token]);

  const hardLogout = useCallback(() => {
    clearRefreshTimer();
    clearTokens();
    setActiveTenantId(null);
    setToken(null);
    setUser(null);
    setMemberships([]);
    setTenantName(null);
    setNeedsTenantSelection(false);
    disconnectSocket();
  }, [clearRefreshTimer]);

  const scheduleRefresh = useCallback((expiresAt: number) => {
    clearRefreshTimer();
    const ms = expiresAt - Date.now();
    if (ms <= 0) return;

    // Refresh 5 minutes before expiry, or at half-life if the token is short.
    const refreshIn = ms > 600_000 ? ms - 300_000 : ms / 2;

    refreshTimerRef.current = setTimeout(async () => {
      const stored = localStorage.getItem(REFRESH_KEY);
      if (!stored) return hardLogout();
      try {
        const next = await refreshTokens(stored);
        storeTokens(next);
        setToken(next.accessToken);
        connectSocket(next.accessToken);
        scheduleRefresh(next.expiresAt);
      } catch {
        // The refresh token is spent or revoked. Drop the session rather than
        // sit on a token that will start 401-ing every request.
        hardLogout();
      }
    }, Math.max(refreshIn, 5000));
  }, [clearRefreshTimer, hardLogout]);

  const adoptSession = useCallback(async (tokens: TokenSet) => {
    storeTokens(tokens);
    setToken(tokens.accessToken);
    const res = await getMe(tokens.accessToken);
    adoptMe(res as any);
    connectSocket(tokens.accessToken);
    scheduleRefresh(tokens.expiresAt);
  }, [scheduleRefresh, adoptMe]);

  /**
   * Switch workspace: server-validates the membership and stamps last-used,
   * then a FULL reload rebuilds every provider (permissions, entitlements,
   * departments, branding, AI config, sockets) against the new tenant - the
   * one mechanism guaranteed to leave no stale tenant state anywhere.
   */
  const switchTenant = useCallback(async (tenantId: string) => {
    if (!token) throw new Error("not_authenticated");
    await postSwitchTenant(token, tenantId);
    setActiveTenantId(tenantId);
    window.location.assign("/");
  }, [token]);

  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) {
      setIsLoading(false);
      return;
    }

    const expiresAt = Number(localStorage.getItem(EXPIRY_KEY) || 0);

    getMe(stored)
      .then((res) => {
        setToken(stored);
        adoptMe(res as any);
        connectSocket(stored);
        scheduleRefresh(expiresAt || Date.now() + 300_000);
      })
      .catch(async () => {
        // Access token rejected - try the refresh token once before giving up.
        const storedRefresh = localStorage.getItem(REFRESH_KEY);
        if (!storedRefresh) return hardLogout();
        try {
          const next = await refreshTokens(storedRefresh);
          storeTokens(next);
          setToken(next.accessToken);
          const res = await getMe(next.accessToken);
          adoptMe(res as any);
          connectSocket(next.accessToken);
          scheduleRefresh(next.expiresAt);
        } catch {
          hardLogout();
        }
      })
      .finally(() => setIsLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback((returnTo?: string, loginHint?: string) => {
    void beginLogin(returnTo, loginHint);
  }, []);

  const logout = useCallback(() => {
    hardLogout();
    // End the Authentik session too, otherwise the next login silently
    // re-authenticates and the user never actually logged out.
    void logoutUrl()
      .then((url) => window.location.assign(url))
      .catch(() => window.location.assign("/"));
  }, [hardLogout]);

  return (
    <AuthContext.Provider
      value={{
        user, token, isLoading, memberships, tenantName, needsTenantSelection,
        switchTenant, login, adoptSession, logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
