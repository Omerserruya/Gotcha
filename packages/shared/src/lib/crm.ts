/**
 * Shared CRM client.
 *
 * Platform-wide entry point for "talk to the tenant's connected CRM".
 * Used by:
 *   - AI tools (replaces the AI-specific crm-prefetch helpers)
 *   - Outbound contact search (CRM-first when connected)
 *   - Broadcast audience filters (CRM-backed targeting)
 *   - Manual UI search
 *   - Future automations / workflows
 *
 * The client is provider-agnostic. Today the connected CRM is resolved by
 * looking at `tenant_integrations.category = "CRM"`; we then dispatch a
 * normalized search through `dispatchToolCall` (same path the AI uses).
 * Each provider's raw rows are normalized to the `CrmRecord` shape so
 * callers don't care whether it's Zoho, HubSpot, Salesforce, etc.
 *
 * Anti-coupling rule (from CLAUDE.md / new architecture brief):
 *   AI consumes this layer. AI is NOT the owner of customer operations.
 *   Adding a new caller (outbound, broadcast) MUST NOT require touching AI.
 */

import { prisma } from "./prisma";
import { type AgentToolContext } from "./agent-tools";

// ─── Types ──────────────────────────────────────────────────

export interface CrmRecord {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  createdAt?: string;
  modifiedAt?: string;
  /** Provider-specific raw row, kept for callers that need extra fields. */
  raw?: Record<string, unknown>;
}

export interface CrmConnection {
  /** Tenant-integration row id. */
  id: string;
  /** Catalog provider slug (zoho_crm, hubspot, salesforce, etc.). */
  slug: string;
  /** Display name. */
  name: string;
  /** "CONNECTED" | "DISCONNECTED" | etc. */
  status: string;
}

export interface CrmLookupArgs {
  phone?: string;
  email?: string;
  name?: string;
  company?: string;
  /**
   * Provider-native criteria expression. For Zoho, the syntax is
   * `(Field:operator:value)` joined by `and`/`or`. Used by the audience
   * resolver to push non-identity filter rules (Lead_Source, Stage,
   * custom fields, etc.) down to the CRM instead of trying to evaluate
   * them locally.
   *
   * Builders live in `audience.ts` and are provider-aware - pass the raw
   * expression string here; the executor forwards it as a query param.
   */
  criteria?: string;
}

// ─── Connection resolution ──────────────────────────────────

/**
 * Returns the tenant's connected CRM, or null. There is at most one
 * "active" CRM per tenant today - when multiple are connected, the first
 * CONNECTED row wins. A future revision can let the operator pin a
 * primary.
 */
export async function getConnectedCrm(tenantId: string): Promise<CrmConnection | null> {
  const row = await (prisma as any).tenantIntegration.findFirst({
    where: {
      tenantId,
      status: "CONNECTED",
      integration: { category: "CRM" },
    },
    include: { integration: { select: { slug: true, name: true } } },
    orderBy: { connectedAt: "desc" },
  });
  if (!row) return null;
  return {
    id: row.id,
    slug: row.integration?.slug ?? "",
    name: row.integration?.name ?? row.integration?.slug ?? "CRM",
    status: row.status,
  };
}

// ─── Public lookup API ──────────────────────────────────────

/**
 * Search leads in the connected CRM. Returns normalized records - empty
 * array if no CRM connected, no match, or the call fails (best-effort).
 */
export async function searchLeads(
  tenantId: string,
  args: CrmLookupArgs,
  ctx?: Partial<AgentToolContext>,
): Promise<CrmRecord[]> {
  return runSearch(tenantId, "lead_search", args, ctx);
}

/**
 * Search contacts in the connected CRM.
 */
export async function searchContacts(
  tenantId: string,
  args: CrmLookupArgs,
  ctx?: Partial<AgentToolContext>,
): Promise<CrmRecord[]> {
  return runSearch(tenantId, "contact_search", args, ctx);
}

/**
 * Convenience: lookup by phone across leads + contacts. Useful when the
 * caller doesn't know which entity the customer is filed under.
 */
export async function getContactByPhone(
  tenantId: string,
  phone: string,
  ctx?: Partial<AgentToolContext>,
): Promise<CrmRecord | null> {
  if (!phone) return null;
  const [leads, contacts] = await Promise.all([
    searchLeads(tenantId, { phone }, ctx),
    searchContacts(tenantId, { phone }, ctx),
  ]);
  return contacts[0] ?? leads[0] ?? null;
}

export async function getContactByEmail(
  tenantId: string,
  email: string,
  ctx?: Partial<AgentToolContext>,
): Promise<CrmRecord | null> {
  if (!email) return null;
  const [leads, contacts] = await Promise.all([
    searchLeads(tenantId, { email }, ctx),
    searchContacts(tenantId, { email }, ctx),
  ]);
  return contacts[0] ?? leads[0] ?? null;
}

// ─── Schema discovery (audience builder) ─────────────────────

export type CrmFieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "email"
  | "phone"
  | "url"
  | "currency"
  | "picklist"
  | "multipicklist"
  | "lookup"
  | "unknown";

export interface CrmFieldDef {
  /** Provider-canonical field name (e.g. "Lead_Source"). Use this in audience filter rules. */
  name: string;
  /** Human-readable label (e.g. "Lead Source"). */
  label: string;
  type: CrmFieldType;
  /** Allowed values for picklist / multipicklist fields. */
  picklist?: string[];
  /** Whether the field was custom-defined by the tenant. */
  custom?: boolean;
  /** Required at create-time? */
  required?: boolean;
  /** Whether the field accepts free-form text vs has constraints. */
  readOnly?: boolean;
}

export interface CrmModuleSchema {
  /** Lower-case module key the audience UI uses ("leads"/"contacts"/...). */
  module: string;
  /** Provider-native module name (e.g. "Leads"). */
  providerModule: string;
  fields: CrmFieldDef[];
}

/**
 * Returns the field schema for a CRM module on the connected provider.
 * The audience builder UI loads this once when the operator opens the
 * filter picker so they can choose from real fields (with picklist
 * values for enum-like ones) instead of typing field names blind.
 */
