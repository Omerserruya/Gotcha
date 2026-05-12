"use client";

import { useState, useEffect, Fragment, FormEvent } from "react";
import { getSocket } from "@/lib/socket";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getScheduledMessages,
  createScheduledMessage,
  cancelScheduledMessage,
  getChannelAccounts,
  getTemplates,
  getContacts,
  getAudienceSchema,
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
  recipientExternalId?: string;
  body: string;
  status: string;
  scheduledAt: string;
  sentAt?: string;
  /** Meta delivery-failure reason (mirrored from the linked Message). */
  error?: string | null;
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
  headerType?: string | null;
  headerContent?: string | null;
  variables?: Array<{ key: string; sample?: string }>;
}

/** A unified contact candidate — local Contact row OR CRM record. The
 *  search endpoint returns both shapes; we normalize them so the picker
 *  only cares about the four display fields. `source: "manual"` is what
 *  we use when the operator typed a phone with no match. */
interface ContactCandidate {
  id: string;
  source: "local" | "crm" | "manual";
  displayName?: string;
  phone?: string;
  email?: string;
  /** Provider-native fields when this is a CRM hit. Lets variable mapping
   *  point at any CRM field (city, age, lead_source, …), not just the
   *  snapshot quartet. */
  raw?: Record<string, any> | null;
}

interface CrmField {
  name: string;
  label: string;
  type: string;
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

type SendType = "regular" | "conversation" | "flow";

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

  // Unified recipient picker: free-text input that lights up CRM matches as
  // the operator types. If they pick a match, `selectedContact` is set and
  // its snapshot fields are available for variable mapping. If nothing
  // matches, the raw query becomes the recipient (manual phone).
  const [recipientQuery, setRecipientQuery] = useState("");
  const [selectedContact, setSelectedContact] = useState<ContactCandidate | null>(null);
  const [contactResults, setContactResults] = useState<ContactCandidate[]>([]);
  const [contactSearching, setContactSearching] = useState(false);
  // Full CRM field list (leads + contacts schemas merged) for the var
  // mapping dropdown when a CRM contact is selected.
  const [crmFields, setCrmFields] = useState<CrmField[]>([]);

  // Message
  const [body, setBody] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  // Per-template variable values (one specific recipient — concrete values).
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  // Live media URL for IMAGE/VIDEO/DOCUMENT template headers.
  const [headerMediaUrl, setHeaderMediaUrl] = useState("");

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

