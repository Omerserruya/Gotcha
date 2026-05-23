"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getConversations, getDepartments, getSlaSettings, getDepartmentSla, deleteConversation } from "@/lib/api";
import { getSocket } from "@/lib/socket";
import Image from "next/image";
function shortTimeAgo(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w`;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${date.getDate()} ${months[date.getMonth()]}`;
}
import clsx from "clsx";
import { ChannelBadge } from "./ChannelBadge";
import { CustomerAvatar } from "./CustomerAvatar";
import { NewConversationPanel } from "./NewConversationPanel";
import ConfirmModal from "@/components/ConfirmModal";
import { LiveCallsSection } from "@/components/voice/LiveCallsSection";
import { MissedCallsSection } from "@/components/voice/MissedCallsSection";

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function getLastReadMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem("chatcenter:lastRead") || "{}"); } catch { return {}; }
}

function getMarkedUnread(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem("chatcenter:markedUnread") || "[]")); } catch { return new Set(); }
}

function saveMarkedUnread(set: Set<string>) {
  localStorage.setItem("chatcenter:markedUnread", JSON.stringify(Array.from(set)));
}

function isUnread(conv: any, lastReadMap: Record<string, string>, markedUnread: Set<string>): boolean {
  if (markedUnread.has(conv.id)) return true;
  if (!conv.lastMessageAt || conv.lastMessageDirection !== "INBOUND") return false;
  const lastRead = lastReadMap[conv.id];
  if (!lastRead) return true;
  return new Date(conv.lastMessageAt) > new Date(lastRead);
}