export async function getCrmSchema(
  tenantId: string,
  module: "leads" | "contacts" | "accounts" | "deals" = "leads",
  ctx?: Partial<AgentToolContext>,
): Promise<CrmModuleSchema | null> {
  const conn = await getConnectedCrm(tenantId);
  if (!conn) return null;
  const providerModule = providerModuleFor(conn.slug, module);

  // Provider-specific dispatch:
  //   - Zoho uses the HTTP-catalog-tool path (its `describe_fields`
  //     catalog row points at /crm/v7/settings/fields).
  //   - HubSpot / Salesforce / Monday use the adapter framework via the
  //     bridge endpoint - each adapter exposes a `describe_fields` tool
  //     that handles the per-provider schema shape (HubSpot Properties,
  //     SF describe, Monday board columns).
  if (conn.slug.startsWith("zoho")) {
    const tenantTool = await (prisma as any).tenantTool.findFirst({
      where: {
        tenantId,
        isEnabled: true,
        tenantIntegrationId: conn.id,
        catalogTool: { slug: "describe_fields" },
      },
      select: { id: true },
    });
    if (!tenantTool) return null;
    const exec = await runHttpCatalogTool(
      tenantId,
      tenantTool.id,
      { module: providerModule },
      ctx,
    );
    if (!exec?.ok) return null;
    return { module, providerModule, fields: normalizeFields(conn.slug, exec.output) };
  }

  if (conn.slug === "hubspot") {
    const exec = await runAdapterTool(
      tenantId,
      "hubspot.describe_fields",
      { object: providerModule },
      ctx,
    );
    if (!exec?.ok) return null;
    return { module, providerModule, fields: normalizeFields(conn.slug, exec.output) };
  }
  if (conn.slug === "salesforce") {
    const exec = await runAdapterTool(
      tenantId,
      "salesforce.describe_fields",
      { sobject: providerModule },
      ctx,
    );
    if (!exec?.ok) return null;
    return { module, providerModule, fields: normalizeFields(conn.slug, exec.output) };
  }
  if (conn.slug === "monday") {
    const exec = await runAdapterTool(
      tenantId,
      "monday.describe_fields",
      { object: module },
      ctx,
    );
    if (!exec?.ok) return null;
    return { module, providerModule, fields: normalizeFields(conn.slug, exec.output) };
  }
  return null;
}

function providerModuleFor(slug: string, module: string): string {
  // Zoho uses Title-Case ("Leads"/"Contacts"). HubSpot uses lower
  // ("contacts"/"deals"). Salesforce uses sObject names ("Lead"/"Contact").
  const m = module.toLowerCase();
  if (slug.startsWith("zoho")) {
    if (m === "leads") return "Leads";
    if (m === "contacts") return "Contacts";
    if (m === "accounts") return "Accounts";
    if (m === "deals") return "Deals";
  }
  if (slug === "salesforce") {
    if (m === "leads") return "Lead";
    if (m === "contacts") return "Contact";
    if (m === "accounts") return "Account";
    if (m === "deals") return "Opportunity";
  }
  // hubspot + default - lowercase
  return m;
}

function normalizeFields(slug: string, raw: unknown): CrmFieldDef[] {
  if (slug.startsWith("zoho")) {
    const arr = Array.isArray((raw as any)?.fields) ? (raw as any).fields : [];
    return arr.map((f: any): CrmFieldDef => ({
      name: String(f.api_name ?? ""),
      label: String(f.field_label ?? f.api_name ?? ""),
      type: mapZohoType(f.data_type, f.json_type),
      picklist: Array.isArray(f.pick_list_values)
        ? f.pick_list_values.map((p: any) => String(p.actual_value ?? p.display_value ?? "")).filter(Boolean)
        : undefined,
      custom: f.custom_field === true,
      required: f.system_mandatory === true || f.required === true,
      readOnly: f.read_only === true,
    })).filter((f: CrmFieldDef) => f.name);
  }

  if (slug === "hubspot") {
    // HubSpot Properties API returns { results: [{ name, label, type, fieldType, options[], hubspotDefined, ... }] }
    const arr = Array.isArray((raw as any)?.results) ? (raw as any).results : Array.isArray(raw) ? raw : [];
    return arr.map((f: any): CrmFieldDef => ({
      name: String(f.name ?? ""),
      label: String(f.label ?? f.name ?? ""),
      type: mapHubspotType(f.type, f.fieldType),
      picklist: Array.isArray(f.options) && f.options.length
        ? f.options.map((o: any) => String(o.value ?? o.label ?? "")).filter(Boolean)
        : undefined,
      custom: f.hubspotDefined === false,
      required: false,
      readOnly: f.modificationMetadata?.readOnlyValue === true,
    })).filter((f: CrmFieldDef) => f.name);
  }

  if (slug === "monday") {
    // Monday describe returns { board: {id, name}, columns: [{id, title, type, settings_str}] }
    // Column types map: "status"/"dropdown" → picklist; "numeric" → number;
    // "date" → date; "people"/"timeline" → string; everything else → string.
    const cols = Array.isArray((raw as any)?.columns) ? (raw as any).columns : [];
    return cols.map((c: any): CrmFieldDef => {
      const type = mapMondayType(String(c.type || ""));
      let picklist: string[] | undefined;
      // "settings_str" is a JSON string carrying labels for status / dropdown columns.
      if (type === "picklist" && typeof c.settings_str === "string" && c.settings_str.length > 0) {
        try {
          const settings = JSON.parse(c.settings_str);
          if (settings.labels && typeof settings.labels === "object") {
            picklist = Object.values(settings.labels).map((v) => String(v)).filter(Boolean);
          } else if (Array.isArray(settings.labels_v2)) {
            picklist = settings.labels_v2.map((l: any) => String(l.name ?? l.label ?? "")).filter(Boolean);
          } else if (Array.isArray(settings.options)) {
            picklist = settings.options.map((o: any) => String(o.name ?? o.label ?? "")).filter(Boolean);
          }
        } catch {
          picklist = undefined;
        }
      }
      return {
        name: String(c.id ?? ""),
        label: String(c.title ?? c.id ?? ""),
        type,
        picklist,
        custom: true, // every Monday column is tenant-defined
        required: false,
        readOnly: false,
      };
    }).filter((f: CrmFieldDef) => f.name);
  }

  if (slug === "salesforce") {
    // Salesforce describe returns { fields: [{ name, label, type, picklistValues, custom, nillable, ... }] }
    const arr = Array.isArray((raw as any)?.fields) ? (raw as any).fields : [];
    return arr.map((f: any): CrmFieldDef => ({
      name: String(f.name ?? ""),
      label: String(f.label ?? f.name ?? ""),
      type: mapSalesforceType(f.type),
      picklist: Array.isArray(f.picklistValues) && f.picklistValues.length
        ? f.picklistValues.map((p: any) => String(p.value ?? p.label ?? "")).filter(Boolean)
        : undefined,
      custom: f.custom === true,
      required: f.nillable === false && f.defaultedOnCreate !== true,
      readOnly: f.updateable === false,
    })).filter((f: CrmFieldDef) => f.name);
  }

  return [];
}

