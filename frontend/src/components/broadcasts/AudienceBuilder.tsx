"use client";

/**
 * AudienceBuilder — the "who" step of the broadcast wizard, redesigned
 * around newsletter user-stories rather than dev-style filter modes.
 *
 * Three modes (down from four):
 *   - "smart" (default, "Find & filter") — free CRM+local search at the
 *     top, chips for hand-picked people, then optional schema-driven
 *     rules below for attribute filtering. The single most common path:
 *     "type a name → click chip" or "filter by attribute → see count".
 *   - "import" — paste/CSV.
 *   - "everyone" — channel-wide blast (gated, with confirmation).
 *
 * Why the merge: the old "Pick people" tab was just Smart-without-rules.
 * Operators kept switching tabs to do "find this one VIP, plus everyone
 * at Consideration stage" — both belong in one screen.
 *
 * New affordances based on UX feedback:
 *   - CRM provenance banner — surfaces that filter fields come from the
 *     connected CRM's lead/contact schema (Zoho/HubSpot/Salesforce).
 *   - Free CRM search pinned to the top (no longer hidden behind a tab).
 *   - Per-rule match count — each rule shows "≈ N match this rule" so
 *     the operator can tell which rule narrowed the audience.
 *   - Audience breakdown ("3 picked + 47 from rule = 50") in the live
 *     count banner so the number is explainable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { getAudienceSchema, getContacts, previewAudience } from "@/lib/api";

// ─── Public state shape ───────────────────────────────────────

export type AudienceMode = "smart" | "pick" | "import" | "everyone";

/** Which CRM module the rules and variable picker target. */
export type AudienceModule = "leads" | "contacts";

export interface AudienceFilterRule {
  id: string;       // local UI id
  field: string;    // field name (matches schema)
  fieldLabel?: string;
  fieldType?: string;
  fieldSource?: "local" | "crm";
  picklist?: string[];
  op: string;
  value: any;
}

export interface PickedContact {
  id: string;          // local Contact id when source==="local"; otherwise externalId/email
  source: "local" | "crm";
  displayName?: string;
  phone?: string;
  email?: string;
}

export interface AudienceState {
  mode: AudienceMode;
  picked: PickedContact[];   // chips for Smart mode
  rules: AudienceFilterRule[]; // ANDed together (Smart mode only)
  importText: string;          // Import mode only
  /** CRM module the rules + variable picker target. Defaults to "leads"
   *  to match the legacy hardcoded behavior for older saved audiences. */
  module: AudienceModule;
}

export function emptyAudience(): AudienceState {
  return { mode: "smart", picked: [], rules: [], importText: "", module: "leads" };
}

// ─── API audience definition derivation ───────────────────────

/**
 * Translate the local UI state into the canonical audience definition
 * the backend understands. Returns null when the audience isn't yet
 * meaningful (e.g. empty Smart mode).
 */
export function buildAudienceDefinition(s: AudienceState, channel: string): any | null {
  if (s.mode === "everyone") {
    return { type: "composite", everyone: true, channel };
  }
  if (s.mode === "import") {
    // Import is materialized into BroadcastRecipient rows directly by
    // the wizard — no audience definition needed.
    return null;
  }
  // smart (and legacy "pick" — treat as smart-without-rules)
  const ids = s.picked.filter((p) => p.source === "local").map((p) => p.id);
  const crmContacts = s.picked
    .filter((p) => p.source === "crm")
    .map((p) => ({
      id: p.id,
      ...(p.displayName && { displayName: p.displayName }),
      ...(p.phone && { phone: p.phone }),
      ...(p.email && { email: p.email }),
    }));
  const validRules = s.rules
    .filter((r) => r.field && r.op)
    .map((r) => ({ field: r.field, op: r.op, value: r.value }));
  if (ids.length === 0 && crmContacts.length === 0 && validRules.length === 0) return null;
  return {
    type: "composite",
    ...(ids.length > 0 && { contactIds: ids }),
    ...(crmContacts.length > 0 && { crmContacts }),
    ...(validRules.length > 0 && { rules: { all: validRules } }),
    // Send module only when rules exist — chip-only audiences don't query
    // CRM by criteria so the field is meaningless there.
    ...(validRules.length > 0 && { module: s.module ?? "leads" }),
  };
}

// ─── Schema field type → operator catalog ─────────────────────

const STRING_OPS = ["equals", "contains", "starts_with", "ends_with", "exists", "not_exists"];
const NUMBER_OPS = ["equals", "not_equals", "gt", "gte", "lt", "lte", "exists", "not_exists"];
const DATE_OPS = ["before", "after", "in_last_days", "exists", "not_exists"];
const PICKLIST_OPS = ["equals", "not_equals", "in", "not_in", "exists", "not_exists"];
const BOOL_OPS = ["equals"];

