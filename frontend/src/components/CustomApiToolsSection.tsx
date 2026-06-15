"use client";

/**
 * Custom API Tools - Postman-style builder for tenant-defined HTTP tools.
 *
 * Each tool the admin defines here surfaces to the AI as `custom.<slug>` with
 * the full LLM contract (description, whenToUse, whenNotToUse, parameters).
 * The runtime in services/ai/src/services/connectors/custom-api.service.ts
 * applies domain whitelisting, secret scrubbing, timeouts, and idempotency.
 */

import { useEffect, useState } from "react";
import {
  listCustomApiTools,
  createCustomApiTool,
  updateCustomApiTool,
  deleteCustomApiTool,
  testCustomApiTool,
  type CustomApiTool,
} from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import clsx from "clsx";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const AUTH_KINDS = ["none", "bearer", "api_key", "basic"] as const;
const CATEGORIES = ["READ", "WRITE", "DELETE", "ACTION"] as const;
const RISKS = ["LOW", "MEDIUM", "HIGH"] as const;

type FormState = {
  id?: string;
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  whenNotToUse: string;
  method: typeof METHODS[number];
  urlTemplate: string;
  headersList: Array<{ key: string; value: string }>;
  bodyTemplate: string;
  authKind: typeof AUTH_KINDS[number];
  authIn: "header" | "query";
  authName: string;
  secretBearer: string;
  secretApiKey: string;
  secretBasicUser: string;
  secretBasicPass: string;
  allowedHostsCsv: string;
  parametersJson: string;
  responseFieldsCsv: string;
  category: typeof CATEGORIES[number];
  riskLevel: typeof RISKS[number];
  timeoutMs: number;
  isActive: boolean;
};

const EMPTY: FormState = {
  slug: "",
  name: "",
  description: "",
  whenToUse: "",
  whenNotToUse: "",
  method: "GET",
  urlTemplate: "",
  headersList: [{ key: "", value: "" }],
  bodyTemplate: "",
  authKind: "none",
  authIn: "header",
  authName: "",
  secretBearer: "",
  secretApiKey: "",
  secretBasicUser: "",
  secretBasicPass: "",
  allowedHostsCsv: "",
  parametersJson: '{\n  "type": "object",\n  "properties": {\n    "id": { "type": "string", "description": "..." }\n  },\n  "required": ["id"]\n}',
  responseFieldsCsv: "",
  category: "READ",
  riskLevel: "MEDIUM",
  timeoutMs: 10000,
  isActive: true,
};