function mapZohoType(dataType: string, jsonType: string): CrmFieldType {
  const t = String(dataType || "").toLowerCase();
  if (t === "text" || t === "textarea") return "text";
  if (t === "string" || t === "owner_lookup" || t === "autonumber") return "string";
  if (t === "email") return "email";
  if (t === "phone") return "phone";
  if (t === "website" || t === "url") return "url";
  if (t === "integer" || t === "decimal" || t === "double" || t === "bigint" || t === "percent") return "number";
  if (t === "currency") return "currency";
  if (t === "boolean") return "boolean";
  if (t === "date") return "date";
  if (t === "datetime") return "datetime";
  if (t === "picklist") return "picklist";
  if (t === "multiselectpicklist") return "multipicklist";
  if (t === "lookup" || t === "ownerlookup") return "lookup";
  return "unknown";
}

function mapHubspotType(type: string, fieldType: string): CrmFieldType {
  const t = String(type || "").toLowerCase();
  const f = String(fieldType || "").toLowerCase();
  if (t === "string" && (f === "text" || f === "textarea")) return f === "textarea" ? "text" : "string";
  if (t === "string") return "string";
  if (t === "enumeration") return f === "checkbox" || f === "booleancheckbox" ? "boolean" : "picklist";
  if (t === "number") return "number";
  if (t === "bool") return "boolean";
  if (t === "date") return "date";
  if (t === "datetime") return "datetime";
  if (f === "phonenumber") return "phone";
  if (f === "email") return "email";
  if (f === "url") return "url";
  return "unknown";
}

function mapSalesforceType(type: string): CrmFieldType {
  const t = String(type || "").toLowerCase();
  if (t === "string" || t === "id" || t === "reference") return t === "reference" ? "lookup" : "string";
  if (t === "textarea") return "text";
  if (t === "email") return "email";
  if (t === "phone") return "phone";
  if (t === "url") return "url";
  if (t === "int" || t === "double" || t === "percent") return "number";
  if (t === "currency") return "currency";
  if (t === "boolean") return "boolean";
  if (t === "date") return "date";
  if (t === "datetime") return "datetime";
  if (t === "picklist") return "picklist";
  if (t === "multipicklist") return "multipicklist";
  return "unknown";
}

// ─── Internal ───────────────────────────────────────────────

async function runSearch(
  tenantId: string,
  toolSlug: "lead_search" | "contact_search",
  args: CrmLookupArgs,
  ctx?: Partial<AgentToolContext>,
): Promise<CrmRecord[]> {
  const conn = await getConnectedCrm(tenantId);

  // Resolve the catalog tool the connected CRM exposes for this slug.
  // Zoho-style providers register their own `lead_search` / `contact_search`
  // catalog row tied to the integration. Providers that DON'T (HubSpot,
  // Salesforce, Shopify, Fireberry, Airtable, ...) fall through to the
  // uniform CRMAdapter path below so they're searchable too. `conn` may be
  // null for source-of-truth systems that aren't category="CRM" (e.g.
  // Shopify) - those still resolve a CRMAdapter on the AI service side.
  const tenantTool = conn
    ? await (prisma as any).tenantTool.findFirst({
        where: {
          tenantId,
          isEnabled: true,
          tenantIntegrationId: conn.id,
          catalogTool: { slug: toolSlug },
        },
        select: { id: true },
      })
    : null;
  if (!tenantTool) {
    return runAdapterSearchFallback(tenantId, conn, toolSlug, args, ctx);
  }
  // tenantTool is only queried when `conn` exists, so this is unreachable;
  // it narrows `conn` to non-null for the catalog path below.
  if (!conn) return [];

  // Call the AI service's tool executor over HTTP. We pass a synthetic
  // conversation id of "system" because the executor only uses the
  // conversation field for audit-row tagging - it does not validate the
  // row exists. This keeps the shared client decoupled from any one
  // service's local state.
  //
  // Future: move the executor itself out of services/ai into a dedicated
  // CRM service so this layer no longer goes through the AI host. The
  // PUBLIC API of crm.ts stays the same when that move happens.
  // From other services, hit `ai` via docker DNS. From inside the ai
  // service itself, prefer localhost so this still works in dev where the
  // container name might not resolve to itself.
  const aiBase = (
    process.env.AI_SERVICE_URL ||
    (process.env.SERVICE_NAME === "ai-service" ? "http://localhost:4006" : "http://ai:4006")
  ).replace(/\/$/, "");
  // Mirror middleware/auth.ts: accept either INTERNAL_SERVICE_TOKEN or
  // INTERNAL_SERVICE_KEY. Some services only populate _KEY, so falling back
  // to it here avoids a cross-service env-coordination 401.
  const token =
    ctx?.authToken ??
    process.env.INTERNAL_SERVICE_TOKEN ??
    process.env.INTERNAL_SERVICE_KEY;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  headers["x-tenant-id"] = tenantId;
  const conversationId = ctx?.conversationId || "system";

  let payload: any;
  try {
    const res = await fetch(
      `${aiBase}/api/ai-assist/${encodeURIComponent(conversationId)}/tools/execute`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ tenantToolId: tenantTool.id, input: buildSearchArgs(conn.slug, args) }),
      },
    );
    payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`[crm.${toolSlug}] HTTP ${res.status}:`, payload?.error);
      return [];
    }
  } catch (err: any) {
    console.warn(`[crm.${toolSlug}] fetch failed:`, err?.message);
    return [];
  }

  const exec = payload?.data;
  if (!exec?.ok) return [];
  return normalizeRows(conn.slug, exec.output ?? []);
}

