/**
 * Airtable adapter - production-grade.
 *
 * Auth: Personal Access Token (PAT). The user generates one at
 * airtable.com/create/tokens with scopes: data.records:read,
 * data.records:write, schema.bases:read. We accept the PAT as `apiKey`
 * in credentials. No refresh - PATs are long-lived.
 *
 * Setup flow (admin UI calls these helpers indirectly):
 *   1. List bases → user picks the base.
 *   2. List tables in that base → user picks the table.
 *   3. We persist `config = { baseId, tableId, tableName }`.
 *
 * Tools (most-used patterns for support + sales bots):
 *   - airtable.list_records   - query records (filterByFormula optional)
 *   - airtable.get_record     - by id
 *   - airtable.create_record  - single record
 *   - airtable.update_record  - patch fields by id
 */

import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";

const AIRTABLE_API = "https://api.airtable.com/v0";

const TOOLS: ToolDefinition[] = [
  {
    name: "airtable.list_records",
    description: "List records from the configured Airtable table.",
    whenToUse: "You need to find rows by criteria - e.g. all records where a field equals a value.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        filter_formula: { type: "string", description: "Airtable formula, e.g. {Email}='x@y.com'" },
        max_records: { type: "number", description: "Default 20, max 100." },
        fields: { type: "array", items: { type: "string" }, description: "Optional whitelist of field names." },
      },
    },
  },
  {
    name: "airtable.get_record",
    description: "Get a single Airtable record by id.",
    whenToUse: "You already have a record id (rec…) and need its fields.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        record_id: { type: "string" },
      },
      required: ["record_id"],
    },
  },
  {
    name: "airtable.create_record",
    description: "Create a single record in the configured Airtable table.",
    whenToUse: "Adding a new lead/order/ticket row to the configured table.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Inserts a row visible to all base collaborators.",
    parameters: {
      type: "object",
      properties: {
        fields: { type: "object", description: "Map of field name → value." },
      },
      required: ["fields"],
    },
  },
  {
    name: "airtable.describe_fields",
    description: "List the columns of the configured Airtable table (name, type, select options).",
    whenToUse: "You need to know which fields exist before filtering, creating or mapping records.",
    category: "READ",
    riskLevel: "LOW",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "airtable.update_record",
    description: "Patch fields on an existing Airtable record.",
    whenToUse: "Updating status/notes on a known record.",
    category: "WRITE",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        record_id: { type: "string" },
        fields: { type: "object", description: "Fields to patch." },
      },
      required: ["record_id", "fields"],
    },
  },
];

