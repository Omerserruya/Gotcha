/**
 * Fireberry (formerly Powerlink) adapter - Israeli CRM.
 *
 * Auth: STATIC API token (no OAuth). The tenant copies their token from
 * Fireberry → Settings → Integration → API Forms → "My Token" and pastes it
 * as `tokenid`. We send it in the `tokenid` header on every request. Tokens
 * are long-lived, so there is no refreshTokens().
 *
 * API model (https://developers.fireberry.com):
 *   - Query (v3):  POST /api/query        body { objecttype: <number>, query, fields, page_size, page_number }
 *   - Get record:  GET  /api/record/{objectTypeName}/{id}
 *   - Create:      POST /api/record/{objectTypeName}            body = field map
 *   - Update:      PUT  /api/record/{objectTypeName}/{id}       body = field map
 *
 * Object types and field names are tenant-customizable, so the CRMAdapter
 * passes them in (resolved from `config` with documented defaults). The
 * Account object is `objecttype` 1 / name "account" with fields
 * `accountname` / `emailaddress1` / `telephone1` / `accountid`.
 */

import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";

const FIREBERRY_API = "https://api.fireberry.com/api";

// Sensible defaults targeting the standard Account object. Overridable per
// call (and per tenant via config in the CRMAdapter layer).
const DEFAULT_OBJECT_TYPE_CODE = 1; // Accounts
const DEFAULT_OBJECT_TYPE_NAME = "account";

const TOOLS: ToolDefinition[] = [
  {
    name: "fireberry.query_records",
    description: "Query Fireberry records of an object type, filtered by a field expression.",
    whenToUse: "You need to find records by criteria - e.g. an account whose email or phone equals a value.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        object_type_code: { type: "number", description: "Numeric object type (Accounts=1). Defaults to config." },
        query: { type: "string", description: "Filter expression, e.g. (emailaddress1 = 'x@y.com')" },
        fields: { type: "string", description: "Comma-separated field names to return." },
        page_size: { type: "number", description: "Default 50, max 100." },
      },
      required: ["query"],
    },
  },
  {
    name: "fireberry.get_record",
    description: "Get a single Fireberry record by id.",
    whenToUse: "You already have a record GUID and need its fields.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        object_type: { type: "string", description: "Object type name (e.g. 'account'). Defaults to config." },
        record_id: { type: "string", description: "Record GUID." },
      },
      required: ["record_id"],
    },
  },
  {
    name: "fireberry.create_record",
    description: "Create a single record of an object type in Fireberry.",
    whenToUse: "Adding a new account/contact/lead row.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Inserts a CRM record visible to all Fireberry users.",
    parameters: {
      type: "object",
      properties: {
        object_type: { type: "string", description: "Object type name (e.g. 'account'). Defaults to config." },
        fields: { type: "object", description: "Map of Fireberry field system-name → value." },
      },
      required: ["fields"],
    },
  },
  {
    name: "fireberry.update_record",
    description: "Patch fields on an existing Fireberry record.",
    whenToUse: "Updating fields (e.g. description/notes, phone, email) on a known record.",
    category: "WRITE",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        object_type: { type: "string", description: "Object type name (e.g. 'account'). Defaults to config." },
        record_id: { type: "string", description: "Record GUID." },
        fields: { type: "object", description: "Fields to patch." },
      },
      required: ["record_id", "fields"],
    },
  },
];

const FireberryAdapter: ProviderAdapter = {
  slug: "fireberry",
  tools: () => TOOLS,

  async execute({ toolName, args, credentials, config }) {
    const token = credentials.tokenid || credentials.apiKey || credentials.accessToken;
    if (!token) throw new Error("no_fireberry_token");

    const typeName = String(args.object_type || config.objectTypeName || DEFAULT_OBJECT_TYPE_NAME);
    const typeCode = Number(args.object_type_code ?? config.objectTypeCode ?? DEFAULT_OBJECT_TYPE_CODE);

    switch (toolName) {
      case "query_records": {
        const body: Record<string, unknown> = {
          objecttype: typeCode,
          query: String(args.query ?? ""),
          page_size: Math.min(100, Number(args.page_size ?? 50)),
          page_number: 1,
        };
        if (args.fields) body.fields = String(args.fields);
        const r = await fireberry(token, "POST", `${FIREBERRY_API}/query`, body);
        return extractRecords(r);
      }
      case "get_record": {
        const r = await fireberry(token, "GET", `${FIREBERRY_API}/record/${encodeURIComponent(typeName)}/${encodeURIComponent(String(args.record_id))}`);
        return extractRecord(r);
      }
      case "create_record": {
        const r = await fireberry(token, "POST", `${FIREBERRY_API}/record/${encodeURIComponent(typeName)}`, args.fields ?? {});
        return extractRecord(r);
      }
      case "update_record": {
        const r = await fireberry(token, "PUT", `${FIREBERRY_API}/record/${encodeURIComponent(typeName)}/${encodeURIComponent(String(args.record_id))}`, args.fields ?? {});
        return extractRecord(r);
      }
      default:
        throw new Error(`unknown_fireberry_tool:${toolName}`);
    }
  },
};

async function fireberry(token: string, method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: {
      tokenid: token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`fireberry_${res.status}: ${text.slice(0, 240)}`);
  }
  return await res.json().catch(() => ({}));
}

// Fireberry wraps responses inconsistently across endpoints/versions; pull the
// record list out defensively rather than assuming one shape.
function extractRecords(body: any): any[] {
  const d = body?.data ?? body;
  return d?.Data ?? d?.Records ?? d?.records ?? (Array.isArray(d) ? d : []);
}

function extractRecord(body: any): any {
  const d = body?.data ?? body;
  return d?.Record ?? d?.record ?? d?.Data ?? d ?? null;
}

registerAdapter(FireberryAdapter);
export default FireberryAdapter;
