"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getActiveTenantId } from "@/lib/active-tenant";
import clsx from "clsx";
import {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  InAppNotification,
  NotificationPriority,
} from "@/lib/api-notifications";

// ─── Tiny notification ping (200ms, ~1kB base64 WAV) ─────────
// Generated: 440Hz sine, 16-bit PCM, 8000Hz mono, 0.2s
const PING_WAV =
  "data:audio/wav;base64,UklGRlQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YTAAAAB" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Soft triangle-wave ping synthesised via AudioContext (no file needed)
function playPing() {
  if (typeof window === "undefined") return;
  if (localStorage.getItem("notificationSound") === "off") return;
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => ctx.close();
  } catch {
    // AudioContext unavailable - ignore silently
  }
}

// Keep the base64 import to avoid unused-var TS error even though we use AudioContext
void PING_WAV;

// ─── Relative time formatter ──────────────────────────────────
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ─── Priority colours ─────────────────────────────────────────
const priorityStripe: Record<NotificationPriority, string> = {
  CRITICAL: "bg-red-500",
  HIGH: "bg-orange-400",
  MEDIUM: "bg-violet-400",
  LOW: "bg-gray-300",
};

const priorityChip: Record<NotificationPriority, string> = {
  CRITICAL: "bg-red-50 text-red-600",
  HIGH: "bg-orange-50 text-orange-600",
  MEDIUM: "bg-violet-50 text-violet-600",
  LOW: "bg-gray-100 text-gray-500",
};

// ─── WebSocket hook ───────────────────────────────────────────
interface UseNotificationStreamOptions {
  onNew: (n: InAppNotification) => void;
}