function operatorsFor(type?: string): string[] {
  switch ((type || "string").toLowerCase()) {
    case "number":
    case "currency":
      return NUMBER_OPS;
    case "date":
    case "datetime":
      return DATE_OPS;
    case "picklist":
    case "multipicklist":
      return PICKLIST_OPS;
    case "boolean":
      return BOOL_OPS;
    case "email":
    case "phone":
    case "url":
    case "string":
    case "text":
    default:
      return STRING_OPS;
  }
}

const OP_I18N: Record<string, string> = {
  equals: "outbound.broadcasts.opLabelEquals",
  not_equals: "outbound.broadcasts.opLabelNotEquals",
  contains: "outbound.broadcasts.opLabelContains",
  starts_with: "outbound.broadcasts.opLabelStartsWith",
  ends_with: "outbound.broadcasts.opLabelEndsWith",
  exists: "outbound.broadcasts.opLabelExists",
  not_exists: "outbound.broadcasts.opLabelNotExists",
  in: "outbound.broadcasts.opLabelIn",
  not_in: "outbound.broadcasts.opLabelNotIn",
  gt: "outbound.broadcasts.opLabelGt",
  gte: "outbound.broadcasts.opLabelGte",
  lt: "outbound.broadcasts.opLabelLt",
  lte: "outbound.broadcasts.opLabelLte",
  in_last_days: "outbound.broadcasts.opLabelInLastDays",
  before: "outbound.broadcasts.opLabelBefore",
  after: "outbound.broadcasts.opLabelAfter",
};

// ─── Component ────────────────────────────────────────────────

interface SchemaField {
  name: string;
  label: string;
  type: string;
  picklist?: string[];
}

interface SchemaState {
  local: SchemaField[];
  crm: { providerName: string; fields: SchemaField[] } | null;
  /** CRM is connected but the schema fetch returned no fields. Lets the
   *  banner say "reconnect to grant scope" instead of the wrong
   *  "Connect a CRM" — the CRM IS connected, the OAuth scope is missing. */
  crmAuthGap: { providerName: string } | null;
  loading: boolean;
  error: string | null;
}

export interface AudienceBuilderProps {
  channel: string;
  channelDisplayName?: string;
  state: AudienceState;
  onChange: (s: AudienceState) => void;
  /** Surfaced upward so the wizard can show the count in its sticky footer too. */
  onCountChange?: (count: number | null, loading: boolean) => void;
}