/**
 * Search fallback for source-of-truth integrations that don't register
 * Zoho-style `lead_search`/`contact_search` catalog tools - HubSpot,
 * Salesforce, Shopify, Fireberry, Airtable, and any future vendor. Routes
 * through the uniform CRMAdapter interface on the AI service:
 *   - identity lookups (email/phone) → findCustomer  (covers EVERY vendor)
 *   - name/company/criteria search   → searchByRules (per-vendor builders
 *     where one exists; best-effort/no-op otherwise)
 *
 * This is what makes "search for contact" work on outbound for every
 * connected system-of-record instead of only Zoho.
 */
async function runAdapterSearchFallback(
  tenantId: string,
  conn: CrmConnection | null,
  toolSlug: "lead_search" | "contact_search",
  args: CrmLookupArgs,
  ctx?: Partial<AgentToolContext>,
): Promise<CrmRecord[]> {
  const kind: "lead" | "contact" = toolSlug === "lead_search" ? "lead" : "contact";
  const hasAttribute = !!(args.name || args.company || args.criteria);

  // 1) Identity lookup - uniform findCustomer across all source-of-truth systems.
  if (args.email || args.phone) {
    const rows = await runAdapterFind(
      tenantId,
      { email: args.email, phone: args.phone },
      ctx,
    );
    if (rows.length) {
      // Prefer rows whose kind matches the requested module. Adapters that
      // don't distinguish leads from contacts tag everything 'contact' - in
      // that case the contact_search call carries them and lead_search
      // yields none, so a caller that merges leads + contacts gets no dupes.
      const matched = rows.filter((r) => crmKindOf(r) === kind);
      if (matched.length) return matched;
      if (kind === "contact") return rows.filter((r) => crmKindOf(r) !== "lead");
      // lead_search with only contact-kind hits: nothing to add from identity.
      if (!hasAttribute) return [];
    } else if (!hasAttribute) {
      return [];
    }
  }

  // 2) Name / company / criteria - per-vendor attribute search. Only the
  //    adapter-framework CRMs with a criteria builder (HubSpot, Salesforce,
  //    Monday) honor this; others return [] rather than erroring.
  if (conn && hasAttribute) {
    const module: CrmSearchModule = kind === "lead" ? "leads" : "contacts";
    const { rows } = await searchByRules(tenantId, args, [], ctx, module);
    return rows;
  }

  return [];
}

/** Read the canonical `kind` stashed on a fallback CrmRecord's raw row. */
function crmKindOf(r: CrmRecord): string | undefined {
  const k = (r.raw as any)?.kind;
  return typeof k === "string" ? k : undefined;
}

/**
 * Call the AI service's uniform CRM find bridge (CRMAdapter.findCustomer).
 * Returns normalized records - empty on any error (best-effort, mirroring
 * the rest of this module).
 */
async function runAdapterFind(
  tenantId: string,
  ids: { email?: string; phone?: string; external_id?: string },
  ctx?: Partial<AgentToolContext>,
): Promise<CrmRecord[]> {
  const conversationId = ctx?.conversationId || "system";
  try {
    const res = await fetch(
      `${aiServiceBaseUrl()}/api/ai-assist/${encodeURIComponent(conversationId)}/crm/find`,
      {
        method: "POST",
        headers: buildHeaders(tenantId, ctx),
        body: JSON.stringify(ids),
      },
    );
    const payload: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("[crm.find] HTTP", res.status, payload?.error);
      return [];
    }
    const data = payload?.data;
    if (!data?.ok) return [];
    return canonicalContactsToRecords(Array.isArray(data.contacts) ? data.contacts : []);
  } catch (err: any) {
    console.warn("[crm.find] fetch failed:", err?.message);
    return [];
  }
}

/** Map CanonicalCrmContact rows from the find bridge into CrmRecord. */
function canonicalContactsToRecords(contacts: any[]): CrmRecord[] {
  return contacts.map((c) => ({
    id: String(c.id ?? ""),
    name: c.display_name ?? undefined,
    email: c.email ?? undefined,
    phone: c.phone ?? undefined,
    company:
      (typeof c.custom_fields?.company === "string" && c.custom_fields.company) ||
      (typeof c.custom_fields?.Company === "string" && c.custom_fields.Company) ||
      undefined,
    modifiedAt: c.vendor_updated_at ?? undefined,
    raw: c,
  }));
}

/**
 * Build provider-specific search args from a generic lookup spec. Today
 * Zoho is the primary path; HubSpot/Salesforce default to the same shape
 * (they accept `criteria` / `query` strings the adapters handle).
 */
function buildSearchArgs(_providerSlug: string, args: CrmLookupArgs): Record<string, unknown> {
  // Zoho `/Leads/search` and `/Contacts/search` accept any of:
  //   - `email` / `phone` - direct identity shortcuts
  //   - `word` - free-text search (this is what name/company queries use)
  //   - `criteria` - structured `(Field:operator:value)` expression
  // The tool executor passes our `input` as query params on a GET, so
  // every key we set here lands as a `?key=value` on the upstream call.
  // Zoho rejects unknown keys with EXPECTED_PARAM_MISSING (it expects one
  // of its supported keys to be present), so `name` / `company` must fold
  // into `word` rather than being sent as their own fields.
  // HubSpot/Salesforce adapters bypass this path (`searchByRules`); for
  // them, the raw `criteria` string is best-effort and may not be honored
  // until per-provider builders are implemented.
  const out: Record<string, unknown> = {};
  if (args.phone) out.phone = args.phone;
  if (args.email) out.email = args.email;
  if (args.criteria) out.criteria = args.criteria;
  // Fold name + company into a single `word` query for Zoho. When both
  // are provided, prefer `name` (the more specific identity hint) and let
  // Zoho's word-search match across all standard text fields.
  const word = args.name || args.company;
  if (word && !out.criteria) out.word = word;
  return out;
}

/**
 * Coerce provider-specific raw rows into the canonical `CrmRecord` shape.
 * Keeps a `raw` reference so callers that need extras can still get them.
 */