export function useNotificationStream(
  token: string | null,
  { onNew }: UseNotificationStreamOptions
) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelay = useRef(500);
  const pollInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const clearPoll = useCallback(() => {
    if (pollInterval.current) {
      clearInterval(pollInterval.current);
      pollInterval.current = null;
    }
  }, []);

  const startPoll = useCallback(() => {
    if (!token || pollInterval.current) return;
    pollInterval.current = setInterval(async () => {
      try {
        await getUnreadCount(token);
        // count-only poll - the bell will re-fetch on next open
      } catch {
        // swallow
      }
    }, 30_000);
  }, [token]);

  const connect = useCallback(() => {
    if (!token || !mountedRef.current) return;

    try {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const tenant = getActiveTenantId();
      const ws = new WebSocket(
        `${proto}://${window.location.host}/ws?token=${token}${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ""}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        retryDelay.current = 500;
        clearPoll();
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data as string) as {
            type: string;
            data: InAppNotification;
          };
          if (msg.type === "notification.new") {
            if (document.visibilityState === "visible") {
              playPing();
            }
            onNew(msg.data);
          }
        } catch {
          // malformed frame - ignore
        }
      };

      ws.onerror = () => {
        // will trigger onclose
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        wsRef.current = null;
        startPoll();
        // exponential back-off capped at 30s
        retryTimeout.current = setTimeout(() => {
          retryDelay.current = Math.min(retryDelay.current * 2, 30_000);
          connect();
        }, retryDelay.current);
      };
    } catch {
      // WebSocket constructor can throw in some environments
      startPoll();
    }
  }, [token, onNew, startPoll, clearPoll]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (retryTimeout.current) clearTimeout(retryTimeout.current);
      clearPoll();
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect loop
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, clearPoll]);
}

// ─── Bell icon ─────────────────────────────────────────────────
function BellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
      />
    </svg>
  );
}

// ─── NotificationBell ─────────────────────────────────────────
export function NotificationBell() {
  const { token } = useAuth();
  const { t } = useI18n();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // ── Fetch unread count on mount ──
  useEffect(() => {
    if (!token) return;
    getUnreadCount(token)
      .then((r) => setUnreadCount(r.count))
      .catch(() => {});
  }, [token]);

  // ── WebSocket stream ──
  const handleNew = useCallback(
    (n: InAppNotification) => {
      setUnreadCount((c) => c + 1);
      setNotifications((prev) => [n, ...prev]);
    },
    []
  );
  useNotificationStream(token, { onNew: handleNew });

  // ── Fetch panel notifications when opened ──
  const fetchNotifications = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await listNotifications(token, { unreadOnly: true, limit: 50 });
      setNotifications(res.data);
    } catch {
      // swallow
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (open) fetchNotifications();
  }, [open, fetchNotifications]);

  // ── Close on outside click ──
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // ── Mark all read ──
  async function handleMarkAllRead() {
    if (!token) return;
    try {
      await markAllRead(token);
      setUnreadCount(0);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch {
      // swallow
    }
  }

  // ── Click notification card ──
  async function handleCardClick(n: InAppNotification) {
    if (!token) return;
    if (!n.read) {
      try {
        await markRead(token, n.id);
        setNotifications((prev) =>
          prev.map((x) => (x.id === n.id ? { ...x, read: true } : x))
        );
        setUnreadCount((c) => Math.max(0, c - 1));
      } catch {
        // swallow
      }
    }
    if (n.link) {
      setOpen(false);
      router.push(n.link);
    }
  }

  const badgeLabel = unreadCount > 9 ? "9+" : String(unreadCount);

  return (
    <div className="relative">
      {/* Bell button - fixed width so badge never shifts siblings */}
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        aria-label={t("notifications.title")}
        aria-haspopup="true"
        aria-expanded={open}
        className={clsx(
          "relative w-9 h-9 flex items-center justify-center rounded-xl transition-colors",
          open
            ? "bg-primary-50 text-primary-600"
            : "text-gray-400 hover:text-gray-600 hover:bg-gray-50"
        )}
      >
        <BellIcon className="w-5 h-5" />
        {/* Badge - pre-allocated 18px slot so layout is stable */}
        <span
          aria-hidden={unreadCount === 0}
          className={clsx(
            "absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1",
            "flex items-center justify-center",
            "rounded-full bg-red-500 text-white text-[10px] font-bold leading-none",
            "transition-all duration-150",
            unreadCount === 0 ? "opacity-0 scale-75 pointer-events-none" : "opacity-100 scale-100"
          )}
        >
          {badgeLabel}
        </span>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t("notifications.title")}
          className="absolute top-full right-0 mt-2 w-96 max-h-[480px] flex flex-col bg-white rounded-2xl shadow-float z-50 overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
            <h3 className="text-sm font-semibold text-gray-900">{t("notifications.title")}</h3>
            <button
              onClick={handleMarkAllRead}
              className="text-xs text-primary-600 hover:text-primary-700 font-medium transition-colors"
            >
              {t("notifications.markAllRead")}
            </button>
          </div>

          {/* List */}
          <div className="overflow-y-auto flex-1">
            {loading && (
              <div className="flex items-center justify-center py-10">
                <div className="w-5 h-5 border-2 border-gray-200 border-t-primary-500 rounded-full animate-spin" />
              </div>
            )}

            {!loading && notifications.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 gap-2 text-gray-400">
                <span className="text-2xl" role="img" aria-label="bell">🔔</span>
                <p className="text-sm">{t("notifications.empty")}</p>
              </div>
            )}

            {!loading &&
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleCardClick(n)}
                  className={clsx(
                    "w-full flex gap-0 text-left hover:bg-gray-50 transition-colors",
                    "border-b border-gray-50 last:border-0",
                    !n.read && "bg-primary-50/30"
                  )}
                >
                  {/* Priority stripe */}
                  <span
                    className={clsx("w-1 shrink-0 rounded-l-sm self-stretch", priorityStripe[n.priority])}
                    aria-hidden="true"
                  />

                  <div className="flex-1 px-3 py-3 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-gray-900 truncate leading-snug">
                        {n.title}
                      </p>
                      <span className="text-[10px] text-gray-400 whitespace-nowrap shrink-0 mt-0.5">
                        {relativeTime(n.createdAt)}
                      </span>
                    </div>
                    <p className="text-xs text-gray-600 mt-0.5 line-clamp-2 leading-relaxed">
                      {n.body}
                    </p>
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <span
                        className={clsx(
                          "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                          priorityChip[n.priority]
                        )}
                      >
                        {n.eventType}
                      </span>
                      {!n.read && (
                        <span className="w-1.5 h-1.5 rounded-full bg-primary-500 shrink-0" />
                      )}
                    </div>
                  </div>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
