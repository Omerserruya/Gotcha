/**
 * HubSpot adapter — production-grade.
 *
 * Auth: OAuth 2.0 (refresh-token flow). Tokens expire in 30 minutes;
 * the framework refreshes within the buffer.
 *
 * Tools (top usage from HubSpot's Sales Hub patterns):
 *   - hubspot.create_contact     — upsert by email (avoids duplicates)
 *   - hubspot.update_contact     — patch fields on a contact
 *   - hubspot.get_contact        — read by id or email
 *   - hubspot.search_contacts    — fuzzy search by email/name/phone
 *   - hubspot.log_activity       — note/email/call engagement
 *   - hubspot.create_deal        — open a deal in a pipeline
 *
 * Leads (Sales Hub Enterprise — uses the dedicated /crm/v3/objects/leads endpoint):
 *   - hubspot.create_lead        — new pre-Contact lead (SDR workflow)
 *   - hubspot.update_lead        — patch lead properties
 *   - hubspot.get_lead           — read by id
 *   - hubspot.search_leads       — search by query string
 *
 * For tenants on Pro/Starter (no Leads object), use create_contact with
 * `source` — that contact's lifecyclestage starts as "lead" by default.
 */

import {
  registerAdapter,
  type ProviderAdapter,
  type ToolDefinition,
} from "./integration-framework";

const HS_API = "https://api.hubapi.com";
const HS_TOKEN = "https://api.hubapi.com/oauth/v1/token";

const TOOLS: ToolDefinition[] = [
  {
    name: "hubspot.create_contact",
    description: "Create or upsert a HubSpot contact by email.",
    whenToUse: "You captured a new lead's email and you want them in CRM. Idempotent on email.",
    whenNotToUse: "You don't have an email — HubSpot requires it for the upsert path.",
    category: "WRITE",
    riskLevel: "LOW",
    sideEffects: "Adds or updates a record in HubSpot Contacts.",
    idempotencyNotes: "Upsert keyed on email — same email never creates a duplicate.",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string" },
        firstname: { type: "string" },
        lastname: { type: "string" },
        phone: { type: "string" },
        company: { type: "string" },
        source: { type: "string", description: "Lead source label, e.g. 'WhatsApp bot'." },
      },
      required: ["email"],
    },
  },
  {
    name: "hubspot.update_contact",
    description: "Patch properties on an existing HubSpot contact.",
    whenToUse: "You learned new info about a known contact (team size, stage, etc).",
    category: "WRITE",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        properties: { type: "object", description: "Map of HubSpot property name → value." },
      },
      required: ["contact_id", "properties"],
    },
  },
  {
    name: "hubspot.get_contact",
    description: "Read a HubSpot contact by id or email.",
    whenToUse: "You need standing context (stage, owner, deals) for an existing contact.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        email: { type: "string" },
      },
    },
  },
  {
    name: "hubspot.search_contacts",
    description: "Search HubSpot contacts by partial email/phone/name.",
    whenToUse: "You're trying to identify a customer with partial info.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term — email, phone, or name fragment." },
        limit: { type: "number", description: "Default 10, max 100." },
      },
      required: ["query"],
    },
  },
  {
    name: "hubspot.log_activity",
    description: "Log a note/email/call engagement against a contact.",
    whenToUse: "Recording a customer interaction in the contact's timeline.",
    category: "WRITE",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        kind: { type: "string", enum: ["NOTE", "EMAIL", "CALL"], description: "Engagement type." },
        body: { type: "string", description: "Plain-text body." },
      },
      required: ["contact_id", "kind", "body"],
    },
  },
  {
    name: "hubspot.create_deal",
    description: "Open a new deal in a HubSpot pipeline, optionally associated to a contact.",
    whenToUse: "Customer has agreed to move forward and a deal record should track the opportunity.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        dealname: { type: "string" },
        amount: { type: "number" },
        pipeline: { type: "string", description: "Pipeline id; defaults to 'default'." },
        dealstage: { type: "string", description: "Pipeline stage id (required)." },
        close_date_iso: { type: "string", description: "ISO8601 expected close date." },
      },
      required: ["dealname", "dealstage"],
    },
  },
  {
    name: "hubspot.create_lead",
    description: "Create a HubSpot Lead (Sales Hub Enterprise pre-Contact object).",
    whenToUse: "Tenant uses HubSpot Leads for SDR qualification before promoting to a Contact.",
    whenNotToUse: "Tenant is on Pro/Starter (no Leads object). Use hubspot.create_contact instead — that 403s otherwise.",
    category: "WRITE",
    riskLevel: "LOW",
    sideEffects: "Adds a Lead record to the Sales Hub leads workspace.",
    parameters: {
      type: "object",
      properties: {
        hs_lead_name: { type: "string", description: "Lead display name (required)." },
        contact_id: { type: "string", description: "Optional Contact id to associate the lead with." },
        company_id: { type: "string", description: "Optional Company id to associate." },
        properties: {
          type: "object",
          description: "Free-form HubSpot lead properties — e.g. { hs_lead_label: 'qualified', hs_pipeline_stage: '...' }.",
        },
      },
      required: ["hs_lead_name"],
    },
  },
  {
    name: "hubspot.update_lead",
    description: "Patch properties on an existing HubSpot Lead.",
    whenToUse: "Updating a lead's status, label, or owner.",
    category: "WRITE",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        lead_id: { type: "string" },
        properties: { type: "object", description: "Map of HubSpot lead property → value." },
      },
      required: ["lead_id", "properties"],
    },
  },
  {
    name: "hubspot.get_lead",
    description: "Read a HubSpot Lead by id.",
    whenToUse: "You have a lead id and need its current properties / associations.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        lead_id: { type: "string" },
      },
      required: ["lead_id"],
    },
  },
  {
    name: "hubspot.search_leads",
    description: "Search HubSpot Leads by query string (name/owner/label).",
    whenToUse: "Identifying an existing lead by partial info.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Default 10, max 100." },
      },
      required: ["query"],
    },
  },
];

