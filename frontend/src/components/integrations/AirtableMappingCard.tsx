"use client";

/**
 * Post-onboarding management of the Airtable source-of-truth mapping.
 *
 * The onboarding wizard writes this mapping exactly once; until this card
 * existed there was no way to see it, refresh the field list after someone
 * renamed a column in Airtable, or point the connection at a different
 * table - short of disconnecting and onboarding again. A renamed column is
 * the quiet killer: the mapping keeps its old name, every lookup silently
 * matches nothing, and the outbound page "just doesn't work".
 *
 * Mounted on the Airtable integration page when connected. Reads the saved
 * mapping, lets the admin refresh bases/tables/fields from Airtable's live
 * schema, edit the mapping, and save it back through the same endpoint the
 * wizard uses.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  airtableListBasesOnboarding,
  airtableListTablesOnboarding,
  airtableListFieldsOnboarding,
  getAirtableMapping,
  saveAirtableMapping,
  type AirtableMeta,
  type AirtableField,
} from "@/lib/api";

type MapKey = "display_name" | "phone" | "email" | "stage";

const MAP_KEYS: Array<{ key: MapKey; required: boolean }> = [
  { key: "display_name", required: true },
  { key: "phone", required: false },
  { key: "email", required: false },
  { key: "stage", required: false },
];

export function AirtableMappingCard() {
  const { token } = useAuth();
  const { t } = useI18n();

  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(true);
  const [bases, setBases] = useState<AirtableMeta[]>([]);
  const [tables, setTables] = useState<AirtableMeta[]>([]);
  const [fields, setFields] = useState<AirtableField[]>([]);
  const [baseId, setBaseId] = useState("");
  const [tableId, setTableId] = useState("");
  const [fieldMap, setFieldMap] = useState<Record<MapKey, string>>({
    display_name: "", phone: "", email: "", stage: "",
  });
  const [notesField, setNotesField] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const loadSchema = useCallback(async (bId: string, tId: string) => {
    if (!token) return;
    const [tbl, fld] = await Promise.all([
      bId ? airtableListTablesOnboarding(token, bId).then((r) => r.data).catch(() => []) : Promise.resolve([]),
      bId && tId ? airtableListFieldsOnboarding(token, bId, tId).then((r) => r.data).catch(() => []) : Promise.resolve([]),
    ]);
    setTables(tbl);
    setFields(fld);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [mapping, basesResp] = await Promise.all([
          getAirtableMapping(token).then((r) => r.data),
          airtableListBasesOnboarding(token).then((r) => r.data).catch(() => [] as AirtableMeta[]),
        ]);
        if (cancelled) return;
        setBases(basesResp);
        const bId = mapping.baseId || "";
        const tId = mapping.tableId || "";
        setBaseId(bId);
        setTableId(tId);
        setFieldMap({
          display_name: mapping.fieldMap.display_name || "",
          phone: mapping.fieldMap.phone || "",
          email: mapping.fieldMap.email || "",
          stage: mapping.fieldMap.stage || "",
        });
        setNotesField(mapping.notesField || "");
        await loadSchema(bId, tId);
      } catch (err: unknown) {
        if (!cancelled && (err as { message?: string })?.message === "not_connected") setConnected(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, loadSchema]);

  async function onRefresh() {
    setRefreshing(true);
    setNotice(null);
    try {
      if (token) setBases((await airtableListBasesOnboarding(token)).data);
      await loadSchema(baseId, tableId);
      setNotice({ kind: "ok", text: t("marketplace.airtable.refreshed") });
    } catch {
      setNotice({ kind: "err", text: t("marketplace.airtable.refreshFailed") });
    } finally {
      setRefreshing(false);
    }
  }

  async function onPickBase(next: string) {
    setBaseId(next);
    setTableId("");
    setFields([]);
    await loadSchema(next, "");
  }

  async function onPickTable(next: string) {
    setTableId(next);
    await loadSchema(baseId, next);
  }

  async function onSave() {
    if (!token) return;
    setSaving(true);
    setNotice(null);
    try {
      const r = await saveAirtableMapping(token, {
        baseId,
        tableId,
        fieldMap: {
          display_name: fieldMap.display_name || undefined,
          phone: fieldMap.phone || undefined,
          email: fieldMap.email || undefined,
          stage: fieldMap.stage || undefined,
        },
        notesField: notesField || undefined,
      });
      setNotice({
        kind: "ok",
        text: r.warning ? `${t("marketplace.airtable.saved")} (${r.warning})` : t("marketplace.airtable.saved"),
      });
    } catch (err: unknown) {
      const code = (err as { message?: string })?.message || "";
      const known: Record<string, string> = {
        map_display_name: t("marketplace.airtable.needName"),
        map_email_or_phone: t("marketplace.airtable.needIdentifier"),
      };
      setNotice({ kind: "err", text: known[code] || t("marketplace.airtable.saveFailed") });
    } finally {
      setSaving(false);
    }
  }

  if (loading || !connected) return null;

  const canSave =
    !!baseId && !!tableId && !!fieldMap.display_name && (!!fieldMap.phone || !!fieldMap.email) && !saving;

  const selectCls =
    "w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-300";

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="font-semibold text-gray-900">{t("marketplace.airtable.mappingTitle")}</h2>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="ms-auto rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {refreshing ? t("marketplace.airtable.refreshing") : t("marketplace.airtable.refreshFields")}
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-4">{t("marketplace.airtable.mappingHint")}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">{t("marketplace.airtable.base")}</span>
          <select value={baseId} onChange={(e) => onPickBase(e.target.value)} className={selectCls}>
            <option value="">—</option>
            {bases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">{t("marketplace.airtable.table")}</span>
          <select value={tableId} onChange={(e) => onPickTable(e.target.value)} className={selectCls} disabled={!baseId}>
            <option value="">—</option>
            {tables.map((tb) => <option key={tb.id} value={tb.id}>{tb.name}</option>)}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {MAP_KEYS.map(({ key, required }) => (
          <label key={key} className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">
              {t(`marketplace.airtable.field_${key}`)}{required ? " *" : ""}
            </span>
            <select
              value={fieldMap[key]}
              onChange={(e) => setFieldMap((prev) => ({ ...prev, [key]: e.target.value }))}
              className={selectCls}
              disabled={fields.length === 0}
            >
              <option value="">—</option>
              {fields.map((f) => <option key={f.id} value={f.name}>{f.name}</option>)}
            </select>
          </label>
        ))}
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">{t("marketplace.airtable.field_notes")}</span>
          <select
            value={notesField}
            onChange={(e) => setNotesField(e.target.value)}
            className={selectCls}
            disabled={fields.length === 0}
          >
            <option value="">—</option>
            {fields.map((f) => <option key={f.id} value={f.name}>{f.name}</option>)}
          </select>
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={!canSave}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
        >
          {saving ? t("marketplace.airtable.saving") : t("marketplace.airtable.saveMapping")}
        </button>
        {notice && (
          <span className={`text-sm ${notice.kind === "ok" ? "text-green-700" : "text-red-600"}`}>{notice.text}</span>
        )}
      </div>
    </div>
  );
}
