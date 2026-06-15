"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  listFieldDefinitions,
  createFieldDefinition,
  updateFieldDefinition,
  deleteFieldDefinition,
  listIndustryPacks,
  applyIndustryPack,
  type FieldDefinition,
  type FieldDefinitionInput,
  type FieldScope,
  type FieldTypeName,
  type IntelligencePack,
} from "@/lib/gotcha-api";

/**
 * Settings → Intelligence Fields (Customer Intelligence V2, Phase 1).
 *
 * The Fields Builder over the scope-aware FieldDefinition registry. Each field
 * declares the SCOPE it owns - customer (durable, per-person), opportunity
 * (per-deal), or conversation (per-interaction) - the core anti-overwrite
 * mechanic. Industry Packs seed scope-tagged fields in one click.
 */

const SCOPES: FieldScope[] = ["customer", "opportunity", "conversation"];
const TYPES: FieldTypeName[] = ["text", "number", "boolean", "enum", "date"];

const SCOPE_META: Record<FieldScope, { en: string; he: string; cls: string }> = {
  customer: { en: "Customer", he: "לקוח", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  opportunity: { en: "Opportunity", he: "הזדמנות", cls: "bg-violet-50 text-violet-700 border-violet-200" },
  conversation: { en: "Conversation", he: "שיחה", cls: "bg-amber-50 text-amber-700 border-amber-200" },
};

const TYPE_LABEL: Record<FieldTypeName, { en: string; he: string }> = {
  text: { en: "Text", he: "טקסט" },
  number: { en: "Number", he: "מספר" },
  boolean: { en: "Yes / No", he: "כן / לא" },
  enum: { en: "Choice", he: "בחירה" },
  date: { en: "Date", he: "תאריך" },
  entity_ref: { en: "Reference", he: "הפניה" },
};

function emptyDraft(): FieldDefinitionInput {
  return {
    key: "",
    label: "",
    description: "",
    type: "text",
    scope: "opportunity",
    options: [],
    required: false,
    aiExtract: true,
    syncToCrm: true,
  };
}

export default function IntelligenceFieldsPage() {
  const { token } = useAuth();
  const { locale } = useI18n();
  const he = locale === "he";

  const [fields, setFields] = useState<FieldDefinition[]>([]);
  const [packs, setPacks] = useState<IntelligencePack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showPacks, setShowPacks] = useState(false);
  const [editing, setEditing] = useState<FieldDefinition | null>(null);
  const [adding, setAdding] = useState(false);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }, []);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const [f, p] = await Promise.all([listFieldDefinitions(token), listIndustryPacks(token)]);
      setFields(f.fields ?? []);
      setPacks(p.packs ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload]);

  const { packFields, customFields } = useMemo(() => {
    const packF = fields.filter((f) => f.origin === "pack");
    const customF = fields.filter((f) => f.origin !== "pack");
    return { packFields: packF, customFields: customF };
  }, [fields]);

  const appliedPackSlugs = useMemo(
    () => new Set(packFields.map((f) => f.packSlug).filter(Boolean) as string[]),
    [packFields],
  );

  async function handleApplyPack(slug: string) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await applyIndustryPack(token, slug);
      await reload();
      flash(he ? `נטענו ${res.applied.length} שדות` : `Loaded ${res.applied.length} fields`);
    } catch (e: any) {
      setError(e?.message ?? "Apply failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(draft: FieldDefinitionInput, id?: string) {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      if (id) {
        await updateFieldDefinition(token, id, draft);
      } else {
        await createFieldDefinition(token, draft);
      }
      await reload();
      setEditing(null);
      setAdding(false);
      flash(he ? "נשמר" : "Saved");
    } catch (e: any) {
      setError(e?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (!token) return;
    if (!confirm(he ? "למחוק את השדה?" : "Delete this field?")) return;
    setBusy(true);
    try {
      await deleteFieldDefinition(token, id);
      await reload();
      flash(he ? "נמחק" : "Deleted");
    } catch (e: any) {
      setError(e?.message ?? "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  if (!token) return null;

  return (
    <div className="p-6" dir={he ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between mb-1 max-w-4xl">
        <h1 className="text-xl font-semibold text-gray-900">
          {he ? "שדות מודיעין" : "Intelligence Fields"}
        </h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowPacks((v) => !v)}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 transition"
          >
            {he ? "עיון בחבילות" : "Browse packs"}
          </button>
          <button
            onClick={() => { setAdding(true); setEditing(null); }}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white transition shadow-sm"
          >
            {he ? "+ שדה חדש" : "+ Add field"}
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500 mb-4 max-w-4xl">
        {he
          ? "השדות שהמערכת לומדת ועוקבת אחריהם. כל שדה שייך לתחום: לקוח (קבוע), הזדמנות (לעסקה), או שיחה."
          : "What the system learns and tracks. Each field belongs to a scope: Customer (durable), Opportunity (per-deal), or Conversation."}
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg mb-4 max-w-4xl">
          {error}
        </div>
      )}
      {toast && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-2 rounded-lg mb-4 max-w-4xl">
          {toast}
        </div>
      )}

      {/* Pack browser */}
      {showPacks && (
        <section className="bg-white rounded-xl shadow-subtle p-5 mb-6 max-w-4xl">
          <h2 className="text-sm font-semibold text-gray-800 mb-3">
            {he ? "חבילות תעשייה" : "Industry packs"}
          </h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {packs.map((p) => {
              const applied = appliedPackSlugs.has(p.slug);
              return (
                <div key={p.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-gray-900 text-sm">{p.name}</div>
                      <div className="text-xs text-gray-500">
                        {p.fields.length} {he ? "שדות" : "fields"}
                      </div>
                    </div>
                    <button
                      onClick={() => handleApplyPack(p.slug)}
                      disabled={busy}
                      className={clsx(
                        "px-3 py-1.5 rounded-lg text-xs font-medium transition",
                        applied
                          ? "bg-gray-100 text-gray-500 hover:bg-gray-200"
                          : "bg-violet-600 text-white hover:bg-violet-700",
                      )}
                    >
                      {applied ? (he ? "רענון" : "Re-apply") : (he ? "טען" : "Apply")}
                    </button>
                  </div>
                </div>
              );
            })}
            {packs.length === 0 && (
              <p className="text-xs text-gray-400 italic">{he ? "אין חבילות זמינות" : "No packs available"}</p>
            )}
          </div>
        </section>
      )}

      {loading ? (
        <div className="bg-white rounded-xl shadow-subtle p-6 text-sm text-gray-500 max-w-4xl">
          {he ? "טוען…" : "Loading…"}
        </div>
      ) : (
        <div className="space-y-6 max-w-4xl">
          {adding && (
            <FieldEditor
              he={he}
              initial={emptyDraft()}
              busy={busy}
              onCancel={() => setAdding(false)}
              onSave={(d) => handleSave(d)}
            />
          )}

          <FieldGroup
            title={he ? "מהחבילה" : "From pack"}
            empty={he ? "לא נטענה חבילה עדיין" : "No pack applied yet"}
            fields={packFields}
            he={he}
            editingId={editing?.id ?? null}
            onEdit={(f) => { setEditing(f); setAdding(false); }}
            onCancelEdit={() => setEditing(null)}
            onSave={handleSave}
            onDelete={handleDelete}
            busy={busy}
          />

          <FieldGroup
            title={he ? "מותאם אישית" : "Custom"}
            empty={he ? "אין שדות מותאמים. הוסיפו אחד למעלה." : "No custom fields. Add one above."}
            fields={customFields}
            he={he}
            editingId={editing?.id ?? null}
            onEdit={(f) => { setEditing(f); setAdding(false); }}
            onCancelEdit={() => setEditing(null)}
            onSave={handleSave}
            onDelete={handleDelete}
            busy={busy}
          />
        </div>
      )}
    </div>
  );
}

// ─── Field group (a labeled list of field rows) ──────────────

function FieldGroup({
  title, empty, fields, he, editingId, onEdit, onCancelEdit, onSave, onDelete, busy,
}: {
  title: string;
  empty: string;
  fields: FieldDefinition[];
  he: boolean;
  editingId: string | null;
  onEdit: (f: FieldDefinition) => void;
  onCancelEdit: () => void;
  onSave: (draft: FieldDefinitionInput, id?: string) => void;
  onDelete: (id: string) => void;
  busy: boolean;
}) {
  return (
    <section className="bg-white rounded-xl shadow-subtle p-5">
      <h2 className="text-sm font-semibold text-gray-800 mb-3">
        {title} <span className="text-gray-400 font-normal">· {fields.length}</span>
      </h2>
      {fields.length === 0 ? (
        <p className="text-xs text-gray-400 italic">{empty}</p>
      ) : (
        <div className="space-y-1.5">
          {fields.map((f) =>
            editingId === f.id ? (
              <FieldEditor
                key={f.id}
                he={he}
                initial={f}
                busy={busy}
                onCancel={onCancelEdit}
                onSave={(d) => onSave(d, f.id)}
              />
            ) : (
              <FieldRow key={f.id} field={f} he={he} onEdit={() => onEdit(f)} onDelete={() => onDelete(f.id)} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

// ─── Field row (read-only display) ───────────────────────────

function FieldRow({
  field, he, onEdit, onDelete,
}: {
  field: FieldDefinition;
  he: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const scope = SCOPE_META[field.scope];
  return (
    <div className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-gray-50 group">
      <span className={clsx("text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0", scope.cls)}>
        {he ? scope.he : scope.en}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 truncate">{field.label}</span>
          <span className="text-[11px] text-gray-400 font-mono truncate">{field.key}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-gray-500">{(TYPE_LABEL[field.type] ?? TYPE_LABEL.text)[he ? "he" : "en"]}</span>
          {field.type === "enum" && field.options.length > 0 && (
            <span className="text-[10px] text-gray-400 truncate">{field.options.join(" · ")}</span>
          )}
          {field.required && <Pill tone="amber">{he ? "חובה" : "Required"}</Pill>}
          {!field.aiExtract && <Pill tone="gray">{he ? "ללא חילוץ AI" : "No AI extract"}</Pill>}
          {!field.syncToCrm && <Pill tone="gray">{he ? "ללא סנכרון CRM" : "No CRM sync"}</Pill>}
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition shrink-0">
        <button onClick={onEdit} className="text-xs text-gray-500 hover:text-violet-600 px-2 py-1">
          {he ? "עריכה" : "Edit"}
        </button>
        <button onClick={onDelete} className="text-xs text-gray-400 hover:text-red-600 px-2 py-1">
          {he ? "מחיקה" : "Delete"}
        </button>
      </div>
    </div>
  );
}

function Pill({ tone, children }: { tone: "amber" | "gray"; children: React.ReactNode }) {
  return (
    <span
      className={clsx(
        "text-[10px] px-1.5 py-0.5 rounded-full border",
        tone === "amber" ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-gray-50 text-gray-500 border-gray-200",
      )}
    >
      {children}
    </span>
  );
}

// ─── Field editor (add + edit) ───────────────────────────────

function FieldEditor({
  he, initial, busy, onCancel, onSave,
}: {
  he: boolean;
  initial: FieldDefinitionInput;
  busy: boolean;
  onCancel: () => void;
  onSave: (draft: FieldDefinitionInput) => void;
}) {
  const [draft, setDraft] = useState<FieldDefinitionInput>({ ...emptyDraft(), ...initial });
  const [optionInput, setOptionInput] = useState("");

  function set<K extends keyof FieldDefinitionInput>(k: K, v: FieldDefinitionInput[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  function addOption() {
    const v = optionInput.trim();
    if (!v) return;
    const opts = draft.options ?? [];
    if (!opts.includes(v)) set("options", [...opts, v]);
    setOptionInput("");
  }

  const isEnum = draft.type === "enum";
  const canSave =
    !!(draft.key && draft.key.trim()) &&
    !!(draft.label && draft.label.trim()) &&
    (!isEnum || (draft.options && draft.options.length > 0));

  const inputCls =
    "px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 outline-none";

  return (
    <div className="border border-violet-200 bg-violet-50/30 rounded-lg p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-600">{he ? "מפתח (snake_case)" : "Key (snake_case)"}</span>
          <input
            className={clsx(inputCls, "font-mono")}
            placeholder="guest_count"
            value={draft.key ?? ""}
            onChange={(e) => set("key", e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-600">{he ? "תווית" : "Label"}</span>
          <input
            className={inputCls}
            placeholder={he ? "מספר אורחים" : "Guest Count"}
            value={draft.label ?? ""}
            onChange={(e) => set("label", e.target.value)}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-gray-600">{he ? "תיאור (לא חובה)" : "Description (optional)"}</span>
        <input
          className={inputCls}
          value={draft.description ?? ""}
          onChange={(e) => set("description", e.target.value)}
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-600">{he ? "תחום" : "Scope"}</span>
          <select className={inputCls} value={draft.scope} onChange={(e) => set("scope", e.target.value as FieldScope)}>
            {SCOPES.map((s) => (
              <option key={s} value={s}>{he ? SCOPE_META[s].he : SCOPE_META[s].en}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-600">{he ? "סוג" : "Type"}</span>
          <select className={inputCls} value={draft.type} onChange={(e) => set("type", e.target.value as FieldTypeName)}>
            {TYPES.map((tp) => (
              <option key={tp} value={tp}>{TYPE_LABEL[tp][he ? "he" : "en"]}</option>
            ))}
          </select>
        </label>
      </div>

      {isEnum && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-600">{he ? "אפשרויות" : "Options"}</span>
          <div className="flex flex-wrap gap-1.5 mb-1">
            {(draft.options ?? []).map((o) => (
              <span key={o} className="inline-flex items-center gap-1 text-xs bg-white border border-gray-200 rounded-full px-2 py-0.5">
                {o}
                <button
                  onClick={() => set("options", (draft.options ?? []).filter((x) => x !== o))}
                  className="text-gray-400 hover:text-red-600"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className={clsx(inputCls, "flex-1")}
              placeholder={he ? "הוסיפו אפשרות ו-Enter" : "Type an option, press Enter"}
              value={optionInput}
              onChange={(e) => setOptionInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOption(); } }}
            />
            <button onClick={addOption} className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg">
              {he ? "הוסף" : "Add"}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-4 pt-1">
        <Toggle label={he ? "חובה" : "Required"} checked={!!draft.required} onChange={(v) => set("required", v)} />
        <Toggle label={he ? "חילוץ ע\"י AI" : "AI extract"} checked={draft.aiExtract !== false} onChange={(v) => set("aiExtract", v)} />
        <Toggle label={he ? "סנכרון ל-CRM" : "Sync to CRM"} checked={draft.syncToCrm !== false} onChange={(v) => set("syncToCrm", v)} />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900">
          {he ? "ביטול" : "Cancel"}
        </button>
        <button
          onClick={() => onSave(draft)}
          disabled={!canSave || busy}
          className={clsx(
            "px-4 py-1.5 rounded-lg text-sm font-medium transition",
            canSave && !busy ? "bg-violet-600 text-white hover:bg-violet-700" : "bg-gray-100 text-gray-400 cursor-not-allowed",
          )}
        >
          {he ? "שמירה" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 accent-violet-600" />
      {label}
    </label>
  );
}