export default function CustomApiToolsSection() {
  const { token } = useAuth();
  const [tools, setTools] = useState<CustomApiTool[]>([]);
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
      const r = await listCustomApiTools(token);
      setTools(r.data || []);
    } catch {
      setTools([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [token]);

  function openNew() {
    setEditing({ ...EMPTY });
    setError(null);
    setTestResult(null);
    setTestArgsJson("{}");
  }

  function openEdit(t: CustomApiTool) {
    const headersList = Object.entries(t.headers || {}).map(([key, value]) => ({ key, value: String(value) }));
    setEditing({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description,
      whenToUse: t.whenToUse,
      whenNotToUse: t.whenNotToUse || "",
      method: t.method,
      urlTemplate: t.urlTemplate,
      headersList: headersList.length ? headersList : [{ key: "", value: "" }],
      bodyTemplate: t.bodyTemplate || "",
      authKind: (t.auth?.kind || "none") as any,
      authIn: (t.auth?.in || "header") as any,
      authName: t.auth?.name || "",
      // Secrets are server-side; we don't echo them. The user can re-paste to update.
      secretBearer: "",
      secretApiKey: "",
      secretBasicUser: "",
      secretBasicPass: "",
      allowedHostsCsv: (t.allowedHosts || []).join(", "),
      parametersJson: JSON.stringify(t.parameters || {}, null, 2),
      responseFieldsCsv: (t.responseFields || []).join(", "),
      category: t.category,
      riskLevel: t.riskLevel,
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
    const headers: Record<string, string> = {};
    for (const { key, value } of s.headersList) {
      if (key.trim() && value !== "") headers[key.trim()] = value;
    }
    let parameters: any = {};
    try {
      parameters = JSON.parse(s.parametersJson || "{}");
    } catch (e: any) {
      throw new Error(`Parameters JSON is invalid: ${e?.message}`);
    }
    const allowedHosts = s.allowedHostsCsv.split(",").map((x) => x.trim()).filter(Boolean);
    if (!allowedHosts.length) throw new Error("Allowed hosts is required (at least one hostname)");
    const responseFields = s.responseFieldsCsv.split(",").map((x) => x.trim()).filter(Boolean);
    const auth: any = { kind: s.authKind };
    if (s.authKind === "api_key") {
      auth.in = s.authIn;
      auth.name = s.authName || "X-API-Key";
    }
    const secrets: Record<string, string> = {};
    if (s.authKind === "bearer" && s.secretBearer) secrets.bearer = s.secretBearer;
    if (s.authKind === "api_key" && s.secretApiKey) secrets.apiKey = s.secretApiKey;
    if (s.authKind === "basic") {
      if (s.secretBasicUser) secrets.basicUser = s.secretBasicUser;
      if (s.secretBasicPass) secrets.basicPass = s.secretBasicPass;
    }
    const payload: any = {
      slug: s.slug.trim(),
      name: s.name.trim(),
      description: s.description.trim(),
      whenToUse: s.whenToUse.trim(),
      whenNotToUse: s.whenNotToUse.trim() || null,
      method: s.method,
      urlTemplate: s.urlTemplate.trim(),
      headers,
      auth,
      parameters,
      bodyTemplate: s.bodyTemplate || null,
      responseFields: responseFields.length ? responseFields : null,
      allowedHosts,
      category: s.category,
      riskLevel: s.riskLevel,
      isActive: s.isActive,
      timeoutMs: Number(s.timeoutMs) || 10000,
    };
    // Only send `secrets` when at least one field is filled - preserves existing
    // server-side secrets when editing without re-entering them.
    if (Object.keys(secrets).length > 0) payload.secrets = secrets;
    return payload;
  }

  async function handleSave() {
    if (!token || !editing) return;
    setError(null);
    setSaving(true);
    try {
      const payload = buildPayload(editing);
      if (editing.id) {
        await updateCustomApiTool(token, editing.id, payload);
      } else {
        await createCustomApiTool(token, payload);
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
    if (!confirm("Delete this tool? This action cannot be undone.")) return;
    try {
      await deleteCustomApiTool(token, id);
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
      const r = await testCustomApiTool(token, editing.id, args);
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
          <h2 className="font-semibold text-gray-900">Custom Tools</h2>
          <p className="text-xs text-gray-500 mt-0.5">Define your own HTTP tools the AI can call. Each tool is one API request with a name, description, and parameters.</p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add tool
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <div className="w-6 h-6 border-2 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
        </div>
      ) : tools.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">No custom tools yet - click <strong>Add tool</strong> to create your first.</p>
      ) : (
        <div className="space-y-2">
          {tools.map((t) => (
            <div key={t.id} className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 hover:border-violet-200 hover:bg-violet-50/30 transition">
              <span className={clsx("text-xs font-mono font-bold px-2 py-1 rounded", METHOD_COLORS[t.method])}>{t.method}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm text-gray-900">{t.name}</span>
                  <span className="text-xs font-mono text-gray-400">custom.{t.slug}</span>
                  {!t.isActive && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">DISABLED</span>}
                  <span className={clsx("text-[10px] px-1.5 py-0.5 rounded", RISK_COLORS[t.riskLevel])}>{t.riskLevel}</span>
                </div>
                <p className="text-xs text-gray-500 truncate">{t.urlTemplate}</p>
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
              <h3 className="font-semibold text-gray-900">{editing.id ? "Edit tool" : "New custom API tool"}</h3>
              <button onClick={close} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>
            <div className="p-6 space-y-5">
              {/* Identity */}
              <Section title="Identity" subtitle="What this tool is and when the AI should use it.">
                <Field label="Name" required>
                  <input className={INPUT_CLS} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Lookup order by id" />
                </Field>
                <Field label="Slug" required help="Tool will be exposed to the AI as `custom.<slug>`. Lowercase, no spaces.">
                  <input className={INPUT_CLS} value={editing.slug} onChange={(e) => setEditing({ ...editing, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} placeholder="lookup_order" disabled={!!editing.id} />
                </Field>
                <Field label="Description" required help="Short - what the tool does.">
                  <textarea className={INPUT_CLS} rows={2} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="Look up an order in our internal API." />
                </Field>
                <Field label="When to use" required help="Plain English: 'Use this tool when ...'. The AI reads this to decide.">
                  <textarea className={INPUT_CLS} rows={2} value={editing.whenToUse} onChange={(e) => setEditing({ ...editing, whenToUse: e.target.value })} placeholder="When the customer asks about a specific order id." />
                </Field>
                <Field label="When NOT to use" help="Optional guardrail: 'Do NOT use this when ...'.">
                  <textarea className={INPUT_CLS} rows={2} value={editing.whenNotToUse} onChange={(e) => setEditing({ ...editing, whenNotToUse: e.target.value })} placeholder="When the customer hasn't given an order id." />
                </Field>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Category">
                    <select className={INPUT_CLS} value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value as any })}>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>
                  <Field label="Risk level">
                    <select className={INPUT_CLS} value={editing.riskLevel} onChange={(e) => setEditing({ ...editing, riskLevel: e.target.value as any })}>
                      {RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </Field>
                  <Field label="Timeout (ms)">
                    <input type="number" className={INPUT_CLS} value={editing.timeoutMs} onChange={(e) => setEditing({ ...editing, timeoutMs: Number(e.target.value) })} />
                  </Field>
                </div>
              </Section>

              {/* Request */}
              <Section title="Request" subtitle="The actual HTTP call. Use {{name}} placeholders to substitute params.">
                <div className="grid grid-cols-[110px_1fr] gap-2">
                  <select className={INPUT_CLS} value={editing.method} onChange={(e) => setEditing({ ...editing, method: e.target.value as any })}>
                    {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input className={INPUT_CLS} value={editing.urlTemplate} onChange={(e) => setEditing({ ...editing, urlTemplate: e.target.value })} placeholder="https://api.example.com/orders/{{order_id}}" />
                </div>
                <Field label="Allowed hosts" required help="Comma-separated hostnames the URL is allowed to resolve to (e.g. api.example.com). Anything else is blocked.">
                  <input className={INPUT_CLS} value={editing.allowedHostsCsv} onChange={(e) => setEditing({ ...editing, allowedHostsCsv: e.target.value })} placeholder="api.example.com" />
                </Field>

                <Field label="Headers">
                  <div className="space-y-1.5">
                    {editing.headersList.map((h, i) => (
                      <div key={i} className="flex gap-2">
                        <input className={INPUT_CLS + " w-1/3"} value={h.key} onChange={(e) => {
                          const list = [...editing.headersList];
                          list[i] = { ...list[i], key: e.target.value };
                          setEditing({ ...editing, headersList: list });
                        }} placeholder="X-Custom-Header" />
                        <input className={INPUT_CLS + " flex-1"} value={h.value} onChange={(e) => {
                          const list = [...editing.headersList];
                          list[i] = { ...list[i], value: e.target.value };
                          setEditing({ ...editing, headersList: list });
                        }} placeholder="value (use {{arg}} to interpolate)" />
                        <button type="button" onClick={() => {
                          const list = editing.headersList.filter((_, j) => j !== i);
                          setEditing({ ...editing, headersList: list.length ? list : [{ key: "", value: "" }] });
                        }} className="px-2 text-gray-400 hover:text-red-500">×</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => setEditing({ ...editing, headersList: [...editing.headersList, { key: "", value: "" }] })} className="text-xs text-violet-600 hover:underline">+ Add header</button>
                  </div>
                </Field>

                {editing.method !== "GET" && editing.method !== "DELETE" && (
                  <Field label="Body template" help="Plain JSON or text. Use {{name}} placeholders. Leave blank to send the args as JSON body.">
                    <textarea rows={5} className={INPUT_CLS + " font-mono text-xs"} value={editing.bodyTemplate} onChange={(e) => setEditing({ ...editing, bodyTemplate: e.target.value })} placeholder='{"id": "{{id}}"}' />
                  </Field>
                )}
              </Section>

              {/* Auth */}
              <Section title="Authentication" subtitle="Credentials are encrypted at rest and never logged.">
                <Field label="Auth type">
                  <select className={INPUT_CLS} value={editing.authKind} onChange={(e) => setEditing({ ...editing, authKind: e.target.value as any })}>
                    {AUTH_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </Field>
                {editing.authKind === "bearer" && (
                  <Field label="Bearer token" help={editing.id ? "Leave blank to keep the existing token." : ""}>
                    <input type="password" className={INPUT_CLS} value={editing.secretBearer} onChange={(e) => setEditing({ ...editing, secretBearer: e.target.value })} placeholder="••••••••" />
                  </Field>
                )}
                {editing.authKind === "api_key" && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Send key in">
                        <select className={INPUT_CLS} value={editing.authIn} onChange={(e) => setEditing({ ...editing, authIn: e.target.value as any })}>
                          <option value="header">Header</option>
                          <option value="query">Query string</option>
                        </select>
                      </Field>
                      <Field label="Key name">
                        <input className={INPUT_CLS} value={editing.authName} onChange={(e) => setEditing({ ...editing, authName: e.target.value })} placeholder="X-API-Key" />
                      </Field>
                    </div>
                    <Field label="API key" help={editing.id ? "Leave blank to keep the existing key." : ""}>
                      <input type="password" className={INPUT_CLS} value={editing.secretApiKey} onChange={(e) => setEditing({ ...editing, secretApiKey: e.target.value })} placeholder="••••••••" />
                    </Field>
                  </>
                )}
                {editing.authKind === "basic" && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Username">
                      <input className={INPUT_CLS} value={editing.secretBasicUser} onChange={(e) => setEditing({ ...editing, secretBasicUser: e.target.value })} />
                    </Field>
                    <Field label="Password" help={editing.id ? "Leave blank to keep existing." : ""}>
                      <input type="password" className={INPUT_CLS} value={editing.secretBasicPass} onChange={(e) => setEditing({ ...editing, secretBasicPass: e.target.value })} placeholder="••••••••" />
                    </Field>
                  </div>
                )}
              </Section>

              {/* Schema */}
              <Section title="Parameters schema" subtitle="JSON Schema (OpenAI function-calling shape) describing the args the AI passes in.">
                <textarea rows={8} className={INPUT_CLS + " font-mono text-xs"} value={editing.parametersJson} onChange={(e) => setEditing({ ...editing, parametersJson: e.target.value })} />
                <Field label="Response fields" help="Optional - comma-separated dotted paths to project from the response. Empty returns the full body.">
                  <input className={INPUT_CLS} value={editing.responseFieldsCsv} onChange={(e) => setEditing({ ...editing, responseFieldsCsv: e.target.value })} placeholder="data.id, data.status, data.total" />
                </Field>
              </Section>

              {/* Test runner */}
              {editing.id && (
                <Section title="Test" subtitle="Fire the actual request with sample args. Status + body shown below.">
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
                  {saving ? "Saving…" : (editing.id ? "Save changes" : "Create tool")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

const INPUT_CLS =
  "w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-300 focus:bg-white outline-none transition";

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-blue-100 text-blue-700",
  POST: "bg-green-100 text-green-700",
  PUT: "bg-yellow-100 text-yellow-700",
  PATCH: "bg-orange-100 text-orange-700",
  DELETE: "bg-red-100 text-red-700",
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