export function ConversationList({ selectedId, onSelect }: Props) {
  const { token, user } = useAuth();
  const { t } = useI18n();
  const [conversations, setConversations] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState<string>("");
  const [departmentFilter, setDepartmentFilter] = useState<string>("");
  const [departments, setDepartments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastReadMap, setLastReadMap] = useState<Record<string, string>>(getLastReadMap);
  const [slaConfig, setSlaConfig] = useState<{ enabled: boolean; slaMinutes: number; warningThreshold: number } | null>(null);
  const [deptSlaMap, setDeptSlaMap] = useState<Record<string, { enabled: boolean; slaMinutes: number }>>({});
  const [markedUnread, setMarkedUnread] = useState<Set<string>>(getMarkedUnread);
  const [contextMenu, setContextMenu] = useState<{ convId: string; x: number; y: number } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const historyMode = false; // History is on a separate page
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // New Conversation panel state
  const [showInitiate, setShowInitiate] = useState(false);

  const handleSelect = useCallback((id: string) => {
    // Clear markedUnread when opening a conversation
    setMarkedUnread((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      saveMarkedUnread(next);
      return next;
    });
    onSelect(id);
  }, [onSelect]);

  const handleContextMenu = useCallback((e: React.MouseEvent, convId: string) => {
    e.preventDefault();
    setContextMenu({ convId, x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleMarkUnread = useCallback(() => {
    if (!contextMenu) return;
    setMarkedUnread((prev) => {
      const next = new Set(prev);
      next.add(contextMenu.convId);
      saveMarkedUnread(next);
      return next;
    });
    setContextMenu(null);
  }, [contextMenu]);

  const handleDeleteClick = useCallback(() => {
    if (!contextMenu) return;
    setDeleteTarget(contextMenu.convId);
    setContextMenu(null);
  }, [contextMenu]);

  // Close context menu on click outside, scroll, or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
    };
    const handleScroll = () => closeContextMenu();
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    listRef.current?.addEventListener("scroll", handleScroll);
    const listEl = listRef.current;
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
      listEl?.removeEventListener("scroll", handleScroll);
    };
  }, [contextMenu, closeContextMenu]);

  function openInitiateModal() {
    setShowInitiate(true);
  }

  function handleConversationCreated(convId: string) {
    fetchConversations();
    if (convId) onSelect(convId);
  }

  const fetchConversations = useCallback(async () => {
    if (!token) return;
    try {
      const params: Record<string, string> = {};
      if (search) params.search = search;
      if (channelFilter) params.channel = channelFilter;
      if (departmentFilter) params.departmentId = departmentFilter;
      if (historyMode) {
        params.status = "CLOSED";
        params.includeAutomated = "true";
      }
      const res = await getConversations(token, params);
      setConversations(res.data);
    } catch (err) {
      console.error("Failed to fetch conversations:", err);
    } finally {
      setLoading(false);
    }
  }, [token, search, channelFilter, departmentFilter, historyMode]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!token || !deleteTarget) return;
    setDeleteLoading(true);
    try {
      await deleteConversation(token, deleteTarget, true);
      setDeleteTarget(null);
      fetchConversations();
    } catch (err) {
      console.error("Failed to delete conversation:", err);
    } finally {
      setDeleteLoading(false);
    }
  }, [token, deleteTarget, fetchConversations]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Fetch departments for filter (admin only)
  useEffect(() => {
    if (!token || user?.role !== "ADMIN") return;
    getDepartments(token).then((list) => {
      const depts = Array.isArray(list) ? list : (list as any)?.data || [];
      setDepartments(depts);
    }).catch(() => {});
  }, [token, user?.role]);

  // Fetch SLA settings
  useEffect(() => {
    if (!token) return;
    getSlaSettings(token).then((data) => {
      setSlaConfig(data);
      // Fetch department SLA overrides if SLA enabled
      if (data.enabled && departments.length > 0) {
        Promise.all(
          departments.map((d: any) => getDepartmentSla(token, d.id).catch(() => ({ enabled: false, slaMinutes: null })))
        ).then((results) => {
          const map: Record<string, { enabled: boolean; slaMinutes: number }> = {};
          departments.forEach((d: any, i: number) => {
            if (results[i]?.enabled) map[d.id] = results[i];
          });
          setDeptSlaMap(map);
        });
      }
    }).catch(() => {});
  }, [token, departments.length]);

  // Real-time updates
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleUpdate = () => fetchConversations();
    socket.on("conversation:updated", handleUpdate);
    socket.on("conversation:closed", handleUpdate);
    socket.on("message:new", handleUpdate);

    return () => {
      socket.off("conversation:updated", handleUpdate);
      socket.off("conversation:closed", handleUpdate);
      socket.off("message:new", handleUpdate);
    };
  }, [fetchConversations]);

  // Listen for read events from ChatPanel
  useEffect(() => {
    const handleRead = () => setLastReadMap(getLastReadMap());
    window.addEventListener("conversation:read", handleRead);
    return () => window.removeEventListener("conversation:read", handleRead);
  }, []);

  // Group conversations into 3 queues (inbox mode) or flat history list
  const { myActive, assignedToMe, generalQueue, closedList } = useMemo(() => {
    const myActive: any[] = [];
    const assignedToMe: any[] = [];
    const generalQueue: any[] = [];
    const closedList: any[] = [];

    for (const conv of conversations) {
      if (historyMode) {
        closedList.push(conv);
        continue;
      }
      if (conv.status === "CLOSED") continue;

      if (conv.assignedAgentId === user?.id) {
        // My conversation - split by whether I've responded
        if (conv.lastMessageDirection === "OUTBOUND") {
          myActive.push(conv);
        } else {
          assignedToMe.push(conv);
        }
      } else if (!conv.assignedAgentId) {
        generalQueue.push(conv);
      } else if (user?.role === "ADMIN") {
        // Admin can see conversations assigned to others in the general area
        myActive.push(conv);
      }
    }

    return { myActive, assignedToMe, generalQueue, closedList };
  }, [conversations, user, historyMode]);

  const sections = [
    {
      key: "myActive",
      label: t("conversations.myActive"),
      items: myActive,
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
        </svg>
      ),
      color: "text-primary-600",
      bgColor: "bg-primary-50",
    },
    {
      key: "assignedToMe",
      label: t("conversations.assignedToMe"),
      items: assignedToMe,
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      color: "text-amber-600",
      bgColor: "bg-amber-50",
    },
    {
      key: "generalQueue",
      label: t("conversations.generalQueue"),
      items: generalQueue,
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
        </svg>
      ),
      color: "text-gray-500",
      bgColor: "bg-gray-50",
    },
  ];

  return (
    <>
      {/* Header */}
      <div className="p-3">
        <div className="flex items-center justify-between mb-3 ps-8 md:ps-0">
          <h2 className="text-lg font-bold text-gray-900">{t("conversations.title")}</h2>
        </div>
        {/* Search & Filter widget */}
        <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm p-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <svg className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("conversations.search")}
                className="w-full ps-9 pe-4 py-2.5 text-base md:text-sm bg-gray-50/80 border-0 ring-1 ring-gray-200/60 rounded-xl focus:ring-2 focus:ring-primary-200 focus:bg-white outline-none transition"
              />
            </div>
            {/* New Conversation button */}
            <button
              onClick={openInitiateModal}
              title={t("conversations.newConversation")}
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all bg-primary-500 text-white hover:bg-primary-600 shadow-sm"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
            {/* Department filter toggle (admin only) */}
            {user?.role === "ADMIN" && departments.length > 0 && (
              <button
                onClick={() => setShowFilters(!showFilters)}
                className={clsx(
                  "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all relative",
                  showFilters || departmentFilter
                    ? "bg-primary-50 text-primary-600"
                    : "bg-gray-50/80 text-gray-400 ring-1 ring-gray-200/60 hover:bg-gray-100"
                )}
                title={t("conversations.allDepartments")}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
                </svg>
                {departmentFilter && (
                  <span className="absolute -top-0.5 -end-0.5 w-2 h-2 bg-primary-500 rounded-full" />
                )}
              </button>
            )}
          </div>

          {/* Channel icon filters — always visible */}
          <div className="flex items-center gap-1 mt-2.5">
            <button
              onClick={() => setChannelFilter("")}
              className={clsx(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all",
                channelFilter === ""
                  ? "bg-primary-50 text-primary-600 ring-1 ring-primary-200"
                  : "text-gray-400 hover:bg-gray-50 hover:text-gray-600"
              )}
            >
              {t("conversations.filterAll")}
            </button>
            {[
              { value: "WHATSAPP", logo: "/icons/wa.png", label: "WhatsApp" },
              { value: "MESSENGER", logo: "/icons/msn.png", label: "Messenger" },
              { value: "INSTAGRAM", logo: "/icons/ins.png", label: "Instagram" },
              { value: "GMAIL", logo: "/icons/gm.png", label: "Gmail" },
              { value: "OUTLOOK", logo: "/icons/ol.png", label: "Outlook" },
              { value: "SLACK", logo: "/icons/slk.png", label: "Slack" },
            ].map((ch) => (
              <button
                key={ch.value}
                onClick={() => setChannelFilter(channelFilter === ch.value ? "" : ch.value)}
                title={ch.label}
                className={clsx(
                  "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all",
                  channelFilter === ch.value
                    ? "bg-primary-50 ring-1 ring-primary-200 shadow-sm"
                    : "hover:bg-gray-100 opacity-50 hover:opacity-100"
                )}
              >
                <Image src={ch.logo} alt={ch.label} width={18} height={18} className="rounded-sm" />
              </button>
            ))}
            {/* Webchat filter (no icon file — inline SVG) */}
            <button
              onClick={() => setChannelFilter(channelFilter === "WEBCHAT" ? "" : "WEBCHAT")}
              title="Web Chat"
              className={clsx(
                "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all",
                channelFilter === "WEBCHAT"
                  ? "bg-primary-50 ring-1 ring-primary-200 shadow-sm"
                  : "hover:bg-gray-100 opacity-50 hover:opacity-100"
              )}
            >
              <svg className="w-[18px] h-[18px] text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5a17.92 17.92 0 01-8.716-2.247m0 0A8.966 8.966 0 013 12c0-1.264.26-2.467.729-3.558" />
              </svg>
            </button>
          </div>

          {/* Department filter (admin only, collapsible) */}
          {showFilters && user?.role === "ADMIN" && departments.length > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-100/60">
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => setDepartmentFilter("")}
                  className={clsx(
                    "text-[11px] px-2.5 py-1 rounded-lg font-medium transition",
                    departmentFilter === ""
                      ? "bg-primary-500 text-white shadow-sm"
                      : "bg-gray-50 text-gray-500 ring-1 ring-gray-200/40 hover:bg-gray-100"
                  )}
                >
                  {t("conversations.allDepartments")}
                </button>
                {departments.map((dept: any) => (
                  <button
                    key={dept.id}
                    onClick={() => setDepartmentFilter(dept.id)}
                    className={clsx(
                      "text-[11px] px-2.5 py-1 rounded-lg font-medium transition",
                      departmentFilter === dept.id
                        ? "bg-primary-500 text-white shadow-sm"
                        : "bg-gray-50 text-gray-500 ring-1 ring-gray-200/40 hover:bg-gray-100"
                    )}
                  >
                    {dept.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 pt-2 space-y-2" ref={listRef}>
        {/* Phase 1 — Live voice calls. Renders null unless tenant has
            `voiceInboxUiEnabled = true` AND there is at least one RINGING
            or live session, so non-voice tenants see today's inbox. */}
        <LiveCallsSection />
        {/* Missed voice calls. Renders null when there are zero un-dismissed
            missed sessions, so non-voice tenants and "clean" inboxes see no
            extra surface. Tap a row → drawer with caller context + call-back. */}
        <MissedCallsSection />
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="p-8 text-center">
            <svg className="w-12 h-12 mx-auto mb-3 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
            </svg>
            <p className="text-sm text-gray-400">{t("conversations.noConversations")}</p>
          </div>
        ) : historyMode ? (
          <div className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
            <div className="px-3.5 py-2.5 flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                {t("conversations.filterClosed")}
              </span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full ms-auto bg-gray-100 text-gray-400">
                {closedList.length}
              </span>
            </div>
            {closedList.length === 0 ? (
              <div className="px-4 py-3 text-xs text-gray-300 text-center">
                {t("conversations.noConversations")}
              </div>
            ) : (
              closedList.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => handleSelect(conv.id)}
                  className={clsx(
                    "w-full text-start px-4 py-3 hover:bg-gray-50/80 transition-colors",
                    selectedId === conv.id && "bg-primary-50/60 rounded-lg mx-2"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <CustomerAvatar
                      name={conv.customerName || conv.customerPhone}
                      avatarUrl={conv.customerAvatarUrl}
                      channel={conv.channel}
                      size="md"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold text-sm truncate text-gray-700">
                          {conv.customerName || conv.customerExternalId || conv.customerPhone}
                        </p>
                        <span className="text-[10px] text-gray-400 shrink-0">
                          {conv.closedAt ? shortTimeAgo(new Date(conv.closedAt)) : conv.lastMessageAt ? shortTimeAgo(new Date(conv.lastMessageAt)) : ""}
                        </span>
                      </div>
                      <p className="text-xs truncate mt-0.5 text-gray-400">
                        {conv.lastMessageBody || conv.customerPhone}
                      </p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {conv.department && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-600">
                            {conv.department.name}
                          </span>
                        )}
                        {conv.handledBy && conv.handledBy !== "human" && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-purple-50 text-purple-600">
                            {conv.handledBy === "ai_agent" ? "AI" : "Flow"}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.key} className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
              {/* Section header */}
              <div className="px-3.5 py-2.5 flex items-center gap-2">
                <span className={section.color}>{section.icon}</span>
                <span className={clsx("text-[10px] font-semibold uppercase tracking-widest", section.color)}>
                  {section.label}
                </span>
                <span className={clsx(
                  "text-[10px] font-bold px-1.5 py-0.5 rounded-full ms-auto",
                  section.items.length > 0 ? "bg-gray-100 " + section.color : "bg-gray-100 text-gray-400"
                )}>
                  {section.items.length}
                </span>
              </div>

              {/* Section items */}
              {section.items.length === 0 ? (
                <div className="px-4 py-3 text-xs text-gray-300 text-center">
                  {t("conversations.noChatsInSection")}
                </div>
              ) : (
                section.items.map((conv) => (
                  <button
                    key={conv.id}
                    onClick={() => handleSelect(conv.id)}
                    onContextMenu={(e) => handleContextMenu(e, conv.id)}
                    className={clsx(
                      "w-full text-start px-4 py-3 hover:bg-gray-50/80 transition-colors",
                      selectedId === conv.id && "bg-primary-50/60 rounded-lg mx-2"
                    )}
                  >
                    <div className="flex items-center gap-3">
                      {/* Avatar with channel badge */}
                      <CustomerAvatar
                        name={conv.customerName || conv.customerPhone}
                        avatarUrl={conv.customerAvatarUrl}
                        channel={conv.channel}
                        size="md"
                      />

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className={clsx(
                            "font-semibold text-sm truncate",
                            isUnread(conv, lastReadMap, markedUnread) ? "text-gray-900" : "text-gray-900"
                          )}>
                            {conv.customerName || conv.customerExternalId || conv.customerPhone}
                          </p>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {conv.lastMessageAt && (
                              <span className="text-[10px] text-gray-400 shrink-0">
                                {shortTimeAgo(new Date(conv.lastMessageAt))}
                              </span>
                            )}
                          </div>
                        </div>
                        <p className={clsx(
                          "text-xs truncate mt-0.5",
                          isUnread(conv, lastReadMap, markedUnread) ? "text-gray-500 font-medium" : "text-gray-400"
                        )}>
                          {conv.lastMessageBody || conv.customerPhone}
                        </p>
                        <div className="flex items-center justify-between mt-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            {conv.department && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-600">
                                {conv.department.name}
                              </span>
                            )}
                            {conv.assignedAgent && conv.assignedAgentId !== user?.id && (
                              <span className="text-[10px] text-gray-400">
                                {conv.assignedAgent.name}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Status dot: blue=unread, red=SLA breach */}
                      {(() => {
                        let dotColor = "";
                        if (slaConfig?.enabled && conv.status !== "CLOSED") {
                          let slaMins = slaConfig.slaMinutes;
                          if (conv.departmentId && deptSlaMap[conv.departmentId]?.enabled) {
                            slaMins = deptSlaMap[conv.departmentId].slaMinutes;
                          }
                          const ref = conv.lastMessageAt || conv.createdAt;
                          if (ref) {
                            const pct = ((Date.now() - new Date(ref).getTime()) / 60000 / slaMins) * 100;
                            if (pct >= 100) dotColor = "bg-red-500";
                          }
                        }
                        if (!dotColor && isUnread(conv, lastReadMap, markedUnread)) dotColor = "bg-blue-500";
                        return dotColor ? (
                          <span className={clsx("w-2 h-2 rounded-full shrink-0", dotColor)} />
                        ) : <span className="w-2 shrink-0" />;
                      })()}
                    </div>
                  </button>
                ))
              )}
            </div>
          ))
        )}
      </div>

      {/* New Conversation Panel */}
      {showInitiate && (
        <NewConversationPanel
          onClose={() => setShowInitiate(false)}
          onCreated={handleConversationCreated}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-white rounded-xl shadow-float py-1 min-w-[180px] animate-in fade-in zoom-in-95 duration-150"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            onClick={handleMarkUnread}
            className="w-full text-start px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5 transition-colors"
          >
            <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 9v.906a2.25 2.25 0 01-1.183 1.981l-6.478 3.488M2.25 9v.906a2.25 2.25 0 001.183 1.981l6.478 3.488m8.839 2.51l-4.66-2.51m0 0l-1.023-.55a2.25 2.25 0 00-2.134 0l-1.022.55m0 0l-4.661 2.51m16.5 1.615a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V8.844a2.25 2.25 0 011.183-1.981l7.5-4.039a2.25 2.25 0 012.134 0l7.5 4.039a2.25 2.25 0 011.183 1.98V19.5z" />
            </svg>
            {t("conversations.markUnread")}
          </button>
          {user?.role === "ADMIN" && (
            <button
              onClick={handleDeleteClick}
              className="w-full text-start px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2.5 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              {t("conversations.deleteChat")}
            </button>
          )}
        </div>
      )}

      {/* Delete confirmation modal */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        title={t("conversations.deleteConfirmTitle")}
        message={t("conversations.deleteConfirmMsg")}
        confirmText={t("common.delete")}
        danger
        loading={deleteLoading}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

function StatusBadge({ status, t }: { status: string; t: (key: string) => string }) {
  const config: Record<string, { class: string; label: string }> = {
    OPEN: { class: "bg-green-50 text-green-600", label: t("conversations.filterOpen") },
    WAITING: { class: "bg-amber-50 text-amber-600", label: t("conversations.filterWaiting") },
    CLOSED: { class: "bg-gray-100 text-gray-500", label: t("conversations.filterClosed") },
  };
  const c = config[status] || config.OPEN;
  return (
    <span className={clsx("text-[10px] px-2 py-0.5 rounded-full font-medium", c.class)}>
      {c.label}
    </span>
  );
}

function SlaChip({ conv, slaConfig, deptSlaMap, t }: {
  conv: any;
  slaConfig: { enabled: boolean; slaMinutes: number; warningThreshold: number } | null;
  deptSlaMap: Record<string, { enabled: boolean; slaMinutes: number }>;
  t: (key: string) => string;
}) {
  if (!slaConfig?.enabled) return null;
  // Only show SLA for non-closed conversations
  if (conv.status === "CLOSED") return null;

  // Determine SLA minutes: use department override if exists, else tenant default
  let slaMinutes = slaConfig.slaMinutes;
  if (conv.departmentId && deptSlaMap[conv.departmentId]?.enabled) {
    slaMinutes = deptSlaMap[conv.departmentId].slaMinutes;
  }

  // Calculate elapsed time since conversation entered queue (createdAt or lastMessageAt)
  const referenceTime = conv.lastMessageAt || conv.createdAt;
  if (!referenceTime) return null;

  const elapsed = (Date.now() - new Date(referenceTime).getTime()) / 60000; // in minutes
  const percentage = (elapsed / slaMinutes) * 100;

  if (percentage >= 100) {
    // SLA breached
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-red-50 text-red-600 flex items-center gap-1">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
        {t("settings.slaBreached")}
      </span>
    );
  } else if (percentage >= slaConfig.warningThreshold) {
    // SLA warning
    const remaining = Math.max(0, Math.ceil(slaMinutes - elapsed));
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-600 flex items-center gap-1">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {remaining}m
      </span>
    );
  }
  return null;
}
