"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { useVoiceCall } from "@/context/VoiceCallContext";
import { useVoiceSessions } from "@/contexts/VoiceSessionsContext";
import { useVoiceFlags } from "@/lib/use-voice-flags";
import { getSocket } from "@/lib/socket";
import { normalizeE164 } from "@/lib/phone";
import {
  callbackMissedVoiceSession,
  getMissedVoiceSessions,
  getMissedVoiceSessionDetail,
  handleMissedVoiceSession,
  type MissedVoiceSession,
  type MissedVoiceSessionDetail,
} from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
const DISMISS_KEY = "chatcenter:dismissedMissedCalls";
const DISMISS_PHONES_KEY = "chatcenter:dismissedMissedPhones";
const SEEN_KEY = "chatcenter:seenMissedCalls";
// Cross-page handoff: when an agent clicks Call back, we navigate them
// to /voice/<newSessionId>. The Voice page reads this map and dismisses
// the missed-call row once the new session goes ACTIVE (= customer
// actually picked up), so unanswered callbacks stay in the inbox.
const PENDING_HANDLE_KEY = "chatcenter:pendingMissedHandle";

interface PendingHandleEntry {
  missedSessionId: string;
  customerNumber: string | null;
}

function recordPendingHandle(
  newSessionId: string,
  missedSessionId: string,
  customerNumber: string | null,
) {
  try {
    const raw = localStorage.getItem(PENDING_HANDLE_KEY);
    // Tolerate the legacy { [newSessionId]: missedSessionId } shape from
    // older bundles - they'll naturally be overwritten as new entries
    // get written in the new { missedSessionId, customerNumber } form.
    const map = raw ? (JSON.parse(raw) as Record<string, string | PendingHandleEntry>) : {};
    map[newSessionId] = { missedSessionId, customerNumber } satisfies PendingHandleEntry;
    localStorage.setItem(PENDING_HANDLE_KEY, JSON.stringify(map));
  } catch { /* quota or parse fail - degrade silently */ }
}

function addDismissedPhone(phone: string | null | undefined) {
  if (!phone) return;
  try {
    const raw = localStorage.getItem(DISMISS_PHONES_KEY);
    const set = new Set<string>(raw ? JSON.parse(raw) : []);
    if (set.has(phone)) return;
    set.add(phone);
    localStorage.setItem(DISMISS_PHONES_KEY, JSON.stringify(Array.from(set)));
  } catch { /* noop */ }
}

function loadIdSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); }
  catch { return new Set(); }
}
function saveIdSet(key: string, set: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify(Array.from(set))); } catch { /* ignore quota */ }
}

