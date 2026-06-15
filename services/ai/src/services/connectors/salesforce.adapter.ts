/**
 * Salesforce adapter - production-grade.
 *
 * Auth: OAuth 2.0 Web Server flow. Salesforce returns an `instance_url`
 * with the token (each org has its own subdomain). We persist:
 *
 *   credentials = { accessToken, refreshToken, instanceUrl }
 *
 * Tokens are short-lived (~2 hours) - refresh via /services/oauth2/token.
 *
 * Tools (top patterns from Sales Cloud / Service Cloud bots):
 *   - salesforce.search_records   - SOSL across an object
 *   - salesforce.get_record       - by Id (sObject)
 *   - salesforce.create_lead      - new Lead
 *   - salesforce.update_lead      - patch Lead fields
 *   - salesforce.create_case      - open a Service Cloud case
 *   - salesforce.log_task         - log a Task (call/email note)
 *
 * API: REST v60.0 (`/services/data/v60.0`).
 */

import {
  registerAdapter,
  type ProviderAdapter,
  type ToolDefinition,
} from "./integration-framework";

const API_VERSION = "v60.0";
const TOKEN_PATH = "/services/oauth2/token";

const TOOLS: ToolDefinition[] = [
  {
    name: "salesforce.search_records",
    description: "Search Salesforce records via SOSL across one sObject.",
    whenToUse: "You're identifying a Lead/Contact/Account by partial info.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "Lead | Contact | Account | Opportunity | Case" },
        query: { type: "string", description: "Free-text search term." },
        limit: { type: "number", description: "Default 10, max 200." },
        fields: { type: "array", items: { type: "string" }, description: "Fields to return. Default: Id,Name." },
      },
      required: ["sobject", "query"],
    },
  },
  {
    name: "salesforce.get_record",
    description: "Get a Salesforce sObject by Id.",
    whenToUse: "You have an Id and need the full record.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        sobject: { type: "string" },
        id: { type: "string" },
        fields: { type: "array", items: { type: "string" }, description: "Optional projection." },
      },
      required: ["sobject", "id"],
    },
  },
  {
    name: "salesforce.create_lead",
    description: "Create a Salesforce Lead.",
    whenToUse: "You captured a new lead (must include LastName + Company).",
    category: "WRITE",
    riskLevel: "MEDIUM",
    parameters: {
      type: "object",
      properties: {
        FirstName: { type: "string" },
        LastName: { type: "string" },
        Company: { type: "string" },
        Email: { type: "string" },
        Phone: { type: "string" },
        LeadSource: { type: "string" },
        Status: { type: "string" },
        Description: { type: "string" },
      },
      required: ["LastName", "Company"],
    },
  },
  {
    name: "salesforce.update_lead",
    description: "Patch fields on a Salesforce Lead by Id.",
    whenToUse: "Updating known Lead fields (status, source, etc.).",
    category: "WRITE",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        fields: { type: "object", description: "Map of field → value." },
      },
      required: ["id", "fields"],
    },
  },
  {
    name: "salesforce.create_case",
    description: "Open a Salesforce Case (Service Cloud).",
    whenToUse: "Customer reports an issue that needs human follow-up.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    parameters: {
      type: "object",
      properties: {
        Subject: { type: "string" },
        Description: { type: "string" },
        ContactId: { type: "string" },
        AccountId: { type: "string" },
        Priority: { type: "string", enum: ["Low", "Medium", "High"] },
        Origin: { type: "string", description: "Default 'Web'." },
      },
      required: ["Subject"],
    },
  },
  {
    name: "salesforce.log_task",
    description: "Log a Task on a record (call/email/note style).",
    whenToUse: "Recording a customer interaction in Salesforce activity history.",
    category: "WRITE",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        WhoId: { type: "string", description: "Lead/Contact Id." },
        WhatId: { type: "string", description: "Account/Opportunity/Case Id." },
        Subject: { type: "string" },
        Description: { type: "string" },
        Status: { type: "string", description: "Default 'Completed'." },
      },
      required: ["Subject"],
    },
  },
  {
    name: "salesforce.describe_fields",
    description: "Return the field schema for a Salesforce sObject (Lead, Contact).",
    whenToUse: "Audience builder discovery - populates the filter-field picker with real fields, picklist values, and types.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "Lead | Contact | Account | Opportunity" },
      },
      required: ["sobject"],
    },
  },
  {
    name: "salesforce.search_with_criteria",
    description: "Search Salesforce records using a SOQL WHERE clause (audience targeting).",
    whenToUse: "Resolving a broadcast audience by attribute (e.g. LeadSource = 'Web' AND CreatedDate > LAST_N_DAYS:30). The audience resolver in `crm.ts` builds the WHERE clause from generic rules.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        sobject: { type: "string", description: "Lead | Contact" },
        where: { type: "string", description: "SOQL WHERE clause (without the WHERE keyword)." },
        limit: { type: "number", description: "Default 200, max 2000." },
      },
      required: ["sobject"],
    },
  },
];

