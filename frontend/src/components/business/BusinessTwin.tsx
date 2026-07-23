"use client";

// The Digital Twin, as a PERMANENT product object.
//
// Onboarding's Movement 2 (the executive briefing) was the twin's first render;
// this component is the twin's permanent home - the same confidence-levelled,
// read-first portrait, rendered on the standalone /business page for the life of
// the account. Discovery + Business Health flow in; corrections and gap-teaching
// flow back out through the same endpoints onboarding uses, so the twin stays a
// living object, never a one-time parlor trick (audit finding P-1).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/context/I18nContext";
import {
  getKnowledgeBases,
  createKnowledgeBase,
  uploadKnowledgeFile,
  type BusinessDiscoveryRecord,
  type HealthReport,
  type DiscoveryGap,
  type RecommendationRow,
} from "@/lib/api";
import ConfirmModal from "@/components/ConfirmModal";

// ─── Confidence + channel visual language (shared with onboarding) ──────────
export function confLabel(he: boolean, c?: string): string {
  switch (c) {
    case "confirmed": return he ? "מאומת" : "Confirmed";
    case "likely": return he ? "סביר" : "Likely";
    case "low": return he ? "ביטחון נמוך" : "Low confidence";
    case "needs_verification": return he ? "דורש אימות" : "Needs verification";
    case "unknown": return he ? "לא בטוח" : "Couldn't determine";
    default: return "";
  }
}

export function ConfidenceChip({ he, c }: { he: boolean; c?: string }) {
  if (!c) return null;
  const cls: Record<string, string> = {
    confirmed: "bg-emerald-50 text-emerald-600 border-emerald-100",
    likely: "bg-sky-50 text-sky-600 border-sky-100",
    low: "bg-amber-50 text-amber-600 border-amber-100",
    needs_verification: "bg-amber-50 text-amber-600 border-amber-100",
    unknown: "bg-gray-100 text-gray-500 border-gray-200",
  };
  return <span className={"text-[10px] px-1.5 py-0.5 rounded-full border font-medium " + (cls[c] || cls.unknown)}>{confLabel(he, c)}</span>;
}

const CHANNEL_META: Record<string, { icon: string; label: [string, string] }> = {
  whatsapp: { icon: "🟢", label: ["WhatsApp", "וואטסאפ"] },
  instagram: { icon: "📸", label: ["Instagram", "אינסטגרם"] },
  facebook: { icon: "📘", label: ["Facebook", "פייסבוק"] },
  messenger: { icon: "💬", label: ["Messenger", "מסנג'ר"] },
  telegram: { icon: "✈️", label: ["Telegram", "טלגרם"] },
  email: { icon: "✉️", label: ["Email", "אימייל"] },
  phone: { icon: "📞", label: ["Phone", "טלפון"] },
  website_chat: { icon: "💬", label: ["Website chat", "צ'אט באתר"] },
  contact_form: { icon: "📝", label: ["Contact form", "טופס יצירת קשר"] },
  tiktok: { icon: "🎵", label: ["TikTok", "טיקטוק"] },
  newsletter: { icon: "📧", label: ["Newsletter", "ניוזלטר"] },
  popup: { icon: "🔔", label: ["Website popup", "פופ-אפ באתר"] },
};
const PRIMARY_CHANNELS = new Set(["whatsapp", "instagram", "facebook", "messenger", "telegram", "email", "phone"]);

export type TwinCorrectFn = (target: "channel" | "tool" | "platform" | "gap", action: "remove" | "incorrect" | "ignore", key: string) => void;
export type TwinTeachFn = (label: string, method: "text" | "url" | "file", value: string) => Promise<boolean>;

// ─── Section scaffolding ────────────────────────────────────────────────────
function Section({ he, title, confidence, defaultOpen = false, right, children }: {
  he: boolean; title: string; confidence?: string; defaultOpen?: boolean; right?: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-gray-100 last:border-0">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center justify-between w-full py-3.5 group">
        <span className="text-sm font-semibold text-gray-800 flex items-center gap-2">
          {title}
          {confidence && <ConfidenceChip he={he} c={confidence} />}
        </span>
        <span className="flex items-center gap-3">
          {right}
          <span className={"text-gray-300 text-xs transition-transform group-hover:text-gray-500 " + (open ? "rotate-180" : "")}>▼</span>
        </span>
      </button>
      {open && <div className="pb-5 -mt-1">{children}</div>}
    </section>
  );
}

