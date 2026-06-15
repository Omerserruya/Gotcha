"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";

/**
 * Variable-insert dropdown for broadcast / template message bodies.
 *
 * Loads field definitions from `/api/audiences/schema?module=leads` -
 * which returns:
 *   - local Contact fields (always)
 *   - CRM fields when a CRM is connected (Zoho/HubSpot/Salesforce)
 *
 * Operator picks a field; we emit a `{Field_Api_Name}` token via
 * `onInsert`. The send-time renderer is responsible for substituting
 * the token from the recipient's data on the audience-resolve pass.
 *
 * Renders nothing if the schema endpoint returns no fields (defensive
 * - keeps the broadcast composer clean in degraded states).
 */
interface CrmField {
  name: string;
  label: string;
  type: string;
}

interface SchemaResponse {
  data: {
    module: string;
    local: { fields: CrmField[]; scope: string };
    crm:
      | { connected: false }
      | {
          connected: true;
          provider: { slug: string; name: string };
          schema: { module: string; providerModule: string; fields: CrmField[] } | null;
        };
  };
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export type CrmVarPickerModule = "leads" | "contacts" | "accounts" | "deals";

export function CrmVarPicker({
  onInsert,
  module = "leads",
}: {
  onInsert: (token: string) => void;
  /** Which CRM module's field schema to pull. Pair with the audience
   *  builder's module so vars match what the rules will resolve against. */
  module?: CrmVarPickerModule;
}) {
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [local, setLocal] = useState<CrmField[]>([]);
  const [crm, setCrm] = useState<{ providerName: string; fields: CrmField[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setErr(null);
    fetch(`${API_URL}/api/audiences/schema?module=${encodeURIComponent(module)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => (r.ok ? (r.json() as Promise<SchemaResponse>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((res) => {
        const data = res.data;
        setLocal(data.local?.fields ?? []);
        if (data.crm.connected && data.crm.schema?.fields?.length) {
          setCrm({
            providerName: data.crm.provider.name,
            fields: data.crm.schema.fields,
          });
        } else if (data.crm.connected && !data.crm.schema) {
          setErr(
            `${(data.crm as any).provider?.name || "CRM"} connected, but the schema endpoint isn't authorised yet - reconnect from Settings → Integrations to grant the required scope.`,
          );
          setCrm(null);
        } else {
          setCrm(null);
        }
      })
      .catch((e) => setErr(e?.message ?? "schema load failed"))
      .finally(() => setLoading(false));
  }, [token, module]);

  const totalFields = local.length + (crm?.fields.length ?? 0);
  if (totalFields === 0 && !err) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
        Insert variable
        {loading && <span className="ml-1 opacity-60">…</span>}
        {!loading && totalFields > 0 && (
          <span className="ml-1 opacity-60">({totalFields})</span>
        )}
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-80 max-h-80 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg p-2">
          {err && (
            <div className="px-3 py-2 text-[11px] text-amber-700 bg-amber-50 rounded-md mb-2">
              {err}
            </div>
          )}

          {local.length > 0 && (
            <>
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Platform fields
              </div>
              {local.map((f) => (
                <FieldRow
                  key={`local:${f.name}`}
                  field={f}
                  onPick={() => {
                    onInsert(`{${f.name}}`);
                    setOpen(false);
                  }}
                />
              ))}
            </>
          )}

          {crm && crm.fields.length > 0 && (
            <>
              <div className="px-2 py-1 mt-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                {crm.providerName} fields
              </div>
              {crm.fields.map((f) => (
                <FieldRow
                  key={`crm:${f.name}`}
                  field={f}
                  onPick={() => {
                    onInsert(`{${f.name}}`);
                    setOpen(false);
                  }}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FieldRow({ field, onPick }: { field: CrmField; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="w-full text-left px-3 py-1.5 text-sm rounded-md hover:bg-violet-50 flex items-center justify-between gap-2"
      title={field.name}
    >
      <span className="truncate">
        <span className="font-medium text-gray-900">{field.label}</span>
        <span className="ml-2 text-[10px] font-mono text-gray-400">{`{${field.name}}`}</span>
      </span>
      <span className="text-[10px] uppercase text-gray-400 shrink-0">{field.type}</span>
    </button>
  );
}
