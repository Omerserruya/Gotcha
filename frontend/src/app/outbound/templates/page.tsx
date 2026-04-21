"use client";

import { useState, useEffect, useRef, FormEvent } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  duplicateTemplate,
  getChannelAccounts,
} from "@/lib/api";
import clsx from "clsx";
import { AIComposeScope, AIComposeTrigger, AIComposePanel } from "@/components/ai/AIComposeInline";

// ─── Inline API helper ───────────────────────────────────────
async function submitTemplateToMeta(token: string, id: string) {
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL || ""}/api/templates/${id}/submit-to-meta`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    }
  );
  if (!res.ok) throw new Error("Failed to submit template");
  return res.json();
}

// ─── Constants ────────────────────────────────────────────────
const CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"];
const LANGUAGES = ["en", "he", "ar", "es", "fr", "de", "pt"];
const HEADER_TYPES = ["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT"];
const STATUSES = ["APPROVED", "PENDING_APPROVAL", "REJECTED", "DRAFT"];

// ─── Types ────────────────────────────────────────────────────
interface Template {
  id: string;
  name: string;
  channel: string;
  channelAccountId?: string | null;
  category: string;
  language: string;
  status: string;
  body: string;
  headerType?: string;
  headerText?: string;
  footer?: string;
  createdAt: string;
}

interface ChannelAccount {
  id: string;
  channel: string;
  displayName: string;
  connectionStatus: string;
  externalId?: string;
}

const emptyForm = {
  name: "",
  channel: "WHATSAPP",
  channelAccountId: "",
  category: "UTILITY",
  language: "en",
  headerType: "NONE",
  headerText: "",
  body: "",
  footer: "",
};

// ─── Helpers ──────────────────────────────────────────────────
function statusBadge(status: string) {
  const map: Record<string, string> = {
    APPROVED: "bg-green-50 text-green-600 ring-1 ring-green-200",
    PENDING_APPROVAL: "bg-yellow-50 text-yellow-600 ring-1 ring-yellow-200",
    PENDING: "bg-yellow-50 text-yellow-600 ring-1 ring-yellow-200",
    REJECTED: "bg-red-50 text-red-600 ring-1 ring-red-200",
    DRAFT: "bg-gray-100 text-gray-500",
  };
  return map[status] ?? "bg-gray-100 text-gray-500";
}

function parseVariables(body: string): number[] {
  const matches = body.match(/\{\{(\d+)\}\}/g);
  if (!matches) return [];
  const nums = matches.map((m) => parseInt(m.replace(/[^0-9]/g, ""), 10));
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}

function renderPreview(body: string, examples: Record<number, string>): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const val = examples[parseInt(n, 10)];
    return val ? val : `{{${n}}}`;
  });
}

// ─── WhatsApp Phone Preview ───────────────────────────────────
function WhatsAppPreview({
  headerType,
  headerText,
  body,
  footer,
  examples,
}: {
  headerType: string;
  headerText: string;
  body: string;
  footer: string;
  examples: Record<number, string>;
}) {
  const rendered = renderPreview(body, examples);

  return (
    <div className="flex flex-col items-center">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
        {"outbound.templates.preview"}
      </p>
      {/* Phone shell */}
      <div className="w-64 bg-gray-900 rounded-3xl p-2 shadow-2xl">
        <div className="bg-[#ECE5DD] rounded-2xl overflow-hidden min-h-[320px] flex flex-col">
          {/* WA top bar */}
          <div className="bg-[#075E54] px-3 py-2 flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
              </svg>
            </div>
            <div>
              <p className="text-white text-xs font-semibold">WhatsApp</p>
              <p className="text-white/70 text-[10px]">online</p>
            </div>
          </div>
          {/* Chat area */}
          <div className="flex-1 p-3 flex flex-col justify-end gap-1">
            <div className="bg-white rounded-xl rounded-tl-sm px-3 py-2 max-w-[90%] shadow-sm">
              {headerType === "TEXT" && headerText && (
                <p className="text-xs font-bold text-gray-900 mb-1 break-words">{headerText}</p>
              )}
              {(headerType === "IMAGE" || headerType === "VIDEO" || headerType === "DOCUMENT") && (
                <div className="w-full h-16 bg-gray-100 rounded-lg mb-1 flex items-center justify-center">
                  <span className="text-[10px] text-gray-400">{headerType}</span>
                </div>
              )}
              <p className="text-xs text-gray-800 whitespace-pre-wrap break-words">
                {rendered || <span className="text-gray-300 italic">{"outbound.templates.bodyPlaceholder"}</span>}
              </p>
              {footer && (
                <p className="text-[10px] text-gray-400 mt-1 break-words">{footer}</p>
              )}
              <p className="text-[10px] text-gray-400 text-right mt-0.5">
                {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────
export default function TemplatesPage() {
  const { token } = useAuth();
  const { t } = useI18n();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterChannel, setFilterChannel] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  const [channelAccounts, setChannelAccounts] = useState<ChannelAccount[]>([]);

  // Panel state
  const [showPanel, setShowPanel] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // WhatsApp variable examples
  const [varExamples, setVarExamples] = useState<Record<number, string>>({});

  // Submit to Meta
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  // Delete
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token) return;
    fetchTemplates();
  }, [token, filterChannel, filterStatus]);

  useEffect(() => {
    if (!token) return;
    getChannelAccounts(token)
      .then((res: any) => setChannelAccounts(res.data ?? res ?? []))
      .catch(console.error);
  }, [token]);

  // Sync varExamples when body changes
  useEffect(() => {
    if (form.channel === "WHATSAPP") {
      const vars = parseVariables(form.body);
      setVarExamples((prev) => {
        const next: Record<number, string> = {};
        vars.forEach((v) => { next[v] = prev[v] ?? ""; });
        return next;
      });
    }
  }, [form.body, form.channel]);

  // Animate panel open
  useEffect(() => {
    if (showPanel) {
      requestAnimationFrame(() => setPanelVisible(true));
    } else {
      setPanelVisible(false);
    }
  }, [showPanel]);

  async function fetchTemplates() {
    if (!token) return;
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (filterChannel) params.channel = filterChannel;
      if (filterStatus) params.status = filterStatus;
      const res = await getTemplates(token, params);
      setTemplates(res.data ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const connectedAccounts = channelAccounts.filter((a) => a.connectionStatus === "CONNECTED");
  const connectedChannels = Array.from(new Set(connectedAccounts.map((a) => a.channel)));

  // Filter dropdown fallback when no accounts exist yet
  const channelOptions = connectedChannels.length > 0
    ? connectedChannels
    : ["WHATSAPP", "INSTAGRAM", "TELEGRAM", "WEBCHAT"];

  function openCreate() {
    setEditingId(null);
    const defaultAccount = connectedAccounts[0];
    setForm({
      ...emptyForm,
      channel: defaultAccount?.channel ?? "WHATSAPP",
      channelAccountId: defaultAccount?.id ?? "",
    });
    setVarExamples({});
    setError("");
    setSubmitSuccess(false);
    setShowPanel(true);
  }

  function openEdit(tpl: Template) {
    setEditingId(tpl.id);
    setForm({
      name: tpl.name,
      channel: tpl.channel,
      channelAccountId: tpl.channelAccountId ?? "",
      category: tpl.category,
      language: tpl.language,
      headerType: tpl.headerType ?? "NONE",
      headerText: tpl.headerText ?? "",
      body: tpl.body,
      footer: tpl.footer ?? "",
    });
    setVarExamples({});
    setError("");
    setSubmitSuccess(false);
    setShowPanel(true);
  }

  function closePanel() {
    setPanelVisible(false);
    setTimeout(() => setShowPanel(false), 300);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSaving(true);
    setError("");
    try {
      const payload = {
        ...form,
        headerType: form.headerType === "NONE" ? undefined : form.headerType,
        headerText: form.headerType === "TEXT" ? form.headerText : undefined,
        footer: form.footer || undefined,
      };
      if (editingId) {
        await updateTemplate(token, editingId, payload);
      } else {
        await createTemplate(token, payload);
      }
      closePanel();
      fetchTemplates();
    } catch (err: any) {
      setError(err.message || t("common.error"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicate(id: string) {
    if (!token) return;
    try {
      await duplicateTemplate(token, id);
      fetchTemplates();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleDelete() {
    if (!token || !deleteId) return;
    setDeleting(true);
    try {
      await deleteTemplate(token, deleteId);
      setDeleteId(null);
      fetchTemplates();
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.includes("broadcast") || msg.includes("409")) {
        if (window.confirm("This template is linked to broadcasts. Delete anyway?")) {
          try {
            await deleteTemplate(token, deleteId, true);
            setDeleteId(null);
            fetchTemplates();
          } catch (e2) { console.error(e2); }
        }
      } else {
        console.error(err);
      }
    } finally {
      setDeleting(false);
    }
  }

  async function handleSubmitToMeta() {
    if (!token || !editingId) return;
    setSubmitting(true);
    setError("");
    try {
      await submitTemplateToMeta(token, editingId);
      setSubmitSuccess(true);
      fetchTemplates();
    } catch (err: any) {
      setError(err.message || "outbound.templates.submitMetaError");
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls =
    "w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition";
  const selectCls =
    "w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition";

  // Get the current editing template's status for Meta flow
  const editingTemplate = editingId ? templates.find((t) => t.id === editingId) : null;
  const isWhatsApp = form.channel === "WHATSAPP";
  const bodyVars = parseVariables(form.body);

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={filterChannel}
          onChange={(e) => setFilterChannel(e.target.value)}
          className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-600 outline-none focus:ring-2 focus:ring-primary-200"
        >
          <option value="">{t("outbound.templates.allChannels")}</option>
          {channelOptions.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-600 outline-none focus:ring-2 focus:ring-primary-200"
        >
          <option value="">{t("outbound.templates.allStatuses")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <div className="flex-1" />
        <button
          onClick={openCreate}
          className="bg-primary-500 hover:bg-primary-600 text-white px-4 py-2 rounded-xl text-sm font-medium transition shadow-sm flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {t("outbound.templates.create")}
        </button>
      </div>

      {/* Table */}
      <div className="hidden md:block bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50/80">
            <tr>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("outbound.templates.colName")}</th>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("outbound.templates.colChannel")}</th>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("outbound.templates.colCategory")}</th>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("outbound.templates.colLanguage")}</th>
              <th className="text-start py-3.5 px-5 font-medium text-gray-500 text-xs uppercase tracking-wide">{t("outbound.templates.colStatus")}</th>
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
            ) : templates.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-gray-400">{t("common.noResults")}</td>
              </tr>
            ) : (
              templates.map((tpl) => (
                <tr key={tpl.id} className="border-t border-gray-50 hover:bg-gray-50/50 transition">
                  <td className="py-3.5 px-5 font-medium text-gray-900">{tpl.name}</td>
                  <td className="py-3.5 px-5 text-gray-500">{tpl.channel}</td>
                  <td className="py-3.5 px-5 text-gray-500">{tpl.category}</td>
                  <td className="py-3.5 px-5 text-gray-500">{tpl.language}</td>
                  <td className="py-3.5 px-5">
                    <span className={clsx("px-2.5 py-1 rounded-full text-xs font-medium", statusBadge(tpl.status))}>
                      {tpl.status}
                    </span>
                  </td>
                  <td className="py-3.5 px-5">
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        onClick={() => handleDuplicate(tpl.id)}
                        className="text-xs px-2.5 py-1.5 rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100 transition"
                        title={t("outbound.templates.duplicate")}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
                        </svg>
                      </button>
                      <button
                        onClick={() => openEdit(tpl)}
                        className="text-xs px-2.5 py-1.5 rounded-lg bg-primary-50 text-primary-600 hover:bg-primary-100 transition"
                      >
                        {t("common.edit")}
                      </button>
                      <button
                        onClick={() => setDeleteId(tpl.id)}
                        className="text-xs px-2.5 py-1.5 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition"
                      >
                        {t("common.delete")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
          </div>
        ) : templates.length === 0 ? (
          <div className="py-12 text-center text-gray-400">{t("common.noResults")}</div>
        ) : (
          templates.map((tpl) => (
            <div key={tpl.id} className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
              <div className="flex items-start justify-between mb-2">
                <p className="font-medium text-gray-900 text-sm">{tpl.name}</p>
                <span className={clsx("px-2.5 py-1 rounded-full text-xs font-medium shrink-0", statusBadge(tpl.status))}>
                  {tpl.status}
                </span>
              </div>
              <p className="text-xs text-gray-400 mb-3">{tpl.channel} · {tpl.category} · {tpl.language}</p>
              <div className="flex gap-2">
                <button onClick={() => handleDuplicate(tpl.id)} className="text-xs px-2.5 py-1.5 rounded-lg bg-gray-50 text-gray-500 hover:bg-gray-100 transition">{t("outbound.templates.duplicate")}</button>
                <button onClick={() => openEdit(tpl)} className="text-xs px-2.5 py-1.5 rounded-lg bg-primary-50 text-primary-600 hover:bg-primary-100 transition">{t("common.edit")}</button>
                <button onClick={() => setDeleteId(tpl.id)} className="text-xs px-2.5 py-1.5 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition">{t("common.delete")}</button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ─── Slide-over Side Panel ─────────────────────────────── */}
      {showPanel && (
        <>
          {/* Backdrop */}
          <div
            className={clsx(
              "fixed inset-0 bg-black/40 backdrop-blur-sm z-40 transition-opacity duration-300",
              panelVisible ? "opacity-100" : "opacity-0"
            )}
            onClick={closePanel}
          />

          {/* Panel */}
          <div
            ref={panelRef}
            className={clsx(
              "fixed inset-y-0 right-0 w-full md:w-[65%] bg-white shadow-2xl z-50 flex flex-col transition-transform duration-300 ease-out",
              panelVisible ? "translate-x-0" : "translate-x-full"
            )}
          >
            {/* Panel Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
              <div className="flex items-center gap-3">
                <h3 className="font-bold text-gray-900 text-lg">
                  {editingId ? t("outbound.templates.editTitle") : t("outbound.templates.createTitle")}
                </h3>
                {editingTemplate && (
                  <span className={clsx("px-2.5 py-1 rounded-full text-xs font-semibold", statusBadge(editingTemplate.status))}>
                    {editingTemplate.status}
                  </span>
                )}
              </div>
              <button
                onClick={closePanel}
                className="w-8 h-8 rounded-xl bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition text-gray-500"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Panel Body */}
            <div className="flex-1 overflow-y-auto">
              {/* Meta Approval Banner */}
              {editingTemplate && editingTemplate.channel === "WHATSAPP" && (
                <div className={clsx(
                  "mx-6 mt-4 px-4 py-3 rounded-xl flex items-center justify-between gap-3",
                  editingTemplate.status === "APPROVED" && "bg-green-50 border border-green-200",
                  editingTemplate.status === "PENDING_APPROVAL" && "bg-yellow-50 border border-yellow-200",
                  editingTemplate.status === "REJECTED" && "bg-red-50 border border-red-100",
                  editingTemplate.status === "DRAFT" && "bg-blue-50 border border-blue-100",
                )}>
                  <div className="flex items-center gap-2.5">
                    {editingTemplate.status === "APPROVED" && (
                      <svg className="w-5 h-5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    )}
                    {editingTemplate.status === "PENDING_APPROVAL" && (
                      <svg className="w-5 h-5 text-yellow-500 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                      </svg>
                    )}
                    {editingTemplate.status === "REJECTED" && (
                      <svg className="w-5 h-5 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                      </svg>
                    )}
                    {editingTemplate.status === "DRAFT" && (
                      <svg className="w-5 h-5 text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
                      </svg>
                    )}
                    <div>
                      <p className="text-sm font-semibold text-gray-800">
                        {"outbound.templates.metaStatus"}: {editingTemplate.status}
                      </p>
                      {editingTemplate.status === "DRAFT" && (
                        <p className="text-xs text-gray-500">{"outbound.templates.metaDraftHint"}</p>
                      )}
                      {editingTemplate.status === "PENDING_APPROVAL" && (
                        <p className="text-xs text-gray-500">{"outbound.templates.metaPendingHint"}</p>
                      )}
                      {editingTemplate.status === "REJECTED" && (
                        <p className="text-xs text-red-500">{"outbound.templates.metaRejectedHint"}</p>
                      )}
                    </div>
                  </div>
                  {(editingTemplate.status === "DRAFT" || editingTemplate.status === "REJECTED") && !submitSuccess && (
                    <button
                      onClick={handleSubmitToMeta}
                      disabled={submitting}
                      className="shrink-0 px-3 py-1.5 bg-[#25D366] hover:bg-[#1ebe59] text-white text-xs font-semibold rounded-lg transition disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {submitting ? (
                        <div className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
                        </svg>
                      )}
                      {editingTemplate.status === "REJECTED"
                        ? "outbound.templates.resubmitToMeta"
                        : "outbound.templates.submitToMeta"}
                    </button>
                  )}
                  {submitSuccess && (
                    <span className="shrink-0 px-3 py-1.5 bg-green-100 text-green-700 text-xs font-semibold rounded-lg">
                      {"outbound.templates.submitMetaSuccess"}
                    </span>
                  )}
                </div>
              )}

              {error && (
                <div className="mx-6 mt-4 p-3 rounded-xl bg-red-50 text-red-600 text-sm border border-red-100">{error}</div>
              )}

              <form
                id="template-form"
                onSubmit={handleSubmit}
                className="p-6 space-y-5"
              >
                {/* Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("outbound.templates.fieldName")}</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                    className={inputCls}
                    placeholder="my_template_name"
                  />
                </div>

                {/* Channel + Category */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("outbound.templates.fieldChannel")}</label>
                    <select
                      value={form.channelAccountId}
                      onChange={(e) => {
                        const id = e.target.value;
                        const acc = connectedAccounts.find((a) => a.id === id);
                        setForm({ ...form, channelAccountId: id, channel: acc?.channel ?? form.channel });
                      }}
                      className={selectCls}
                      required
                    >
                      {connectedAccounts.length === 0 && <option value="">—</option>}
                      {connectedAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.channel} — {a.displayName}
                        </option>
                      ))}
                    </select>
                    {connectedAccounts.length === 0 && (
                      <p className="text-xs text-amber-500 mt-1">{"outbound.templates.noConnectedChannels"}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("outbound.templates.fieldCategory")}</label>
                    <select
                      value={form.category}
                      onChange={(e) => setForm({ ...form, category: e.target.value })}
                      className={selectCls}
                    >
                      {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>

                {/* Language + Header Type */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("outbound.templates.fieldLanguage")}</label>
                    <select
                      value={form.language}
                      onChange={(e) => setForm({ ...form, language: e.target.value })}
                      className={selectCls}
                    >
                      {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("outbound.templates.fieldHeaderType")}</label>
                    <select
                      value={form.headerType}
                      onChange={(e) => setForm({ ...form, headerType: e.target.value })}
                      className={selectCls}
                    >
                      {HEADER_TYPES.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                </div>

                {/* Header Text */}
                {form.headerType === "TEXT" && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("outbound.templates.fieldHeaderText")}</label>
                    <input
                      type="text"
                      value={form.headerText}
                      onChange={(e) => setForm({ ...form, headerText: e.target.value })}
                      className={inputCls}
                    />
                  </div>
                )}

                {/* Body + WhatsApp Preview */}
                <div className={clsx(isWhatsApp && "flex flex-col lg:flex-row gap-5")}>
                  <div className={clsx("flex-1 min-w-0 space-y-4")}>
                    <AIComposeScope
                      surface="template"
                      asTemplate
                      channel={form.channel}
                      currentValue={form.body}
                      onApply={(text) => setForm((f) => ({ ...f, body: text }))}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-sm font-medium text-gray-700">
                          {t("outbound.templates.fieldBody")}
                          {isWhatsApp && (
                            <span className="ms-2 text-xs text-gray-400 font-normal">
                              {"outbound.templates.variableHint"}
                            </span>
                          )}
                        </label>
                        <AIComposeTrigger />
                      </div>
                      <textarea
                        value={form.body}
                        onChange={(e) => setForm({ ...form, body: e.target.value })}
                        required
                        rows={5}
                        className={inputCls}
                        placeholder={t("outbound.templates.bodyPlaceholder")}
                      />
                      <AIComposePanel />
                    </AIComposeScope>

                    {/* Variable example inputs for WhatsApp */}
                    {isWhatsApp && bodyVars.length > 0 && (
                      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 space-y-3">
                        <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">
                          {"outbound.templates.variableExamples"}
                        </p>
                        {bodyVars.map((varNum) => (
                          <div key={varNum} className="flex items-center gap-3">
                            <span className="shrink-0 w-8 h-8 rounded-lg bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center">
                              {`{{${varNum}}}`}
                            </span>
                            <input
                              type="text"
                              value={varExamples[varNum] ?? ""}
                              onChange={(e) =>
                                setVarExamples((prev) => ({ ...prev, [varNum]: e.target.value }))
                              }
                              placeholder={`Example for {{${varNum}}}`}
                              className={inputCls}
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Footer */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">{t("outbound.templates.fieldFooter")}</label>
                      <input
                        type="text"
                        value={form.footer}
                        onChange={(e) => setForm({ ...form, footer: e.target.value })}
                        className={inputCls}
                        placeholder={t("outbound.templates.footerPlaceholder")}
                      />
                    </div>
                  </div>

                  {/* WhatsApp live preview */}
                  {isWhatsApp && (
                    <div className="shrink-0 lg:w-72 flex justify-center lg:justify-start pt-2">
                      <WhatsAppPreview
                        headerType={form.headerType}
                        headerText={form.headerText}
                        body={form.body}
                        footer={form.footer}
                        examples={varExamples}
                      />
                    </div>
                  )}
                </div>
              </form>
            </div>

            {/* Panel Footer */}
            <div className="shrink-0 border-t border-gray-100 px-6 py-4 flex gap-3 bg-white">
              <button
                type="submit"
                form="template-form"
                disabled={saving}
                className="flex-1 bg-primary-500 hover:bg-primary-600 text-white py-2.5 rounded-xl text-sm font-medium transition shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving && (
                  <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                )}
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

      {/* Delete Confirmation Modal */}
      {deleteId && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl">
            <h3 className="font-bold text-gray-900 text-lg mb-2">{t("outbound.templates.deleteTitle")}</h3>
            <p className="text-sm text-gray-500 mb-5">{t("outbound.templates.deleteConfirm")}</p>
            <div className="flex gap-3">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 bg-red-500 hover:bg-red-600 text-white py-2.5 rounded-xl text-sm font-medium transition disabled:opacity-50"
              >
                {deleting ? t("common.loading") : t("common.delete")}
              </button>
              <button
                onClick={() => setDeleteId(null)}
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
