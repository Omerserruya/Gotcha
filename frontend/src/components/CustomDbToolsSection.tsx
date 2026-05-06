"use client";

/**
 * Custom DB Query Tools — admin-defined parameterized SQL / Mongo queries the
 * AI can call as `custom_db.<slug>`. Safer than the generic CRUD tools because
 * the admin pre-defines the exact query shape; the AI only fills in named
 * parameters that match `parameterSchema`.
 */

import { useEffect, useState } from "react";
import {
  listCustomDbTools,
  createCustomDbTool,
  updateCustomDbTool,
  deleteCustomDbTool,
  testCustomDbTool,
  type CustomDbQueryTool,
} from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import clsx from "clsx";

const CATEGORIES = ["READ", "WRITE", "DELETE", "ACTION"] as const;
const RISKS = ["LOW", "MEDIUM", "HIGH"] as const;

interface FormState {
  id?: string;
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  whenNotToUse: string;
  queryTemplate: string;
  parameterSchemaJson: string;
  parameterOrderCsv: string;
  category: typeof CATEGORIES[number];
  riskLevel: typeof RISKS[number];
  maxRows: number;
  timeoutMs: number;
  isActive: boolean;
}

const TEMPLATES_BY_PROVIDER: Record<string, { sample: string; schema: string; order: string }> = {
  postgresql: {
    sample: "SELECT id, email, total\nFROM orders\nWHERE buyer_email = $1\n  AND created_at >= $2\nORDER BY created_at DESC",
    schema: '{\n  "type": "object",\n  "properties": {\n    "buyer_email": { "type": "string", "description": "Customer email" },\n    "since": { "type": "string", "description": "ISO date — orders since this date" }\n  },\n  "required": ["buyer_email"]\n}',
    order: "buyer_email, since",
  },
  aws_rds: {
    sample: "SELECT id, email, total\nFROM orders\nWHERE buyer_email = $1\n  AND created_at >= $2\nORDER BY created_at DESC",
    schema: '{\n  "type": "object",\n  "properties": {\n    "buyer_email": { "type": "string", "description": "Customer email" },\n    "since": { "type": "string", "description": "ISO date" }\n  },\n  "required": ["buyer_email"]\n}',
    order: "buyer_email, since",
  },
  mongodb: {
    sample: '{\n  "op": "find",\n  "collection": "orders",\n  "filter": { "buyerEmail": "{{buyer_email}}" },\n  "sort": { "createdAt": -1 }\n}',
    schema: '{\n  "type": "object",\n  "properties": {\n    "buyer_email": { "type": "string", "description": "Customer email" }\n  },\n  "required": ["buyer_email"]\n}',
    order: "",
  },
};

const PROVIDER_LABELS: Record<string, string> = {
  postgresql: "PostgreSQL",
  mongodb: "MongoDB",
  aws_rds: "AWS RDS",
};

