"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getConversations, getDepartments } from "@/lib/api";
import { getSocket } from "@/lib/socket";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { ChannelBadge } from "./ChannelBadge";

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function getLastReadMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem("chatcenter:lastRead") || "{}"); } catch { return {}; }
}

function isUnread(conv: any, lastReadMap: Record<string, string>): boolean {
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

  const fetchConversations = useCallback(async () => {
    if (!token) return;
    try {
      const params: Record<string, string> = {};
      if (search) params.search = search;
      if (channelFilter) params.channel = channelFilter;
      if (departmentFilter) params.departmentId = departmentFilter;
      const res = await getConversations(token, params);
      setConversations(res.data);
    } catch (err) {
      console.error("Failed to fetch conversations:", err);
    } finally {
      setLoading(false);
    }
  }, [token, search, channelFilter, departmentFilter]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Fetch departments for filter (admin only)
  useEffect(() => {
    if (!token || user?.role !== "ADMIN") return;
    getDepartments(token).then((list) => {
      setDepartments(Array.isArray(list) ? list : []);
    }).catch(() => {});
  }, [token, user?.role]);

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

  // Group conversations into 3 queues
  const { myActive, assignedToMe, generalQueue } = useMemo(() => {
    const myActive: any[] = [];
    const assignedToMe: any[] = [];
    const generalQueue: any[] = [];

    for (const conv of conversations) {
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

    return { myActive, assignedToMe, generalQueue };
  }, [conversations, user]);

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
      <div className="p-4 border-b border-gray-100">
        <h2 className="text-lg font-bold text-gray-900 mb-3 ps-8 md:ps-0">{t("conversations.title")}</h2>
        <div className="relative mb-2">
          <svg className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("conversations.search")}
            className="w-full ps-10 pe-4 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
          />
        </div>
        {/* Channel filter */}
        <div className="flex items-center gap-1.5">
          {[
            { value: "", label: t("conversations.channelAll") },
            { value: "WHATSAPP", label: t("conversations.channelWhatsApp") },
            { value: "MESSENGER", label: t("conversations.channelMessenger") },
          ].map((opt) => (
            <button
              key={opt.value}
              onClick={() => setChannelFilter(opt.value)}
              className={clsx(
                "text-[11px] px-2.5 py-1 rounded-lg font-medium transition",
                channelFilter === opt.value
                  ? "bg-primary-500 text-white shadow-sm"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {/* Department filter (admin only) */}
        {user?.role === "ADMIN" && departments.length > 0 && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <button
              onClick={() => setDepartmentFilter("")}
              className={clsx(
                "text-[11px] px-2.5 py-1 rounded-lg font-medium transition",
                departmentFilter === ""
                  ? "bg-teal-500 text-white shadow-sm"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200"
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
                    ? "bg-teal-500 text-white shadow-sm"
                    : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                )}
              >
                {dept.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
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
        ) : (
          sections.map((section) => (
            <div key={section.key}>
              {/* Section header */}
              <div className={clsx("px-4 py-2.5 flex items-center gap-2 border-b border-gray-100", section.bgColor)}>
                <span className={section.color}>{section.icon}</span>
                <span className={clsx("text-xs font-semibold uppercase tracking-wide", section.color)}>
                  {section.label}
                </span>
                <span className={clsx(
                  "text-[10px] font-bold px-1.5 py-0.5 rounded-full ms-auto",
                  section.items.length > 0 ? `${section.bgColor} ${section.color}` : "bg-gray-100 text-gray-400"
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
                    onClick={() => onSelect(conv.id)}
                    className={clsx(
                      "w-full text-start px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors",
                      selectedId === conv.id && "bg-primary-50 border-e-2 border-e-primary-500"
                    )}
                  >
                    <div className="flex items-start gap-3">
                      {/* Avatar */}
                      <div className="w-10 h-10 bg-gradient-to-br from-primary-100 to-primary-200 rounded-xl flex items-center justify-center shrink-0">
                        <span className="text-sm font-bold text-primary-600">
                          {(conv.customerName || conv.customerPhone || "?").charAt(0).toUpperCase()}
                        </span>
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <ChannelBadge channel={conv.channel} />
                            <p className={clsx(
                              "font-semibold text-sm truncate",
                              isUnread(conv, lastReadMap) ? "text-gray-900" : "text-gray-900"
                            )}>
                              {conv.customerName || conv.customerExternalId || conv.customerPhone}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {isUnread(conv, lastReadMap) && (
                              <span className="w-2.5 h-2.5 bg-blue-500 rounded-full shadow-sm shadow-blue-500/30" title="Unread" />
                            )}
                            {conv.lastMessageAt && (
                              <span className={clsx(
                                "text-[10px] shrink-0",
                                isUnread(conv, lastReadMap) ? "text-blue-500 font-semibold" : "text-gray-400"
                              )}>
                                {formatDistanceToNow(new Date(conv.lastMessageAt), { addSuffix: true })}
                              </span>
                            )}
                          </div>
                        </div>
                        <p className={clsx(
                          "text-xs truncate mt-0.5",
                          isUnread(conv, lastReadMap) ? "text-gray-700 font-medium" : "text-gray-500"
                        )}>
                          {conv.lastMessageBody || conv.customerPhone}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          <StatusBadge status={conv.status} t={t} />
                          {conv.department && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-teal-50 text-teal-600 ring-1 ring-teal-200">
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
                  </button>
                ))
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}

function StatusBadge({ status, t }: { status: string; t: (key: string) => string }) {
  const config: Record<string, { class: string; label: string }> = {
    OPEN: { class: "bg-green-50 text-green-600 ring-1 ring-green-200", label: t("conversations.filterOpen") },
    WAITING: { class: "bg-amber-50 text-amber-600 ring-1 ring-amber-200", label: t("conversations.filterWaiting") },
    CLOSED: { class: "bg-gray-100 text-gray-500", label: t("conversations.filterClosed") },
  };
  const c = config[status] || config.OPEN;
  return (
    <span className={clsx("text-[10px] px-2 py-0.5 rounded-full font-medium", c.class)}>
      {c.label}
    </span>
  );
}