const HubSpotAdapter: ProviderAdapter = {
  slug: "hubspot",
  tools: () => TOOLS,

  async refreshTokens(creds) {
    const clientId = process.env.HUBSPOT_CLIENT_ID;
    const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("HUBSPOT_CLIENT_ID/SECRET not configured");
    if (!creds.refreshToken) throw new Error("no_refresh_token");
    const res = await fetch(HS_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: creds.refreshToken,
      }).toString(),
    });
    if (!res.ok) throw new Error(`hubspot_refresh_${res.status}`);
    const j: any = await res.json();
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || creds.refreshToken,
      expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : undefined,
    };
  },

  async execute({ toolName, args, credentials }) {
    const token = credentials.accessToken;
    if (!token) throw new Error("no_access_token");
    switch (toolName) {
      case "create_contact": {
        const props = stripEmpty({
          email: args.email,
          firstname: args.firstname,
          lastname: args.lastname,
          phone: args.phone,
          company: args.company,
          hs_lead_source: args.source,
        });
        // Upsert via /contacts batch with idProperty=email
        const r = await hsRequest(token, "POST", "/crm/v3/objects/contacts/batch/upsert", {
          inputs: [{ idProperty: "email", id: args.email, properties: props }],
        });
        return (r as any).results?.[0] ?? r;
      }
      case "update_contact":
        return await hsRequest(token, "PATCH", `/crm/v3/objects/contacts/${encodeURIComponent(String(args.contact_id))}`, {
          properties: args.properties,
        });
      case "get_contact": {
        if (args.contact_id) {
          return await hsRequest(token, "GET", `/crm/v3/objects/contacts/${encodeURIComponent(String(args.contact_id))}`, null);
        }
        if (args.email) {
          const r = await hsRequest(token, "POST", `/crm/v3/objects/contacts/search`, {
            filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: args.email }] }],
            limit: 1,
          });
          return (r as any).results?.[0] ?? null;
        }
        throw new Error("contact_id_or_email_required");
      }
      case "search_contacts": {
        const limit = Math.min(100, Number(args.limit ?? 10));
        const r = await hsRequest(token, "POST", `/crm/v3/objects/contacts/search`, {
          query: args.query,
          limit,
        });
        return (r as any).results || [];
      }
      case "log_activity": {
        const map: Record<string, string> = { NOTE: "notes", EMAIL: "emails", CALL: "calls" };
        const path = map[String(args.kind).toUpperCase()] || "notes";
        const propKey = path === "notes" ? "hs_note_body" : path === "emails" ? "hs_email_text" : "hs_call_body";
        const created = await hsRequest(token, "POST", `/crm/v3/objects/${path}`, {
          properties: { [propKey]: args.body, hs_timestamp: Date.now() },
        });
        if (args.contact_id) {
          await hsRequest(token, "PUT",
            `/crm/v3/objects/${path}/${(created as any).id}/associations/contacts/${args.contact_id}/${path === "notes" ? "note_to_contact" : path === "emails" ? "email_to_contact" : "call_to_contact"}`,
            null,
          );
        }
        return created;
      }
      case "create_deal": {
        const props = stripEmpty({
          dealname: args.dealname,
          amount: args.amount != null ? String(args.amount) : undefined,
          pipeline: args.pipeline || "default",
          dealstage: args.dealstage,
          closedate: args.close_date_iso,
        });
        const deal = await hsRequest(token, "POST", "/crm/v3/objects/deals", { properties: props });
        if (args.contact_id) {
          await hsRequest(token, "PUT",
            `/crm/v3/objects/deals/${(deal as any).id}/associations/contacts/${args.contact_id}/deal_to_contact`,
            null,
          );
        }
        return deal;
      }
      case "create_lead": {
        const props = stripEmpty({
          hs_lead_name: args.hs_lead_name,
          ...(args.properties && typeof args.properties === "object" ? args.properties : {}),
        });
        const lead: any = await hsRequest(token, "POST", "/crm/v3/objects/leads", { properties: props });
        // Associate lead → contact / company if provided. HubSpot's lead
        // associations use the typed-association endpoint.
        if (args.contact_id) {
          await hsRequest(token, "PUT",
            `/crm/v3/objects/leads/${lead.id}/associations/contacts/${args.contact_id}/lead_to_contact`,
            null,
          ).catch(() => undefined);
        }
        if (args.company_id) {
          await hsRequest(token, "PUT",
            `/crm/v3/objects/leads/${lead.id}/associations/companies/${args.company_id}/lead_to_company`,
            null,
          ).catch(() => undefined);
        }
        return lead;
      }
      case "update_lead":
        return await hsRequest(token, "PATCH", `/crm/v3/objects/leads/${encodeURIComponent(String(args.lead_id))}`, {
          properties: args.properties,
        });
      case "get_lead":
        return await hsRequest(token, "GET", `/crm/v3/objects/leads/${encodeURIComponent(String(args.lead_id))}`, null);
      case "search_leads": {
        const limit = Math.min(100, Number(args.limit ?? 10));
        const r = await hsRequest(token, "POST", "/crm/v3/objects/leads/search", {
          query: args.query,
          limit,
        });
        return (r as any).results || [];
      }
      default:
        throw new Error(`unknown_hubspot_tool:${toolName}`);
    }
  },
};

async function hsRequest(token: string, method: string, path: string, body: unknown | null): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  };
  const res = await fetch(`${HS_API}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`hubspot_${res.status}: ${text.slice(0, 240)}`);
  }
  if (res.status === 204) return null;
  return await res.json();
}

function stripEmpty(o: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

registerAdapter(HubSpotAdapter);
export default HubSpotAdapter;