export default function CustomDbToolsSection({ providerSlug }: { providerSlug: "postgresql" | "mongodb" | "aws_rds" }) {
  const { token } = useAuth();
  const [tools, setTools] = useState<CustomDbQueryTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testArgsJson, setTestArgsJson] = useState("{}");
  const [testResult, setTestResult] = useState<any>(null);
  const [testRunning, setTestRunning] = useState(false);

  async function load() {
    if (!token) return;
    setLoading(true);
    try {
      const r = await listCustomDbTools(token, { provider: providerSlug });
      setTools(r.data || []);
    } catch {
      setTools([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [token, providerSlug]);

  function openNew() {
    const template = TEMPLATES_BY_PROVIDER[providerSlug] || TEMPLATES_BY_PROVIDER.postgresql;
    setEditing({
      slug: "",
      name: "",
      description: "",
      whenToUse: "",
      whenNotToUse: "",
      queryTemplate: template.sample,
      parameterSchemaJson: template.schema,
      parameterOrderCsv: template.order,
      category: "READ",
      riskLevel: "LOW",
      maxRows: 100,
      timeoutMs: 5000,
      isActive: true,
    });
    setError(null);
    setTestResult(null);
    setTestArgsJson('{\n  "buyer_email": "alice@example.com"\n}');
  }

  function openEdit(t: CustomDbQueryTool) {
    setEditing({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description,
      whenToUse: t.whenToUse,
      whenNotToUse: t.whenNotToUse || "",
      queryTemplate: t.queryTemplate,
      parameterSchemaJson: JSON.stringify(t.parameterSchema || {}, null, 2),
      parameterOrderCsv: (t.parameterOrder || []).join(", "),
      category: t.category,
      riskLevel: t.riskLevel,
      maxRows: t.maxRows,
      timeoutMs: t.timeoutMs,
      isActive: t.isActive,
    });
    setError(null);
    setTestResult(null);
  }

  function close() {
    setEditing(null);
    setError(null);
    setTestResult(null);
  }

  function buildPayload(s: FormState) {
    let parameterSchema: any = {};
    try {
      parameterSchema = JSON.parse(s.parameterSchemaJson || "{}");
    } catch (e: any) {
      throw new Error(`Parameter schema JSON invalid: ${e?.message}`);
    }
    const parameterOrder = s.parameterOrderCsv.split(",").map((x) => x.trim()).filter(Boolean);
    return {
      providerSlug,
      slug: s.slug.trim(),
      name: s.name.trim(),
      description: s.description.trim(),
      whenToUse: s.whenToUse.trim(),
      whenNotToUse: s.whenNotToUse.trim() || null,
      queryTemplate: s.queryTemplate,
      parameterSchema,
      parameterOrder,
      category: s.category,
      riskLevel: s.riskLevel,
      maxRows: Number(s.maxRows) || 100,
      timeoutMs: Number(s.timeoutMs) || 5000,
      isActive: s.isActive,
    };
  }

  async function handleSave() {
    if (!token || !editing) return;
    setError(null);
    setSaving(true);
    try {
      const payload = buildPayload(editing);
      if (editing.id) {
        await updateCustomDbTool(token, editing.id, payload);
      } else {
        await createCustomDbTool(token, payload);
      }
      await load();
      close();
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!token) return;
    if (!confirm("Delete this query tool?")) return;
    try {
      await deleteCustomDbTool(token, id);
      await load();
    } catch {
      // ignore
    }
  }

  async function handleTest() {
    if (!token || !editing?.id) {
      setError("Save the tool before testing.");
      return;
    }
    setTestRunning(true);
    setTestResult(null);
    try {
      const args = JSON.parse(testArgsJson || "{}");
      const r = await testCustomDbTool(token, editing.id, args);
      setTestResult(r);
    } catch (e: any) {
      setTestResult({ ok: false, reason: e?.message || "test failed" });
    } finally {
      setTestRunning(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-semibold text-gray-900">Custom Queries</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Pre-canned {PROVIDER_LABELS[providerSlug]} queries the AI can call. Safer than generic table CRUD — you define the shape, the AI fills in parameters.
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add query
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <div className="w-6 h-6 border-2 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
        </div>
      ) : tools.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">No custom queries yet — click <strong>Add query</strong> to define one.</p>
      ) : (
        <div className="space-y-2">
          {tools.map((t) => (
            <div key={t.id} className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 hover:border-violet-200 hover:bg-violet-50/30 transition">
              <span className={clsx("text-xs font-mono font-bold px-2 py-1 rounded", CATEGORY_COLORS[t.category])}>{t.category}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm text-gray-900">{t.name}</span>
                  <span className="text-xs font-mono text-gray-400">custom_db.{t.slug}</span>
                  {!t.isActive && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">DISABLED</span>}
                  <span className={clsx("text-[10px] px-1.5 py-0.5 rounded", RISK_COLORS[t.riskLevel])}>{t.riskLevel}</span>
                </div>
                <p className="text-xs text-gray-500 truncate font-mono">{t.queryTemplate.split("\n")[0]}</p>
              </div>
              <button onClick={() => openEdit(t)} className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 hover:bg-gray-50">Edit</button>
              <button onClick={() => handleDelete(t.id)} className="px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-600 hover:bg-red-50">Delete</button>
            </div>
          ))}
        </div>
      )}

      {/* Editor modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">{editing.id ? "Edit query" : `New ${PROVIDER_LABELS[providerSlug]} query`}</h3>
              <button onClick={close} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>
            <div className="p-6 space-y-5">
              <Section title="Identity">
                <Field label="Name" required>
                  <input className={INPUT_CLS} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Find orders for customer email" />
                </Field>
                <Field label="Slug" required help="Tool exposed as `custom_db.<slug>`. Lowercase, no spaces.">
                  <input className={INPUT_CLS} value={editing.slug} onChange={(e) => setEditing({ ...editing, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} disabled={!!editing.id} placeholder="find_orders_by_email" />
                </Field>
                <Field label="Description" required>
                  <textarea className={INPUT_CLS} rows={2} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="Look up recent orders for a given customer email." />
                </Field>
                <Field label="When to use" required>
                  <textarea className={INPUT_CLS} rows={2} value={editing.whenToUse} onChange={(e) => setEditing({ ...editing, whenToUse: e.target.value })} placeholder="When the customer asks about their order history." />
                </Field>
                <Field label="When NOT to use" help="Optional guardrail.">
                  <textarea className={INPUT_CLS} rows={2} value={editing.whenNotToUse} onChange={(e) => setEditing({ ...editing, whenNotToUse: e.target.value })} placeholder="When you don't have a verified customer email." />
                </Field>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Category">
                    <select className={INPUT_CLS} value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value as any })}>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>
                  <Field label="Risk">
                    <select className={INPUT_CLS} value={editing.riskLevel} onChange={(e) => setEditing({ ...editing, riskLevel: e.target.value as any })}>
                      {RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </Field>
                  <Field label="Max rows">
                    <input type="number" className={INPUT_CLS} value={editing.maxRows} onChange={(e) => setEditing({ ...editing, maxRows: Number(e.target.value) })} />
                  </Field>
                </div>
              </Section>

              <Section title="Query" subtitle={
                providerSlug === "mongodb"
                  ? "JSON object with op (find/findOne/insertOne/updateOne/deleteOne), collection, filter, etc. Use {{paramName}} for substitution."
                  : "SQL with $1, $2 … placeholders. The AI fills in args in parameterOrder."
              }>
                <textarea rows={10} className={INPUT_CLS + " font-mono text-xs"} value={editing.queryTemplate} onChange={(e) => setEditing({ ...editing, queryTemplate: e.target.value })} />
              </Section>

              <Section title="Parameters" subtitle="JSON schema describing the args the AI passes in.">
                <textarea rows={8} className={INPUT_CLS + " font-mono text-xs"} value={editing.parameterSchemaJson} onChange={(e) => setEditing({ ...editing, parameterSchemaJson: e.target.value })} />
                {providerSlug !== "mongodb" && (
                  <Field label="Parameter order (for $1, $2 …)" help="Comma-separated property names matching the SQL placeholders' numeric order.">
                    <input className={INPUT_CLS} value={editing.parameterOrderCsv} onChange={(e) => setEditing({ ...editing, parameterOrderCsv: e.target.value })} placeholder="buyer_email, since" />
                  </Field>
                )}
              </Section>

              {editing.id && (
                <Section title="Test" subtitle="Fire the actual query with sample args.">
                  <Field label="Sample args (JSON)">
                    <textarea rows={4} className={INPUT_CLS + " font-mono text-xs"} value={testArgsJson} onChange={(e) => setTestArgsJson(e.target.value)} />
                  </Field>
                  <button onClick={handleTest} disabled={testRunning} className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 disabled:opacity-50">
                    {testRunning ? "Running…" : "Run test"}
                  </button>
                  {testResult && (
                    <pre className={clsx("mt-3 p-3 rounded-lg text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto",
                      testResult.ok ? "bg-green-50 text-green-900" : "bg-red-50 text-red-900",
                    )}>
                      {JSON.stringify(testResult, null, 2)}
                    </pre>
                  )}
                </Section>
              )}

              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>

            <div className="sticky bottom-0 bg-white border-t border-gray-100 px-6 py-3 flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} className="rounded text-violet-600" />
                Active (exposed to AI)
              </label>
              <div className="flex items-center gap-2">
                <button onClick={close} className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:bg-gray-50">Cancel</button>
                <button onClick={handleSave} disabled={saving} className="px-5 py-2 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium disabled:opacity-50">
                  {saving ? "Saving…" : (editing.id ? "Save changes" : "Create query")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const INPUT_CLS = "w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition";

const CATEGORY_COLORS: Record<string, string> = {
  READ: "bg-blue-100 text-blue-700",
  WRITE: "bg-violet-100 text-violet-700",
  DELETE: "bg-red-100 text-red-700",
  ACTION: "bg-orange-100 text-orange-700",
};

const RISK_COLORS: Record<string, string> = {
  LOW: "bg-green-100 text-green-700",
  MEDIUM: "bg-yellow-100 text-yellow-700",
  HIGH: "bg-red-100 text-red-700",
};

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 pb-4 border-b border-gray-100 last:border-b-0 last:pb-0">
      <div>
        <h4 className="text-sm font-semibold text-gray-900">{title}</h4>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, help, required, children }: { label: string; help?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      {children}
      {help && <p className="text-xs text-gray-400 mt-1">{help}</p>}
    </div>
  );
}