function normalizeRows(providerSlug: string, raw: unknown): CrmRecord[] {
  const rows: any[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as any).data)
      ? (raw as any).data
      : [];

  if (providerSlug === "zoho_crm" || providerSlug.startsWith("zoho")) {
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      name: r.Full_Name || [r.First_Name, r.Last_Name].filter(Boolean).join(" ").trim() || undefined,
      email: r.Email || undefined,
      phone: r.Phone || r.Mobile || undefined,
      company: r.Company || r.Account_Name || undefined,
      createdAt: r.Created_Time || undefined,
      modifiedAt: r.Modified_Time || undefined,
      raw: r,
    }));
  }

  if (providerSlug === "hubspot") {
    return rows.map((r) => {
      const props = r.properties ?? r;
      return {
        id: String(r.id ?? props.hs_object_id ?? ""),
        name: [props.firstname, props.lastname].filter(Boolean).join(" ").trim() || props.name || undefined,
        email: props.email || undefined,
        phone: props.phone || props.mobilephone || undefined,
        company: props.company || undefined,
        createdAt: props.createdate || r.createdAt || undefined,
        modifiedAt: props.lastmodifieddate || r.updatedAt || undefined,
        raw: r,
      };
    });
  }

  if (providerSlug === "salesforce") {
    return rows.map((r) => ({
      id: String(r.Id ?? ""),
      name: r.Name || [r.FirstName, r.LastName].filter(Boolean).join(" ").trim() || undefined,
      email: r.Email || undefined,
      phone: r.Phone || r.MobilePhone || undefined,
      company: r.Company || r.Account?.Name || undefined,
      createdAt: r.CreatedDate || undefined,
      modifiedAt: r.LastModifiedDate || undefined,
      raw: r,
    }));
  }

  if (providerSlug === "monday") {
    // Monday items: { id, name, column_values: [{ id, text, value }] }.
    // Column ids are board-specific. We do a best-effort extraction by
    // matching common patterns (email/phone column titles) - the
    // tenant can override by setting `config.emailColumnId` /
    // `config.phoneColumnId` on the integration. That refinement is a
    // separate ticket.
    return rows.map((r) => {
      const cols: any[] = Array.isArray(r.column_values) ? r.column_values : [];
      const findByPattern = (rx: RegExp): string | undefined => {
        const c = cols.find((cv) => rx.test(String(cv.id || ""))) ||
                  cols.find((cv) => rx.test(String(cv.text || "")));
        return c?.text || undefined;
      };
      return {
        id: String(r.id ?? ""),
        name: r.name || undefined,
        email: findByPattern(/email/i),
        phone: findByPattern(/phone|mobile/i),
        company: findByPattern(/company|account/i),
        createdAt: r.created_at || undefined,
        modifiedAt: r.updated_at || undefined,
        raw: r,
      };
    });
  }

  // Default: pass through with best-effort field names. Each provider gets
  // its own normalizer above as it's exercised.
  return rows.map((r) => ({
    id: String(r.id ?? r.Id ?? ""),
    name: r.name || r.Name || undefined,
    email: r.email || r.Email || undefined,
    phone: r.phone || r.Phone || undefined,
    company: r.company || r.Company || undefined,
    raw: r,
  }));
}

function mapMondayType(t: string): CrmFieldType {
  const s = t.toLowerCase();
  if (s === "status" || s === "dropdown" || s === "color") return "picklist";
  if (s === "numeric" || s === "numbers" || s === "rating") return "number";
  if (s === "date" || s === "timerange" || s === "timeline") return "date";
  if (s === "checkbox") return "boolean";
  if (s === "email") return "email";
  if (s === "phone") return "phone";
  if (s === "link") return "url";
  if (s === "long_text" || s === "long-text" || s === "longtext") return "text";
  return "string";
}

// ─── HTTP / adapter dispatch helpers ───────────────────────────

function aiServiceBaseUrl(): string {
  return (
    process.env.AI_SERVICE_URL ||
    (process.env.SERVICE_NAME === "ai-service" ? "http://localhost:4006" : "http://ai:4006")
  ).replace(/\/$/, "");
}

function buildHeaders(tenantId: string, ctx?: Partial<AgentToolContext>): Record<string, string> {
  // Mirror middleware/auth.ts: accept either INTERNAL_SERVICE_TOKEN or
  // INTERNAL_SERVICE_KEY. Some services only populate _KEY, so falling back
  // to it here avoids a cross-service env-coordination 401.
  const token =
    ctx?.authToken ??
    process.env.INTERNAL_SERVICE_TOKEN ??
    process.env.INTERNAL_SERVICE_KEY;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  headers["x-tenant-id"] = tenantId;
  return headers;
}

/**
 * Run an HTTP-catalog tool by tenantToolId. Used for Zoho today (the only
 * provider with full catalog tool endpoints). Returns the executor's
 * `{ok, output, error}` envelope or `null` on transport failure.
 */
async function runHttpCatalogTool(
  tenantId: string,
  tenantToolId: string,
  input: Record<string, unknown>,
  ctx?: Partial<AgentToolContext>,
): Promise<{ ok: boolean; output?: unknown; error?: string } | null> {
  const conversationId = ctx?.conversationId || "system";
  try {
    const res = await fetch(
      `${aiServiceBaseUrl()}/api/ai-assist/${encodeURIComponent(conversationId)}/tools/execute`,
      {
        method: "POST",
        headers: buildHeaders(tenantId, ctx),
        body: JSON.stringify({ tenantToolId, input }),
      },
    );
    const payload: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("[crm.runHttpCatalogTool] HTTP", res.status, payload?.error);
      return null;
    }
    return payload?.data ?? null;
  } catch (err: any) {
    console.warn("[crm.runHttpCatalogTool] fetch failed:", err?.message);
    return null;
  }
}

/**
 * Run an adapter-framework tool over the bridge endpoint. Used by
 * HubSpot/Salesforce/Monday - they don't have HTTP catalog tools, so the
 * shared client reaches their adapters via the bridge route on the AI
 * service. Returns `{ok, output}` envelope mirroring the catalog path.
 */