const AirtableAdapter: ProviderAdapter = {
  slug: "airtable",
  tools: () => TOOLS,

  async execute({ toolName, args, credentials, config }) {
    const apiKey = credentials.apiKey || credentials.accessToken;
    const baseId = config.baseId;
    const tableId = config.tableId || config.tableName;
    if (!apiKey) throw new Error("no_airtable_pat");
    if (!baseId || !tableId) throw new Error("airtable_base_or_table_not_selected");

    const tableUrl = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableId)}`;
    switch (toolName) {
      case "list_records": {
        const params = new URLSearchParams();
        if (args.filter_formula) params.set("filterByFormula", String(args.filter_formula));
        params.set("maxRecords", String(Math.min(100, Number(args.max_records ?? 20))));
        if (Array.isArray(args.fields)) {
          for (const f of args.fields) params.append("fields[]", String(f));
        }
        const r: any = await airtable(apiKey, "GET", `${tableUrl}?${params}`);
        return (r.records || []).map((rec: any) => ({ id: rec.id, fields: rec.fields }));
      }
      case "describe_fields": {
        // The table's live column schema - powers the audience builder's
        // field picker and template-variable mapping, the same way
        // hubspot.describe_fields does for HubSpot.
        const r: any = await airtable(apiKey, "GET", `${AIRTABLE_API}/meta/bases/${baseId}/tables`);
        const table = (r.tables || []).find((t: any) => t.id === tableId || t.name === tableId);
        return (table?.fields || []).map((f: any) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          choices: Array.isArray(f.options?.choices)
            ? f.options.choices.map((c: any) => String(c.name ?? "")).filter(Boolean)
            : undefined,
        }));
      }
      case "get_record": {
        const r: any = await airtable(apiKey, "GET", `${tableUrl}/${encodeURIComponent(String(args.record_id))}`);
        return { id: r.id, fields: r.fields };
      }
      case "create_record": {
        const r: any = await airtable(apiKey, "POST", tableUrl, {
          records: [{ fields: args.fields }],
        });
        return r.records?.[0] ?? null;
      }
      case "update_record": {
        const r: any = await airtable(apiKey, "PATCH", tableUrl, {
          records: [{ id: String(args.record_id), fields: args.fields }],
        });
        return r.records?.[0] ?? null;
      }
      default:
        throw new Error(`unknown_airtable_tool:${toolName}`);
    }
  },

  // OAuth2 token refresh (Airtable access tokens are short-lived; refresh
  // tokens rotate on use). PAT connections have no refreshToken and never
  // reach here - the framework only refreshes when expiresAt is set + passed.
  async refreshTokens(credentials) {
    const clientId = process.env.AIRTABLE_CLIENT_ID;
    const clientSecret = process.env.AIRTABLE_CLIENT_SECRET || "";
    if (!clientId || !credentials.refreshToken) throw new Error("airtable_refresh_not_configured");
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (clientSecret) headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: clientId,
    });
    const res = await fetch("https://airtable.com/oauth2/v1/token", { method: "POST", headers, body: body.toString() });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`airtable_refresh_${res.status}: ${t.slice(0, 200)}`);
    }
    const j: any = await res.json();
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: j.expires_in ? new Date(Date.now() + Number(j.expires_in) * 1000) : undefined,
      scope: j.scope,
    };
  },
};

async function airtable(pat: string, method: string, url: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`airtable_${res.status}: ${text.slice(0, 240)}`);
  }
  return await res.json();
}

// ─── Setup helpers (called from the admin route, not from the LLM) ──

export async function airtableListBases(pat: string): Promise<Array<{ id: string; name: string }>> {
  const r: any = await airtable(pat, "GET", "https://api.airtable.com/v0/meta/bases");
  return (r.bases || []).map((b: any) => ({ id: b.id, name: b.name }));
}

export async function airtableListTables(token: string, baseId: string): Promise<Array<{ id: string; name: string }>> {
  const r: any = await airtable(token, "GET", `https://api.airtable.com/v0/meta/bases/${baseId}/tables`);
  return (r.tables || []).map((t: any) => ({ id: t.id, name: t.name }));
}

/** List the columns of a specific table - powers the mapping UI. */
export async function airtableListFields(token: string, baseId: string, tableId: string): Promise<Array<{ id: string; name: string; type: string }>> {
  const r: any = await airtable(token, "GET", `https://api.airtable.com/v0/meta/bases/${baseId}/tables`);
  const table = (r.tables || []).find((t: any) => t.id === tableId || t.name === tableId);
  return (table?.fields || []).map((f: any) => ({ id: f.id, name: f.name, type: f.type }));
}

/**
 * Create a column on a table. Requires the OAuth token to carry the
 * `schema.bases:write` scope. Used to auto-create the notes / idempotency
 * columns we own (never the tenant's identifier columns). `type` is an
 * Airtable field type, e.g. "multilineText" or "singleLineText".
 */
export async function airtableCreateField(token: string, baseId: string, tableId: string, name: string, type = "multilineText"): Promise<{ id: string; name: string; type: string }> {
  const r: any = await airtable(token, "POST", `https://api.airtable.com/v0/meta/bases/${baseId}/tables/${tableId}/fields`, { name, type });
  return { id: r.id, name: r.name, type: r.type };
}

registerAdapter(AirtableAdapter);
export default AirtableAdapter;
