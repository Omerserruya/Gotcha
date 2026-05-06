/**
 * Airtable adapter — production-grade.
 *
 * Auth: Personal Access Token (PAT). The user generates one at
 * airtable.com/create/tokens with scopes: data.records:read,
 * data.records:write, schema.bases:read. We accept the PAT as `apiKey`
 * in credentials. No refresh — PATs are long-lived.
 *
 * Setup flow (admin UI calls these helpers indirectly):
 *   1. List bases → user picks the base.
 *   2. List tables in that base → user picks the table.
 *   3. We persist `config = { baseId, tableId, tableName }`.
 *
 * Tools (most-used patterns for support + sales bots):
 *   - airtable.list_records   — query records (filterByFormula optional)
 *   - airtable.get_record     — by id
 *   - airtable.create_record  — single record
 *   - airtable.update_record  — patch fields by id
 */

import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";

const AIRTABLE_API = "https://api.airtable.com/v0";

const TOOLS: ToolDefinition[] = [
  {
    name: "airtable.list_records",
    description: "List records from the configured Airtable table.",
    whenToUse: "You need to find rows by criteria — e.g. all records where a field equals a value.",
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

export async function airtableListTables(pat: string, baseId: string): Promise<Array<{ id: string; name: string }>> {
  const r: any = await airtable(pat, "GET", `https://api.airtable.com/v0/meta/bases/${baseId}/tables`);
  return (r.tables || []).map((t: any) => ({ id: t.id, name: t.name }));
}

registerAdapter(AirtableAdapter);
export default AirtableAdapter;