const SalesforceAdapter: ProviderAdapter = {
  slug: "salesforce",
  tools: () => TOOLS,

  async refreshTokens(creds) {
    const clientId = process.env.SALESFORCE_CLIENT_ID;
    const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
    const loginHost = creds.loginHost || "https://login.salesforce.com";
    if (!clientId || !clientSecret) throw new Error("SALESFORCE_CLIENT_ID/SECRET not configured");
    if (!creds.refreshToken) throw new Error("no_refresh_token");
    const res = await fetch(`${loginHost}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: creds.refreshToken,
      }).toString(),
    });
    if (!res.ok) throw new Error(`salesforce_refresh_${res.status}`);
    const j: any = await res.json();
    return {
      accessToken: j.access_token,
      refreshToken: creds.refreshToken,
      // Salesforce doesn't always return expires_in; default 90 minutes
      expiresAt: new Date(Date.now() + 90 * 60_000),
      scope: j.scope,
    };
  },

  async execute({ toolName, args, credentials }) {
    const token = credentials.accessToken;
    const instance = credentials.instanceUrl || credentials.instance_url;
    if (!token) throw new Error("no_access_token");
    if (!instance) throw new Error("no_instance_url");
    const base = `${String(instance).replace(/\/$/, "")}/services/data/${API_VERSION}`;

    switch (toolName) {
      case "search_records": {
        const sobject = String(args.sobject);
        const limit = Math.min(200, Number(args.limit ?? 10));
        const fields = Array.isArray(args.fields) && args.fields.length ? args.fields.join(",") : "Id,Name";
        const sosl = `FIND {${escapeSosl(String(args.query))}} IN ALL FIELDS RETURNING ${sobject}(${fields} LIMIT ${limit})`;
        const r: any = await sfRequest(token, "GET", `${base}/search/?q=${encodeURIComponent(sosl)}`);
        return r.searchRecords || [];
      }
      case "get_record": {
        const sobject = String(args.sobject);
        const id = String(args.id);
        const params = Array.isArray(args.fields) && args.fields.length ? `?fields=${encodeURIComponent(args.fields.join(","))}` : "";
        return await sfRequest(token, "GET", `${base}/sobjects/${sobject}/${encodeURIComponent(id)}${params}`);
      }
      case "create_lead":
        return await sfRequest(token, "POST", `${base}/sobjects/Lead`, stripEmpty(args));
      case "update_lead":
        await sfRequest(token, "PATCH", `${base}/sobjects/Lead/${encodeURIComponent(String(args.id))}`, stripEmpty(args.fields || {}));
        return { id: args.id, updated: true };
      case "create_case":
        return await sfRequest(token, "POST", `${base}/sobjects/Case`, stripEmpty({ ...args, Origin: args.Origin || "Web" }));
      case "log_task":
        return await sfRequest(token, "POST", `${base}/sobjects/Task`, stripEmpty({
          ...args,
          Status: args.Status || "Completed",
        }));
      case "describe_fields": {
        const sobject = String(args.sobject || "Lead");
        // /sobjects/Lead/describe → { fields: [{name, label, type, picklistValues, ...}] }
        return await sfRequest(token, "GET", `${base}/sobjects/${encodeURIComponent(sobject)}/describe`);
      }
      case "search_with_criteria": {
        // SOQL via /query?q=... - returns { totalSize, records: [...] }
        const sobject = String(args.sobject || "Lead");
        const limit = Math.min(2000, Number(args.limit ?? 200));
        const fields =
          sobject === "Lead"
            ? "Id, FirstName, LastName, Email, Phone, MobilePhone, Company, CreatedDate, LastModifiedDate"
            : "Id, FirstName, LastName, Email, Phone, MobilePhone, AccountId, CreatedDate, LastModifiedDate";
        const where = typeof args.where === "string" && args.where.trim() ? `WHERE ${args.where}` : "";
        const soql = `SELECT ${fields} FROM ${sobject} ${where} LIMIT ${limit}`.replace(/\s+/g, " ").trim();
        const r: any = await sfRequest(token, "GET", `${base}/query/?q=${encodeURIComponent(soql)}`);
        return r.records || [];
      }
      default:
        throw new Error(`unknown_salesforce_tool:${toolName}`);
    }
  },
};

async function sfRequest(token: string, method: string, url: string, body?: unknown): Promise<any> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`salesforce_${res.status}: ${text.slice(0, 240)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function stripEmpty(o: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

function escapeSosl(s: string): string {
  return s.replace(/[\\?&|!{}\[\]\^~*:"\(\)+\-]/g, "\\$&");
}

registerAdapter(SalesforceAdapter);
export default SalesforceAdapter;