async function runAdapterTool(
  tenantId: string,
  toolFunctionName: string,
  args: Record<string, unknown>,
  ctx?: Partial<AgentToolContext>,
): Promise<{ ok: boolean; output?: unknown; error?: string } | null> {
  const conversationId = ctx?.conversationId || "system";
  try {
    const res = await fetch(
      `${aiServiceBaseUrl()}/api/ai-assist/${encodeURIComponent(conversationId)}/adapter-tools/execute`,
      {
        method: "POST",
        headers: buildHeaders(tenantId, ctx),
        body: JSON.stringify({ toolFunctionName, args }),
      },
    );
    const payload: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("[crm.runAdapterTool] HTTP", res.status, payload?.error);
      return null;
    }
    return payload?.data ?? null;
  } catch (err: any) {
    console.warn("[crm.runAdapterTool] fetch failed:", err?.message);
    return null;
  }
}

// ─── Audience-rule abstraction & per-provider criteria builders ─

/**
 * Generic filter rule shape - matches `AudienceFilter` in audience.ts but
 * lives here so the criteria builders are co-located with provider
 * knowledge. Audience.ts passes its rules through to `searchByRules` and
 * stays provider-agnostic.
 */
export interface CrmFilterRule {
  field: string;
  op: string;
  value?: unknown;
}

/**
 * Which CRM module to target. Mirrors `AudienceModule` in audience.ts but
 * lives here so crm.ts has no dependency on audience.ts.
 */
export type CrmSearchModule = "leads" | "contacts" | "accounts" | "deals";

/**
 * Translate generic filter rules into the connected CRM's native search
 * shape, dispatch the call, and return normalized records. The audience
 * resolver uses this; non-audience callers should keep using
 * `searchLeads` / `searchContacts` for identity lookups.
 *
 * When `module` is provided, only that module is queried. When omitted,
 * we call *both* leads and contacts - the legacy behavior, since broadcast
 * audiences without an explicit module commonly straddle the two.
 * Accounts/deals go through `module:` only (no implicit fan-out) and are
 * skipped on providers where searchByRules doesn't have an adapter for them.
 */
export async function searchByRules(
  tenantId: string,
  identityHints: CrmLookupArgs,
  rules: CrmFilterRule[],
  ctx?: Partial<AgentToolContext>,
  module?: CrmSearchModule,
): Promise<{ rows: CrmRecord[]; skipped: CrmFilterRule[]; provider: CrmConnection | null }> {
  const conn = await getConnectedCrm(tenantId);
  if (!conn) return { rows: [], skipped: rules, provider: null };

  if (conn.slug.startsWith("zoho")) {
    return zohoSearchByRules(tenantId, conn, identityHints, rules, ctx, module);
  }
  if (conn.slug === "hubspot") {
    return hubspotSearchByRules(tenantId, conn, identityHints, rules, ctx, module);
  }
  if (conn.slug === "salesforce") {
    return salesforceSearchByRules(tenantId, conn, identityHints, rules, ctx, module);
  }
  if (conn.slug === "monday") {
    return mondaySearchByRules(tenantId, conn, identityHints, rules, ctx, module);
  }
  return { rows: [], skipped: rules, provider: conn };
}

// ─── Zoho ────────────────────────────────────────────────────

async function zohoSearchByRules(
  tenantId: string,
  conn: CrmConnection,
  identityHints: CrmLookupArgs,
  rules: CrmFilterRule[],
  ctx?: Partial<AgentToolContext>,
  module?: CrmSearchModule,
): Promise<{ rows: CrmRecord[]; skipped: CrmFilterRule[]; provider: CrmConnection }> {
  const { criteria, skipped } = buildZohoCriteria(rules);
  const args: CrmLookupArgs = { ...identityHints };
  if (criteria) args.criteria = criteria;
  if (!args.phone && !args.email && !args.name && !args.company && !args.criteria) {
    return { rows: [], skipped, provider: conn };
  }
  // Module routing: when explicit, query only that module. accounts/deals
  // fall through to "no rows" - Zoho has those modules but messageable
  // segments are leads/contacts; the audience resolver surfaces this as
  // skipped rules so the operator sees nothing matched.
  const wantLeads = module === undefined || module === "leads";
  const wantContacts = module === undefined || module === "contacts";
  const calls: Array<Promise<CrmRecord[]>> = [];
  if (wantLeads) calls.push(runSearch(tenantId, "lead_search", args, ctx));
  if (wantContacts) calls.push(runSearch(tenantId, "contact_search", args, ctx));
  const results = await Promise.all(calls);
  const dedup = new Map<string, CrmRecord>();
  for (const r of results.flat()) {
    const key = r.email?.toLowerCase() || r.phone?.toLowerCase() || r.id;
    if (key && !dedup.has(key)) dedup.set(key, r);
  }
  return { rows: Array.from(dedup.values()), skipped, provider: conn };
}

function buildZohoCriteria(rules: CrmFilterRule[]): { criteria: string; skipped: CrmFilterRule[] } {
  const parts: string[] = [];
  const skipped: CrmFilterRule[] = [];
  for (const r of rules) {
    const e = zohoExpr(r);
    if (e) parts.push(e);
    else skipped.push(r);
  }
  if (parts.length === 0) return { criteria: "", skipped };
  if (parts.length === 1) return { criteria: parts[0], skipped };
  return { criteria: parts.join("and"), skipped };
}