export function AudienceBuilder({
  channel,
  channelDisplayName,
  state,
  onChange,
  onCountChange,
}: AudienceBuilderProps) {
  const { token } = useAuth();
  const { t } = useI18n();

  // Schema (local + CRM fields), loaded once.
  const [schema, setSchema] = useState<SchemaState>({
    local: [],
    crm: null,
    crmAuthGap: null,
    loading: true,
    error: null,
  });

  const activeModule: AudienceModule = state.module ?? "leads";

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setSchema((s) => ({ ...s, loading: true }));
    getAudienceSchema(token, activeModule)
      .then((res) => {
        if (cancelled) return;
        const local = (res.data.local?.fields ?? []) as SchemaField[];
        const crmData = res.data.crm as any;
        const connected = crmData.connected;
        const hasFields = connected && (crmData.schema?.fields?.length ?? 0) > 0;
        const crm = hasFields
          ? {
              providerName: crmData.provider.name,
              fields: crmData.schema!.fields as SchemaField[],
            }
          : null;
        // Connected but schema empty/null → OAuth scope or describe_fields
        // path is failing. Surface as a distinct state so the banner can
        // direct the operator to reconnect rather than (mis)telling them
        // there's no CRM.
        const crmAuthGap = connected && !hasFields
          ? { providerName: (res.data.crm as any).provider.name }
          : null;
        setSchema({ local, crm, crmAuthGap, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setSchema({ local: [], crm: null, crmAuthGap: null, loading: false, error: err?.message ?? "schema load failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [token, activeModule]);

  // ─── Live preview (count + first 10 names) ────────────────
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewSample, setPreviewSample] = useState<
    Array<{ id: string; source: "local" | "crm"; displayName?: string; phone?: string; email?: string }>
  >([]);
  const [previewReason, setPreviewReason] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onCountChange?.(previewCount, previewLoading);
  }, [previewCount, previewLoading, onCountChange]);

  const audience = useMemo(() => buildAudienceDefinition(state, channel), [state, channel]);

  useEffect(() => {
    if (!token) return;
    if (state.mode === "import") {
      // Import count handled locally — just count non-empty lines.
      const n = state.importText.split("\n").map((l) => l.trim()).filter(Boolean).length;
      setPreviewCount(n);
      setPreviewLoading(false);
      setPreviewSample([]);
      return;
    }
    if (!audience) {
      setPreviewCount(null);
      setPreviewLoading(false);
      setPreviewSample([]);
      setPreviewError(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setPreviewLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await previewAudience(token, audience);
        setPreviewCount(res.data.total);
        setPreviewSample((res.data.recipients ?? []).slice(0, 10));
        setPreviewReason(res.data.reasoning ?? []);
        setPreviewError(null);
      } catch (err: any) {
        setPreviewError(err?.message ?? "preview failed");
        setPreviewCount(null);
        setPreviewSample([]);
      } finally {
        setPreviewLoading(false);
      }
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [token, audience, state.mode, state.importText]);

  // ─── Handlers ────────────────────────────────────────────
  function setMode(mode: AudienceMode) {
    onChange({ ...state, mode });
  }
  function setModule(module: AudienceModule) {
    if (module === state.module) return;
    // Module switch invalidates CRM-side fields on existing rules; reset
    // their `field` so the operator re-picks from the new schema instead
    // of silently sending lead-named fields against the contact module.
    const rules = state.rules.map((r) =>
      r.fieldSource === "crm" ? { ...r, field: "", fieldLabel: undefined } : r,
    );
    onChange({ ...state, module, rules });
  }
  function addRule() {
    onChange({
      ...state,
      rules: [
        ...state.rules,
        {
          id: Math.random().toString(36).slice(2),
          field: "",
          op: "equals",
          value: "",
        },
      ],
    });
  }
  function updateRule(id: string, patch: Partial<AudienceFilterRule>) {
    onChange({
      ...state,
      rules: state.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  }
  function removeRule(id: string) {
    onChange({ ...state, rules: state.rules.filter((r) => r.id !== id) });
  }
  function addPicked(c: PickedContact) {
    if (state.picked.some((p) => p.id === c.id)) return;
    onChange({ ...state, picked: [...state.picked, c] });
  }
  function removePicked(id: string) {
    onChange({ ...state, picked: state.picked.filter((p) => p.id !== id) });
  }

  const inSmartMode = state.mode === "smart" || state.mode === "pick";

  return (
    <div className="space-y-4">
      {/* CRM provenance banner — answers "I don't see how rules tie to my CRM schema" */}
      <CrmProvenanceBanner schema={schema} t={t} />

      {/* Module selector — show whenever a CRM is connected (even if the
          schema fetch failed) so the operator can still flip leads↔contacts
          and trigger another fetch after fixing the OAuth scope. */}
      {(schema.crm || schema.crmAuthGap) && (
        <ModuleSelector
          module={activeModule}
          onChange={setModule}
          providerName={(schema.crm ?? schema.crmAuthGap)!.providerName}
          t={t}
        />
      )}

      {/* Mode tabs (3 strategies) */}
      <ModeTabs mode={inSmartMode ? "smart" : state.mode} onChange={setMode} t={t} />

      {/* Smart (Find & filter): always-visible search → chips → rules */}
      {inSmartMode && (
        <>
          <PickPeopleSection
            picked={state.picked}
            onAdd={addPicked}
            onRemove={removePicked}
            providerName={schema.crm?.providerName}
            t={t}
          />
          <RulesSection
            rules={state.rules}
            schema={schema}
            channel={channel}
            picked={state.picked}
            onAdd={addRule}
            onUpdate={updateRule}
            onRemove={removeRule}
            t={t}
          />
        </>
      )}

      {state.mode === "import" && (
        <ImportSection
          value={state.importText}
          onChange={(v) => onChange({ ...state, importText: v })}
          t={t}
        />
      )}

      {state.mode === "everyone" && (
        <EveryoneSection channelDisplayName={channelDisplayName ?? channel} t={t} />
      )}

      {/* Sticky live count + preview drawer */}
      <LiveCountBanner
        count={previewCount}
        loading={previewLoading}
        sample={previewSample}
        reasoning={previewReason}
        error={previewError}
        mode={inSmartMode ? "smart" : state.mode}
        pickedCount={state.picked.length}
        rulesCount={state.rules.filter((r) => r.field && r.op).length}
        channelDisplayName={channelDisplayName ?? channel}
        t={t}
      />
    </div>
  );
}

// ─── CRM provenance banner ────────────────────────────────────

function CrmProvenanceBanner({
  schema,
  t,
}: {
  schema: SchemaState;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  if (schema.loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-50 border border-gray-100 text-xs text-gray-400">
        <span className="w-3 h-3 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
        {t("outbound.broadcasts.crmBannerLoading")}
      </div>
    );
  }
  if (!schema.crm) {
    // Connected-but-unauthorized — distinct from no-CRM-connected. The
    // CRM IS connected; the OAuth scope or describe_fields path is failing.
    if (schema.crmAuthGap) {
      const provider = schema.crmAuthGap.providerName;
      return (
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-100">
          <div className="flex items-center gap-2 min-w-0">
            <svg className="w-4 h-4 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            <span className="text-xs text-amber-700 truncate">
              {t("outbound.broadcasts.crmBannerScopeMissing", { provider })}
            </span>
          </div>
          <a
            href="/integrations"
            className="text-xs font-medium text-amber-700 hover:text-amber-800 underline-offset-2 hover:underline shrink-0"
          >
            {t("outbound.broadcasts.crmBannerReconnect")}
          </a>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-100">
        <div className="flex items-center gap-2 min-w-0">
          <svg className="w-4 h-4 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 11-5.656-5.656l1.5-1.5M10.172 13.828a4 4 0 010-5.656l3-3a4 4 0 115.656 5.656l-1.5 1.5" />
          </svg>
          <span className="text-xs text-amber-700 truncate">
            {t("outbound.broadcasts.crmBannerNotConnected")}
          </span>
        </div>
        <a
          href="/integrations"
          className="text-xs font-medium text-amber-700 hover:text-amber-800 underline-offset-2 hover:underline shrink-0"
        >
          {t("outbound.broadcasts.crmBannerConnect")}
        </a>
      </div>
    );
  }
  const fieldCount = schema.crm.fields.length;
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gradient-to-r from-violet-50 to-primary-50/40 border border-violet-100">
      <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-violet-100 text-violet-700">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-violet-900 truncate">
          {t("outbound.broadcasts.crmBannerConnected", { provider: schema.crm.providerName })}
        </div>
        <div className="text-[11px] text-violet-700/80 truncate">
          {t("outbound.broadcasts.crmBannerFieldsAvailable", { count: String(fieldCount) })}
        </div>
      </div>
    </div>
  );
}

// ─── Module selector (Leads vs Contacts) ─────────────────────

function ModuleSelector({
  module,
  onChange,
  providerName,
  t,
}: {
  module: AudienceModule;
  onChange: (m: AudienceModule) => void;
  providerName: string;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const items: { key: AudienceModule; label: string }[] = [
    { key: "leads", label: t("outbound.broadcasts.moduleLeads") },
    { key: "contacts", label: t("outbound.broadcasts.moduleContacts") },
  ];
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-white border border-gray-200">
      <span className="text-xs text-gray-600 truncate">
        {t("outbound.broadcasts.moduleSelectorLabel", { provider: providerName })}
      </span>
      <div className="inline-flex p-0.5 rounded-lg bg-gray-100">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(it.key)}
            className={clsx(
              "px-3 py-1 text-xs font-medium rounded-md transition",
              module === it.key
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-600 hover:text-gray-800",
            )}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Mode tabs (3 strategies) ─────────────────────────────────

function ModeTabs({
  mode,
  onChange,
  t,
}: {
  mode: AudienceMode;
  onChange: (m: AudienceMode) => void;
  t: (k: string) => string;
}) {
  const items: { key: AudienceMode; label: string; desc: string; icon: JSX.Element }[] = [
    {
      key: "smart",
      label: t("outbound.broadcasts.modeSmart"),
      desc: t("outbound.broadcasts.modeSmartDesc"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35m1.35-5.4a6.75 6.75 0 11-13.5 0 6.75 6.75 0 0113.5 0z" />
        </svg>
      ),
    },
    {
      key: "import",
      label: t("outbound.broadcasts.modeImport"),
      desc: t("outbound.broadcasts.modeImportDesc"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12M12 16.5V3" />
        </svg>
      ),
    },
    {
      key: "everyone",
      label: t("outbound.broadcasts.modeEveryone"),
      desc: t("outbound.broadcasts.modeEveryoneDesc"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-5a4 4 0 11-8 0 4 4 0 018 0zm6 0a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      ),
    },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onChange(it.key)}
          className={clsx(
            "text-left p-3 rounded-xl border transition",
            mode === it.key
              ? "border-primary-300 bg-primary-50/60 ring-2 ring-primary-200"
              : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50"
          )}
        >
          <div className={clsx("flex items-center gap-2 text-sm font-semibold", mode === it.key ? "text-primary-700" : "text-gray-800")}>
            <span className={clsx("inline-flex items-center justify-center w-6 h-6 rounded-md", mode === it.key ? "bg-primary-100 text-primary-600" : "bg-gray-100 text-gray-500")}>
              {it.icon}
            </span>
            {it.label}
          </div>
          <p className="text-[11px] text-gray-500 mt-1 leading-snug">{it.desc}</p>
        </button>
      ))}
    </div>
  );
}

// ─── Pick people (search + chips) ─────────────────────────────

function PickPeopleSection({
  picked,
  onAdd,
  onRemove,
  providerName,
  t,
}: {
  picked: PickedContact[];
  onAdd: (c: PickedContact) => void;
  onRemove: (id: string) => void;
  providerName?: string;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const { token } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickedContact[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!token) return;
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    setSearching(true);
    setOpen(true);
    timer.current = setTimeout(async () => {
      try {
        const { data } = await getContacts(token, { q: query.trim(), limit: "12", includeCrm: "1" });
        const arr: PickedContact[] = (data || []).map((c: any) => ({
          id: c.id,
          source: c.source === "crm" ? "crm" : "local",
          displayName: c.displayName || c.name || c.externalId || "(no name)",
          phone: c.phone,
          email: c.email,
        }));
        setResults(arr);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [token, query]);

  const placeholder = providerName
    ? t("outbound.broadcasts.findSearchPlaceholderCrm", { provider: providerName })
    : t("outbound.broadcasts.findSearchPlaceholder");

  return (
    <section className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900">{t("outbound.broadcasts.findHeading")}</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {providerName
              ? t("outbound.broadcasts.findHelpCrm", { provider: providerName })
              : t("outbound.broadcasts.findHelp")}
          </p>
        </div>
        {picked.length > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-primary-50 text-primary-700 ring-1 ring-primary-100">
            {t("outbound.broadcasts.findChipsCount", { count: String(picked.length) })}
          </span>
        )}
      </div>

      {/* Big search */}
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35m1.35-5.4a6.75 6.75 0 11-13.5 0 6.75 6.75 0 0113.5 0z" />
          </svg>
        </span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => query && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          className="w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition"
        />
        {open && (
          <div className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-lg">
            {searching && (
              <div className="px-3 py-2.5 text-xs text-gray-400 flex items-center gap-2">
                <span className="w-3 h-3 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                {t("outbound.broadcasts.findSearching")}
              </div>
            )}
            {!searching && results.length === 0 && (
              <div className="px-3 py-2.5 text-xs text-gray-400">{t("outbound.broadcasts.pickEmpty")}</div>
            )}
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onAdd(r);
                  setQuery("");
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 hover:bg-primary-50 flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">{r.displayName}</div>
                  <div className="text-[11px] text-gray-500 truncate">{r.phone || r.email}</div>
                </div>
                <span
                  className={clsx(
                    "shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium",
                    r.source === "crm" ? "bg-violet-50 text-violet-600 ring-1 ring-violet-100" : "bg-gray-100 text-gray-500"
                  )}
                >
                  {r.source === "crm" ? t("outbound.broadcasts.pickFromCrm") : t("outbound.broadcasts.pickFromLocal")}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Chips */}
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {picked.map((p) => (
            <span
              key={p.id}
              className={clsx(
                "inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full text-xs font-medium",
                p.source === "crm" ? "bg-violet-50 text-violet-700 ring-1 ring-violet-100" : "bg-gray-100 text-gray-700"
              )}
            >
              <span className="truncate max-w-[180px]">{p.displayName || p.phone || p.email || p.id}</span>
              <button
                type="button"
                onClick={() => onRemove(p.id)}
                className="w-4 h-4 inline-flex items-center justify-center rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50"
                aria-label={t("outbound.broadcasts.chipsRemove")}
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Rule builder ─────────────────────────────────────────────

function RulesSection({
  rules,
  schema,
  channel,
  picked,
  onAdd,
  onUpdate,
  onRemove,
  t,
}: {
  rules: AudienceFilterRule[];
  schema: SchemaState;
  channel: string;
  picked: PickedContact[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<AudienceFilterRule>) => void;
  onRemove: (id: string) => void;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  void channel;
  void picked;
  return (
    <section className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900">{t("outbound.broadcasts.rulesHeading")}</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {schema.crm
              ? t("outbound.broadcasts.rulesHelpCrm", { provider: schema.crm.providerName })
              : t("outbound.broadcasts.rulesHelp")}
          </p>
        </div>
        {rules.length > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 px-2 py-0.5 rounded-full text-[10px] uppercase font-bold bg-primary-50 text-primary-700">
            {t("outbound.broadcasts.rulesGroupAll")}
          </span>
        )}
      </div>

      {rules.length === 0 ? (
        <button
          type="button"
          onClick={onAdd}
          className="w-full border-2 border-dashed border-gray-200 rounded-xl p-4 text-sm text-gray-400 hover:border-primary-300 hover:text-primary-600 hover:bg-primary-50/40 transition flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {t("outbound.broadcasts.rulesEmpty")}
        </button>
      ) : (
        <>
          <div className="space-y-2">
            {rules.map((r, idx) => (
              <RuleRow
                key={r.id}
                rule={r}
                schema={schema}
                isFirst={idx === 0}
                onUpdate={(patch) => onUpdate(r.id, patch)}
                onRemove={() => onRemove(r.id)}
                t={t}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={onAdd}
            className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 font-medium"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            {t("outbound.broadcasts.rulesAddRule")}
          </button>
        </>
      )}
    </section>
  );
}

function RuleRow({
  rule,
  schema,
  isFirst,
  onUpdate,
  onRemove,
  t,
}: {
  rule: AudienceFilterRule;
  schema: SchemaState;
  isFirst: boolean;
  onUpdate: (patch: Partial<AudienceFilterRule>) => void;
  onRemove: () => void;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const ops = useMemo(() => operatorsFor(rule.fieldType), [rule.fieldType]);

  function pickField(name: string, source: "local" | "crm") {
    const def =
      source === "local"
        ? schema.local.find((f) => f.name === name)
        : schema.crm?.fields.find((f) => f.name === name);
    if (!def) return;
    const newOps = operatorsFor(def.type);
    const op = newOps.includes(rule.op) ? rule.op : newOps[0];
    onUpdate({
      field: name,
      fieldLabel: def.label,
      fieldType: def.type,
      fieldSource: source,
      picklist: def.picklist,
      op,
      value: "",
    });
  }

  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-2.5">
      <div className="flex items-start gap-2">
        <span className="text-[10px] font-semibold text-gray-400 w-10 text-center pt-2 shrink-0">
          {isFirst ? t("outbound.broadcasts.ruleWhere") : t("outbound.broadcasts.rulesGroupAll")}
        </span>

        <div className="flex-1 grid grid-cols-12 gap-2">
          <div className="col-span-5">
            <FieldPicker schema={schema} value={rule.field} onPick={pickField} t={t} />
          </div>
          <div className="col-span-3">
            <select
              value={rule.op}
              onChange={(e) => onUpdate({ op: e.target.value, value: "" })}
              className="w-full px-2.5 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none transition"
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {t(OP_I18N[op] ?? op)}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-4">
            <ValueInput rule={rule} onUpdate={onUpdate} t={t} />
          </div>
        </div>

        <button
          type="button"
          onClick={onRemove}
          className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition shrink-0 mt-0.5"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Per-rule live count — recomputes on rule change with a small debounce */}
      <div className="mt-2 pl-12">
        <RuleMatchBadge rule={rule} t={t} />
      </div>
    </div>
  );
}

/**
 * Tiny live count for a single rule. Calls /audiences/preview with just
 * this rule wrapped in a one-rule filter audience so the operator can
 * see "this rule alone narrows the audience to 47 leads" — telling them
 * which rule is doing the work.
 */
function RuleMatchBadge({
  rule,
  t,
}: {
  rule: AudienceFilterRule;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const { token } = useAuth();
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ready =
    !!rule.field &&
    !!rule.op &&
    (rule.op === "exists" ||
      rule.op === "not_exists" ||
      (rule.value !== undefined && rule.value !== null && String(rule.value).length > 0) ||
      (Array.isArray(rule.value) && rule.value.length > 0));

  useEffect(() => {
    if (!token) return;
    if (debounce.current) clearTimeout(debounce.current);
    if (!ready) {
      setCount(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounce.current = setTimeout(async () => {
      try {
        const audience = {
          type: "filter",
          rules: { all: [{ field: rule.field, op: rule.op, value: rule.value }] },
        };
        const res = await previewAudience(token, audience);
        setCount(res.data.total);
      } catch {
        setCount(null);
      } finally {
        setLoading(false);
      }
    }, 450);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [token, rule.field, rule.op, JSON.stringify(rule.value), ready]);

  if (!ready) {
    return (
      <span className="inline-flex items-center text-[11px] text-gray-400">
        {t("outbound.broadcasts.ruleMatchHint")}
      </span>
    );
  }
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500">
        <span className="w-2.5 h-2.5 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
        {t("outbound.broadcasts.ruleMatchLoading")}
      </span>
    );
  }
  if (count === null) {
    return null;
  }
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium",
        count > 0
          ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
          : "bg-amber-50 text-amber-700 ring-1 ring-amber-100"
      )}
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        {count > 0 ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01" />
        )}
      </svg>
      {count > 0
        ? t("outbound.broadcasts.ruleMatchCount", { count: String(count) })
        : t("outbound.broadcasts.ruleMatchZero")}
    </span>
  );
}

function FieldPicker({
  schema,
  value,
  onPick,
  t,
}: {
  schema: SchemaState;
  value: string;
  onPick: (name: string, source: "local" | "crm") => void;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const ql = q.trim().toLowerCase();
  const localFiltered = schema.local.filter(
    (f) => !ql || f.label.toLowerCase().includes(ql) || f.name.toLowerCase().includes(ql),
  );
  const crmFiltered = schema.crm?.fields.filter(
    (f) => !ql || f.label.toLowerCase().includes(ql) || f.name.toLowerCase().includes(ql),
  ) ?? [];

  const selectedLabel =
    schema.local.find((f) => f.name === value)?.label ||
    schema.crm?.fields.find((f) => f.name === value)?.label ||
    value ||
    t("outbound.broadcasts.fieldPickerPlaceholder");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-2.5 py-2 bg-white border border-gray-200 rounded-lg text-sm hover:border-gray-300 outline-none transition truncate flex items-center justify-between gap-2"
      >
        <span className="truncate">{selectedLabel}</span>
        <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-72 bg-white border border-gray-200 rounded-xl shadow-lg p-2 max-h-80 overflow-y-auto">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("outbound.broadcasts.fieldsSearchPlaceholder")}
            className="w-full mb-2 px-2 py-1.5 text-xs border border-gray-200 rounded-md focus:ring-1 focus:ring-primary-200 outline-none"
            autoFocus
          />
          {schema.loading && (
            <div className="px-2 py-1 text-[11px] text-gray-400">…</div>
          )}
          {localFiltered.length > 0 && (
            <>
              <div className="px-1 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                {t("outbound.broadcasts.fieldsGroupPlatform")}
              </div>
              {localFiltered.map((f) => (
                <FieldOption key={`l:${f.name}`} field={f} onClick={() => { onPick(f.name, "local"); setOpen(false); setQ(""); }} />
              ))}
            </>
          )}
          {schema.crm && crmFiltered.length > 0 && (
            <>
              <div className="px-1 py-0.5 mt-1 text-[10px] font-bold uppercase tracking-wider text-violet-500">
                {t("outbound.broadcasts.fieldsGroupCrm", { provider: schema.crm.providerName })}
              </div>
              {crmFiltered.map((f) => (
                <FieldOption key={`c:${f.name}`} field={f} onClick={() => { onPick(f.name, "crm"); setOpen(false); setQ(""); }} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FieldOption({ field, onClick }: { field: SchemaField; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-2 py-1.5 rounded-md hover:bg-primary-50 flex items-center justify-between gap-2"
    >
      <span className="truncate text-sm text-gray-800">{field.label}</span>
      <span className="text-[10px] uppercase text-gray-400 shrink-0">{field.type}</span>
    </button>
  );
}

function ValueInput({
  rule,
  onUpdate,
  t,
}: {
  rule: AudienceFilterRule;
  onUpdate: (patch: Partial<AudienceFilterRule>) => void;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  // Operators that don't need a value
  if (rule.op === "exists" || rule.op === "not_exists") {
    return <div className="text-[11px] text-gray-400 px-2 py-2 italic">—</div>;
  }
  const type = (rule.fieldType || "string").toLowerCase();

  if (rule.op === "in_last_days") {
    return (
      <input
        type="number"
        min={1}
        value={rule.value ?? ""}
        onChange={(e) => onUpdate({ value: e.target.value })}
        placeholder={t("outbound.broadcasts.valueDaysPlaceholder")}
        className="w-full px-2.5 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none transition"
      />
    );
  }
  if (type === "date" || type === "datetime") {
    return (
      <input
        type="date"
        value={rule.value ?? ""}
        onChange={(e) => onUpdate({ value: e.target.value })}
        className="w-full px-2.5 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none transition"
      />
    );
  }
  if ((type === "picklist" || type === "multipicklist") && rule.picklist?.length) {
    if (rule.op === "in" || rule.op === "not_in") {
      // Multi-select
      const arr: string[] = Array.isArray(rule.value) ? rule.value : [];
      return (
        <select
          multiple
          value={arr}
          onChange={(e) => {
            const next = Array.from(e.target.selectedOptions).map((o) => o.value);
            onUpdate({ value: next });
          }}
          className="w-full px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 outline-none"
        >
          {rule.picklist.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    return (
      <select
        value={rule.value ?? ""}
        onChange={(e) => onUpdate({ value: e.target.value })}
        className="w-full px-2.5 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 outline-none transition"
      >
        <option value="">—</option>
        {rule.picklist.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  if (type === "number" || type === "currency") {
    return (
      <input
        type="number"
        value={rule.value ?? ""}
        onChange={(e) => onUpdate({ value: e.target.value })}
        className="w-full px-2.5 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none transition"
      />
    );
  }
  if (type === "boolean") {
    return (
      <select
        value={String(rule.value ?? "true")}
        onChange={(e) => onUpdate({ value: e.target.value === "true" })}
        className="w-full px-2.5 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 outline-none transition"
      >
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }
  return (
    <input
      type="text"
      value={rule.value ?? ""}
      onChange={(e) => onUpdate({ value: e.target.value })}
      className="w-full px-2.5 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 outline-none transition"
    />
  );
}

// ─── Import section ───────────────────────────────────────────

function ImportSection({
  value,
  onChange,
  t,
}: {
  value: string;
  onChange: (v: string) => void;
  t: (k: string) => string;
}) {
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split("\n").map((l) => l.split(",")[0].trim()).filter(Boolean);
      onChange(lines.join("\n"));
    };
    reader.readAsText(file);
  }

  return (
    <section className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">{t("outbound.broadcasts.modeImport")}</h3>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={8}
        placeholder={t("outbound.broadcasts.importPlaceholder")}
        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-300 focus:bg-white outline-none transition font-mono"
      />
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) handleFile(file);
        }}
        onClick={() => fileInputRef.current?.click()}
        className={clsx(
          "border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition",
          dragOver ? "border-primary-400 bg-primary-50" : "border-gray-200 hover:border-primary-300 hover:bg-gray-50"
        )}
      >
        <p className="text-xs text-gray-400">{t("outbound.broadcasts.importDrop")}</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </div>
    </section>
  );
}

// ─── Everyone section ─────────────────────────────────────────

function EveryoneSection({ channelDisplayName, t }: { channelDisplayName: string; t: (k: string) => string }) {
  return (
    <section className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
      <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
        <p className="text-sm text-amber-700 font-medium">
          {t("outbound.broadcasts.everyoneWarning")}
        </p>
        <p className="text-xs text-amber-500 mt-1">{channelDisplayName}</p>
      </div>
    </section>
  );
}

// ─── Live count banner + preview drawer ───────────────────────

function LiveCountBanner({
  count,
  loading,
  sample,
  reasoning,
  error,
  mode,
  pickedCount,
  rulesCount,
  channelDisplayName,
  t,
}: {
  count: number | null;
  loading: boolean;
  sample: Array<{ id: string; source: "local" | "crm"; displayName?: string; phone?: string; email?: string }>;
  reasoning: string[];
  error: string | null;
  mode: AudienceMode;
  pickedCount: number;
  rulesCount: number;
  channelDisplayName: string;
  t: (k: string, vars?: Record<string, string>) => string;
}) {
  const [open, setOpen] = useState(false);
  const [showWhy, setShowWhy] = useState(false);

  const tone = count == null
    ? "neutral"
    : count === 0
      ? "warn"
      : "ok";

  const toneCls = tone === "ok"
    ? "bg-emerald-50 border-emerald-200 text-emerald-700"
    : tone === "warn"
      ? "bg-amber-50 border-amber-200 text-amber-700"
      : "bg-gray-50 border-gray-200 text-gray-500";

  const text = loading
    ? t("outbound.broadcasts.liveCountLoading")
    : error
      ? error
      : count == null
        ? t("outbound.broadcasts.audienceEmpty")
        : mode === "everyone"
          ? t("outbound.broadcasts.liveCountEverybody", { count: String(count), channel: channelDisplayName })
          : count === 0
            ? t("outbound.broadcasts.liveCountZero")
            : t("outbound.broadcasts.liveCountReady", { count: String(count) });

  // Breakdown only meaningful in smart mode with at least one input.
  const showBreakdown = mode === "smart" && (pickedCount > 0 || rulesCount > 0);

  return (
    <div className={clsx("rounded-xl border p-3 transition", toneCls)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {loading ? (
            <span className="w-3.5 h-3.5 border-2 border-current/30 border-t-current rounded-full animate-spin" />
          ) : (
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d={tone === "ok"
                  ? "M5 13l4 4L19 7"
                  : tone === "warn"
                    ? "M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z"
                    : "M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.5"}
              />
            </svg>
          )}
          <span className="text-sm font-semibold truncate">{text}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {sample.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-[11px] underline-offset-2 hover:underline opacity-80"
            >
              {open
                ? t("outbound.broadcasts.previewListHide")
                : t("outbound.broadcasts.previewListShow", { count: String(sample.length) })}
            </button>
          )}
          {reasoning.length > 0 && (
            <button
              type="button"
              onClick={() => setShowWhy((v) => !v)}
              className="text-[11px] underline-offset-2 hover:underline opacity-70"
            >
              {t("outbound.broadcasts.liveCountReason")}
            </button>
          )}
        </div>
      </div>

      {showBreakdown && (
        <div className="mt-1 text-[11px] opacity-75">
          {pickedCount > 0 && rulesCount > 0
            ? t("outbound.broadcasts.audienceBreakdownBoth", {
                picked: String(pickedCount),
                rules: String(rulesCount),
              })
            : pickedCount > 0
              ? t("outbound.broadcasts.audienceBreakdownPicked", { picked: String(pickedCount) })
              : t("outbound.broadcasts.audienceBreakdownRules", { rules: String(rulesCount) })}
        </div>
      )}

      {open && sample.length > 0 && (
        <ul className="mt-3 divide-y divide-current/10 bg-white/50 rounded-lg overflow-hidden">
          {sample.map((s) => (
            <li key={s.id} className="px-3 py-2 flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <div className="font-medium text-gray-800 truncate">{s.displayName || s.phone || s.email || s.id}</div>
                <div className="text-[11px] text-gray-500 truncate">{s.phone || s.email}</div>
              </div>
              <span
                className={clsx(
                  "shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium",
                  s.source === "crm" ? "bg-violet-100 text-violet-600" : "bg-gray-100 text-gray-600"
                )}
              >
                {s.source === "crm" ? t("outbound.broadcasts.previewListCrm") : t("outbound.broadcasts.previewListLocal")}
              </span>
            </li>
          ))}
        </ul>
      )}

      {showWhy && reasoning.length > 0 && (
        <ul className="mt-3 text-[11px] opacity-80 space-y-0.5">
          {reasoning.map((r, i) => (
            <li key={i}>• {r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Suppress unused-import warning for useCallback (kept for future hooks).
void useCallback;
