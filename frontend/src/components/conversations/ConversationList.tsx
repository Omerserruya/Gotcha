"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getConversations, getDepartments, getSlaSettings, getDepartmentSla, deleteConversation, getAIAgents } from "@/lib/api";
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
import { EmptyState } from "@/components/EmptyState";
import { useChannelsSummary } from "@/lib/use-channels-summary";
import { track } from "@/lib/analytics";
import { NewConversationPanel } from "./NewConversationPanel";
import ConfirmModal from "@/components/ConfirmModal";
import { LiveCallsSection } from "@/components/voice/LiveCallsSection";
import { MissedCallsSection } from "@/components/voice/MissedCallsSection";

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

// Collapsed is the DEFAULT, and the stored value only ever un-collapses a
// returning user who opened it themselves. These sections are ambient
// awareness, not work: expanded by default they would compete with the queues
// that do need attention.
//
// Two keys, because they answer different questions. "An employee is talking
// to this customer" and "a scripted flow is stepping this customer through
// something" fail differently and get looked at by different people, so one
// shared toggle would force whoever cares about one to keep opening the other.
const AI_SECTION_COLLAPSED_KEY = "chatcenter:inboxAiSectionCollapsed";
const FLOW_SECTION_COLLAPSED_KEY = "chatcenter:inboxFlowSectionCollapsed";

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
  // Why-aware empty states need to know whether ANY channel is connected.
  const channelsSummary = useChannelsSummary(token);
  const [departments, setDepartments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Initial state MUST match the static build (empty/defaults) or React
  // hydration throws #425/#418/#423 and unmounts the tree - see I18nContext
  // for the same pattern. localStorage is hydrated in a useEffect below.
  const [lastReadMap, setLastReadMap] = useState<Record<string, string>>({});
  const [slaConfig, setSlaConfig] = useState<{ enabled: boolean; slaMinutes: number; warningThreshold: number } | null>(null);
  const [deptSlaMap, setDeptSlaMap] = useState<Record<string, { enabled: boolean; slaMinutes: number }>>({});
  const [markedUnread, setMarkedUnread] = useState<Set<string>>(() => new Set());
  // Conversations an AI employee / flow currently owns. Fetched separately
  // from the human queues rather than filtered out of them: they are excluded
  // server-side by default, and sharing one paginated request would let a busy
  // AI push real work off the first page.
  const [aiConversations, setAiConversations] = useState<any[]>([]);
  const [aiCollapsed, setAiCollapsed] = useState(true);
  const [flowCollapsed, setFlowCollapsed] = useState(true);
  const [aiAgentNames, setAiAgentNames] = useState<Record<string, string>>({});

  // Post-hydration warm-up from localStorage.
  useEffect(() => {
    setLastReadMap(getLastReadMap());
    setMarkedUnread(getMarkedUnread());
    try {
      // Absent key → stays collapsed. Only an explicit "0" opens it.
      if (localStorage.getItem(AI_SECTION_COLLAPSED_KEY) === "0") setAiCollapsed(false);
      if (localStorage.getItem(FLOW_SECTION_COLLAPSED_KEY) === "0") setFlowCollapsed(false);
    } catch {}
  }, []);
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

  // The AI-handled section. Its own request, and its own failure: if this one
  // errors the inbox still renders every human queue, because an ambient panel
  // must never be able to take the actual work down with it.
  const fetchAiConversations = useCallback(async () => {
    if (!token || historyMode) { setAiConversations([]); return; }
    try {
      const params: Record<string, string> = { automatedOnly: "true" };
      // The same filters the human queues obey. A channel filter that silently
      // did not apply here would make the counts disagree with what is shown.
      if (search) params.search = search;
      if (channelFilter) params.channel = channelFilter;
      if (departmentFilter) params.departmentId = departmentFilter;
      const res = await getConversations(token, params);
      setAiConversations(res.data || []);
    } catch (err) {
      console.error("Failed to fetch AI-handled conversations:", err);
      setAiConversations([]);
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

  useEffect(() => {
    fetchAiConversations();
  }, [fetchAiConversations]);

  // Names for the `assignedAiAgentId` on each row. Resolved from the employee
  // roster rather than joined onto Conversation, which has no AI-agent
  // relation - a schema migration for one label is not worth it.
  useEffect(() => {
    if (!token) return;
    getAIAgents(token)
      .then((res) => {
        const map: Record<string, string> = {};
        for (const a of res.data || []) if (a?.id) map[a.id] = a.name;
        setAiAgentNames(map);
      })
      .catch(() => {});
  }, [token]);

  // Guided-tour demo mode toggled while we're already mounted (the tour can
  // start from /conversations): swap between real and fixture data live.
  useEffect(() => {
    const onMockChanged = () => fetchConversations();
    window.addEventListener("tour:mock-changed", onMockChanged);
    return () => window.removeEventListener("tour:mock-changed", onMockChanged);
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

    // Both lists refresh together. An escalation moves a conversation OUT of
    // the AI section and INTO a human queue in the same instant, so refreshing
    // one without the other shows it in both places or in neither.
    const handleUpdate = () => { fetchConversations(); fetchAiConversations(); };
    socket.on("conversation:updated", handleUpdate);
    socket.on("conversation:closed", handleUpdate);
    socket.on("message:new", handleUpdate);

    return () => {
      socket.off("conversation:updated", handleUpdate);
      socket.off("conversation:closed", handleUpdate);
      socket.off("message:new", handleUpdate);
    };
  }, [fetchConversations, fetchAiConversations]);

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

  // One request returns everything an automation owns; `handledBy` splits it.
  // Partitioned here rather than in two requests because the distinction is a
  // field already on the row, and a second round-trip to re-ask the same
  // question would only add a way for the two halves to disagree.
  const { aiEmployeeConvs, flowConvs } = useMemo(() => {
    const aiEmployeeConvs: any[] = [];
    const flowConvs: any[] = [];
    for (const conv of aiConversations) {
      (conv.handledBy === "flow" ? flowConvs : aiEmployeeConvs).push(conv);
    }
    return { aiEmployeeConvs, flowConvs };
  }, [aiConversations]);

  const automationSections = [
    {
      key: "ai",
      items: aiEmployeeConvs,
      collapsed: aiCollapsed,
      setCollapsed: setAiCollapsed,
      storageKey: AI_SECTION_COLLAPSED_KEY,
      label: t("conversations.aiHandledSection"),
      hint: t("conversations.aiHandledHint"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
      ),
      iconColor: "text-purple-500",
      labelColor: "text-purple-600",
      countClass: "bg-purple-50 text-purple-600",
      chevronColor: "text-purple-400",
      hoverBg: "hover:bg-purple-50/40",
    },
    {
      key: "flow",
      items: flowConvs,
      collapsed: flowCollapsed,
      setCollapsed: setFlowCollapsed,
      storageKey: FLOW_SECTION_COLLAPSED_KEY,
      label: t("conversations.flowHandledSection"),
      hint: t("conversations.flowHandledHint"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
        </svg>
      ),
      iconColor: "text-sky-500",
      labelColor: "text-sky-600",
      countClass: "bg-sky-50 text-sky-600",
      chevronColor: "text-sky-400",
      hoverBg: "hover:bg-sky-50/40",
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

          {/* Channel icon filters - always visible */}
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
            {/* Webchat filter (no icon file - inline SVG) */}
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
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 pt-2 space-y-2" ref={listRef} data-tour="inbox-list">
        {/* Phase 1 - Live voice calls. Renders null unless tenant has
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
          // Why-aware empty states: a filtered miss, a workspace with no
          // channel, a broken channel, and "ready but quiet" are different
          // situations and get different explanations + next actions.
          (() => {
            const hasFilters = !!(search || channelFilter || departmentFilter);
            const isAdmin = user?.role === "ADMIN";
            if (hasFilters) {
              return (
                <EmptyState
                  title={t("conversations.emptyFilteredTitle")}
                  description={t("conversations.emptyFilteredDesc")}
                  action={{
                    label: t("conversations.clearFilters"),
                    onClick: () => { setSearch(""); setChannelFilter(""); setDepartmentFilter(""); },
                  }}
                />
              );
            }
            if (!channelsSummary) {
              // Channel state unknown (still loading / request failed):
              // stay neutral rather than guessing wrong.
              return <EmptyState title={t("conversations.noConversations")} />;
            }
            if (channelsSummary.connected === 0 && channelsSummary.unhealthy > 0) {
              return (
                <EmptyState
                  tone="attention"
                  title={t("conversations.emptyChannelBrokenTitle")}
                  description={isAdmin ? t("conversations.emptyChannelBrokenDesc") : t("conversations.emptyNoChannelAgent")}
                  action={isAdmin ? {
                    label: t("conversations.fixChannelCta"),
                    href: "/settings/channels?return=/conversations",
                    onClick: () => track("connect_channel_empty_cta_clicked", { surface: "inbox", kind: "reconnect" }),
                  } : undefined}
                />
              );
            }
            if (channelsSummary.connected === 0) {
              return (
                <EmptyState
                  title={t("conversations.emptyNoChannelTitle")}
                  description={isAdmin ? t("conversations.emptyNoChannelDesc") : t("conversations.emptyNoChannelAgent")}
                  action={isAdmin ? {
                    label: t("conversations.connectChannelCta"),
                    href: "/settings/channels?return=/conversations",
                    onClick: () => track("connect_channel_empty_cta_clicked", { surface: "inbox", kind: "connect" }),
                  } : undefined}
                />
              );
            }
            return (
              <EmptyState
                title={t("conversations.emptyReadyTitle")}
                description={t("conversations.emptyReadyDesc")}
                secondaryAction={isAdmin ? { label: t("conversations.viewChannels"), href: "/settings/channels" } : undefined}
              />
            );
          })()
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
                  <ConversationRow
                    key={conv.id}
                    conv={conv}
                    selected={selectedId === conv.id}
                    unread={isUnread(conv, lastReadMap, markedUnread)}
                    onSelect={handleSelect}
                    onContextMenu={handleContextMenu}
                    slaConfig={slaConfig}
                    deptSlaMap={deptSlaMap}
                    currentUserId={user?.id}
                  />
                ))
              )}
            </div>
          ))
        )}

        {/* Work already in progress: an AI employee answering, or a scripted
            flow stepping a customer through something.
            Collapsed by default and last in the column, because the promise of
            these sections is "nobody is waiting on you for these" - they are a
            window onto work being done, not a queue. Each renders only when
            non-empty, so a workspace with no AI employees and no flows never
            sees a box it has to reason about.

            Two sections rather than one: an employee holding a conversation and
            a flow holding a conversation are different situations with
            different people responsible, and a flow that stalls mid-graph is an
            authoring bug rather than a busy employee. */}
        {!historyMode && !loading && automationSections.map((section) => (
          section.items.length === 0 ? null : (
            <div key={section.key} className="bg-white rounded-2xl ring-1 ring-gray-100 shadow-sm overflow-hidden">
              <button
                onClick={() => {
                  const next = !section.collapsed;
                  section.setCollapsed(next);
                  try { localStorage.setItem(section.storageKey, next ? "1" : "0"); } catch {}
                  track("inbox_automation_section_toggled", { section: section.key, open: !next, count: section.items.length });
                }}
                aria-expanded={!section.collapsed}
                className={clsx("w-full px-3.5 py-2.5 flex items-center gap-2 transition-colors", section.hoverBg)}
              >
                <span className={section.iconColor}>{section.icon}</span>
                <span className={clsx("text-[10px] font-semibold uppercase tracking-widest", section.labelColor)}>
                  {section.label}
                </span>
                <span className={clsx("text-[10px] font-bold px-1.5 py-0.5 rounded-full ms-auto", section.countClass)}>
                  {section.items.length}
                </span>
                <svg
                  className={clsx("w-3.5 h-3.5 transition-transform", section.chevronColor, !section.collapsed && "rotate-180")}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>

              {!section.collapsed && (
                <>
                  <p className="px-4 pb-2 text-[11px] leading-snug text-gray-400">
                    {section.hint}
                  </p>
                  {section.items.map((conv: any) => (
                    <ConversationRow
                      key={conv.id}
                      conv={conv}
                      selected={selectedId === conv.id}
                      unread={false}
                      onSelect={handleSelect}
                      onContextMenu={handleContextMenu}
                      slaConfig={slaConfig}
                      deptSlaMap={deptSlaMap}
                      currentUserId={user?.id}
                      // Names who is answering, so "who has this?" is readable
                      // without opening the conversation.
                      aiLabel={
                        section.key === "flow"
                          ? t("conversations.aiHandledByFlow")
                          : aiAgentNames[conv.assignedAiAgentId] || t("conversations.aiHandledByAgent")
                      }
                    />
                  ))}
                </>
              )}
            </div>
          )
        ))}
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

/**
 * One row in the inbox list. Extracted so the human queues and the
 * AI-handled section render the SAME row and cannot drift - a row that looked
 * different in the AI section would read as a different kind of object rather
 * than the same conversation seen from another angle.
 *
 * `aiLabel` is the only difference: present, it names the employee answering.
 */
function ConversationRow({
  conv, selected, unread, onSelect, onContextMenu, slaConfig, deptSlaMap, currentUserId, aiLabel,
}: {
  conv: any;
  selected: boolean;
  unread: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  slaConfig: { enabled: boolean; slaMinutes: number; warningThreshold: number } | null;
  deptSlaMap: Record<string, { enabled: boolean; slaMinutes: number }>;
  currentUserId?: string;
  aiLabel?: string;
}) {
  return (
    <button
      onClick={() => onSelect(conv.id)}
      onContextMenu={(e) => onContextMenu(e, conv.id)}
      // Guided-tour anchor: the tour spotlights ONLY the demo
      // conversation it narrates (Dana, tour-1) - other rows are
      // deliberately not targetable so a stray click can't derail
      // the walkthrough.
      data-tour={conv.id === "tour-1" ? "inbox-row-primary" : "inbox-row"}
      className={clsx(
        "w-full text-start px-4 py-3 hover:bg-gray-50/80 transition-colors",
        selected && "bg-primary-50/60 rounded-lg mx-2"
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
            <p className="font-semibold text-sm truncate text-gray-900">
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
            unread ? "text-gray-500 font-medium" : "text-gray-400"
          )}>
            {conv.lastMessageBody || conv.customerPhone}
          </p>
          <div className="flex items-center justify-between mt-1">
            <div className="flex items-center gap-2 flex-wrap">
              {aiLabel && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-purple-50 text-purple-600 truncate max-w-[140px]">
                  {aiLabel}
                </span>
              )}
              {conv.department && (
                <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-600">
                  {conv.department.name}
                </span>
              )}
              {conv.assignedAgent && conv.assignedAgentId !== currentUserId && (
                <span className="text-[10px] text-gray-400">
                  {conv.assignedAgent.name}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Status dot: blue=unread, red=SLA breach.
            Both are suppressed in the AI section (`aiLabel`): an SLA clock
            counts a human's time to respond, and nobody is late for a
            conversation an employee is already answering. Showing red here
            would manufacture an alarm out of the system working. */}
        {(() => {
          if (aiLabel) return <span className="w-2 shrink-0" />;
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
          if (!dotColor && unread) dotColor = "bg-blue-500";
          return dotColor ? (
            <span className={clsx("w-2 h-2 rounded-full shrink-0", dotColor)} />
          ) : <span className="w-2 shrink-0" />;
        })()}
      </div>
    </button>
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