function shortTimeAgo(iso: string): string {
  const date = new Date(iso);
  const mins = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

function formatPhone(num: string | null | undefined): string {
  if (!num) return "";
  const normalized = normalizeE164(num);
  const display = normalized || num;
  if (!display.startsWith("+")) return display;
  return display.replace(/(\+\d{1,3})(\d{3})(\d{3})(\d+)/, "$1 $2 $3 $4").trim();
}

/**
 * Missed-calls inbox section. Rendered inside ConversationList between
 * LiveCallsSection and the conversation buckets. Hidden when no visible
 * missed sessions exist (or when the tenant has voice disabled).
 *
 * Sources of truth:
 *   - GET /api/voice-sessions/missed on mount + on state_changed socket events
 *   - localStorage tracks per-agent "dismissed" + "seen" sets so the section
 *     doesn't keep nagging once the agent has acted (or marked as handled)
 *
 * Click a row → side-drawer with full caller context + Call back /
 * Open conversation / Dismiss actions.
 */
export function MissedCallsSection() {
  const { token } = useAuth();
  const { t } = useI18n();
  const flags = useVoiceFlags();
  const router = useRouter();
  // Browser dialer fallback for IN_PLATFORM outbound channels - the
  // /missed/:id/callback endpoint only handles AGENT_FIRST; on 409 we
  // route through this instead so the agent doesn't have to navigate
  // away to the conversation page.
  const { placeCall } = useVoiceCall();

  const [sessions, setSessions] = useState<MissedVoiceSession[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadIdSet(DISMISS_KEY));
  // Phone-level dismissal - populated whenever a callback answers
  // successfully (Voice page writes here too). Hides every session in
  // the inbox sharing that number, even those that arrive AFTER the
  // dismissal as long as the agent hasn't deliberately re-engaged.
  const [dismissedPhones, setDismissedPhones] = useState<Set<string>>(() => loadIdSet(DISMISS_PHONES_KEY));
  const [seen, setSeen] = useState<Set<string>>(() => loadIdSet(SEEN_KEY));
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  // IN_PLATFORM callbacks don't get the new outbound sessionId back from
  // placeCall - it's only knowable after Twilio webhooks fire and the row
  // is created. Stash the missed-id + conversationId here and let the
  // effect below watch `allLive` for the new outbound row; when it shows
  // up, navigate to the Voice workspace and mark the missed row handled.
  const [pendingNav, setPendingNav] = useState<{
    missedSessionId: string;
    conversationId: string;
    placedAt: number;
  } | null>(null);
  const { allLive } = useVoiceSessions();

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getMissedVoiceSessions(token);
      setSessions(res.data || []);
    } catch {
      // Best-effort - section just stays empty on failure.
    }
  }, [token]);

  // Initial load.
  useEffect(() => {
    if (!flags.voiceCopilotEnabled) return;
    reload();
  }, [flags.voiceCopilotEnabled, reload]);

  // Refresh whenever a session transitions to/from MISSED.
  useEffect(() => {
    if (!token || !flags.voiceCopilotEnabled) return;
    let socket = getSocket();
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const onMaybeMissed = (data: unknown) => {
      const d = (data ?? {}) as { state?: string; to?: string };
      const val = String(d.state || d.to || "").toUpperCase();
      // Refetch on every terminal transition - keeps the section in sync
      // without filtering edge cases (un-dismiss after recall, etc.).
      if (val === "MISSED" || val === "ENDED" || val === "FAILED" || val === "") {
        reload();
      }
    };
    const attach = () => {
      const s = getSocket();
      if (!s) return false;
      socket = s;
      s.on("voice.session.state", onMaybeMissed);
      s.on("voice.session.state_changed", onMaybeMissed);
      s.on("voice.session.ended", onMaybeMissed);
      return true;
    };
    if (!attach()) {
      pollTimer = setInterval(() => {
        if (attach() && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }, 250);
    }
    return () => {
      if (pollTimer) clearInterval(pollTimer);
      if (socket) {
        socket.off("voice.session.state", onMaybeMissed);
        socket.off("voice.session.state_changed", onMaybeMissed);
        socket.off("voice.session.ended", onMaybeMissed);
      }
    };
  }, [token, flags.voiceCopilotEnabled, reload]);

  const visible = useMemo(
    () => sessions.filter(
      (s) => !dismissed.has(s.id) && !(s.customerNumber && dismissedPhones.has(s.customerNumber)),
    ),
    [sessions, dismissed, dismissedPhones],
  );
  // Group by customer phone so repeated missed calls from the same person
  // collapse into a single row with a count badge instead of stacking the
  // inbox. Sessions without a customerNumber (rare - number suppressed
  // or unresolved) each get their own group keyed by id so they remain
  // visible. Within a group, the most-recent session is the "leader" and
  // its row is what the agent clicks.
  const grouped = useMemo(() => {
    const map = new Map<string, { leader: MissedVoiceSession; sessionIds: string[]; latestStartedAt: number }>();
    for (const s of visible) {
      const key = s.customerNumber || `__no_number:${s.id}`;
      const startedAt = new Date(s.startedAt).getTime();
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { leader: s, sessionIds: [s.id], latestStartedAt: startedAt });
      } else {
        existing.sessionIds.push(s.id);
        if (startedAt > existing.latestStartedAt) {
          existing.leader = s;
          existing.latestStartedAt = startedAt;
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.latestStartedAt - a.latestStartedAt);
  }, [visible]);
  const unseenCount = useMemo(
    () => grouped.reduce((n, g) => (g.sessionIds.some((id) => !seen.has(id)) ? n + 1 : n), 0),
    [grouped, seen],
  );
  const openSession = useMemo(
    () => visible.find((s) => s.id === openSessionId) || null,
    [visible, openSessionId],
  );

  function flash(kind: "ok" | "err" | "info", text: string) {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4000);
  }

  function markSeen(id: string) {
    setSeen((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev); next.add(id); saveIdSet(SEEN_KEY, next); return next;
    });
  }
  function dismiss(id: string) {
    const target = sessions.find((s) => s.id === id);
    const groupPhone = target?.customerNumber ?? null;
    // Optimistic local hide first - server cascade is fire-and-forget.
    setDismissed((prev) => {
      const next = new Set(prev);
      if (groupPhone) {
        for (const s of sessions) {
          if (s.customerNumber === groupPhone) next.add(s.id);
        }
      } else {
        next.add(id);
      }
      saveIdSet(DISMISS_KEY, next);
      return next;
    });
    if (groupPhone) {
      addDismissedPhone(groupPhone);
      setDismissedPhones((prev) => {
        if (prev.has(groupPhone)) return prev;
        const next = new Set(prev); next.add(groupPhone); return next;
      });
    }
    // Server-side cascade: stamp `handledAt` on every MISSED row for the
    // same customer phone, so other agents / other browsers / the next
    // page reload all see it as handled too. Best-effort - local hide
    // already happened.
    if (token) {
      handleMissedVoiceSession(token, id).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[missed-calls] server dismiss failed:", err);
      });
    }
    if (openSessionId === id) setOpenSessionId(null);
  }

  async function handleCallback(s: MissedVoiceSession) {
    if (!token || busyId) return;
    setBusyId(s.id);
    try {
      const result = await callbackMissedVoiceSession(token, s.id);
      flash("ok", t("voice.missedCalls.callbackStarted"));
      markSeen(s.id);
      // Don't dismiss yet - the Voice page will mark it handled when the
      // session actually reaches ACTIVE (customer picked up). If the
      // callback isn't answered the row stays in the inbox.
      const newSessionId = result?.data?.sessionId;
      if (newSessionId) {
        recordPendingHandle(newSessionId, s.id, s.customerNumber);
        router.push(`/voice/${newSessionId}`);
      } else {
        // No id returned (degenerate AGENT_FIRST path) - fall back to the
        // conversation page so the agent at least sees the right thread.
        router.push(`/conversations?id=${s.conversationId}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("outbound_mode_in_platform")) {
        // The tenant's channel uses the browser dialer for outbound rather
        // than the agent-first bridge. Dispatch the call directly via the
        // VoiceCallContext, stash the conversationId so the watcher effect
        // below can navigate to the Voice workspace once Twilio's webhook
        // has created the new outbound VoiceCallSession row.
        if (!s.customerNumber) {
          flash("err", t("voice.missedCalls.callbackFailed"));
          return;
        }
        try {
          // VoiceCallSession.conversationId is UNIQUE in the schema, so
          // reusing the missed call's conversationId would silently fail
          // the new session insert in /twiml/outbound (constraint violation
          // is caught but no row is created → no voice.session.created
          // event → the watcher below never finds a match to navigate).
          // Mirror /app/outbound/call/page.tsx and mint a fresh UUID; the
          // call still places, the workspace opens, and the missed row
          // gets marked handled once the new session reaches ACTIVE.
          const newConversationId = crypto.randomUUID();
          // Mirror /app/outbound/call/page.tsx: set the pending pointer
          // BEFORE placeCall so the watcher effect can't race the socket
          // event that creates the new outbound session row.
          setPendingNav({
            missedSessionId: s.id,
            conversationId: newConversationId,
            placedAt: Date.now(),
          });
          await placeCall(s.customerNumber, {
            contactName: s.contact?.displayName ?? undefined,
            conversationId: newConversationId,
          });
          // CRITICAL: mirrors /app/outbound/call/page.tsx - the AI service's
          // /voice/start endpoint is what creates the Conversation row.
          // Without this, /twiml/outbound silently fails on a FK violation
          // when trying to insert the VoiceCallSession (conversationId FK
          // points at a non-existent row) → no voice.session.created event
          // → the watcher below has nothing to find → no navigation.
          // Fire-and-forget; navigation works once the row lands in allLive.
          fetch(`${API_URL}/api/ai-assist/voice/start`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              type: "voice_start",
              conversationId: newConversationId,
              context: {
                phone: s.customerNumber,
                contactName: s.contact?.displayName ?? null,
                notes: null,
              },
            }),
          }).catch((e) => {
            // eslint-disable-next-line no-console
            console.warn("[missed-callback] voice_start dispatch failed:", e);
          });
          flash("ok", t("voice.missedCalls.callbackStarted"));
          markSeen(s.id);
        } catch (dialErr) {
          const dialMsg = dialErr instanceof Error ? dialErr.message : String(dialErr);
          if (dialMsg.toLowerCase().includes("voice not ready") || dialMsg.toLowerCase().includes("not ready")) {
            flash("err", t("voice.missedCalls.dialerNotReady"));
          } else {
            flash("err", t("voice.missedCalls.callbackFailed"));
          }
        }
      } else if (msg.includes("agent_phone_not_configured")) {
        flash("err", t("voice.missedCalls.agentPhoneMissing"));
      } else {
        flash("err", t("voice.missedCalls.callbackFailed"));
      }
    } finally {
      setBusyId(null);
    }
  }

  // IN_PLATFORM callback follow-up. Identical pattern to the regular
  // outbound page (/app/outbound/call/page.tsx) which is the proven path
  // from "placeCall returns" → /voice/[sessionId] open: watch `allLive`
  // for a session with matching conversationId, then navigate. The
  // VoiceSessionsProvider already subscribes to voice.session.created
  // and upserts new rows into allLive - no extra socket listener needed.
  useEffect(() => {
    if (!pendingNav) return;
    const match = allLive.find((s) => s.conversationId === pendingNav.conversationId);
    if (match) {
      // eslint-disable-next-line no-console
      console.log("[missed-callback] handoff to /voice/" + match.id);
      const missedSession = sessions.find((x) => x.id === pendingNav.missedSessionId);
      recordPendingHandle(match.id, pendingNav.missedSessionId, missedSession?.customerNumber ?? null);
      setPendingNav(null);
      router.replace(`/voice/${match.id}`);
    }
  }, [pendingNav, allLive, router, sessions]);

  if (flags.loading) return null;
  if (!flags.voiceCopilotEnabled) return null;
  if (visible.length === 0) return null;

  return (
    <>
      <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
        <div className="px-3.5 py-2.5 flex items-center gap-2">
          <span className="text-rose-600">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M8.13 9.36C5.78 11.5 4.5 13.92 4.5 16.5c0 1.24 1.01 2.25 2.25 2.25h2.06c.66 0 1.21-.43 1.38-1.04l.6-1.97M14.86 14.71l1.65-.5c.65-.2 1.36 0 1.73.5l1.43 1.93c.44.6.39 1.42-.13 1.97l-1.04 1.08" />
            </svg>
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-rose-600">
            {t("voice.missedCalls.inboxSectionTitle")}
          </span>
          <span className={clsx(
            "text-[10px] font-bold px-1.5 py-0.5 rounded-full ms-auto",
            unseenCount > 0 ? "bg-rose-50 text-rose-600" : "bg-gray-100 text-gray-500",
          )}>
            {grouped.length}
          </span>
        </div>
        {grouped.slice(0, 5).map((g) => {
          const s = g.leader;
          const name = s.contact?.displayName?.trim();
          const phone = formatPhone(s.customerNumber);
          const display = name || phone || t("voice.missedCalls.unknownCaller");
          const unseen = g.sessionIds.some((id) => !seen.has(id));
          const count = g.sessionIds.length;
          return (
            <button
              key={s.customerNumber || s.id}
              type="button"
              onClick={() => {
                setOpenSessionId(s.id);
                // Mark every session in the group as seen so the "new" badge clears.
                g.sessionIds.forEach((id) => markSeen(id));
              }}
              className="w-full text-start px-4 py-3 hover:bg-gray-50/80 transition-colors border-t border-gray-50 first:border-t-0"
            >
              <div className="flex items-center gap-3">
                <div className={clsx(
                  "w-9 h-9 rounded-full flex items-center justify-center shrink-0 relative",
                  unseen ? "bg-rose-50 text-rose-600" : "bg-gray-100 text-gray-500",
                )}>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M8.13 9.36C5.78 11.5 4.5 13.92 4.5 16.5c0 1.24 1.01 2.25 2.25 2.25h2.06c.66 0 1.21-.43 1.38-1.04l.6-1.97M14.86 14.71l1.65-.5c.65-.2 1.36 0 1.73.5l1.43 1.93c.44.6.39 1.42-.13 1.97l-1.04 1.08" />
                  </svg>
                  {count > 1 ? (
                    <span className="absolute -top-1 -end-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-white">
                      {count > 99 ? "99+" : count}
                    </span>
                  ) : null}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className={clsx(
                      "text-sm truncate",
                      unseen ? "font-semibold text-gray-900" : "font-medium text-gray-700",
                    )}>
                      {display}
                      {count > 1 ? (
                        <span className="ms-1.5 text-[11px] font-normal text-rose-600">
                          ({count})
                        </span>
                      ) : null}
                    </p>
                    <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
                      {shortTimeAgo(s.startedAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    {name && phone ? (
                      <span className="text-[11px] text-gray-400 font-mono truncate">{phone}</span>
                    ) : null}
                    {unseen ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-rose-50 text-rose-600 ms-auto">
                        {t("voice.missedCalls.newBadge")}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
        {grouped.length > 5 ? (
          <div className="px-4 py-2 text-[11px] text-center text-gray-400 border-t border-gray-50">
            {t("voice.missedCalls.moreCount").replace("{n}", String(grouped.length - 5))}
          </div>
        ) : null}
      </div>

      {toast ? (
        <div className={clsx(
          "fixed z-50 left-1/2 -translate-x-1/2 top-4 text-sm px-4 py-2.5 rounded-xl ring-1 shadow-lg",
          toast.kind === "ok" && "bg-green-50 text-green-700 ring-green-200",
          toast.kind === "err" && "bg-red-50 text-red-700 ring-red-200",
          toast.kind === "info" && "bg-amber-50 text-amber-800 ring-amber-200",
        )}>
          {toast.text}
        </div>
      ) : null}

      {openSession ? (
        <MissedCallDetailDrawer
          session={openSession}
          busy={busyId === openSession.id}
          allSessions={sessions}
          onClose={() => setOpenSessionId(null)}
          onCallback={() => handleCallback(openSession)}
          onOpenConversation={() => {
            if (openSession.conversationId) {
              router.push(`/conversations?id=${openSession.conversationId}`);
              setOpenSessionId(null);
            }
          }}
          onDismiss={() => dismiss(openSession.id)}
        />
      ) : null}
    </>
  );
}

// ─── Drawer ───────────────────────────────────────────────────────
// Right-side slide-out panel with caller identity, contact metadata, and
// the recent-history list. Three primary actions on the footer; the row
// stays in the inbox section until the agent explicitly dismisses or the
// callback completes successfully.
function MissedCallDetailDrawer(props: {
  session: MissedVoiceSession;
  allSessions: MissedVoiceSession[];
  busy: boolean;
  onClose: () => void;
  onCallback: () => void;
  onOpenConversation: () => void;
  onDismiss: () => void;
}) {
  const { t, locale } = useI18n();
  const { token } = useAuth();
  const { session, allSessions, busy, onClose, onCallback, onOpenConversation, onDismiss } = props;
  const name = session.contact?.displayName?.trim();
  const phone = formatPhone(session.customerNumber);
  const display = name || phone || t("voice.missedCalls.unknownCaller");

  // Fetch the enriched detail (contact + CRM + brief + recent conversations)
  // lazily on open. Falls back to the bare session if the request fails so
  // the drawer is always usable.
  const [detail, setDetail] = useState<MissedVoiceSessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setDetailLoading(true);
    getMissedVoiceSessionDetail(token, session.id)
      .then((res) => { if (!cancelled) setDetail(res.data); })
      .catch(() => { /* keep the section usable on failure */ })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [token, session.id]);

  // Prefer the enriched contact (has metadata + lastInteractionAt) when
  // available; fall back to the slimmer summary that came with the list.
  const contact = detail?.contact ?? session.contact;
  const tags = contact?.tags ?? [];
  const brief = detail?.brief ?? null;
  const priorConversations = detail?.priorConversations ?? [];
  const customFields = (contact && "metadata" in contact && contact.metadata)
    ? Object.entries(contact.metadata as Record<string, unknown>).filter(
        ([, v]) => v != null && v !== "",
      )
    : [];

  // Group recent missed calls by this same number to surface call cadence.
  const previousFromSameNumber = useMemo(
    () => allSessions.filter(
      (s) => s.id !== session.id && s.customerNumber && s.customerNumber === session.customerNumber,
    ).slice(0, 5),
    [allSessions, session.id, session.customerNumber],
  );

  function formatWhen(iso: string | null): string {
    if (!iso) return "-";
    try {
      return new Date(iso).toLocaleString(locale, {
        hour: "2-digit", minute: "2-digit",
        day: "2-digit", month: "short",
      });
    } catch { return iso; }
  }

  function channelLabel(ch: string): string {
    return ch.charAt(0) + ch.slice(1).toLowerCase().replace(/_/g, " ");
  }

  return (
    <div className="fixed inset-0 z-40 flex" role="dialog" aria-modal="true">
      {/* Click-outside scrim */}
      <button
        type="button"
        aria-label={t("voice.missedCalls.closeDrawer")}
        onClick={onClose}
        className="flex-1 bg-black/30"
      />
      {/* Panel */}
      <div className="w-full max-w-md bg-white shadow-2xl flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest text-rose-600">
              {t("voice.missedCalls.drawerTitle")}
            </p>
            <h2 className="text-lg font-bold text-gray-900 truncate mt-0.5">{display}</h2>
            {name && phone ? (
              <p className="text-xs text-gray-500 font-mono mt-0.5">{phone}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 rounded-md hover:bg-gray-50"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Call context */}
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
              {t("voice.missedCalls.sectionCall")}
            </h3>
            <dl className="text-sm space-y-1.5">
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">{t("voice.missedCalls.fieldWhen")}</dt>
                <dd className="text-gray-900">{formatWhen(session.startedAt)}</dd>
              </div>
              {session.contact?.email ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-500">{t("voice.missedCalls.fieldEmail")}</dt>
                  <dd className="text-gray-900 truncate">{session.contact.email}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          {/* Tags */}
          {tags.length > 0 ? (
            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
                {t("voice.missedCalls.sectionTags")}
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span key={tag} className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
                    {tag}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {/* Customer Brief (AI-generated behavioral summary) */}
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
              {t("voice.missedCalls.sectionBrief")}
            </h3>
            {detailLoading && !detail ? (
              <p className="text-xs text-gray-400 italic">{t("voice.missedCalls.loadingDetail")}</p>
            ) : brief ? (
              <div className="space-y-2.5">
                <p className="text-sm text-gray-800 leading-relaxed">{brief.brief}</p>

                {/* Signals - short "remember this" phrases */}
                {brief.signals.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">
                      {t("voice.missedCalls.briefSignalsLabel")}
                    </p>
                    <ul className="space-y-0.5">
                      {brief.signals.map((s, i) => (
                        <li key={i} className="text-xs text-gray-700 flex gap-1.5">
                          <span className="text-rose-500">•</span>
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Tone + mood chips */}
                {(brief.tone || brief.mood) && (
                  <div className="flex flex-wrap gap-1.5">
                    {brief.tone && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                        {t("voice.missedCalls.briefToneLabel")}: {brief.tone}
                      </span>
                    )}
                    {brief.mood && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                        {t("voice.missedCalls.briefMoodLabel")}: {brief.mood}
                      </span>
                    )}
                  </div>
                )}

                {/* Recommended behaviors */}
                {brief.recommendedBehaviors.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-1">
                      {t("voice.missedCalls.briefRecommendedLabel")}
                    </p>
                    <ul className="space-y-0.5">
                      {brief.recommendedBehaviors.map((b, i) => (
                        <li key={i} className="text-xs text-gray-700 flex gap-1.5">
                          <span className="text-emerald-500">→</span>
                          <span>{b}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <p className="text-[10px] text-gray-400">
                  {t("voice.missedCalls.briefMeta")
                    .replace("{n}", String(brief.conversationCount))
                    .replace("{when}", formatWhen(brief.generatedAt))}
                </p>
              </div>
            ) : (
              <p className="text-xs text-gray-400 italic">{t("voice.missedCalls.noBrief")}</p>
            )}
          </section>

          {/* CRM details - custom fields + last interaction */}
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
              {t("voice.missedCalls.sectionCrm")}
            </h3>
            {detailLoading && !detail ? (
              <p className="text-xs text-gray-400 italic">{t("voice.missedCalls.loadingDetail")}</p>
            ) : detail?.contact ? (
              <dl className="text-sm space-y-1.5">
                {detail.contact.lastInteractionAt && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500">{t("voice.missedCalls.fieldLastSeen")}</dt>
                    <dd className="text-gray-900">{formatWhen(detail.contact.lastInteractionAt)}</dd>
                  </div>
                )}
                {customFields.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="text-gray-500 truncate">{k}</dt>
                    <dd className="text-gray-900 truncate text-end">
                      {typeof v === "object" ? JSON.stringify(v) : String(v)}
                    </dd>
                  </div>
                ))}
                {!detail.contact.lastInteractionAt && customFields.length === 0 && (
                  <p className="text-xs text-gray-400 italic">{t("voice.missedCalls.noCrm")}</p>
                )}
              </dl>
            ) : (
              <p className="text-xs text-gray-400 italic">{t("voice.missedCalls.noCrm")}</p>
            )}
          </section>

          {/* Last 3 conversations with their AI summary */}
          <section>
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
              {t("voice.missedCalls.sectionRecentConversations")}
            </h3>
            {detailLoading && !detail ? (
              <p className="text-xs text-gray-400 italic">{t("voice.missedCalls.loadingDetail")}</p>
            ) : priorConversations.length > 0 ? (
              <ul className="space-y-2.5">
                {priorConversations.map((c) => (
                  <li key={c.id} className="border-s-2 border-gray-200 ps-2.5">
                    <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-0.5">
                      <span className="font-semibold text-gray-700">{channelLabel(c.channel)}</span>
                      <span>·</span>
                      <span>{c.status.toLowerCase()}</span>
                      <span className="ms-auto">{formatWhen(c.lastMessageAt)}</span>
                    </div>
                    {c.aiSummary ? (
                      <p className="text-xs text-gray-700 leading-relaxed">{c.aiSummary}</p>
                    ) : (
                      <p className="text-xs text-gray-400 italic">-</p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-gray-400 italic">{t("voice.missedCalls.noConversations")}</p>
            )}
          </section>

          {/* Previous missed calls from same number */}
          {previousFromSameNumber.length > 0 ? (
            <section>
              <h3 className="text-[10px] font-semibold uppercase tracking-widest text-gray-500 mb-2">
                {t("voice.missedCalls.sectionPrevious")}
              </h3>
              <ul className="space-y-1.5">
                {previousFromSameNumber.map((s) => (
                  <li key={s.id} className="text-sm text-gray-700 flex justify-between gap-3">
                    <span className="truncate">{formatWhen(s.startedAt)}</span>
                    <span className="text-xs text-gray-400">{shortTimeAgo(s.startedAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs font-medium text-gray-500 hover:text-gray-700 px-3 py-2 rounded-lg hover:bg-gray-50"
          >
            {t("voice.missedCalls.dismiss")}
          </button>
          <div className="ms-auto flex items-center gap-2">
            {session.conversationId ? (
              <button
                type="button"
                onClick={onOpenConversation}
                className="text-xs font-medium px-3 py-2 rounded-lg ring-1 ring-gray-200 text-gray-700 hover:bg-gray-50"
              >
                {t("voice.missedCalls.openConversation")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onCallback}
              disabled={busy}
              className={clsx(
                "text-xs font-semibold px-4 py-2 rounded-lg transition shrink-0",
                busy ? "bg-gray-100 text-gray-400 cursor-wait" : "bg-rose-600 text-white hover:bg-rose-700",
              )}
            >
              {busy ? t("voice.missedCalls.callingBack") : t("voice.missedCalls.callBack")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