function zohoExpr(r: CrmFilterRule): string | null {
  const f = r.field;
  const v = r.value;
  const empty = v === undefined || v === null || v === "";
  switch (r.op) {
    case "equals":      return empty ? null : `(${f}:equals:${escZ(v)})`;
    case "not_equals":  return empty ? null : `(${f}:not_equal:${escZ(v)})`;
    case "contains":    return empty ? null : `(${f}:contains:${escZ(v)})`;
    case "starts_with": return empty ? null : `(${f}:starts_with:${escZ(v)})`;
    case "ends_with":   return empty ? null : `(${f}:contains:${escZ(v)})`;
    case "gt":          return empty ? null : `(${f}:greater_than:${escZ(v)})`;
    case "gte":         return empty ? null : `(${f}:greater_equal:${escZ(v)})`;
    case "lt":          return empty ? null : `(${f}:less_than:${escZ(v)})`;
    case "lte":         return empty ? null : `(${f}:less_equal:${escZ(v)})`;
    case "before":      return empty ? null : `(${f}:less_than:${escZ(v)})`;
    case "after":       return empty ? null : `(${f}:greater_than:${escZ(v)})`;
    case "in_last_days": {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      return `(${f}:greater_than:${new Date(Date.now() - n * 86400_000).toISOString()})`;
    }
    case "in":
      return Array.isArray(v) && v.length
        ? (v.length === 1 ? `(${f}:equals:${escZ(v[0])})` : `(${v.map((x) => `(${f}:equals:${escZ(x)})`).join("or")})`)
        : null;
    case "not_in":
      return Array.isArray(v) && v.length
        ? (v.length === 1 ? `(${f}:not_equal:${escZ(v[0])})` : `(${v.map((x) => `(${f}:not_equal:${escZ(x)})`).join("and")})`)
        : null;
    case "exists":
    case "not_exists":
      return null; // Zoho criteria has no null operator.
    default:
      return null;
  }
}

function escZ(v: unknown): string {
  return String(v).replace(/[()]/g, "").replace(/,/g, "\\,");
}

// ─── HubSpot ─────────────────────────────────────────────────

async function hubspotSearchByRules(
  tenantId: string,
  conn: CrmConnection,
  identityHints: CrmLookupArgs,
  rules: CrmFilterRule[],
  ctx?: Partial<AgentToolContext>,
  module?: CrmSearchModule,
): Promise<{ rows: CrmRecord[]; skipped: CrmFilterRule[]; provider: CrmConnection }> {
  const { filterGroups, skipped } = buildHubspotFilterGroups(rules, identityHints);
  if (filterGroups.length === 0 && !identityHints.phone && !identityHints.email && !identityHints.name) {
    return { rows: [], skipped, provider: conn };
  }
  const query = identityHints.email || identityHints.phone || identityHints.name || undefined;
  const wantLeads = module === undefined || module === "leads";
  const wantContacts = module === undefined || module === "contacts";
  const calls: Array<Promise<{ ok: boolean; output?: unknown; error?: string } | null>> = [];
  if (wantLeads) calls.push(runAdapterTool(tenantId, "hubspot.search_with_criteria", { object: "leads", filterGroups, query, limit: 200 }, ctx));
  if (wantContacts) calls.push(runAdapterTool(tenantId, "hubspot.search_with_criteria", { object: "contacts", filterGroups, query, limit: 200 }, ctx));
  const results = await Promise.all(calls);
  const rows = results.flatMap((r) => (r?.ok ? normalizeRows("hubspot", r.output) : []));
  const dedup = new Map<string, CrmRecord>();
  for (const r of rows) {
    const key = r.email?.toLowerCase() || r.phone?.toLowerCase() || r.id;
    if (key && !dedup.has(key)) dedup.set(key, r);
  }
  return { rows: Array.from(dedup.values()), skipped, provider: conn };
}

function buildHubspotFilterGroups(
  rules: CrmFilterRule[],
  hints: CrmLookupArgs,
): { filterGroups: any[]; skipped: CrmFilterRule[] } {
  const filters: any[] = [];
  const skipped: CrmFilterRule[] = [];
  // HubSpot identity hints become EQ filters on the standard properties.
  if (hints.email) filters.push({ propertyName: "email", operator: "EQ", value: hints.email });
  if (hints.phone) filters.push({ propertyName: "phone", operator: "EQ", value: hints.phone });
  for (const r of rules) {
    const f = hubspotFilterFor(r);
    if (f) filters.push(f);
    else skipped.push(r);
  }
  if (filters.length === 0) return { filterGroups: [], skipped };
  return { filterGroups: [{ filters }], skipped };
}

function hubspotFilterFor(r: CrmFilterRule): any | null {
  const propertyName = r.field;
  const v = r.value;
  const empty = v === undefined || v === null || v === "";
  switch (r.op) {
    case "equals":      return empty ? null : { propertyName, operator: "EQ", value: String(v) };
    case "not_equals":  return empty ? null : { propertyName, operator: "NEQ", value: String(v) };
    case "contains":    return empty ? null : { propertyName, operator: "CONTAINS_TOKEN", value: String(v) };
    case "starts_with": return empty ? null : { propertyName, operator: "CONTAINS_TOKEN", value: String(v) };
    case "ends_with":   return empty ? null : { propertyName, operator: "CONTAINS_TOKEN", value: String(v) };
    case "gt":          return empty ? null : { propertyName, operator: "GT", value: String(v) };
    case "gte":         return empty ? null : { propertyName, operator: "GTE", value: String(v) };
    case "lt":          return empty ? null : { propertyName, operator: "LT", value: String(v) };
    case "lte":         return empty ? null : { propertyName, operator: "LTE", value: String(v) };
    case "before":      return empty ? null : { propertyName, operator: "LT", value: String(v) };
    case "after":       return empty ? null : { propertyName, operator: "GT", value: String(v) };
    case "in_last_days": {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      return { propertyName, operator: "GT", value: new Date(Date.now() - n * 86400_000).toISOString() };
    }
    case "in":          return Array.isArray(v) && v.length ? { propertyName, operator: "IN", values: v.map(String) } : null;
    case "not_in":      return Array.isArray(v) && v.length ? { propertyName, operator: "NOT_IN", values: v.map(String) } : null;
    case "exists":      return { propertyName, operator: "HAS_PROPERTY" };
    case "not_exists":  return { propertyName, operator: "NOT_HAS_PROPERTY" };
    default:            return null;
  }
}

// ─── Salesforce ──────────────────────────────────────────────

