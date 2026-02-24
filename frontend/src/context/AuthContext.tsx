"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { getMe, refreshAccessToken } from "@/lib/api";
import { connectSocket, disconnectSocket } from "@/lib/socket";

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

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (token: string, user: User, refreshToken?: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  token: null,
  isLoading: true,
  login: () => {},
  logout: () => {},
});

// Parse JWT exp claim to get milliseconds until expiry
function getTokenExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.exp) {
      return payload.exp * 1000 - Date.now();
    }
  } catch { /* ignore */ }
  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const scheduleRefresh = useCallback((accessToken: string) => {
    clearRefreshTimer();
    const expiryMs = getTokenExpiryMs(accessToken);
    if (!expiryMs || expiryMs <= 0) return;

    // Refresh 5 minutes before expiry, or at half-life if less than 10 minutes
    const refreshIn = expiryMs > 600000 ? expiryMs - 300000 : expiryMs / 2;

    refreshTimerRef.current = setTimeout(async () => {
      const storedRefresh = localStorage.getItem("refreshToken");
      if (!storedRefresh) return;

      try {
        const result = await refreshAccessToken(storedRefresh);
        localStorage.setItem("token", result.token);
        localStorage.setItem("refreshToken", result.refreshToken);
        setToken(result.token);
        connectSocket(result.token);
        scheduleRefresh(result.token);
      } catch {
        // Refresh failed - token will expire naturally, user will be redirected to login
        localStorage.removeItem("token");
        localStorage.removeItem("refreshToken");
        setToken(null);
        setUser(null);
        disconnectSocket();
      }
    }, Math.max(refreshIn, 5000)); // minimum 5 seconds
  }, [clearRefreshTimer]);

  useEffect(() => {
    const stored = localStorage.getItem("token");
    if (stored) {
      setToken(stored);
      getMe(stored)
        .then((res) => {
          setUser(res.user);
          connectSocket(stored);
          scheduleRefresh(stored);
        })
        .catch(() => {
          // Access token expired - try refresh
          const storedRefresh = localStorage.getItem("refreshToken");
          if (storedRefresh) {
            refreshAccessToken(storedRefresh)
              .then((result) => {
                localStorage.setItem("token", result.token);
                localStorage.setItem("refreshToken", result.refreshToken);
                setToken(result.token);
                return getMe(result.token).then((res) => {
                  setUser(res.user);
                  connectSocket(result.token);
                  scheduleRefresh(result.token);
                });
              })
              .catch(() => {
                localStorage.removeItem("token");
                localStorage.removeItem("refreshToken");
                setToken(null);
              });
          } else {
            localStorage.removeItem("token");
            setToken(null);
          }
        })
        .finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback((newToken: string, newUser: User, newRefreshToken?: string) => {
    localStorage.setItem("token", newToken);
    if (newRefreshToken) {
      localStorage.setItem("refreshToken", newRefreshToken);
    }
    setToken(newToken);
    setUser(newUser);
    connectSocket(newToken);
    scheduleRefresh(newToken);
  }, [scheduleRefresh]);

  const logout = useCallback(() => {
    clearRefreshTimer();
    localStorage.removeItem("token");
    localStorage.removeItem("refreshToken");
    setToken(null);
    setUser(null);
    disconnectSocket();
  }, [clearRefreshTimer]);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