function BrandRow({ he, label, value }: { he: boolean; label: [string, string]; value?: string }) {
  if (!value) return null;
  return <div><span className="text-[11px] text-gray-400">{label[he ? 1 : 0]}: </span><span className="text-gray-700">{value}</span></div>;
}
function ChipRow({ he, label, items, tone }: { he: boolean; label: [string, string]; items: string[]; tone?: "red" }) {
  if (!items.length) return null;
  return (
    <div>
      <span className="text-[11px] text-gray-400">{label[he ? 1 : 0]}: </span>
      <span className="inline-flex flex-wrap gap-1 align-middle">{items.slice(0, 12).map((x, i) => (
        <span key={i} className={"text-[11px] px-2 py-0.5 rounded-full border " + (tone === "red" ? "bg-red-50 text-red-500 border-red-100" : "bg-gray-100 text-gray-600 border-gray-200")}>{x}</span>
      ))}</span>
    </div>
  );
}

function TeachCard({ he, gap, token, onTeach, onDismiss }: { he: boolean; gap: DiscoveryGap; token: string; onTeach: TwinTeachFn; onDismiss?: () => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<null | "url" | "text" | "file">(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [fileState, setFileState] = useState<null | "uploading" | "failed">(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function submit() {
    if (!value.trim()) return;
    setBusy(true);
    const ok = await onTeach(gap.label, mode as "url" | "text", value.trim());
    setBusy(false);
    if (ok) setDone(true);
  }

  // Third teach path: upload a file into the tenant's knowledge base, then
  // close the gap with method:"file" + the created document id (backend
  // just verifies ownership - the upload endpoint already parsed + stored it).
  async function submitFile(file: File) {
    setFileState("uploading");
    setBusy(true);
    try {
      const kbList = await getKnowledgeBases(token);
      let kbId = kbList.data?.[0]?.id as string | undefined;
      if (!kbId) {
        const created = await createKnowledgeBase(token, { name: "Company Knowledge" });
        kbId = created.data.id;
      }
      const uploaded = await uploadKnowledgeFile(token, kbId!, file, file.name.replace(/\.[^.]+$/, ""));
      const documentId = uploaded?.data?.id;
      if (!documentId) throw new Error("no document id");
      const ok = await onTeach(gap.label, "file", documentId);
      setBusy(false);
      if (ok) { setDone(true); } else { setFileState("failed"); }
    } catch {
      setBusy(false);
      setFileState("failed");
    }
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) submitFile(file);
  }

  if (dismissed) return null;
  if (done) return (
    <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-100 text-sm text-emerald-700 flex items-center gap-2"><span>✓</span>{he ? `למדתי את «${gap.label}». תודה!` : `Learned "${gap.label}". Thanks!`}</div>
  );
  return (
    <div className="p-3.5 rounded-xl border border-gray-200 bg-gray-50/60">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0"><span className="text-amber-500">⚠</span><span className="font-medium text-gray-800 text-sm truncate">{gap.label}</span></div>
        <div className="flex items-center gap-2 shrink-0">
          <ConfidenceChip he={he} c={gap.confidence} />
          {onDismiss && <button type="button" onClick={() => { setDismissed(true); onDismiss(); }} className="text-[11px] text-gray-400 hover:text-gray-600">{he ? "לא רלוונטי" : "Not relevant"}</button>}
        </div>
      </div>
      {gap.ask && <p className="text-xs text-gray-500 mt-1">{gap.ask}</p>}
      {!mode ? (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          <button type="button" onClick={() => setMode("url")} className="text-xs font-medium px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:border-primary-300">{he ? "נתינת קישור" : "Provide URL"}</button>
          <button type="button" onClick={() => setMode("text")} className="text-xs font-medium px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:border-primary-300">{he ? "הדבקת טקסט" : "Paste text"}</button>
          <button
            type="button"
            onClick={() => { setMode("file"); fileInputRef.current?.click(); }}
            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:border-primary-300"
          >
            {t("businessPage.uploadFile")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.md,.txt"
            className="hidden"
            onChange={onFilePicked}
          />
        </div>
      ) : mode === "file" ? (
        <div className="mt-2.5 space-y-2">
          <p className="text-[11px] text-gray-400">{t("businessPage.uploadHint")}</p>
          {fileState === "uploading" && <p className="text-xs text-primary-600">{t("businessPage.uploading")}</p>}
          {fileState === "failed" && <p className="text-xs text-rose-600">{t("businessPage.uploadFailed")}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50">{t("businessPage.uploadFile")}</button>
            <button type="button" onClick={() => { setMode(null); setFileState(null); }} disabled={busy} className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:text-gray-700">{he ? "ביטול" : "Cancel"}</button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 space-y-2">
          {mode === "url"
            ? <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…" dir="ltr" className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary-200" />
            : <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={3} placeholder={he ? "הדביקו כאן…" : "Paste it here…"} className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary-200 resize-none" />}
          <div className="flex gap-2">
            <button type="button" onClick={submit} disabled={busy || !value.trim()} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50">{busy ? (he ? "לומד…" : "Learning…") : (he ? "למד את זה" : "Learn it")}</button>
            <button type="button" onClick={() => { setMode(null); setValue(""); }} className="text-xs font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:text-gray-700">{he ? "ביטול" : "Cancel"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export type TwinSaveProfileFn = (patch: {
  business?: { summary?: string };
  brand?: { voice?: string; tone?: string; languages?: string[] };
}) => Promise<boolean>;

// Editable profile - description, brand voice/tone/languages. Reuses the same
// BusinessDiscovery model onboarding writes (PATCH /api/onboarding/discovery),
// so there is no settings-only copy of the twin's data.
function EditProfileModal({ he, open, initial, onSave, onClose }: {
  he: boolean;
  open: boolean;
  initial: { description: string; voice: string; tone: string; languages: string };
  onSave: TwinSaveProfileFn;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [description, setDescription] = useState(initial.description);
  const [voice, setVoice] = useState(initial.voice);
  const [tone, setTone] = useState(initial.tone);
  const [languages, setLanguages] = useState(initial.languages);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  // Re-seed whenever the panel (re)opens - the parent may have refetched
  // discovery since the last time it was closed.
  useEffect(() => {
    if (open) {
      setDescription(initial.description);
      setVoice(initial.voice);
      setTone(initial.tone);
      setLanguages(initial.languages);
      setSaved(false);
      setFailed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial.description, initial.voice, initial.tone, initial.languages]);

  if (!open) return null;

  async function submit() {
    setSaving(true);
    setFailed(false);
    const ok = await onSave({
      business: { summary: description.trim() },
      brand: {
        voice: voice.trim(),
        tone: tone.trim(),
        languages: languages.split(",").map((l) => l.trim()).filter(Boolean),
      },
    });
    setSaving(false);
    if (ok) { setSaved(true); window.setTimeout(onClose, 900); } else { setFailed(true); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-4" dir={he ? "rtl" : "ltr"}>
        <h3 className="text-lg font-semibold text-gray-900">{t("businessPage.editProfileTitle")}</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-500">{t("businessPage.editDescription")}</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="w-full mt-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary-200 resize-none" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500">{t("businessPage.editVoice")}</label>
            <input value={voice} onChange={(e) => setVoice(e.target.value)} className="w-full mt-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary-200" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500">{t("businessPage.editTone")}</label>
            <input value={tone} onChange={(e) => setTone(e.target.value)} className="w-full mt-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary-200" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500">{t("businessPage.editLanguages")}</label>
            <input value={languages} onChange={(e) => setLanguages(e.target.value)} className="w-full mt-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-primary-200" />
          </div>
        </div>
        {saved && <p className="text-sm text-emerald-600">{t("businessPage.profileSaved")}</p>}
        {failed && <p className="text-sm text-rose-600">{t("businessPage.profileSaveFailed")}</p>}
        <div className="flex gap-3">
          <button type="button" onClick={onClose} disabled={saving} className="flex-1 py-2.5 px-4 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium rounded-xl transition text-sm disabled:opacity-50">{t("businessPage.cancel")}</button>
          <button type="button" onClick={submit} disabled={saving} className="flex-1 py-2.5 px-4 bg-primary-500 hover:bg-primary-600 text-white font-medium rounded-xl transition text-sm disabled:opacity-50">{t("businessPage.save")}</button>
        </div>
      </div>
    </div>
  );
}

// ─── The Twin ───────────────────────────────────────────────────────────────
export function BusinessTwin({ he, disc, health, gaps, token, onCorrect, onTeach, onSaveProfile }: {
  he: boolean;
  disc: BusinessDiscoveryRecord;
  health: HealthReport | null;
  gaps: DiscoveryGap[];
  token: string;
  onCorrect: TwinCorrectFn;
  onTeach: TwinTeachFn;
  onSaveProfile: TwinSaveProfileFn;
}) {
  const { t } = useI18n();
  const [editOpen, setEditOpen] = useState(false);
  const b = disc.business || {};
  const brand = disc.brand || {};
  const allChannels = disc.communication?.channels || [];
  const channels = allChannels.filter((c) => PRIMARY_CHANNELS.has(c.type));
  const otherMethods = allChannels.filter((c) => !PRIMARY_CHANNELS.has(c.type));
  const tech = disc.technology || null;

  const allHealth = health ? [...health.knowledge, ...health.communication, ...health.tools] : [];
  const okCount = allHealth.filter((i) => i.ok).length;
  const readyPct = allHealth.length ? Math.round((okCount / allHealth.length) * 100) : 0;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 px-6 sm:px-8 py-8" dir={he ? "rtl" : "ltr"}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-primary-500 uppercase tracking-wide mb-1.5">{he ? "העסק שלכם, כפי שאני מבין אותו" : "Your business, as I understand it"}</p>
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">{b.name || (he ? "העסק שלכם" : "Your business")}</h1>
          {b.industry && <p className="text-sm text-gray-500 mt-1">{b.industry}{b.country ? ` · ${b.country}` : ""}{disc.websiteDomain ? ` · ${disc.websiteDomain}` : ""}</p>}
        </div>
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          className="shrink-0 text-xs font-medium text-primary-600 hover:text-primary-700 border border-primary-200 rounded-lg px-3 py-1.5 hover:bg-primary-50"
        >
          {t("businessPage.editProfile")}
        </button>
      </div>

      <EditProfileModal
        he={he}
        open={editOpen}
        initial={{
          description: b.summary || "",
          voice: brand.voice || "",
          tone: brand.tone || "",
          languages: (brand.languages || []).join(", "),
        }}
        onSave={onSaveProfile}
        onClose={() => setEditOpen(false)}
      />

      {disc.report && <div className="mt-5 text-[15px] text-gray-700 leading-relaxed whitespace-pre-line">{disc.report}</div>}

      {/* Readiness - the permanent "can I help you yet?" score (Law: living Health). */}
      {health && allHealth.length > 0 && (
        <div className="mt-6 p-4 rounded-2xl bg-gray-50 border border-gray-100">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-gray-800">{he ? "כמה אני מוכן לעזור" : "How ready I am to help"}</span>
            <span className="text-xs text-gray-500">{he ? `${okCount} מתוך ${allHealth.length} מוכן` : `${okCount} of ${allHealth.length} ready`}</span>
          </div>
          <div className="h-1.5 rounded-full bg-gray-200 overflow-hidden"><div className="h-full bg-emerald-400 rounded-full transition-all" style={{ width: `${readyPct}%` }} /></div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
            {allHealth.slice(0, 10).map((it, i) => (
              <span key={i} className="text-xs flex items-center gap-1"><span className={it.ok ? "text-emerald-500" : "text-amber-500"}>{it.ok ? "✓" : "⚠"}</span><span className={it.ok ? "text-gray-600" : "text-gray-500"}>{it.label}</span></span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 divide-y divide-gray-100">
        {/* What you do */}
        <div className="py-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-2">{he ? "מה אתם עושים" : "What you do"}<ConfidenceChip he={he} c={b.confidence} /></p>
          <p className="text-[15px] text-gray-700 leading-relaxed mt-1">{b.summary || b.valueProp || "-"}</p>
          {(b.products || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">{(b.products || []).slice(0, 10).map((p, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200 capitalize">{p}</span>)}</div>
          )}
        </div>

        {channels.length > 0 && (
          <Section he={he} title={he ? "ערוצי תקשורת" : "Communication channels"} defaultOpen>
            <div className="grid sm:grid-cols-2 gap-2.5">
              {channels.map((c, i) => {
                const meta = CHANNEL_META[c.type] || { icon: "🔗", label: [c.type, c.type] as [string, string] };
                return (
                  <div key={i} className="flex items-start gap-3 p-3 rounded-xl border border-gray-150 bg-gray-50/60">
                    <span className="text-xl leading-none mt-0.5">{meta.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap"><span className="font-semibold text-gray-900 text-sm">{meta.label[he ? 1 : 0]}</span><ConfidenceChip he={he} c={c.confidence} /></div>
                      {c.identifier && <div className="text-xs text-gray-500 truncate" dir="ltr">{c.identifier}</div>}
                      {c.purpose && <div className="text-[11px] text-primary-500 mt-0.5">{c.purpose}</div>}
                    </div>
                    <button type="button" onClick={() => onCorrect("channel", "remove", c.type)} className="text-gray-300 hover:text-red-500 text-sm leading-none" aria-label={he ? "הסר" : "Remove"}>×</button>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {otherMethods.length > 0 && (
          <Section he={he} title={he ? "דרכי תקשורת נוספות" : "Other communication methods"}>
            <div className="space-y-1.5">
              {otherMethods.map((c, i) => {
                const meta = CHANNEL_META[c.type] || { icon: "🔗", label: [c.type, c.type] as [string, string] };
                return (
                  <div key={i} className="flex items-center gap-2.5 py-1.5">
                    <span className="text-base leading-none">{meta.icon}</span>
                    <span className="text-sm text-gray-700">{meta.label[he ? 1 : 0]}</span>
                    {c.identifier && <span className="text-xs text-gray-400 truncate" dir="ltr">{c.identifier}</span>}
                    <ConfidenceChip he={he} c={c.confidence} />
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {tech && (tech.platform || tech.tools.length > 0 || tech.legacy.length > 0) && (
          <Section he={he} title={he ? "טכנולוגיות ומערכות" : "Technologies & systems"} defaultOpen>
            {tech.platform && (
              <div className="flex items-center gap-3 p-3.5 rounded-xl border-2 border-primary-200 bg-primary-50/40">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`https://cdn.simpleicons.org/${tech.platform.slug}`} alt="" className="w-8 h-8 object-contain" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                <div className="flex-1">
                  <div className="flex items-center gap-2"><span className="font-bold text-gray-900">{tech.platform.name}</span><ConfidenceChip he={he} c={tech.platform.confidence} /></div>
                  <div className="text-[11px] text-gray-500">{he ? "פלטפורמת הליבה שלכם" : "Your core platform"}</div>
                </div>
                <button type="button" onClick={() => onCorrect("platform", "remove", tech.platform!.slug)} className="text-gray-300 hover:text-red-500 text-sm" aria-label={he ? "הסר" : "Remove"}>×</button>
              </div>
            )}
            {tech.tools.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {tech.tools.map((t, i) => (
                  <span key={i} className="group inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                    {t.name}
                    <button type="button" onClick={() => onCorrect("tool", "remove", t.slug)} className="text-gray-300 hover:text-red-500 leading-none" aria-label={he ? "הסר" : "Remove"}>×</button>
                  </span>
                ))}
              </div>
            )}
            {tech.legacy.length > 0 && (
              <p className="text-[11px] text-gray-400 mt-2">{he ? "זוהו גם (כנראה שרידים ישנים): " : "Also detected (likely legacy artifacts): "}{tech.legacy.map((l) => l.name).join(", ")}</p>
            )}
          </Section>
        )}

        {(brand.voice || brand.tone || brand.personality || (brand.vocabulary || []).length > 0) && (
          <Section he={he} title={he ? "קול המותג" : "Brand voice"} confidence={brand.confidence}>
            <div className="space-y-2 text-sm">
              <BrandRow he={he} label={["Personality", "אישיות"]} value={brand.personality} />
              <BrandRow he={he} label={["Tone", "טון"]} value={brand.tone} />
              <BrandRow he={he} label={["Voice", "קול"]} value={brand.voice} />
              <BrandRow he={he} label={["Audience", "קהל"]} value={brand.audience} />
              <BrandRow he={he} label={["Positioning", "מיצוב"]} value={brand.positioning} />
              <BrandRow he={he} label={["CTA style", "סגנון קריאה לפעולה"]} value={brand.ctaStyle} />
              <ChipRow he={he} label={["Preferred words", "מילים מועדפות"]} items={brand.vocabulary || []} />
              <ChipRow he={he} label={["Avoids", "נמנע מ"]} items={brand.forbiddenWords || []} tone="red" />
              <ChipRow he={he} label={["Languages", "שפות"]} items={brand.languages || []} />
            </div>
          </Section>
        )}

        {gaps.length > 0 && (
          <Section he={he} title={he ? "מה שאשמח שתלמדו אותי" : "What I'd love you to teach me"} defaultOpen right={<span className="text-[11px] text-gray-400">{gaps.length}</span>}>
            <div className="space-y-2.5">
              {gaps.slice(0, 8).map((g) => <TeachCard key={g.id} he={he} gap={g} token={token} onTeach={onTeach} onDismiss={() => onCorrect("gap", "ignore", g.label)} />)}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

// ─── Recommendations hub - the living backlog, now with an in-app home ──────
const KIND_LABEL: Record<string, [string, string]> = {
  hire_employee: ["Hire", "גיוס"],
  connect_system: ["Connect a system", "חיבור מערכת"],
  connect_channel: ["Connect a channel", "חיבור ערוץ"],
  import_knowledge: ["Teach me", "ללמד אותי"],
  setup_workflow: ["Automate", "אוטומציה"],
};

export function RecommendationsHub({ he, recs, onResolve, onDismiss, onReopen }: {
  he: boolean;
  recs: RecommendationRow[];
  onResolve: (id: string) => void;
  onDismiss: (id: string) => void;
  onReopen: (id: string) => void;
}) {
  const { t } = useI18n();
  const [reopenId, setReopenId] = useState<string | null>(null);
  // The list is fetched with status=all: open recs render as the working
  // backlog; COMPLETED ones move to the green section below - and an item is
  // only ever there because the BACKEND says so (status field), never
  // optimistically.
  const sorted = recs.filter((r) => r.status === "OPEN").slice().sort((a, b) => b.priority - a.priority);
  const completed = recs
    .filter((r) => r.status === "COMPLETED")
    .slice()
    .sort((a, b) => new Date(b.completedAt || 0).getTime() - new Date(a.completedAt || 0).getTime());
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 px-6 sm:px-8 py-8" dir={he ? "rtl" : "ltr"}>
      <h2 className="text-xl font-bold text-gray-900 tracking-tight">{he ? "מה שאני ממליץ" : "What I recommend"}</h2>
      <p className="text-sm text-gray-500 mt-1">{he ? "רשימה חיה - מתעדכנת ככל שאני לומד. חצו כל דבר שכבר טיפלתם בו." : "A living list - it keeps working as I learn. Nothing here is ever lost."}</p>
      {sorted.length === 0 ? (
        <div className="py-8 text-sm text-gray-500">{he ? "אין המלצות פתוחות כרגע. עבודה יפה 🎉" : "No open recommendations right now. Nice work 🎉"}</div>
      ) : (
        <div className="mt-5 space-y-2.5">
          {sorted.map((r) => (
            <div key={r.id} className="flex items-start gap-3 p-4 rounded-2xl border border-gray-200 bg-gray-50/50">
              <span className="text-primary-400 mt-0.5">◆</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[9px] uppercase tracking-wide font-bold text-primary-600 bg-primary-50 px-1.5 py-0.5 rounded-full">{(KIND_LABEL[r.kind] || [r.kind, r.kind])[he ? 1 : 0]}</span>
                  <span className="font-semibold text-gray-900 text-sm">{r.title}</span>
                  {r.payload?.alreadyDetected ? <span className="text-[9px] uppercase tracking-wide font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full">{he ? "זוהה אצלכם" : "detected"}</span> : null}
                </div>
                {r.reason && <p className="text-xs text-gray-500 mt-0.5">{r.reason}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button type="button" onClick={() => onResolve(r.id)} className="text-[11px] font-medium text-emerald-600 hover:text-emerald-700">{he ? "בוצע" : "Done"}</button>
                <button type="button" onClick={() => onDismiss(r.id)} className="text-[11px] text-gray-400 hover:text-gray-600">{he ? "לא רלוונטי" : "Dismiss"}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {completed.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-emerald-700">{t("businessPage.completedTitle")}</h3>
          <div className="mt-2 space-y-2">
            {completed.slice(0, 10).map((r) => (
              <div key={r.id} className="flex items-start gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/50 p-3.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[11px] text-white">✓</span>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-emerald-800">{r.title}</span>
                  {r.completedAt && (
                    <p className="mt-0.5 text-[11px] text-emerald-600">
                      {t("businessPage.completedAt").replace("{date}", new Date(r.completedAt).toLocaleDateString(he ? "he-IL" : undefined))}
                    </p>
                  )}
                </div>
                <button type="button" onClick={() => setReopenId(r.id)} className="shrink-0 text-[11px] font-medium text-emerald-700 underline-offset-2 hover:underline">
                  {t("businessPage.reopen")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={reopenId !== null}
        title={t("businessPage.reopenTitle")}
        message={t("businessPage.reopenBody")}
        confirmText={t("businessPage.reopenConfirm")}
        onConfirm={() => {
          const id = reopenId;
          setReopenId(null);
          if (id) onReopen(id);
        }}
        onCancel={() => setReopenId(null)}
      />
    </div>
  );
}