async function salesforceSearchByRules(
  tenantId: string,
  conn: CrmConnection,
  identityHints: CrmLookupArgs,
  rules: CrmFilterRule[],
  ctx?: Partial<AgentToolContext>,
  module?: CrmSearchModule,
): Promise<{ rows: CrmRecord[]; skipped: CrmFilterRule[]; provider: CrmConnection }> {
  const { where, skipped } = buildSoqlWhere(rules, identityHints);
  if (!where && !identityHints.phone && !identityHints.email && !identityHints.name) {
    return { rows: [], skipped, provider: conn };
  }
  const wantLeads = module === undefined || module === "leads";
  const wantContacts = module === undefined || module === "contacts";
  const calls: Array<Promise<{ ok: boolean; output?: unknown; error?: string } | null>> = [];
  if (wantLeads) calls.push(runAdapterTool(tenantId, "salesforce.search_with_criteria", { sobject: "Lead", where, limit: 200 }, ctx));
  if (wantContacts) calls.push(runAdapterTool(tenantId, "salesforce.search_with_criteria", { sobject: "Contact", where, limit: 200 }, ctx));
  const results = await Promise.all(calls);
  const rows = results.flatMap((r) => (r?.ok ? normalizeRows("salesforce", r.output) : []));
  const dedup = new Map<string, CrmRecord>();
  for (const r of rows) {
    const key = r.email?.toLowerCase() || r.phone?.toLowerCase() || r.id;
    if (key && !dedup.has(key)) dedup.set(key, r);
  }
  return { rows: Array.from(dedup.values()), skipped, provider: conn };
}

function buildSoqlWhere(
  rules: CrmFilterRule[],
  hints: CrmLookupArgs,
): { where: string; skipped: CrmFilterRule[] } {
  const parts: string[] = [];
  const skipped: CrmFilterRule[] = [];
  if (hints.email) parts.push(`Email = '${escSoql(hints.email)}'`);
  if (hints.phone) parts.push(`Phone = '${escSoql(hints.phone)}'`);
  for (const r of rules) {
    const e = soqlExpr(r);
    if (e) parts.push(e);
    else skipped.push(r);
  }
  return { where: parts.join(" AND "), skipped };
}

function soqlExpr(r: CrmFilterRule): string | null {
  const f = r.field;
  const v = r.value;
  const empty = v === undefined || v === null || v === "";
  const numeric = typeof v === "number" || (typeof v === "string" && /^[0-9.]+$/.test(v));
  const lit = (val: unknown) => numeric ? String(val) : `'${escSoql(String(val))}'`;
  switch (r.op) {
    case "equals":      return empty ? null : `${f} = ${lit(v)}`;
    case "not_equals":  return empty ? null : `${f} != ${lit(v)}`;
    case "contains":    return empty ? null : `${f} LIKE '%${escSoql(String(v))}%'`;
    case "starts_with": return empty ? null : `${f} LIKE '${escSoql(String(v))}%'`;
    case "ends_with":   return empty ? null : `${f} LIKE '%${escSoql(String(v))}'`;
    case "gt":          return empty ? null : `${f} > ${lit(v)}`;
    case "gte":         return empty ? null : `${f} >= ${lit(v)}`;
    case "lt":          return empty ? null : `${f} < ${lit(v)}`;
    case "lte":         return empty ? null : `${f} <= ${lit(v)}`;
    case "before":      return empty ? null : `${f} < ${String(v)}`;
    case "after":       return empty ? null : `${f} > ${String(v)}`;
    case "in_last_days": {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      return `${f} = LAST_N_DAYS:${n}`;
    }
    case "in":
      return Array.isArray(v) && v.length ? `${f} IN (${v.map(lit).join(",")})` : null;
    case "not_in":
      return Array.isArray(v) && v.length ? `${f} NOT IN (${v.map(lit).join(",")})` : null;
    case "exists":      return `${f} != null`;
    case "not_exists":  return `${f} = null`;
    default:            return null;
  }
}

function escSoql(s: string): string {
  return s.replace(/'/g, "\\'");
}

// ─── Monday ──────────────────────────────────────────────────

async function mondaySearchByRules(
  tenantId: string,
  conn: CrmConnection,
  identityHints: CrmLookupArgs,
  rules: CrmFilterRule[],
  ctx?: Partial<AgentToolContext>,
  module?: CrmSearchModule,
): Promise<{ rows: CrmRecord[]; skipped: CrmFilterRule[]; provider: CrmConnection }> {
  // Monday has no native global search across boards, so identityHints are
  // expressed as additional column rules at best-effort. The audience UI
  // primarily drives the criteria-rule path.
  const { columnRules, skipped } = buildMondayColumnRules(rules);
  const wantLeads = module === undefined || module === "leads";
  const wantContacts = module === undefined || module === "contacts";
  const calls: Array<Promise<{ ok: boolean; output?: unknown; error?: string } | null>> = [];
  if (wantLeads) calls.push(runAdapterTool(tenantId, "monday.search_with_criteria", { object: "leads", column_rules: columnRules, limit: 500 }, ctx));
  if (wantContacts) calls.push(runAdapterTool(tenantId, "monday.search_with_criteria", { object: "contacts", column_rules: columnRules, limit: 500 }, ctx));
  const results = await Promise.all(calls);
  const rows = results.flatMap((r) => (r?.ok ? normalizeRows("monday", r.output) : []));
  const dedup = new Map<string, CrmRecord>();
  for (const r of rows) {
    const key = r.email?.toLowerCase() || r.phone?.toLowerCase() || r.id;
    if (key && !dedup.has(key)) dedup.set(key, r);
  }
  // identity-only hints can't be translated cleanly without column id
  // mapping - surface as skipped so the caller can hint at config gaps.
  void identityHints;
  return { rows: Array.from(dedup.values()), skipped, provider: conn };
}

function buildMondayColumnRules(
  rules: CrmFilterRule[],
): { columnRules: Array<{ column_id: string; values: string[] }>; skipped: CrmFilterRule[] } {
  const columnRules: Array<{ column_id: string; values: string[] }> = [];
  const skipped: CrmFilterRule[] = [];
  for (const r of rules) {
    // Monday's items_page_by_column_values matches values per column id.
    // Only equals/in are natively supported there; richer comparisons
    // (gt/lt/contains) need a different query path and are deferred.
    if (r.op === "equals" && r.value !== undefined && r.value !== null && r.value !== "") {
      columnRules.push({ column_id: r.field, values: [String(r.value)] });
    } else if (r.op === "in" && Array.isArray(r.value) && r.value.length > 0) {
      columnRules.push({ column_id: r.field, values: r.value.map(String) });
    } else {
      skipped.push(r);
    }
  }
  return { columnRules, skipped };
}