  // Refresh when the linked Message changes status (the worker / webhook
  // mirror SENT/FAILED back onto the ScheduledMessage row).
  useEffect(() => {
    if (!token) return;
    const socket = getSocket();
    if (!socket) return;
    const onStatus = (data: any) => {
      // Only refetch when this status change actually touched a scheduled
      // message — keeps the polling quiet for unrelated chat traffic.
      if (data?.scheduledMessageId || data?.status === "FAILED") {
        fetchMessages();
      }
    };
    socket.on("message:status", onStatus);
    return () => {
      socket.off("message:status", onStatus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setRecipientQuery("");
    setSelectedContact(null);
    setContactResults([]);
    setBody("");
    setSelectedTemplateId("");
    setVarValues({});
    setHeaderMediaUrl("");
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
    if (!id) {
      setVarValues({});
      setHeaderMediaUrl("");
      return;
    }
    const tpl = templates.find((t) => t.id === id);
    if (tpl) {
      setBody(tpl.body ?? tpl.content ?? "");
      // Seed variable inputs with the template's declared samples (operator
      // can still override per-recipient).
      const initial: Record<string, string> = {};
      const declared = Array.isArray(tpl.variables) ? tpl.variables : [];
      for (const v of declared) {
        if (v && typeof v.key === "string") initial[v.key] = v.sample ?? "";
      }
      // Also pick up any {{key}} that the body uses but the template's
      // variables array doesn't declare (legacy templates).
      const re = /\{\{\s*([\w-]+)\s*\}\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(tpl.body ?? ""))) {
        if (!(m[1] in initial)) initial[m[1]] = "";
      }
      setVarValues(initial);
      // Pre-fill media URL with the template's example for media headers.
      const ht = (tpl.headerType ?? "").toUpperCase();
      setHeaderMediaUrl(
        ht === "IMAGE" || ht === "VIDEO" || ht === "DOCUMENT"
          ? tpl.headerContent ?? ""
          : "",
      );
    }
  }

  // Fetch the CRM schema when a CRM contact is selected so the variable
  // mapping dropdown can offer every field (city, age, lead_source, …),
  // not just the displayName/phone/email snapshot.
  useEffect(() => {
    if (!token) return;
    if (!selectedContact || selectedContact.source !== "crm") {
      setCrmFields([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      getAudienceSchema(token, "leads").catch(() => null),
      getAudienceSchema(token, "contacts").catch(() => null),
    ]).then((results) => {
      if (cancelled) return;
      const seen = new Set<string>();
      const merged: CrmField[] = [];
      for (const res of results) {
        const fields = ((res?.data as any)?.crm?.schema?.fields ?? []) as CrmField[];
        for (const f of fields) {
          if (!f?.name || seen.has(f.name)) continue;
          seen.add(f.name);
          merged.push(f);
        }
      }
      setCrmFields(merged);
    });
    return () => {
      cancelled = true;
    };
  }, [token, selectedContact]);

  // ---------------------------------------------------------------------------
  // Live CRM contact search
  // ---------------------------------------------------------------------------

  // Debounced fetch — fires when the operator types in the recipient field
  // and clears results when they pick a match or empty the box. Picks up
  // both local Contacts and CRM records via `includeCrm=1`.
  useEffect(() => {
    if (!token) return;
    // Don't search while a match is selected — the input shows the chip,
    // not free text.
    if (selectedContact) return;
    const q = recipientQuery.trim();
    if (q.length < 2) {
      setContactResults([]);
      setContactSearching(false);
      return;
    }
    setContactSearching(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await getContacts(token, { q, limit: "8", includeCrm: "1" });
        if (cancelled) return;
        const rows = ((res?.data ?? []) as any[]).map((c) => normalizeContactCandidate(c));
        setContactResults(rows);
      } catch (err) {
        if (!cancelled) console.warn("[scheduled] contact search failed:", err);
      } finally {
        if (!cancelled) setContactSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token, recipientQuery, selectedContact]);

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError("");

    // Recipient: either the selected match's phone, or what the operator
    // typed if nothing matched (treated as a manual phone number).
    const recipientId = selectedContact?.phone?.trim()
      ? selectedContact.phone.trim()
      : recipientQuery.trim();
    if (!recipientId) {
      setError(t("outbound.scheduled.errorRecipientRequired"));
      return;
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
      if (selectedTemplateId) {
        payload.templateId = selectedTemplateId;
        payload.messageType = "template";
        if (Object.keys(varValues).length > 0) {
          // Each entry is either a literal value or a `crm:<field>` token.
          // Tokens are resolved here against the picked contact's snapshot
          // so the worker only ever sees flat string values (Meta-ready).
          const resolved: Record<string, string> = {};
          for (const [k, raw] of Object.entries(varValues)) {
            const v = (raw ?? "").trim();
            if (!v) continue;
            if (v.startsWith("crm:") && selectedContact) {
              const field = v.slice(4);
              const resolvedVal = resolveCrmFieldFromContact(field, selectedContact);
              if (resolvedVal) resolved[k] = resolvedVal;
            } else if (!v.startsWith("crm:")) {
              resolved[k] = v;
            }
          }
          if (Object.keys(resolved).length > 0) payload.variables = resolved;
        }
        if (headerMediaUrl.trim()) payload.mediaUrl = headerMediaUrl.trim();
      }
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
                <Fragment key={msg.id}>
                <tr className="border-t border-gray-50 hover:bg-gray-50/50 transition">
                  <td className="py-3.5 px-5 font-medium text-gray-900 font-mono text-xs">
                    {msg.recipientExternalId || msg.recipientId}
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
                {msg.status === "FAILED" && msg.error && (
                  <tr className="bg-red-50/40">
                    <td colSpan={6} className="px-5 py-2 text-xs text-red-700">
                      <span className="font-semibold">Error: </span>
                      {msg.error}
                    </td>
                  </tr>
                )}
                </Fragment>
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
              {msg.status === "FAILED" && msg.error && (
                <div className="mb-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-2 py-1.5">
                  <span className="font-semibold">Error: </span>
                  {msg.error}
                </div>
              )}
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
                <RecipientSearch
                  query={recipientQuery}
                  onQueryChange={setRecipientQuery}
                  selected={selectedContact}
                  onSelect={setSelectedContact}
                  results={contactResults}
                  searching={contactSearching}
                />
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
                    readOnly={!!(selectedTemplateId && channelValue === "WHATSAPP")}
                    className={clsx(
                      inputCls,
                      selectedTemplateId && channelValue === "WHATSAPP" && "bg-gray-50 cursor-not-allowed text-gray-500",
                    )}
                    placeholder={t("outbound.scheduled.bodyPlaceholder")}
                  />
                  {selectedTemplateId && channelValue === "WHATSAPP" && (
                    <p className="text-[11px] text-gray-400 mt-1">
                      WhatsApp template body is locked. Fill in the variables below — Meta requires the exact approved text.
                    </p>
                  )}
                  <AIComposePanel />
                </AIComposeScope>
              </section>

              {/* ---------------------------------------------------------- */}
              {/* Template variables + media URL                              */}
              {/* ---------------------------------------------------------- */}
              {selectedTemplateId && (() => {
                const tpl = templates.find((tt) => tt.id === selectedTemplateId);
                const headerType = (tpl?.headerType ?? "").toUpperCase();
                const isMedia =
                  headerType === "IMAGE" ||
                  headerType === "VIDEO" ||
                  headerType === "DOCUMENT";
                const varKeys = Object.keys(varValues);
                if (!isMedia && varKeys.length === 0) return null;
                return (
                  <section className="space-y-4">
                    {isMedia && (
                      <div className="rounded-xl border border-amber-100 bg-amber-50/40 p-3 space-y-2">
                        <div className="text-xs font-semibold text-amber-900">
                          Header {headerType.toLowerCase()}
                        </div>
                        <div className="text-[11px] text-amber-700/80">
                          Public URL of the {headerType.toLowerCase()} to send to this recipient.
                        </div>
                        <input
                          type="url"
                          value={headerMediaUrl}
                          onChange={(e) => setHeaderMediaUrl(e.target.value)}
                          className="w-full text-xs px-2 py-1.5 rounded border border-gray-200 bg-white"
                          placeholder={
                            headerType === "IMAGE"
                              ? "https://example.com/image.jpg"
                              : headerType === "VIDEO"
                              ? "https://example.com/video.mp4"
                              : "https://example.com/file.pdf"
                          }
                        />
                      </div>
                    )}

                    {varKeys.length > 0 && (
                      <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-3 space-y-2">
                        <div className="text-xs font-semibold text-violet-900">
                          Template variables
                        </div>
                        <div className="text-[11px] text-violet-700/80">
                          Concrete values for this recipient. Empty values fall back to the template&apos;s sample.
                        </div>
                        <div className="space-y-2">
                          {varKeys.map((key) => {
                            const raw = varValues[key] ?? "";
                            const isCrm = raw.startsWith("crm:");
                            const crmField = isCrm ? raw.slice(4) : "";
                            return (
                              <div
                                key={key}
                                className="flex flex-wrap items-center gap-2 bg-white rounded-lg border border-gray-200 p-2 min-w-0"
                              >
                                <code className="px-2 py-1 text-xs font-mono bg-gray-100 rounded shrink-0">{`{{${key}}}`}</code>
                                {selectedContact && (
                                  <select
                                    value={isCrm ? "crm" : "static"}
                                    onChange={(e) => {
                                      if (e.target.value === "crm") {
                                        setVarValues((prev) => ({ ...prev, [key]: "crm:" }));
                                      } else {
                                        setVarValues((prev) => ({ ...prev, [key]: "" }));
                                      }
                                    }}
                                    className="text-xs px-2 py-1 rounded border border-gray-200 bg-gray-50 shrink-0"
                                  >
                                    <option value="static">Static</option>
                                    <option value="crm">From contact</option>
                                  </select>
                                )}
                                {isCrm ? (
                                  <select
                                    value={crmField}
                                    onChange={(e) =>
                                      setVarValues((prev) => ({ ...prev, [key]: `crm:${e.target.value}` }))
                                    }
                                    className="flex-1 min-w-[140px] max-w-full text-xs px-2 py-1 rounded border border-gray-200 bg-white truncate"
                                  >
                                    <option value="">Pick CRM field…</option>
                                    {/* Snapshot aliases first so common ones stay at the top. */}
                                    <optgroup label="Common">
                                      <option value="displayName">Full name</option>
                                      <option value="firstName">First name</option>
                                      <option value="lastName">Last name</option>
                                      <option value="phone">Phone</option>
                                      <option value="email">Email</option>
                                    </optgroup>
                                    {crmFields.length > 0 && (
                                      <optgroup label="All CRM fields">
                                        {crmFields.map((f) => (
                                          <option key={f.name} value={f.name}>
                                            {f.label} ({f.name})
                                          </option>
                                        ))}
                                      </optgroup>
                                    )}
                                  </select>
                                ) : (
                                  <input
                                    type="text"
                                    value={raw}
                                    onChange={(e) =>
                                      setVarValues((prev) => ({ ...prev, [key]: e.target.value }))
                                    }
                                    className="flex-1 min-w-[140px] text-xs px-2 py-1 rounded border border-gray-200"
                                    placeholder={`Value for {{${key}}}`}
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </section>
                );
              })()}

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize a row from /api/contacts (which returns local Contact rows
 *  and CRM records in the same response shape) into our compact candidate. */
function normalizeContactCandidate(c: any): ContactCandidate {
  const isCrm = c?.source === "crm" || c?.isCrm === true || typeof c?.id === "string" && c.id.length >= 18 && !/^c[a-z0-9]{24}$/.test(c.id);
  return {
    id: String(c?.id ?? ""),
    source: isCrm ? "crm" : "local",
    displayName: c?.displayName || c?.name || [c?.firstName, c?.lastName].filter(Boolean).join(" ") || undefined,
    phone: c?.phone || c?.mobile || c?.phoneNumber || undefined,
    email: c?.email || undefined,
  };
}

/** Resolve `crm:<field>` tokens to concrete values using the picked
 *  contact's snapshot. Mirrors the alias logic from the campaign worker
 *  so the same field names work in both surfaces. */
function resolveCrmFieldFromContact(field: string, contact: ContactCandidate): string {
  // 1. Exact match against the provider-native raw row (any CRM field).
  if (contact.raw && Object.prototype.hasOwnProperty.call(contact.raw, field)) {
    const v = contact.raw[field];
    if (v != null && String(v).length > 0) return String(v);
  }
  // 2. Fall back to the snapshot quartet via alias matching.
  const key = field.toLowerCase().replace(/[\s_-]/g, "");
  if (key === "displayname" || key === "name" || key === "fullname") return contact.displayName || "";
  if (key === "firstname" || key === "first" || key === "givenname") {
    return (contact.displayName || "").trim().split(/\s+/)[0] || "";
  }
  if (key === "lastname" || key === "last" || key === "familyname" || key === "surname") {
    const parts = (contact.displayName || "").trim().split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(" ") : "";
  }
  if (
    key === "phone" || key === "mobile" || key === "phonenumber" ||
    key === "tel" || key === "telephone" || key === "cell"
  ) return contact.phone || "";
  if (key === "email" || key === "mail" || key === "emailaddress") return contact.email || "";
  return "";
}

// ─── RecipientSearch ─────────────────────────────────────────────────────────

/** Live CRM contact search input. While typing, shows a dropdown of
 *  matching contacts (local + CRM via includeCrm=1). Picking a match sets
 *  `selected` and stops the live search. Typing again with no pick = the
 *  raw query is later used as a manual phone number. */
function RecipientSearch({
  query,
  onQueryChange,
  selected,
  onSelect,
  results,
  searching,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  selected: ContactCandidate | null;
  onSelect: (c: ContactCandidate | null) => void;
  results: ContactCandidate[];
  searching: boolean;
}) {
  if (selected) {
    return (
      <div className="flex items-center justify-between gap-2 bg-primary-50 border border-primary-100 rounded-xl px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900 truncate">
            {selected.displayName || selected.phone || selected.email || selected.id}
            <span className="ms-2 text-[10px] uppercase tracking-wide text-primary-600">
              {selected.source === "crm" ? "CRM" : selected.source === "local" ? "Contact" : "Manual"}
            </span>
          </div>
          <div className="text-xs text-gray-500 truncate">
            {[selected.phone, selected.email].filter(Boolean).join(" · ")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            onSelect(null);
            onQueryChange("");
          }}
          className="text-xs px-2 py-1 rounded-lg bg-white text-gray-500 hover:text-red-500 border border-gray-200"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
        placeholder="Search by name / phone / email, or type a phone number…"
      />
      {query.trim().length >= 2 && (results.length > 0 || searching) && (
        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-72 overflow-y-auto">
          {searching && (
            <div className="px-3 py-2 text-xs text-gray-400">Searching…</div>
          )}
          {results.map((c) => (
            <button
              key={`${c.source}:${c.id}`}
              type="button"
              onClick={() => {
                onSelect(c);
                onQueryChange("");
              }}
              className="w-full text-left px-3 py-2 hover:bg-gray-50 transition flex items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-900 truncate">
                  {c.displayName || c.phone || c.email || c.id}
                </div>
                <div className="text-xs text-gray-500 truncate">
                  {[c.phone, c.email].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
              <span className="text-[10px] uppercase tracking-wide text-gray-400 shrink-0">
                {c.source === "crm" ? "CRM" : "Local"}
              </span>
            </button>
          ))}
          {!searching && results.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-400">
              No matches — the value will be used as a manual phone number.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
