"use client";

import { useState, useEffect, FormEvent } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getScheduledMessages,
  createScheduledMessage,
  cancelScheduledMessage,
  getChannelAccounts,
  getTemplates,
} from "@/lib/api";
import ChannelAccountPicker from "@/components/ChannelAccountPicker";
import { AIComposeScope, AIComposeTrigger, AIComposePanel } from "@/components/ai/AIComposeInline";
import clsx from "clsx";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduledMessage {
  id: string;
  channel: string;
  channelAccountId?: string;
  recipientId: string;
  body: string;
  status: string;
  scheduledAt: string;
  sentAt?: string;
  createdAt: string;
}

interface ChannelAccount {
  id: string;
  channel: string;
  displayName: string;
  connectionStatus: string;
  externalId?: string;
}

interface Department {
  id: string;
  name: string;
}

interface Template {
  id: string;
  name: string;
  body?: string;
  content?: string;
}

interface SegmentRule {
  field: "channel" | "tag" | "lastSeen";
  operator: "eq" | "neq" | "lt" | "gt";
  value: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_BADGES: Record<string, string> = {
  PENDING: "bg-blue-50 text-blue-600 ring-1 ring-blue-200",
  SENT: "bg-green-50 text-green-600 ring-1 ring-green-200",
  FAILED: "bg-red-50 text-red-600 ring-1 ring-red-200",
  CANCELLED: "bg-gray-100 text-gray-500",
};

const inputCls =
  "w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition";

type RecipientTab = "single" | "segment" | "import";
type SendType = "regular" | "conversation" | "flow";

const SEGMENT_FIELDS: { value: SegmentRule["field"]; label: string }[] = [
  { value: "channel", label: "Channel" },
  { value: "tag", label: "Tag" },
  { value: "lastSeen", label: "Last Seen" },
];

const SEGMENT_OPERATORS: { value: SegmentRule["operator"]; label: string }[] = [
  { value: "eq", label: "=" },
  { value: "neq", label: "≠" },
  { value: "lt", label: "<" },
  { value: "gt", label: ">" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchDepartments(token: string): Promise<Department[]> {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL || ""}/api/departments`,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.data ?? [];
}

function defaultScheduledAt(): string {
  const dt = new Date(Date.now() + 60 * 60 * 1000);
  return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ScheduledPage() {
  const { token } = useAuth();
  const { t } = useI18n();

  // List state
  const [messages, setMessages] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(true);

  // Side panel state
  const [showPanel, setShowPanel] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Cancel confirm state
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Channel accounts (connected only)
  const [channelAccounts, setChannelAccounts] = useState<ChannelAccount[]>([]);

  // Templates
  const [templates, setTemplates] = useState<Template[]>([]);

  // Departments
  const [departments, setDepartments] = useState<Department[]>([]);

  // ---- Form fields ----
  const [channelAccountId, setChannelAccountId] = useState("");
  const [channelValue, setChannelValue] = useState("WHATSAPP");
  const [recipientTab, setRecipientTab] = useState<RecipientTab>("single");

  // Single
  const [singleRecipient, setSingleRecipient] = useState("");

  // Segment
  const [segmentRules, setSegmentRules] = useState<SegmentRule[]>([
    { field: "channel", operator: "eq", value: "" },
  ]);

  // Import
  const [importText, setImportText] = useState("");

  // Message
  const [body, setBody] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");

  // Advanced options
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sendType, setSendType] = useState<SendType>("regular");
  const [departmentId, setDepartmentId] = useState("");

  // Schedule
  const [scheduledAt, setScheduledAt] = useState(defaultScheduledAt());

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!token) return;
    fetchMessages();
    loadChannelAccounts();
    loadTemplates();
    loadDepartments();
  }, [token]);

  async function fetchMessages() {
    if (!token) return;
    setLoading(true);
    try {
      const res = await getScheduledMessages(token);
      const sorted = (res.data ?? []).sort(
        (a: ScheduledMessage, b: ScheduledMessage) =>
          new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
      );
      setMessages(sorted);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function loadChannelAccounts() {
    if (!token) return;
    try {
      const res = await getChannelAccounts(token);
      const all: ChannelAccount[] = res.data ?? [];
      // Hide Meta channels — Facebook / Instagram / Messenger DMs cannot be
      // initiated by the business; outbound is restricted to user-initiated
      // 24h messaging windows, so they don't belong in a scheduled-send
      // picker. Plus the standard "must be CONNECTED" filter.
      const blocked = new Set(["INSTAGRAM", "MESSENGER", "FACEBOOK"]);
      setChannelAccounts(
        all.filter(
          (a) =>
            a.connectionStatus === "CONNECTED"
            && !blocked.has(String(a.channel || "").toUpperCase()),
        ),
      );
    } catch (err) {
      console.error(err);
    }
  }

  async function loadTemplates() {
    if (!token) return;
    try {
      const res = await getTemplates(token, { status: "APPROVED" });
      setTemplates(res.data ?? []);
    } catch (err) {
      console.error(err);
    }
  }

  async function loadDepartments() {
    if (!token) return;
    try {
      const deps = await fetchDepartments(token);
      setDepartments(deps);
    } catch (err) {
      console.error(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Panel open / close
  // ---------------------------------------------------------------------------

  function openCreate() {
    setChannelAccountId("");
    setChannelValue("WHATSAPP");
    setRecipientTab("single");
    setSingleRecipient("");
    setSegmentRules([{ field: "channel", operator: "eq", value: "" }]);
    setImportText("");
    setBody("");
    setSelectedTemplateId("");
    setAdvancedOpen(false);
    setSendType("regular");
    setDepartmentId("");
    setScheduledAt(defaultScheduledAt());
    setError("");
    setShowPanel(true);
  }

  function closePanel() {
    setShowPanel(false);
  }

  // ---------------------------------------------------------------------------
  // Template selection
  // ---------------------------------------------------------------------------

  function handleTemplateSelect(id: string) {
    setSelectedTemplateId(id);
    if (!id) return;
    const tpl = templates.find((t) => t.id === id);
    if (tpl) {
      setBody(tpl.body ?? tpl.content ?? "");
    }
  }

  // ---------------------------------------------------------------------------
  // Segment rules
  // ---------------------------------------------------------------------------

  function updateRule(index: number, patch: Partial<SegmentRule>) {
    setSegmentRules((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch } : r))
    );
  }

  function addRule() {
    setSegmentRules((prev) => [
      ...prev,
      { field: "channel", operator: "eq", value: "" },
    ]);
  }

  function removeRule(index: number) {
    setSegmentRules((prev) => prev.filter((_, i) => i !== index));
  }

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError("");

    // Build recipientId string
    let recipientId = "";
    if (recipientTab === "single") {
      recipientId = singleRecipient.trim();
      if (!recipientId) {
        setError(t("outbound.scheduled.errorRecipientRequired"));
        return;
      }
    } else if (recipientTab === "import") {
      const ids = importText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        setError(t("outbound.scheduled.errorRecipientRequired"));
        return;
      }
      recipientId = ids.join(",");
    } else {
      // segment: serialize rules as JSON string
      recipientId = JSON.stringify({ type: "segment", rules: segmentRules });
    }

    if (!body.trim()) {
      setError(t("outbound.scheduled.errorBodyRequired"));
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, any> = {
        channel: channelValue,
        channelAccountId: channelAccountId || undefined,
        recipientExternalId: recipientId,
        body,
        scheduledAt: new Date(scheduledAt).toISOString(),
        sendType,
      };
      if (sendType === "conversation" && departmentId) {
        payload.departmentId = departmentId;
      }
      await createScheduledMessage(token, payload);
      setShowPanel(false);
      fetchMessages();
    } catch (err: any) {
      setError(err.message || t("common.error"));
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Cancel message
  // ---------------------------------------------------------------------------

  async function handleCancel() {
    if (!token || !cancelId) return;
    setCancelling(true);
    try {
      await cancelScheduledMessage(token, cancelId);
      setCancelId(null);
      fetchMessages();
    } catch (err) {
      console.error(err);
    } finally {
      setCancelling(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Import line count
  // ---------------------------------------------------------------------------

  const importCount = importText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">
          {messages.length} {t("outbound.scheduled.count")}
        </p>
        <button
          onClick={openCreate}
          className="bg-primary-500 hover:bg-primary-600 text-white px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm flex items-center gap-2"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4.5v15m7.5-7.5h-15"
            />
          </svg>
          {t("outbound.scheduled.create")}
        </button>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Desktop table                                                       */}
      {/* ------------------------------------------------------------------ */}
      <div className="hidden md:block bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50/80">
            <tr>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">
                {t("outbound.scheduled.colRecipient")}
              </th>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">
                {t("outbound.scheduled.colChannel")}
              </th>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">
                {t("outbound.scheduled.colBody")}
              </th>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">
                {t("outbound.scheduled.colScheduledAt")}
              </th>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">
                {t("outbound.scheduled.colStatus")}
              </th>
              <th className="py-3.5 px-5" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-gray-400">
                  <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin mx-auto" />
                </td>
              </tr>
            ) : messages.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-gray-400">
                  {t("common.noResults")}
                </td>
              </tr>
            ) : (
              messages.map((msg) => (
                <tr
                  key={msg.id}
                  className="border-t border-gray-50 hover:bg-gray-50/50 transition"
                >
                  <td className="py-3.5 px-5 font-medium text-gray-900 font-mono text-xs">
                    {msg.recipientId}
                  </td>
                  <td className="py-3.5 px-5 text-gray-500">{msg.channel}</td>
                  <td className="py-3.5 px-5 text-gray-500 max-w-xs truncate">
                    {msg.body}
                  </td>
                  <td className="py-3.5 px-5 text-gray-500 text-xs whitespace-nowrap">
                    {new Date(msg.scheduledAt).toLocaleString()}
                  </td>
                  <td className="py-3.5 px-5">
                    <span
                      className={clsx(
                        "px-2.5 py-1 rounded-full text-xs font-medium",
                        STATUS_BADGES[msg.status] ?? "bg-gray-100 text-gray-500"
                      )}
                    >
                      {msg.status}
                    </span>
                  </td>
                  <td className="py-3.5 px-5 text-end">
                    {msg.status === "PENDING" && (
                      <button
                        onClick={() => setCancelId(msg.id)}
                        className="text-xs px-3 py-1.5 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition"
                      >
                        {t("outbound.scheduled.cancel")}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Mobile cards                                                        */}
      {/* ------------------------------------------------------------------ */}
      <div className="md:hidden space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="py-12 text-center text-gray-400">
            {t("common.noResults")}
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm"
            >
              <div className="flex items-start justify-between mb-2">
                <div>
                  <p className="font-medium text-gray-900 text-sm font-mono">
                    {msg.recipientId}
                  </p>
                  <p className="text-xs text-gray-400">{msg.channel}</p>
                </div>
                <span
                  className={clsx(
                    "px-2.5 py-1 rounded-full text-xs font-medium shrink-0",
                    STATUS_BADGES[msg.status] ?? "bg-gray-100 text-gray-500"
                  )}
                >
                  {msg.status}
                </span>
              </div>
              <p className="text-xs text-gray-500 mb-2 line-clamp-2">
                {msg.body}
              </p>
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400">
                  {new Date(msg.scheduledAt).toLocaleString()}
                </p>
                {msg.status === "PENDING" && (
                  <button
                    onClick={() => setCancelId(msg.id)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition"
                  >
                    {t("outbound.scheduled.cancel")}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* ================================================================== */}
      {/* SLIDE-OVER SIDE PANEL                                              */}
      {/* ================================================================== */}
      {showPanel && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
            onClick={closePanel}
          />

          {/* Panel */}
          <div className="fixed inset-y-0 right-0 w-full md:w-[65%] bg-white shadow-2xl z-50 flex flex-col overflow-hidden">
            {/* Panel header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
              <h2 className="text-lg font-bold text-gray-900">
                {t("outbound.scheduled.createTitle")}
              </h2>
              <button
                type="button"
                onClick={closePanel}
                className="p-2 rounded-xl text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Scrollable form body */}
            <form
              id="scheduled-panel-form"
              onSubmit={handleSubmit}
              className="flex-1 overflow-y-auto px-6 py-5 space-y-6"
            >
              {error && (
                <div className="p-3 rounded-xl bg-red-50 text-red-600 text-sm">
                  {error}
                </div>
              )}

              {/* ---------------------------------------------------------- */}
              {/* 1. Channel selection                                        */}
              {/* ---------------------------------------------------------- */}
              <section>
                <label className="block text-sm font-semibold text-gray-800 mb-2">
                  {t("outbound.scheduled.fieldChannel")}
                </label>
                <ChannelAccountPicker
                  accounts={channelAccounts}
                  value={channelAccountId}
                  onChange={(accountId, channel) => {
                    setChannelAccountId(accountId);
                    setChannelValue(channel);
                  }}
                  placeholder={t("outbound.scheduled.selectChannel")}
                />
                {channelAccounts.length === 0 && (
                  <p className="mt-1.5 text-xs text-amber-500">
                    {t("outbound.scheduled.noConnectedChannels")}
                  </p>
                )}
              </section>

              {/* ---------------------------------------------------------- */}
              {/* 2. Recipients                                               */}
              {/* ---------------------------------------------------------- */}
              <section>
                <label className="block text-sm font-semibold text-gray-800 mb-3">
                  {t("outbound.scheduled.fieldRecipients")}
                </label>

                {/* Tab pills */}
                <div className="flex gap-1.5 mb-4">
                  {(
                    [
                      { key: "single", label: t("outbound.scheduled.tabSingle") },
                      { key: "segment", label: t("outbound.scheduled.tabSegment") },
                      { key: "import", label: t("outbound.scheduled.tabImport") },
                    ] as { key: RecipientTab; label: string }[]
                  ).map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setRecipientTab(key)}
                      className={clsx(
                        "px-4 py-1.5 rounded-full text-sm font-medium transition",
                        recipientTab === key
                          ? "bg-primary-500 text-white shadow-sm"
                          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Tab: Single */}
                {recipientTab === "single" && (
                  <input
                    type="text"
                    value={singleRecipient}
                    onChange={(e) => setSingleRecipient(e.target.value)}
                    className={inputCls}
                    placeholder="+1234567890"
                  />
                )}

                {/* Tab: CRM Segment */}
                {recipientTab === "segment" && (
                  <div className="space-y-2">
                    {segmentRules.map((rule, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        {idx > 0 && (
                          <span className="text-xs text-gray-400 w-8 text-center shrink-0">
                            AND
                          </span>
                        )}
                        {idx === 0 && <span className="w-8 shrink-0" />}

                        <select
                          value={rule.field}
                          onChange={(e) =>
                            updateRule(idx, {
                              field: e.target.value as SegmentRule["field"],
                            })
                          }
                          className={clsx(inputCls, "flex-1")}
                        >
                          {SEGMENT_FIELDS.map((f) => (
                            <option key={f.value} value={f.value}>
                              {f.label}
                            </option>
                          ))}
                        </select>

                        <select
                          value={rule.operator}
                          onChange={(e) =>
                            updateRule(idx, {
                              operator: e.target.value as SegmentRule["operator"],
                            })
                          }
                          className={clsx(inputCls, "w-20")}
                        >
                          {SEGMENT_OPERATORS.map((op) => (
                            <option key={op.value} value={op.value}>
                              {op.label}
                            </option>
                          ))}
                        </select>

                        <input
                          type="text"
                          value={rule.value}
                          onChange={(e) =>
                            updateRule(idx, { value: e.target.value })
                          }
                          className={clsx(inputCls, "flex-1")}
                          placeholder={t("outbound.scheduled.segmentValuePlaceholder")}
                        />

                        <button
                          type="button"
                          onClick={() => removeRule(idx)}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition shrink-0"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      </div>
                    ))}

                    <button
                      type="button"
                      onClick={addRule}
                      className="mt-1 flex items-center gap-1.5 text-sm text-primary-500 hover:text-primary-700 transition"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 4.5v15m7.5-7.5h-15"
                        />
                      </svg>
                      {t("outbound.scheduled.addRule")}
                    </button>
                  </div>
                )}

                {/* Tab: Import */}
                {recipientTab === "import" && (
                  <div>
                    <textarea
                      value={importText}
                      onChange={(e) => setImportText(e.target.value)}
                      rows={6}
                      className={inputCls}
                      placeholder={t("outbound.scheduled.importPlaceholder")}
                    />
                    <p className="mt-1.5 text-xs text-gray-400">
                      {importCount} {t("outbound.scheduled.importCount")}
                    </p>
                  </div>
                )}
              </section>

              {/* ---------------------------------------------------------- */}
              {/* 3. Message content                                          */}
              {/* ---------------------------------------------------------- */}
              <section>
                <AIComposeScope
                  surface="scheduled"
                  channel={channelValue}
                  currentValue={body}
                  onApply={(text) => setBody(text)}
                >
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-semibold text-gray-800">
                      {t("outbound.scheduled.fieldBody")}
                    </label>
                    <AIComposeTrigger />
                  </div>

                  {templates.length > 0 && (
                    <div className="mb-3">
                      <select
                        value={selectedTemplateId}
                        onChange={(e) => handleTemplateSelect(e.target.value)}
                        className={inputCls}
                      >
                        <option value="">
                          {t("outbound.scheduled.selectTemplate")}
                        </option>
                        {templates.map((tpl) => (
                          <option key={tpl.id} value={tpl.id}>
                            {tpl.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={5}
                    className={inputCls}
                    placeholder={t("outbound.scheduled.bodyPlaceholder")}
                  />
                  <AIComposePanel />
                </AIComposeScope>
              </section>

              {/* ---------------------------------------------------------- */}
              {/* 4. Advanced Options (collapsible)                           */}
              {/* ---------------------------------------------------------- */}
              <section>
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  className="flex items-center gap-2 text-sm font-semibold text-gray-700 hover:text-gray-900 transition w-full text-start"
                >
                  <svg
                    className={clsx(
                      "w-4 h-4 text-gray-400 transition-transform duration-200",
                      advancedOpen && "rotate-180"
                    )}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                    />
                  </svg>
                  {t("outbound.scheduled.advancedOptions")}
                </button>

                {advancedOpen && (
                  <div className="mt-4 space-y-4 pl-6">
                    {/* Send Type */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        {t("outbound.scheduled.sendType")}
                      </label>
                      <div className="space-y-2">
                        {(
                          [
                            { value: "regular", label: t("outbound.scheduled.sendTypeRegular") },
                            { value: "conversation", label: t("outbound.scheduled.sendTypeConversation") },
                            { value: "flow", label: t("outbound.scheduled.sendTypeFlow") },
                          ] as { value: SendType; label: string }[]
                        ).map(({ value, label }) => (
                          <label
                            key={value}
                            className="flex items-center gap-3 cursor-pointer group"
                          >
                            <input
                              type="radio"
                              name="sendType"
                              value={value}
                              checked={sendType === value}
                              onChange={() => setSendType(value)}
                              className="accent-primary-500"
                            />
                            <span className="text-sm text-gray-700 group-hover:text-gray-900 transition">
                              {label}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Department dropdown (conversation mode) */}
                    {sendType === "conversation" && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          {t("outbound.scheduled.department")}
                        </label>
                        <select
                          value={departmentId}
                          onChange={(e) => setDepartmentId(e.target.value)}
                          className={inputCls}
                        >
                          <option value="">
                            {t("outbound.scheduled.selectDepartment")}
                          </option>
                          {departments.map((dep) => (
                            <option key={dep.id} value={dep.id}>
                              {dep.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Flow dropdown (placeholder) */}
                    {sendType === "flow" && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          {t("outbound.scheduled.triggerFlow")}
                        </label>
                        <select disabled className={clsx(inputCls, "opacity-60 cursor-not-allowed")}>
                          <option>{t("outbound.scheduled.flowComingSoon")}</option>
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* ---------------------------------------------------------- */}
              {/* 5. Schedule datetime                                        */}
              {/* ---------------------------------------------------------- */}
              <section>
                <label className="block text-sm font-semibold text-gray-800 mb-2">
                  {t("outbound.scheduled.fieldScheduledAt")}
                </label>
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  required
                  className={inputCls}
                />
              </section>
            </form>

            {/* Panel footer */}
            <div className="shrink-0 px-6 py-4 border-t border-gray-100 flex gap-3 bg-white">
              <button
                type="submit"
                form="scheduled-panel-form"
                disabled={saving}
                className="flex-1 bg-primary-500 hover:bg-primary-600 text-white py-2.5 rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-50"
              >
                {saving ? t("common.loading") : t("common.save")}
              </button>
              <button
                type="button"
                onClick={closePanel}
                className="flex-1 bg-gray-50 hover:bg-gray-100 text-gray-600 py-2.5 rounded-xl text-sm font-medium transition"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ================================================================== */}
      {/* Cancel Confirmation Modal                                          */}
      {/* ================================================================== */}
      {cancelId && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl">
            <h3 className="font-bold text-gray-900 text-lg mb-2">
              {t("outbound.scheduled.cancelTitle")}
            </h3>
            <p className="text-sm text-gray-500 mb-5">
              {t("outbound.scheduled.cancelConfirm")}
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="flex-1 bg-red-500 hover:bg-red-600 text-white py-2.5 rounded-xl text-sm font-medium transition disabled:opacity-50"
              >
                {cancelling ? t("common.loading") : t("outbound.scheduled.cancel")}
              </button>
              <button
                onClick={() => setCancelId(null)}
                className="flex-1 bg-gray-50 hover:bg-gray-100 text-gray-600 py-2.5 rounded-xl text-sm font-medium transition"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
