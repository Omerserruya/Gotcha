/**
 * Per-vendor CRMAdapter implementations.
 *
 * These adapters wrap the existing ProviderAdapter-based tools
 * (in hubspot.adapter.ts, salesforce.adapter.ts) by calling
 * `executeAdapterTool()`, which gives us OAuth refresh + rate limit + audit
 * for free.
 *
 * Each implementation declares its `capabilities` so callers can branch
 * on what the vendor actually supports.
 *
 * v1 scope:
 *   • findCustomer       — phone/email lookup
 *   • getCustomerContext — contact + last 5 activities
 *   • createLead         — when CRM doesn't have them yet
 *   • createNote         — manual notes from the chat panel
 *   • appendInteraction  — close-of-conversation summary + engagement
 *
 * Reserved for later: createTask, createTicket, mergeContacts, splitContacts,
 * subscribeToChanges, parseWebhook, pollChanges. The interface in
 * `crm-adapter.types.ts` only models v1 methods so type checks stay tight.
 */

import { executeAdapterTool, loadConnection } from "./integration-framework";
import {
  DEFAULT_CAPABILITIES,
  GOTCHA_CUSTOM_FIELDS,
  notImplemented,
  type CRMAdapter,
  type CanonicalCrmContact,
  type CrmActivity,
  type CrmAdapterCapabilities,
  type CrmAdapterContextResult,
  type CrmAdapterFindResult,
  type CrmAdapterWriteResult,
  type CrmContactCreatePayload,
  type CrmCustomerContext,
  type CrmDeal,
  type CrmEnrichArgs,
  type CrmFindByCustomFieldArgs,
  type CrmMergeArgs,
  type CrmMergeResult,
  type CrmObjectKind,
  type CrmTask,
  type CrmTicket,
  type CrmVendor,
  type AppendInteractionArgs,
  type CreateNoteArgs,
  type InteractionEnvelope,
} from "./crm-adapter.types";
import { coerceSearchPhone, normalizeEmail, normalizePhone } from "./crm-identity.service";

// ─── Shared helpers ─────────────────────────────────────────

function nowIso(): string { return new Date().toISOString(); }

/**
 * Per-locale labels for the CRM activity note. Falls back to English when
 * the tenant's effective locale isn't represented here. Add a new locale
 * by adding its block — `renderInteractionBody` picks it up automatically.
 */
interface NoteLabels {
  inbound: string; outbound: string;
  duration: string; messages: string;
  started: string; ended: string;
  summary: string; sentiment: string;
  qualification: string; actionItems: string;
  minutesShort: string; secondsShort: string;
}

const NOTE_LABELS: Record<string, NoteLabels> = {
  en: {
    inbound: "Inbound", outbound: "Outbound",
    duration: "Duration", messages: "Messages",
    started: "Started", ended: "Ended",
    summary: "Summary", sentiment: "Sentiment",
    qualification: "Qualification", actionItems: "Action items",
    minutesShort: "m", secondsShort: "s",
  },
  he: {
    inbound: "נכנסת", outbound: "יוצאת",
    duration: "משך", messages: "הודעות",
    started: "התחלה", ended: "סיום",
    summary: "סיכום", sentiment: "סנטימנט",
    qualification: "כשירות", actionItems: "פעולות לביצוע",
    minutesShort: "ד׳", secondsShort: "ש׳",
  },
};

function resolveNoteLabels(locale?: string): NoteLabels {
  if (locale && NOTE_LABELS[locale]) return NOTE_LABELS[locale];
  return NOTE_LABELS.en;
}

/**
 * Format an interaction envelope as plain-text note body.
 * Used by adapters whose `appendInteraction` falls back to "createNote".
 * Labels are localized via `i.locale` (set by syncCloseToCrm from the
 * tenant's effective system language).
 */
export function renderInteractionBody(i: InteractionEnvelope): string {
  const L = resolveNoteLabels(i.locale);
  const lines: string[] = [];
  const channel = i.channel.toUpperCase();
  const dir = i.direction === "inbound" ? L.inbound : L.outbound;
  lines.push(`GOTCHA — ${dir} ${channel}`);
  if (i.duration_seconds != null) lines.push(`${L.duration}: ${formatDuration(i.duration_seconds, L)}`);
  if (i.message_count != null) lines.push(`${L.messages}: ${i.message_count}`);
  if (i.started_at) lines.push(`${L.started}: ${i.started_at}`);
  if (i.ended_at) lines.push(`${L.ended}: ${i.ended_at}`);
  lines.push("");
  if (i.summary) lines.push(`${L.summary}:`, i.summary.trim(), "");
  const eng = i.engagement || {};
  if (eng.sentiment) lines.push(`${L.sentiment}: ${eng.sentiment}`);
  if (eng.qualification) lines.push(`${L.qualification}: ${eng.qualification}`);
  if (Array.isArray(eng.action_items) && eng.action_items.length) {
    lines.push("", `${L.actionItems}:`);
    for (const a of eng.action_items) lines.push(`- ${a}`);
  }
  lines.push("", `[gotcha_source_interaction_id=${i.source_interaction_id}]`);
  return lines.join("\n").trim();
}

function formatDuration(seconds: number, L: NoteLabels): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return `0${L.secondsShort}`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}${L.minutesShort} ${s}${L.secondsShort}` : `${s}${L.secondsShort}`;
}

// ─── HubSpot ────────────────────────────────────────────────

export class HubSpotCRMAdapter implements CRMAdapter {
  readonly vendor: CrmVendor = "hubspot";
  readonly capabilities: CrmAdapterCapabilities = DEFAULT_CAPABILITIES.hubspot;
  constructor(public readonly tenantId: string) {}

  async findCustomer(query: { phone?: string; email?: string; external_id?: string }): Promise<CrmAdapterFindResult> {
    // Defense-in-depth normalization — identity service normalizes too, but
    // direct callers shouldn't bypass. Phone uses the *lax* coercion so the
    // identity service can probe multiple variants of the same number
    // (with/without +, national form, etc.) without each adapter snapping
    // them back to strict E.164.
    const email = normalizeEmail(query.email);
    const phone = coerceSearchPhone(query.phone);
    if (!email && !phone && !query.external_id) {
      return { ok: false, contacts: [], reason: "no_query" };
    }

    // Prefer email exact match via get_contact (uses search EQ filter under the hood).
    if (email) {
      const r = await executeAdapterTool({
        tenantId: this.tenantId,
        toolFunctionName: "hubspot.get_contact",
        args: { email },
      });
      if (!r.ok) return { ok: false, contacts: [], reason: r.reason };
      const contact = mapHubSpotContact(r.result);
      return { ok: true, contacts: contact ? [contact] : [] };
    }

    // Phone search via search_with_criteria with phone or mobilephone filter.
    if (phone) {
      const r = await executeAdapterTool({
        tenantId: this.tenantId,
        toolFunctionName: "hubspot.search_with_criteria",
        args: {
          object: "contacts",
          filterGroups: [
            { filters: [{ propertyName: "phone", operator: "EQ", value: phone }] },
            { filters: [{ propertyName: "mobilephone", operator: "EQ", value: phone }] },
          ],
          limit: 5,
        },
      });
      if (!r.ok) return { ok: false, contacts: [], reason: r.reason };
      const list = Array.isArray(r.result) ? r.result : [];
      return { ok: true, contacts: list.map(mapHubSpotContact).filter(Boolean) as CanonicalCrmContact[] };
    }

    // External id passthrough — HubSpot uses contact_id (the HubSpot id).
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "hubspot.get_contact",
      args: { contact_id: query.external_id },
    });
    if (!r.ok) return { ok: false, contacts: [], reason: r.reason };
    const contact = mapHubSpotContact(r.result);
    return { ok: true, contacts: contact ? [contact] : [] };
  }

  async findByCustomField(args: CrmFindByCustomFieldArgs): Promise<CrmAdapterFindResult> {
    if (!args.field || !args.value) return { ok: false, contacts: [], reason: "no_query" };
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "hubspot.search_with_criteria",
      args: {
        object: "contacts",
        filterGroups: [{ filters: [{ propertyName: args.field, operator: "EQ", value: args.value }] }],
        limit: 5,
      },
    });
    if (!r.ok) return { ok: false, contacts: [], reason: r.reason };
    const list = Array.isArray(r.result) ? r.result : [];
    return { ok: true, contacts: list.map(mapHubSpotContact).filter(Boolean) as CanonicalCrmContact[] };
  }

  async getCustomerContext(args: { contact_id: string; kind: CrmObjectKind }): Promise<CrmAdapterContextResult> {
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "hubspot.get_contact",
      args: { contact_id: args.contact_id },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    const contact = mapHubSpotContact(r.result);
    if (!contact) return { ok: false, reason: "contact_not_found" };

    // v1: deals + tickets + activities not yet fetched (avoid extra API calls).
    // Phase 2 wires associations; for the side panel we ship contact + empty
    // arrays so the UI renders cleanly.
    const ctx: CrmCustomerContext = {
      contact,
      recent_activities: [],
      deals: [],
      tickets: [],
    };
    return { ok: true, context: ctx };
  }

  async createLead(payload: CrmContactCreatePayload): Promise<CrmAdapterWriteResult & { kind: CrmObjectKind }> {
    const email = normalizeEmail(payload.email);
    const phone = normalizePhone(payload.phone);
    // HubSpot Pro/Starter don't have Leads — default to Contact upsert. Tenants on
    // Sales Hub Enterprise can override via tenant config (Phase 2).
    if (!email && !phone) {
      return { ok: false, kind: "contact", reason: "email_or_phone_required" };
    }
    if (email) {
      const r = await executeAdapterTool({
        tenantId: this.tenantId,
        toolFunctionName: "hubspot.create_contact",
        args: {
          email,
          firstname: payload.first_name,
          lastname: payload.last_name,
          phone: phone ?? undefined,
          company: payload.company,
          source: payload.source ?? "GOTCHA",
        },
      });
      if (!r.ok) return { ok: false, kind: "contact", reason: r.reason };
      const id = (r.result as any)?.id ?? (r.result as any)?.results?.[0]?.id;
      // Best-effort: persist channel custom fields via update_contact. If the
      // tenant hasn't defined these properties, HubSpot rejects the patch and
      // we log + move on — the create itself succeeded.
      if (id && payload.custom && Object.keys(payload.custom).length) {
        await executeAdapterTool({
          tenantId: this.tenantId,
          toolFunctionName: "hubspot.update_contact",
          args: { contact_id: id, properties: payload.custom },
        }).catch((err: any) => console.warn("[hubspot-adapter] custom field write on create failed:", err?.message));
      }
      return { ok: true, kind: "contact", id };
    }
    // Phone-only — HubSpot upsert requires email; the public create endpoint
    // refuses phone-only creates. Surface a clear reason; identity service
    // routes this back to the panel as `error`.
    return { ok: false, kind: "contact", reason: "hubspot_requires_email_for_create" };
  }

  async enrichContact(args: CrmEnrichArgs): Promise<CrmAdapterWriteResult> {
    const properties: Record<string, string> = {};
    const email = normalizeEmail(args.update.email);
    const phone = normalizePhone(args.update.phone);
    if (email) properties.email = email;
    if (phone) properties.phone = phone;
    if (args.update.display_name) {
      const [first, ...rest] = args.update.display_name.trim().split(/\s+/);
      if (first) properties.firstname = first;
      if (rest.length) properties.lastname = rest.join(" ");
    }
    if (args.update.custom) {
      for (const [k, v] of Object.entries(args.update.custom)) {
        if (typeof v === "string" && v) properties[k] = v;
      }
    }
    if (Object.keys(properties).length === 0) return { ok: true };

    const toolName = args.kind === "lead" ? "hubspot.update_lead" : "hubspot.update_contact";
    const idField  = args.kind === "lead" ? "lead_id"             : "contact_id";
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: toolName,
      args: { [idField]: args.contact_id, properties },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: args.contact_id, was_update: true };
  }

  async createTask(args: {
    contact_id: string;
    kind: CrmObjectKind;
    subject: string;
    body?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    due_at?: string;
    source_interaction_id?: string;
  }): Promise<CrmAdapterWriteResult> {
    // HubSpot's adapter tool surface today is `hubspot.log_activity` with
    // kinds NOTE/EMAIL/CALL — no first-class TASK. Degrade by writing a NOTE
    // prefixed with "TODO:" so the action is at least visible on the
    // record's timeline (and search-discoverable in HubSpot).
    const head = `TODO: ${args.subject}` + (args.priority ? ` [priority=${args.priority}]` : "")
      + (args.due_at ? ` (due ${args.due_at})` : "");
    const body = args.body ? `${head}\n\n${args.body}` : head;
    const finalBody = augmentBodyWithMarker(body, args.source_interaction_id, undefined, undefined);
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "hubspot.log_activity",
      args: { contact_id: args.contact_id, kind: "NOTE", body: finalBody },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: (r.result as any)?.id, was_update: false };
  }

  async updateRecord(args: { id: string; kind: CrmObjectKind; fields: Record<string, unknown> }): Promise<CrmAdapterWriteResult> {
    // HubSpot has the same update tool surface as enrichContact (update_lead /
    // update_contact). Pass the sparse `fields` straight through — the LLM is
    // responsible for using HubSpot property names (the summarizer's
    // allowedFields list is the contract).
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args.fields ?? {})) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      properties[k] = v;
    }
    if (Object.keys(properties).length === 0) return { ok: true, id: args.id, was_update: false };

    const toolName = args.kind === "lead" ? "hubspot.update_lead" : "hubspot.update_contact";
    const idField  = args.kind === "lead" ? "lead_id"             : "contact_id";
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: toolName,
      args: { [idField]: args.id, properties },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: args.id, was_update: true };
  }

  async mergeContacts(_args: CrmMergeArgs): Promise<CrmMergeResult> {
    // HubSpot exposes POST /crm/v3/objects/contacts/merge but the tool isn't
    // wired through executeAdapterTool yet. Return not_implemented so the
    // identity service falls through to operator approval.
    return { ok: false, reason: notImplemented("mergeContacts", "hubspot").reason };
  }

  async createNote(args: CreateNoteArgs): Promise<CrmAdapterWriteResult> {
    // HubSpot log_activity (NOTE) → /crm/v3/objects/notes + association.
    const body = augmentBodyWithMarker(args.body, args.source_interaction_id, args.source_outbox_id, args.payload_version);
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "hubspot.log_activity",
      args: { contact_id: args.contact_id, kind: "NOTE", body },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: (r.result as any)?.id, was_update: false };
  }

  async appendInteraction(args: AppendInteractionArgs): Promise<CrmAdapterWriteResult> {
    // HubSpot has Engagements for call / email / note. For v1 we project every
    // channel as NOTE (uniform body via renderInteractionBody) — Phase 2 splits
    // voice → CALL, email → EMAIL.
    const body = renderInteractionBody({
      ...args.interaction,
      // Ensure marker is present even if caller forgot.
      source_interaction_id: args.interaction.source_interaction_id,
    });
    const finalBody = augmentBodyWithMarker(body, args.interaction.source_interaction_id, args.source_outbox_id, args.payload_version);
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "hubspot.log_activity",
      args: { contact_id: args.contact_id, kind: "NOTE", body: finalBody },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: (r.result as any)?.id, was_update: false };
  }

  async listTasks(_args: { contact_id: string; kind: CrmObjectKind; openOnly?: boolean; limit?: number }): Promise<{ ok: boolean; tasks: CrmTask[]; reason?: string }> {
    // HubSpot tasks are `tasks` engagement objects. The existing tool surface
    // doesn't expose engagement listing; surface empty so the panel renders
    // cleanly. Phase 2 wires `hubspot.list_engagements` for full coverage.
    return { ok: true, tasks: [] };
  }

  async listRecentNotes(_args: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> {
    return { ok: true, activities: [] };
  }

  async listRecentActivities(_args: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> {
    // HubSpot timeline = engagements (notes/tasks/calls/emails/meetings)
    // exposed via /crm/v3/objects/{engagement-type}. Current tool surface
    // doesn't list engagements; Phase 2 wires `hubspot.list_engagements`.
    return { ok: true, activities: [] };
  }
}

function mapHubSpotContact(raw: unknown): CanonicalCrmContact | null {
  if (!raw || typeof raw !== "object") return null;
  const r: any = raw;
  const p = r.properties || {};
  const displayName = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || null;
  return {
    id: String(r.id),
    kind: "contact",
    display_name: displayName,
    email: p.email ?? null,
    phone: p.phone ?? p.mobilephone ?? null,
    owner_id: p.hubspot_owner_id ?? null,
    stage: p.lifecyclestage ?? null,
    custom_fields: p,
    vendor_updated_at: p.lastmodifieddate || r.updatedAt || nowIso(),
    fetched_at: nowIso(),
    vendor: "hubspot",
  };
}

// ─── Salesforce ─────────────────────────────────────────────

export class SalesforceCRMAdapter implements CRMAdapter {
  readonly vendor: CrmVendor = "salesforce";
  readonly capabilities: CrmAdapterCapabilities = DEFAULT_CAPABILITIES.salesforce;
  constructor(public readonly tenantId: string) {}

  async findCustomer(query: { phone?: string; email?: string; external_id?: string }): Promise<CrmAdapterFindResult> {
    const email = normalizeEmail(query.email);
    // Lax phone coercion: identity service probes multiple variants of the
    // same number — preserve whatever shape it asked for so we don't snap
    // them all back to strict E.164.
    const phone = coerceSearchPhone(query.phone);
    if (!email && !phone && !query.external_id) {
      return { ok: false, contacts: [], reason: "no_query" };
    }
    const clauses: string[] = [];
    if (email) clauses.push(`Email = '${escapeSoql(email)}'`);
    if (phone) clauses.push(`(Phone = '${escapeSoql(phone)}' OR MobilePhone = '${escapeSoql(phone)}')`);
    if (query.external_id) clauses.push(`Id = '${escapeSoql(query.external_id)}'`);
    const where = clauses.join(" OR ");

    // Try Lead first, then Contact — vendor norm is Lead-first for inbound.
    for (const sobject of ["Lead", "Contact"] as const) {
      const r = await executeAdapterTool({
        tenantId: this.tenantId,
        toolFunctionName: "salesforce.search_with_criteria",
        args: { sobject, where, limit: 5 },
      });
      if (!r.ok) continue;
      const list = Array.isArray(r.result) ? r.result : [];
      if (list.length) {
        return {
          ok: true,
          contacts: list.map((row: any) => mapSalesforceRow(row, sobject)).filter(Boolean) as CanonicalCrmContact[],
        };
      }
    }
    return { ok: true, contacts: [] };
  }

  async findByCustomField(args: CrmFindByCustomFieldArgs): Promise<CrmAdapterFindResult> {
    if (!args.field || !args.value) return { ok: false, contacts: [], reason: "no_query" };
    // Salesforce custom fields carry the `__c` suffix in the API.
    const field = args.field.endsWith("__c") ? args.field : `${args.field}__c`;
    const where = `${field} = '${escapeSoql(args.value)}'`;
    for (const sobject of ["Lead", "Contact"] as const) {
      const r = await executeAdapterTool({
        tenantId: this.tenantId,
        toolFunctionName: "salesforce.search_with_criteria",
        args: { sobject, where, limit: 5 },
      });
      if (!r.ok) continue;
      const list = Array.isArray(r.result) ? r.result : [];
      if (list.length) {
        return {
          ok: true,
          contacts: list.map((row: any) => mapSalesforceRow(row, sobject)).filter(Boolean) as CanonicalCrmContact[],
        };
      }
    }
    return { ok: true, contacts: [] };
  }

  async getCustomerContext(args: { contact_id: string; kind: CrmObjectKind }): Promise<CrmAdapterContextResult> {
    const sobject = args.kind === "lead" ? "Lead" : "Contact";
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "salesforce.get_record",
      args: { sobject, id: args.contact_id },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    const contact = mapSalesforceRow(r.result as any, sobject);
    if (!contact) return { ok: false, reason: "record_not_found" };
    return {
      ok: true,
      context: { contact, recent_activities: [], deals: [], tickets: [] },
    };
  }

  async createLead(payload: CrmContactCreatePayload): Promise<CrmAdapterWriteResult & { kind: CrmObjectKind }> {
    const email = normalizeEmail(payload.email);
    const phone = normalizePhone(payload.phone);
    const args: Record<string, unknown> = {
      FirstName: payload.first_name,
      LastName: payload.last_name || payload.display_name || "Unknown",
      Company: payload.company || payload.source || "GOTCHA Inbound",
      Email: email ?? undefined,
      Phone: phone ?? undefined,
      LeadSource: payload.source ?? "GOTCHA",
    };
    // Channel custom fields ride into the same create payload; Salesforce
    // accepts arbitrary __c properties on the Lead record.
    if (payload.custom) {
      for (const [k, v] of Object.entries(payload.custom)) {
        if (typeof v !== "string" || !v) continue;
        const key = k.endsWith("__c") ? k : `${k}__c`;
        args[key] = v;
      }
    }
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "salesforce.create_lead",
      args,
    });
    if (!r.ok) return { ok: false, kind: "lead", reason: r.reason };
    return { ok: true, kind: "lead", id: (r.result as any)?.id };
  }

  async enrichContact(args: CrmEnrichArgs): Promise<CrmAdapterWriteResult> {
    // v1 supports Lead enrichment (salesforce.update_lead). Contact enrichment
    // would require a salesforce.update_contact tool which doesn't exist yet —
    // surface a clean reason so the identity service degrades to was_enriched:false.
    if (args.kind !== "lead") {
      return { ok: false, reason: notImplemented("enrichContact:contact", "salesforce").reason };
    }
    const fields: Record<string, string> = {};
    const email = normalizeEmail(args.update.email);
    const phone = normalizePhone(args.update.phone);
    if (email) fields.Email = email;
    if (phone) fields.Phone = phone;
    if (args.update.display_name) {
      const [first, ...rest] = args.update.display_name.trim().split(/\s+/);
      if (first) fields.FirstName = first;
      if (rest.length) fields.LastName = rest.join(" ");
    }
    if (args.update.custom) {
      for (const [k, v] of Object.entries(args.update.custom)) {
        if (typeof v !== "string" || !v) continue;
        const key = k.endsWith("__c") ? k : `${k}__c`;
        fields[key] = v;
      }
    }
    if (Object.keys(fields).length === 0) return { ok: true };

    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "salesforce.update_lead",
      args: { id: args.contact_id, fields },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: args.contact_id, was_update: true };
  }

  async createTask(args: {
    contact_id: string;
    kind: CrmObjectKind;
    subject: string;
    body?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    due_at?: string;
    source_interaction_id?: string;
  }): Promise<CrmAdapterWriteResult> {
    // Salesforce Tasks live on the Task object. `salesforce.log_task` already
    // creates a Task — for a real OPEN task we set Status="Not Started"
    // (the note path uses Status="Completed"). WhoId works for Lead+Contact.
    const description = args.body
      ? augmentBodyWithMarker(args.body, args.source_interaction_id, undefined, undefined)
      : "";
    const sfPriority = args.priority === "high" || args.priority === "urgent"
      ? "High" : args.priority === "low" ? "Low" : "Normal";
    const fields: Record<string, unknown> = {
      WhoId: args.contact_id,
      Subject: args.subject,
      Status: "Not Started",
      Priority: sfPriority,
    };
    if (description) fields.Description = description;
    if (args.due_at) fields.ActivityDate = args.due_at;
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "salesforce.log_task",
      args: fields,
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: (r.result as any)?.id, was_update: false };
  }

  async updateRecord(args: { id: string; kind: CrmObjectKind; fields: Record<string, unknown> }): Promise<CrmAdapterWriteResult> {
    // Salesforce v1 has salesforce.update_lead but no salesforce.update_contact.
    // Contact-side fall-through is handled at the caller via createNote on the
    // contact timeline.
    if (args.kind !== "lead") {
      return { ok: false, reason: notImplemented("updateRecord:contact", "salesforce").reason };
    }
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args.fields ?? {})) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      fields[k] = v;
    }
    if (Object.keys(fields).length === 0) return { ok: true, id: args.id, was_update: false };

    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "salesforce.update_lead",
      args: { id: args.id, fields },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: args.id, was_update: true };
  }

  async mergeContacts(_args: CrmMergeArgs): Promise<CrmMergeResult> {
    // Salesforce has REST merge (POST /services/data/vXX.X/composite/sobjects/Lead/merge)
    // capped at 3 records per call; not yet wired through executeAdapterTool.
    return { ok: false, reason: notImplemented("mergeContacts", "salesforce").reason };
  }

  async createNote(args: CreateNoteArgs): Promise<CrmAdapterWriteResult> {
    // Salesforce: log a Task as the note carrier (capability_supported).
    // PATCH-in-place is supported but we don't have search_tasks via the existing
    // tool surface; for v1 we always create.
    const body = augmentBodyWithMarker(args.body, args.source_interaction_id, args.source_outbox_id, args.payload_version);
    const whoField = args.kind === "lead" ? "WhoId" : "WhoId"; // both Lead & Contact go on WhoId
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "salesforce.log_task",
      args: {
        [whoField]: args.contact_id,
        Subject: "GOTCHA Note",
        Description: body,
        Status: "Completed",
      },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: (r.result as any)?.id, was_update: false };
  }

  async appendInteraction(args: AppendInteractionArgs): Promise<CrmAdapterWriteResult> {
    const body = renderInteractionBody(args.interaction);
    const finalBody = augmentBodyWithMarker(body, args.interaction.source_interaction_id, args.source_outbox_id, args.payload_version);
    const subject = `GOTCHA — ${args.interaction.channel.toUpperCase()} ${args.interaction.direction}`;
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "salesforce.log_task",
      args: {
        WhoId: args.contact_id,
        Subject: subject,
        Description: finalBody,
        Status: "Completed",
      },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: (r.result as any)?.id, was_update: false };
  }

  async listTasks(_args: { contact_id: string; kind: CrmObjectKind; openOnly?: boolean; limit?: number }): Promise<{ ok: boolean; tasks: CrmTask[]; reason?: string }> {
    // Salesforce Task is a first-class sObject queryable via SOQL, but the
    // existing `salesforce.search_with_criteria` tool hardcodes SELECT to
    // Lead/Contact fields. Surface empty for v1; Phase 2 adds a generic
    // SOQL tool that handles Task fields directly.
    return { ok: true, tasks: [] };
  }

  async listRecentNotes(_args: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> {
    // Same constraint — SF Notes are ContentNote linked via ContentDocumentLink.
    // Empty for v1; Phase 2 wires the ContentNote query.
    return { ok: true, activities: [] };
  }

  async listRecentActivities(_args: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> {
    // Salesforce timeline = Task + Event records queryable via SOQL on WhoId.
    // Existing `salesforce.search_with_criteria` tool hardcodes SELECT to
    // Lead/Contact fields; Phase 2 adds a generic SOQL tool covering Task/Event.
    return { ok: true, activities: [] };
  }
}

function mapSalesforceRow(raw: any, sobject: string): CanonicalCrmContact | null {
  if (!raw || typeof raw !== "object") return null;
  const displayName = [raw.FirstName, raw.LastName].filter(Boolean).join(" ").trim() || raw.Name || null;
  return {
    id: String(raw.Id),
    kind: sobject === "Lead" ? "lead" : "contact",
    display_name: displayName,
    email: raw.Email ?? null,
    phone: raw.Phone ?? raw.MobilePhone ?? null,
    owner_id: raw.OwnerId ?? null,
    stage: raw.Status ?? raw.LeadSource ?? null,
    custom_fields: raw,
    vendor_updated_at: raw.LastModifiedDate || nowIso(),
    fetched_at: nowIso(),
    vendor: "salesforce",
  };
}

function escapeSoql(s: string): string {
  return String(s).replace(/'/g, "\\'");
}

// ─── Zoho CRM ───────────────────────────────────────────────
//
// Talks Zoho REST v6 directly with the `Zoho-oauthtoken` auth scheme
// (NOT Bearer). Region-specific base URL lives on TenantIntegration.config.baseUrl
// (e.g. https://www.zohoapis.com / .eu / .in). Token refresh routed through
// the existing zoho.service.ts so 1h expiry is handled transparently.

import { prisma } from "@chatcenter/shared";
import { maybeRefreshZohoToken } from "../zoho.service";

interface ZohoConnection {
  integrationId: string;
  accessToken: string;
  baseUrl: string; // https://www.zohoapis.com (region-specific)
}

async function loadZohoConnection(tenantId: string): Promise<{ ok: true; conn: ZohoConnection } | { ok: false; reason: string }> {
  const ti = await (prisma as any).tenantIntegration.findFirst({
    where: {
      tenantId,
      status: "CONNECTED",
      integration: { slug: "zoho_crm" },
    },
    select: { id: true, credentials: true, config: true },
  });
  if (!ti) return { ok: false, reason: "zoho_not_connected" };

  // Refresh if within expiry buffer; returns the FRESH access token (or stale on error).
  let accessToken: string | null = null;
  try {
    accessToken = await maybeRefreshZohoToken(ti.id);
  } catch (err: any) {
    console.warn("[zoho-adapter] token refresh failed:", err?.message);
  }
  if (!accessToken) {
    const creds = (ti.credentials as Record<string, any>) || {};
    accessToken = typeof creds.accessToken === "string" ? creds.accessToken : null;
  }
  if (!accessToken) return { ok: false, reason: "zoho_no_access_token" };

  const cfg = (ti.config as Record<string, any>) || {};
  const baseUrl = typeof cfg.baseUrl === "string" && cfg.baseUrl
    ? String(cfg.baseUrl).replace(/\/$/, "")
    : "https://www.zohoapis.com";

  return { ok: true, conn: { integrationId: ti.id, accessToken, baseUrl } };
}

async function zohoFetch(conn: ZohoConnection, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data?: any; reason?: string }> {
  const url = `${conn.baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Zoho-oauthtoken ${conn.accessToken}`,
    "Content-Type": "application/json",
  };
  try {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return { ok: true, status: 204 };
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    if (!res.ok) return { ok: false, status: res.status, data: parsed, reason: `zoho_${res.status}:${text.slice(0, 200)}` };
    return { ok: true, status: res.status, data: parsed };
  } catch (err: any) {
    return { ok: false, status: 0, reason: `zoho_network:${err?.message ?? "unknown"}` };
  }
}

function mapZohoRecord(raw: any, module: "Leads" | "Contacts"): CanonicalCrmContact | null {
  if (!raw || typeof raw !== "object") return null;
  const displayName =
    raw.Full_Name ||
    [raw.First_Name, raw.Last_Name].filter(Boolean).join(" ").trim() ||
    null;
  return {
    id: String(raw.id),
    kind: module === "Leads" ? "lead" : "contact",
    display_name: displayName,
    email: raw.Email ?? null,
    phone: raw.Phone ?? raw.Mobile ?? null,
    owner_id: raw.Owner?.id ?? null,
    stage: raw.Lead_Status ?? raw.Lead_Source ?? null,
    custom_fields: raw,
    vendor_updated_at: raw.Modified_Time || nowIso(),
    fetched_at: nowIso(),
    vendor: "zoho",
  };
}

export class ZohoCRMAdapter implements CRMAdapter {
  readonly vendor: CrmVendor = "zoho";
  readonly capabilities: CrmAdapterCapabilities = DEFAULT_CAPABILITIES.zoho;
  constructor(public readonly tenantId: string) {}

  async findCustomer(query: { phone?: string; email?: string; external_id?: string }): Promise<CrmAdapterFindResult> {
    const email = normalizeEmail(query.email);
    // Lax phone coercion: see HubSpot adapter for rationale.
    const phone = coerceSearchPhone(query.phone);
    if (!email && !phone && !query.external_id) {
      return { ok: false, contacts: [], reason: "no_query" };
    }
    const c = await loadZohoConnection(this.tenantId);
    if (!c.ok) return { ok: false, contacts: [], reason: c.reason };

    // External_id passthrough — assume it's a Lead id; let getCustomerContext
    // route Contact lookups via its own kind argument.
    if (query.external_id) {
      const r = await zohoFetch(c.conn, "GET", `/crm/v6/Leads/${encodeURIComponent(query.external_id)}`);
      const data = r.data?.data?.[0];
      const mapped = data ? mapZohoRecord(data, "Leads") : null;
      return { ok: r.ok, contacts: mapped ? [mapped] : [], reason: r.ok ? undefined : r.reason };
    }

    // Try Leads first, then Contacts. Zoho's search accepts `email` and `phone`
    // query params for exact match.
    const collected: CanonicalCrmContact[] = [];
    for (const mod of ["Leads", "Contacts"] as const) {
      const qsParts: string[] = [];
      if (email) qsParts.push(`email=${encodeURIComponent(email)}`);
      if (!email && phone) qsParts.push(`phone=${encodeURIComponent(phone)}`);
      const qs = qsParts.join("&");
      if (!qs) continue;
      const r = await zohoFetch(c.conn, "GET", `/crm/v6/${mod}/search?${qs}`);
      // 204 → no match
      if (r.status === 204) continue;
      if (!r.ok) continue;
      const list: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
      for (const row of list) {
        const mapped = mapZohoRecord(row, mod);
        if (mapped) collected.push(mapped);
      }
      if (collected.length) break; // prefer Lead match
    }
    return { ok: true, contacts: collected };
  }

  async findByCustomField(args: CrmFindByCustomFieldArgs): Promise<CrmAdapterFindResult> {
    if (!args.field || !args.value) return { ok: false, contacts: [], reason: "no_query" };
    const c = await loadZohoConnection(this.tenantId);
    if (!c.ok) return { ok: false, contacts: [], reason: c.reason };
    // Zoho COQL search: criteria=(field:equals:value). Field name is the API
    // name on Leads/Contacts; the tenant is expected to have created it.
    const criteria = `(${args.field}:equals:${args.value})`;
    const qs = `criteria=${encodeURIComponent(criteria)}`;
    const collected: CanonicalCrmContact[] = [];
    for (const mod of ["Leads", "Contacts"] as const) {
      const r = await zohoFetch(c.conn, "GET", `/crm/v6/${mod}/search?${qs}`);
      if (r.status === 204) continue;
      if (!r.ok) continue;
      const list: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
      for (const row of list) {
        const mapped = mapZohoRecord(row, mod);
        if (mapped) collected.push(mapped);
      }
      if (collected.length) break;
    }
    return { ok: true, contacts: collected };
  }

  async getCustomerContext(args: { contact_id: string; kind: CrmObjectKind }): Promise<CrmAdapterContextResult> {
    const c = await loadZohoConnection(this.tenantId);
    if (!c.ok) return { ok: false, reason: c.reason };
    const module = args.kind === "lead" ? "Leads" : "Contacts";
    const r = await zohoFetch(c.conn, "GET", `/crm/v6/${module}/${encodeURIComponent(args.contact_id)}`);
    if (!r.ok) return { ok: false, reason: r.reason };
    const data = r.data?.data?.[0];
    const contact = mapZohoRecord(data, module);
    if (!contact) return { ok: false, reason: "record_not_found" };
    return { ok: true, context: { contact, recent_activities: [], deals: [], tickets: [] } };
  }

  async createLead(payload: CrmContactCreatePayload): Promise<CrmAdapterWriteResult & { kind: CrmObjectKind }> {
    const c = await loadZohoConnection(this.tenantId);
    if (!c.ok) return { ok: false, kind: "lead", reason: c.reason };
    const email = normalizeEmail(payload.email);
    const phone = normalizePhone(payload.phone);
    const record: Record<string, unknown> = {
      Last_Name: payload.last_name || payload.display_name || "Unknown",
      First_Name: payload.first_name,
      Email: email,
      Phone: phone,
      Company: payload.company || payload.source || "GOTCHA Inbound",
      Lead_Source: payload.source ?? "GOTCHA",
    };
    // Channel custom fields — Zoho API names are case-sensitive but the keys
    // GOTCHA emits use snake_case which is the Zoho convention.
    if (payload.custom) {
      for (const [k, v] of Object.entries(payload.custom)) {
        if (typeof v === "string" && v) record[k] = v;
      }
    }
    const r = await zohoFetch(c.conn, "POST", `/crm/v6/Leads`, { data: [record] });
    if (!r.ok) return { ok: false, kind: "lead", reason: r.reason };
    const entry = r.data?.data?.[0];
    const status = entry?.status;
    const id = entry?.details?.id;
    if (status !== "success" || !id) {
      return { ok: false, kind: "lead", reason: `zoho_create_lead_${status ?? "unknown"}:${entry?.message ?? ""}` };
    }
    return { ok: true, kind: "lead", id: String(id) };
  }

  async enrichContact(args: CrmEnrichArgs): Promise<CrmAdapterWriteResult> {
    const c = await loadZohoConnection(this.tenantId);
    if (!c.ok) return { ok: false, reason: c.reason };
    const record: Record<string, unknown> = { id: args.contact_id };
    const email = normalizeEmail(args.update.email);
    const phone = normalizePhone(args.update.phone);
    if (email) record.Email = email;
    if (phone) record.Phone = phone;
    if (args.update.display_name) {
      const [first, ...rest] = args.update.display_name.trim().split(/\s+/);
      if (first) record.First_Name = first;
      if (rest.length) record.Last_Name = rest.join(" ");
    }
    if (args.update.custom) {
      for (const [k, v] of Object.entries(args.update.custom)) {
        if (typeof v === "string" && v) record[k] = v;
      }
    }
    // Just the id means nothing to update — short-circuit.
    if (Object.keys(record).length <= 1) return { ok: true };

    const mod = args.kind === "lead" ? "Leads" : "Contacts";
    const r = await zohoFetch(c.conn, "PUT", `/crm/v6/${mod}`, { data: [record] });
    if (!r.ok) return { ok: false, reason: r.reason };
    const entry = r.data?.data?.[0];
    if (entry?.status !== "success") return { ok: false, reason: `zoho_update_${entry?.status ?? "unknown"}:${entry?.message ?? ""}` };
    return { ok: true, id: args.contact_id, was_update: true };
  }

  async createTask(args: {
    contact_id: string;
    kind: CrmObjectKind;
    subject: string;
    body?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    due_at?: string;
    source_interaction_id?: string;
  }): Promise<CrmAdapterWriteResult> {
    // Zoho Tasks live in /crm/v6/Tasks. Who_Id references a Lead or Contact
    // (and $se_module names the parent module so Zoho associates correctly).
    const c = await loadZohoConnection(this.tenantId);
    if (!c.ok) return { ok: false, reason: c.reason };
    const description = args.body
      ? augmentBodyWithMarker(args.body, args.source_interaction_id, undefined, undefined)
      : undefined;
    const zPriority = args.priority === "urgent" ? "Highest"
      : args.priority === "high" ? "High"
      : args.priority === "low" ? "Low" : "Normal";
    const seModule = args.kind === "lead" ? "Leads" : "Contacts";
    const record: Record<string, unknown> = {
      Subject: args.subject,
      Status: "Not Started",
      Priority: zPriority,
      Who_Id: { id: args.contact_id, module: { api_name: seModule } },
      $se_module: seModule,
    };
    if (description) record.Description = description;
    if (args.due_at) record.Due_Date = args.due_at;
    const r = await zohoFetch(c.conn, "POST", `/crm/v6/Tasks`, { data: [record] });
    if (!r.ok) return { ok: false, reason: r.reason };
    const entry = r.data?.data?.[0];
    if (entry?.status !== "success") return { ok: false, reason: `zoho_task_${entry?.status ?? "unknown"}:${entry?.message ?? ""}` };
    return { ok: true, id: String(entry?.details?.id ?? ""), was_update: false };
  }

  async updateRecord(args: { id: string; kind: CrmObjectKind; fields: Record<string, unknown> }): Promise<CrmAdapterWriteResult> {
    const c = await loadZohoConnection(this.tenantId);
    if (!c.ok) return { ok: false, reason: c.reason };
    const record: Record<string, unknown> = { id: args.id };
    for (const [k, v] of Object.entries(args.fields ?? {})) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      record[k] = v;
    }
    if (Object.keys(record).length <= 1) return { ok: true, id: args.id, was_update: false };

    const mod = args.kind === "lead" ? "Leads" : "Contacts";
    const r = await zohoFetch(c.conn, "PUT", `/crm/v6/${mod}`, { data: [record] });
    if (!r.ok) return { ok: false, reason: r.reason };
    const entry = r.data?.data?.[0];
    if (entry?.status !== "success") return { ok: false, reason: `zoho_update_${entry?.status ?? "unknown"}:${entry?.message ?? ""}` };
    return { ok: true, id: args.id, was_update: true };
  }

  async mergeContacts(_args: CrmMergeArgs): Promise<CrmMergeResult> {
    // Zoho CRM v6 doesn't expose a public merge endpoint — manual dedup is
    // operator-driven in the Zoho UI. Identity service routes 2+ matches to
    // approval (the operator picks the survivor manually).
    return { ok: false, reason: notImplemented("mergeContacts", "zoho").reason };
  }

  async createNote(args: CreateNoteArgs): Promise<CrmAdapterWriteResult> {
    const c = await loadZohoConnection(this.tenantId);
    if (!c.ok) return { ok: false, reason: c.reason };
    const body = augmentBodyWithMarker(args.body, args.source_interaction_id, args.source_outbox_id, args.payload_version);
    const seModule = args.kind === "lead" ? "Leads" : "Contacts";
    const payload = {
      data: [{
        Note_Title: "GOTCHA Note",
        Note_Content: body,
        Parent_Id: { id: args.contact_id, module: { api_name: seModule } },
        se_module: seModule,
      }],
    };
    const r = await zohoFetch(c.conn, "POST", `/crm/v6/Notes`, payload);
    if (!r.ok) return { ok: false, reason: r.reason };
    const entry = r.data?.data?.[0];
    if (entry?.status !== "success") return { ok: false, reason: `zoho_note_${entry?.status ?? "unknown"}:${entry?.message ?? ""}` };
    return { ok: true, id: String(entry?.details?.id ?? ""), was_update: false };
  }

  async appendInteraction(args: AppendInteractionArgs): Promise<CrmAdapterWriteResult> {
    const c = await loadZohoConnection(this.tenantId);
    if (!c.ok) return { ok: false, reason: c.reason };
    const body = renderInteractionBody(args.interaction);
    const finalBody = augmentBodyWithMarker(body, args.interaction.source_interaction_id, args.source_outbox_id, args.payload_version);
    const seModule = args.kind === "lead" ? "Leads" : "Contacts";
    const title = `GOTCHA — ${args.interaction.channel.toUpperCase()} ${args.interaction.direction}`;
    const payload = {
      data: [{
        Note_Title: title,
        Note_Content: finalBody,
        Parent_Id: { id: args.contact_id, module: { api_name: seModule } },
        se_module: seModule,
      }],
    };
    const r = await zohoFetch(c.conn, "POST", `/crm/v6/Notes`, payload);
    if (!r.ok) return { ok: false, reason: r.reason };
    const entry = r.data?.data?.[0];
    if (entry?.status !== "success") return { ok: false, reason: `zoho_note_${entry?.status ?? "unknown"}:${entry?.message ?? ""}` };
    return { ok: true, id: String(entry?.details?.id ?? ""), was_update: false };
  }

  async listTasks(args: { contact_id: string; kind: CrmObjectKind; openOnly?: boolean; limit?: number }): Promise<{ ok: boolean; tasks: CrmTask[]; reason?: string }> {
    const c = await loadZohoConnection(this.tenantId);
    if (!c.ok) return { ok: false, tasks: [], reason: c.reason };
    // Zoho v6: search Tasks by What_Id (parent record). v6's related-list
    // endpoint (`/Leads/{id}/Tasks`) requires an explicit `fields` param;
    // search-by-criteria is simpler and returns full task records.
    const criteria = `(What_Id:equals:${args.contact_id})`;
    const r = await zohoFetch(c.conn, "GET", `/crm/v6/Tasks/search?criteria=${encodeURIComponent(criteria)}`);
    console.log(`[zoho.listTasks] contact=${args.contact_id} kind=${args.kind} status=${r.status} ok=${r.ok} reason=${r.reason ?? "-"} count=${Array.isArray(r.data?.data) ? r.data.data.length : 0}`);
    if (r.status === 204) return { ok: true, tasks: [] };
    if (!r.ok) return { ok: false, tasks: [], reason: r.reason };
    const list: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
    const tasks = list.map((t): CrmTask => {
      const status = t.Status ?? null;
      const isOpen = status ? !/completed|closed/i.test(String(status)) : true;
      return {
        id: String(t.id),
        subject: t.Subject ?? "(no subject)",
        description: t.Description ?? null,
        status,
        is_open: isOpen,
        due_at: t.Due_Date ?? null,
        owner_id: t.Owner?.id ?? null,
        priority: t.Priority ?? null,
        created_at: t.Created_Time ?? nowIso(),
        vendor: "zoho",
      };
    });
    const limit = Math.min(args.limit ?? 10, 50);
    const filtered = args.openOnly ? tasks.filter((t) => t.is_open) : tasks;
    return { ok: true, tasks: filtered.slice(0, limit) };
  }

  async listRecentNotes(args: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> {
    const c = await loadZohoConnection(this.tenantId);
    if (!c.ok) return { ok: false, activities: [], reason: c.reason };
    // Zoho v6: Notes can't be searched by `Parent_Id:equals` — that lookup
    // field rejects the equals operator with INVALID_QUERY. The supported
    // path is the related-list endpoint `/{Module}/{record_id}/Notes`,
    // which Zoho explicitly exposes for the polymorphic parent relationship.
    const limit = Math.min(args.limit ?? 10, 50);
    const module = args.kind === "lead" ? "Leads" : "Contacts";
    const fields = "Note_Title,Note_Content,Created_Time,Modified_Time,Owner";
    const r = await zohoFetch(
      c.conn,
      "GET",
      `/crm/v6/${module}/${encodeURIComponent(args.contact_id)}/Notes?fields=${encodeURIComponent(fields)}&per_page=${limit}&sort_by=Created_Time&sort_order=desc`,
    );
    console.log(`[zoho.listRecentNotes] contact=${args.contact_id} kind=${args.kind} status=${r.status} ok=${r.ok} reason=${r.reason ?? "-"} count=${Array.isArray(r.data?.data) ? r.data.data.length : 0}`);
    if (r.status === 204) return { ok: true, activities: [] };
    if (!r.ok) return { ok: false, activities: [], reason: r.reason };
    const list: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
    const activities = list.slice(0, limit).map((n): CrmActivity => ({
      id: String(n.id),
      kind: "note",
      body: stripGotchaMarkers(
        [n.Note_Title, n.Note_Content].filter(Boolean).join("\n").trim()
      ) || "(empty note)",
      occurred_at: n.Created_Time ?? nowIso(),
      source_interaction_id: extractGotchaMarker(n.Note_Content),
    }));
    return { ok: true, activities };
  }

  async listRecentActivities(args: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> {
    // Unified timeline = Notes + Tasks + Calls merged and sorted by
    // Created_Time / occurred_at desc. We deliberately reuse listRecentNotes
    // and listTasks rather than re-fetching so the marker-extraction logic
    // for notes stays single-sourced. /Calls is fetched inline since Zoho's
    // Calls module has no equivalent helper yet.
    const limit = Math.min(args.limit ?? 10, 50);
    const c = await loadZohoConnection(this.tenantId);
    if (!c.ok) return { ok: false, activities: [], reason: c.reason };

    const [notesRes, tasksRes, callsRes] = await Promise.all([
      this.listRecentNotes({ contact_id: args.contact_id, kind: args.kind, limit }).catch(() => ({ ok: false, activities: [] as CrmActivity[] })),
      this.listTasks({ contact_id: args.contact_id, kind: args.kind, limit }).catch(() => ({ ok: false, tasks: [] as CrmTask[] })),
      (async () => {
        // Zoho Calls live on /crm/v6/Calls. Search by What_Id (polymorphic
        // parent ref, same convention as Tasks). Returns full call records.
        const criteria = `(What_Id:equals:${args.contact_id})`;
        const r = await zohoFetch(c.conn, "GET", `/crm/v6/Calls/search?criteria=${encodeURIComponent(criteria)}`);
        if (r.status === 204) return { ok: true, calls: [] as any[] };
        if (!r.ok) return { ok: false, calls: [] as any[] };
        return { ok: true, calls: Array.isArray(r.data?.data) ? r.data.data : [] };
      })().catch(() => ({ ok: false, calls: [] as any[] })),
    ]);

    const merged: CrmActivity[] = [];
    for (const n of (notesRes as any).activities ?? []) merged.push(n);
    for (const t of (tasksRes as any).tasks ?? []) {
      const cleanedDescription = t.description ? stripGotchaMarkers(t.description) : "";
      merged.push({
        id: String(t.id),
        kind: "task",
        body: [t.subject, t.status ? `[${t.status}]` : "", cleanedDescription].filter(Boolean).join(" — "),
        occurred_at: t.created_at ?? nowIso(),
        source_interaction_id: null,
      });
    }
    for (const cl of (callsRes as any).calls ?? []) {
      const subject = cl.Subject ?? cl.Description ?? "(call)";
      const direction = cl.Call_Type ? ` (${cl.Call_Type})` : "";
      const duration = cl.Call_Duration ? ` · ${cl.Call_Duration}` : "";
      merged.push({
        id: String(cl.id),
        kind: "call",
        body: `${subject}${direction}${duration}`.trim(),
        occurred_at: cl.Call_Start_Time ?? cl.Created_Time ?? nowIso(),
        source_interaction_id: null,
      });
    }

    merged.sort((a, b) => (b.occurred_at || "").localeCompare(a.occurred_at || ""));
    return { ok: true, activities: merged.slice(0, limit) };
  }
}

// ─── NoOp adapter ───────────────────────────────────────────
//
// Returned by the resolver when a tenant has no CRM connected. Methods all
// return `ok: false, reason: 'no_crm_configured'` so callers can degrade
// gracefully (the side panel shows "no CRM connected"; close-sync skips).

// ─── Shopify (optional CRM / source of truth) ───────────────
//
// Shopify is primarily an ECOMMERCE integration, but a tenant can opt to use
// it as their CRM source of truth (config.useAsCrm on the Shopify connection
// — see crm-adapter-resolver). This adapter is a thin CRM projection over the
// Shopify customer tools in shopify.adapter.ts: a Shopify "customer" is our
// canonical "contact", order history projects onto `deals`, and notes/
// interactions are appended to the customer's free-text `note` field.
export class ShopifyCRMAdapter implements CRMAdapter {
  readonly vendor: CrmVendor = "shopify";
  readonly capabilities: CrmAdapterCapabilities = DEFAULT_CAPABILITIES.shopify;
  constructor(public readonly tenantId: string) {}

  async findCustomer(query: { phone?: string; email?: string; external_id?: string }): Promise<CrmAdapterFindResult> {
    const email = normalizeEmail(query.email);
    const phone = coerceSearchPhone(query.phone);
    if (!email && !phone && !query.external_id) {
      return { ok: false, contacts: [], reason: "no_query" };
    }

    if (query.external_id) {
      const r = await executeAdapterTool({
        tenantId: this.tenantId,
        toolFunctionName: "shopify.get_customer",
        args: { customer_id: query.external_id },
      });
      if (!r.ok) return { ok: false, contacts: [], reason: r.reason };
      const c = mapShopifyCustomer(r.result);
      return { ok: true, contacts: c ? [c] : [] };
    }
    if (email) {
      const r = await executeAdapterTool({
        tenantId: this.tenantId,
        toolFunctionName: "shopify.get_customer_by_email",
        args: { email },
      });
      if (!r.ok) return { ok: false, contacts: [], reason: r.reason };
      const c = mapShopifyCustomer(r.result);
      return { ok: true, contacts: c ? [c] : [] };
    }
    // phone
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "shopify.get_customer_by_phone",
      args: { phone },
    });
    if (!r.ok) return { ok: false, contacts: [], reason: r.reason };
    const c = mapShopifyCustomer(r.result);
    return { ok: true, contacts: c ? [c] : [] };
  }

  async getCustomerContext(args: { contact_id: string; kind: CrmObjectKind }): Promise<CrmAdapterContextResult> {
    const cr = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "shopify.get_customer",
      args: { customer_id: args.contact_id },
    });
    if (!cr.ok) return { ok: false, reason: cr.reason };
    const contact = mapShopifyCustomer(cr.result);
    if (!contact) return { ok: false, reason: "contact_not_found" };

    // Project recent order history onto canonical `deals` so the side panel
    // renders purchase context. Best-effort — failures degrade to no deals.
    let deals: CrmDeal[] = [];
    try {
      const or = await executeAdapterTool({
        tenantId: this.tenantId,
        toolFunctionName: "shopify.get_customer_orders",
        args: { customer_id: args.contact_id, limit: 10 },
      });
      if (or.ok && Array.isArray(or.result)) {
        deals = (or.result as any[]).map(mapShopifyOrderToDeal).filter(Boolean) as CrmDeal[];
      }
    } catch { /* no deals */ }

    const ctx: CrmCustomerContext = { contact, recent_activities: [], deals, tickets: [] };
    return { ok: true, context: ctx };
  }

  async createLead(payload: CrmContactCreatePayload): Promise<CrmAdapterWriteResult & { kind: CrmObjectKind }> {
    const email = normalizeEmail(payload.email);
    const phone = normalizePhone(payload.phone);
    if (!email && !phone) return { ok: false, kind: "contact", reason: "email_or_phone_required" };
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "shopify.create_customer",
      args: {
        email: email ?? undefined,
        phone: phone ?? undefined,
        first_name: payload.first_name,
        last_name: payload.last_name,
        tags: payload.source ? [String(payload.source)] : undefined,
      },
    });
    if (!r.ok) return { ok: false, kind: "contact", reason: r.reason };
    const id = (r.result as any)?.id;
    return { ok: true, kind: "contact", id: id != null ? String(id) : undefined };
  }

  async createNote(args: CreateNoteArgs): Promise<CrmAdapterWriteResult> {
    // Shopify customers have a single free-text `note` field (no timeline) —
    // create_note appends to it. Markers keep read-then-write idempotency.
    const body = augmentBodyWithMarker(args.body, args.source_interaction_id, args.source_outbox_id, args.payload_version);
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "shopify.create_note",
      args: { customer_id: args.contact_id, note: body },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: args.contact_id, was_update: true };
  }

  async appendInteraction(args: AppendInteractionArgs): Promise<CrmAdapterWriteResult> {
    const body = renderInteractionBody(args.interaction);
    const finalBody = augmentBodyWithMarker(body, args.interaction.source_interaction_id, args.source_outbox_id, args.payload_version);
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "shopify.create_note",
      args: { customer_id: args.contact_id, note: finalBody },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: args.contact_id, was_update: true };
  }

  async enrichContact(args: CrmEnrichArgs): Promise<CrmAdapterWriteResult> {
    const fields: Record<string, unknown> = {};
    const email = normalizeEmail(args.update.email);
    const phone = normalizePhone(args.update.phone);
    if (email) fields.email = email;
    if (phone) fields.phone = phone;
    if (args.update.display_name) {
      const [first, ...rest] = args.update.display_name.trim().split(/\s+/);
      if (first) fields.first_name = first;
      if (rest.length) fields.last_name = rest.join(" ");
    }
    if (args.update.custom) {
      for (const [k, v] of Object.entries(args.update.custom)) {
        if (typeof v === "string" && v) fields[k] = v;
      }
    }
    if (Object.keys(fields).length === 0) return { ok: true };
    return this.updateRecord({ id: args.contact_id, kind: args.kind, fields });
  }

  async updateRecord(args: { id: string; kind: CrmObjectKind; fields: Record<string, unknown> }): Promise<CrmAdapterWriteResult> {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args.fields ?? {})) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      fields[k] = v;
    }
    if (Object.keys(fields).length === 0) return { ok: true, id: args.id, was_update: false };
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "shopify.update_customer",
      args: { customer_id: args.id, fields },
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: args.id, was_update: true };
  }

  async listRecentNotes(_args: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> {
    return { ok: true, activities: [] };
  }

  async listRecentActivities(_args: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> {
    return { ok: true, activities: [] };
  }
}

function mapShopifyCustomer(raw: unknown): CanonicalCrmContact | null {
  if (!raw || typeof raw !== "object") return null;
  const c: any = raw;
  if (c.id == null) return null;
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim()
    || c.default_address?.name || null;
  return {
    id: String(c.id),
    kind: "contact",
    display_name: name,
    email: c.email ?? null,
    phone: c.phone ?? c.default_address?.phone ?? null,
    owner_id: null,
    stage: null,
    custom_fields: {
      orders_count: c.orders_count ?? null,
      total_spent: c.total_spent ?? null,
      currency: c.currency ?? null,
      tags: c.tags ?? null,
      state: c.state ?? null,
      verified_email: c.verified_email ?? null,
      note: c.note ?? null,
      last_order_id: c.last_order_id ?? null,
      last_order_name: c.last_order_name ?? null,
    },
    vendor_updated_at: c.updated_at ?? nowIso(),
    fetched_at: nowIso(),
    vendor: "shopify",
  };
}

function mapShopifyOrderToDeal(raw: unknown): CrmDeal | null {
  if (!raw || typeof raw !== "object") return null;
  const o: any = raw;
  if (o.id == null) return null;
  const amount = o.total_price != null ? Number(o.total_price) : null;
  return {
    id: String(o.id),
    name: o.name ?? `Order ${o.id}`,
    stage: o.financial_status ?? o.fulfillment_status ?? null,
    amount: Number.isFinite(amount as number) ? (amount as number) : null,
    close_date: o.created_at ?? null,
  };
}

// ─── Fireberry (Powerlink) ──────────────────────────────────
//
// Customer entity is the Account object (objecttype 1). Object type + field
// names are tenant-customizable, so we resolve them from the integration
// `config` with documented defaults. Notes project onto a single text field
// (default `description`) via read-modify-write — Fireberry has no lightweight
// timeline note we rely on. Auth is a static API token (no refresh).

interface FireberrySchema {
  objectTypeName: string;
  objectTypeCode: number;
  idField: string;
  nameField: string;
  emailField: string;
  phoneField: string;
  noteField: string;
}

function fireberrySchemaFromConfig(config: Record<string, any>): FireberrySchema {
  return {
    objectTypeName: config.objectTypeName || "account",
    objectTypeCode: Number(config.objectTypeCode ?? 1),
    idField: config.idField || "accountid",
    nameField: config.nameField || "accountname",
    emailField: config.emailField || "emailaddress1",
    phoneField: config.phoneField || "telephone1",
    noteField: config.noteField || "description",
  };
}

function escapeFireberryValue(v: string): string {
  return v.replace(/'/g, "''");
}

export class FireberryCRMAdapter implements CRMAdapter {
  readonly vendor: CrmVendor = "fireberry";
  readonly capabilities: CrmAdapterCapabilities = DEFAULT_CAPABILITIES.fireberry;
  constructor(public readonly tenantId: string) {}

  private schemaCache: FireberrySchema | null = null;
  private async schema(): Promise<FireberrySchema> {
    if (this.schemaCache) return this.schemaCache;
    const conn = await loadConnection({ tenantId: this.tenantId, slug: "fireberry" });
    this.schemaCache = fireberrySchemaFromConfig(conn?.config || {});
    return this.schemaCache;
  }

  private mapRecord(raw: any, s: FireberrySchema): CanonicalCrmContact | null {
    if (!raw || typeof raw !== "object") return null;
    const id = raw[s.idField] ?? raw.id ?? raw.objectid ?? null;
    if (id == null) return null;
    return {
      id: String(id),
      kind: "contact",
      display_name: raw[s.nameField] ?? null,
      email: raw[s.emailField] ?? null,
      phone: raw[s.phoneField] ?? null,
      owner_id: raw.ownerid ?? null,
      stage: raw.statuscode ?? raw.statecode ?? null,
      custom_fields: raw,
      vendor_updated_at: raw[this.capabilities.version_token_field] ?? nowIso(),
      fetched_at: nowIso(),
      vendor: "fireberry",
    };
  }

  async findCustomer(query: { phone?: string; email?: string; external_id?: string }): Promise<CrmAdapterFindResult> {
    const s = await this.schema();
    const email = normalizeEmail(query.email);
    const phone = coerceSearchPhone(query.phone);
    if (!email && !phone && !query.external_id) return { ok: false, contacts: [], reason: "no_query" };

    if (query.external_id) {
      const r = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "fireberry.get_record", args: { object_type: s.objectTypeName, record_id: query.external_id } });
      if (!r.ok) return { ok: false, contacts: [], reason: r.reason };
      const c = this.mapRecord(r.result, s);
      return { ok: true, contacts: c ? [c] : [] };
    }

    const field = email ? s.emailField : s.phoneField;
    const value = email ?? phone!;
    const r = await executeAdapterTool({
      tenantId: this.tenantId,
      toolFunctionName: "fireberry.query_records",
      args: { object_type_code: s.objectTypeCode, query: `(${field} = '${escapeFireberryValue(value)}')`, page_size: 5 },
    });
    if (!r.ok) return { ok: false, contacts: [], reason: r.reason };
    const rows = Array.isArray(r.result) ? r.result : [];
    const contacts = rows.map((row: any) => this.mapRecord(row, s)).filter(Boolean) as CanonicalCrmContact[];
    return { ok: true, contacts };
  }

  async getCustomerContext(args: { contact_id: string; kind: CrmObjectKind }): Promise<CrmAdapterContextResult> {
    const s = await this.schema();
    const r = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "fireberry.get_record", args: { object_type: s.objectTypeName, record_id: args.contact_id } });
    if (!r.ok) return { ok: false, reason: r.reason };
    const contact = this.mapRecord(r.result, s);
    if (!contact) return { ok: false, reason: "contact_not_found" };
    return { ok: true, context: { contact, recent_activities: [], deals: [], tickets: [] } };
  }

  async createLead(payload: CrmContactCreatePayload): Promise<CrmAdapterWriteResult & { kind: CrmObjectKind }> {
    const s = await this.schema();
    const email = normalizeEmail(payload.email);
    const phone = normalizePhone(payload.phone);
    const name = payload.display_name || [payload.first_name, payload.last_name].filter(Boolean).join(" ").trim();
    if (!email && !phone && !name) return { ok: false, kind: "contact", reason: "identifier_required" };
    const fields: Record<string, unknown> = {};
    if (name) fields[s.nameField] = name;
    if (email) fields[s.emailField] = email;
    if (phone) fields[s.phoneField] = phone;
    if (payload.custom) Object.assign(fields, payload.custom);
    const r = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "fireberry.create_record", args: { object_type: s.objectTypeName, fields } });
    if (!r.ok) return { ok: false, kind: "contact", reason: r.reason };
    const id = (r.result as any)?.[s.idField] ?? (r.result as any)?.id;
    return { ok: true, kind: "contact", id: id != null ? String(id) : undefined };
  }

  // Read-modify-write onto a single text field (no lightweight timeline).
  private async appendToNoteField(contactId: string, body: string): Promise<CrmAdapterWriteResult> {
    const s = await this.schema();
    let existing = "";
    const cur = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "fireberry.get_record", args: { object_type: s.objectTypeName, record_id: contactId } });
    if (cur.ok && cur.result && typeof cur.result === "object") {
      const v = (cur.result as any)[s.noteField];
      if (typeof v === "string") existing = v;
    }
    const next = existing ? `${existing}\n\n${body}` : body;
    const r = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "fireberry.update_record", args: { object_type: s.objectTypeName, record_id: contactId, fields: { [s.noteField]: next } } });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: contactId, was_update: true };
  }

  async createNote(args: CreateNoteArgs): Promise<CrmAdapterWriteResult> {
    const body = augmentBodyWithMarker(args.body, args.source_interaction_id, args.source_outbox_id, args.payload_version);
    return this.appendToNoteField(args.contact_id, body);
  }

  async appendInteraction(args: AppendInteractionArgs): Promise<CrmAdapterWriteResult> {
    const body = augmentBodyWithMarker(renderInteractionBody(args.interaction), args.interaction.source_interaction_id, args.source_outbox_id, args.payload_version);
    return this.appendToNoteField(args.contact_id, body);
  }

  async enrichContact(args: CrmEnrichArgs): Promise<CrmAdapterWriteResult> {
    const s = await this.schema();
    const fields: Record<string, unknown> = {};
    const email = normalizeEmail(args.update.email);
    const phone = normalizePhone(args.update.phone);
    if (email) fields[s.emailField] = email;
    if (phone) fields[s.phoneField] = phone;
    if (args.update.display_name) fields[s.nameField] = args.update.display_name;
    if (args.update.custom) for (const [k, v] of Object.entries(args.update.custom)) if (typeof v === "string" && v) fields[k] = v;
    if (Object.keys(fields).length === 0) return { ok: true };
    return this.updateRecord({ id: args.contact_id, kind: args.kind, fields });
  }

  async updateRecord(args: { id: string; kind: CrmObjectKind; fields: Record<string, unknown> }): Promise<CrmAdapterWriteResult> {
    const s = await this.schema();
    const map: Record<string, string> = { email: s.emailField, phone: s.phoneField, display_name: s.nameField, name: s.nameField, notes: s.noteField };
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args.fields ?? {})) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      fields[map[k] || k] = v;
    }
    if (Object.keys(fields).length === 0) return { ok: true, id: args.id, was_update: false };
    const r = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "fireberry.update_record", args: { object_type: s.objectTypeName, record_id: args.id, fields } });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: args.id, was_update: true };
  }

  async listRecentNotes(): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> { return { ok: true, activities: [] }; }
  async listRecentActivities(): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> { return { ok: true, activities: [] }; }
}

// ─── Airtable (bring-your-own-schema) ───────────────────────
//
// Airtable has no fixed contact schema, so the adapter is a thin translator
// driven entirely by per-tenant `config`: which columns map to canonical
// fields, a long-text notes column, and an optional idempotency column. Notes
// append to the single notes column (no timeline). The base/table live on
// `config.baseId`/`config.tableId` and are read by the generic airtable.* tools.

interface AirtableSchema {
  fieldMap: { email?: string; phone?: string; display_name?: string; stage?: string };
  notesField?: string;
  idempotencyField?: string;
}

function airtableSchemaFromConfig(config: Record<string, any>): AirtableSchema {
  const fm = (config.fieldMap && typeof config.fieldMap === "object") ? config.fieldMap : {};
  return {
    fieldMap: { email: fm.email, phone: fm.phone, display_name: fm.display_name, stage: fm.stage },
    notesField: config.notesField,
    idempotencyField: config.idempotencyField,
  };
}

function airtableFormulaEscape(v: string): string { return v.replace(/'/g, "\\'"); }

export class AirtableCRMAdapter implements CRMAdapter {
  readonly vendor: CrmVendor = "airtable";
  readonly capabilities: CrmAdapterCapabilities = DEFAULT_CAPABILITIES.airtable;
  constructor(public readonly tenantId: string) {}

  private schemaCache: AirtableSchema | null = null;
  private async schema(): Promise<AirtableSchema> {
    if (this.schemaCache) return this.schemaCache;
    const conn = await loadConnection({ tenantId: this.tenantId, slug: "airtable" });
    this.schemaCache = airtableSchemaFromConfig(conn?.config || {});
    return this.schemaCache;
  }

  private mapRecord(raw: any, s: AirtableSchema): CanonicalCrmContact | null {
    if (!raw || typeof raw !== "object" || !raw.id) return null;
    const f = raw.fields || {};
    return {
      id: String(raw.id),
      kind: "contact",
      display_name: s.fieldMap.display_name ? (f[s.fieldMap.display_name] ?? null) : null,
      email: s.fieldMap.email ? (f[s.fieldMap.email] ?? null) : null,
      phone: s.fieldMap.phone ? (f[s.fieldMap.phone] ?? null) : null,
      owner_id: null,
      stage: s.fieldMap.stage ? (f[s.fieldMap.stage] ?? null) : null,
      custom_fields: f,
      vendor_updated_at: nowIso(),
      fetched_at: nowIso(),
      vendor: "airtable",
    };
  }

  async findCustomer(query: { phone?: string; email?: string; external_id?: string }): Promise<CrmAdapterFindResult> {
    const s = await this.schema();
    const email = normalizeEmail(query.email);
    const phone = coerceSearchPhone(query.phone);

    if (query.external_id) {
      const r = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "airtable.get_record", args: { record_id: query.external_id } });
      if (!r.ok) return { ok: false, contacts: [], reason: r.reason };
      const c = this.mapRecord(r.result, s);
      return { ok: true, contacts: c ? [c] : [] };
    }

    let col: string | undefined;
    let val: string | undefined;
    if (email && s.fieldMap.email) { col = s.fieldMap.email; val = email; }
    else if (phone && s.fieldMap.phone) { col = s.fieldMap.phone; val = phone; }
    if (!col || !val) return { ok: false, contacts: [], reason: "no_query_or_unmapped" };

    const formula = `{${col}}='${airtableFormulaEscape(val)}'`;
    const r = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "airtable.list_records", args: { filter_formula: formula, max_records: 5 } });
    if (!r.ok) return { ok: false, contacts: [], reason: r.reason };
    const rows = Array.isArray(r.result) ? r.result : [];
    return { ok: true, contacts: rows.map((row: any) => this.mapRecord(row, s)).filter(Boolean) as CanonicalCrmContact[] };
  }

  async getCustomerContext(args: { contact_id: string; kind: CrmObjectKind }): Promise<CrmAdapterContextResult> {
    const s = await this.schema();
    const r = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "airtable.get_record", args: { record_id: args.contact_id } });
    if (!r.ok) return { ok: false, reason: r.reason };
    const contact = this.mapRecord(r.result, s);
    if (!contact) return { ok: false, reason: "contact_not_found" };
    return { ok: true, context: { contact, recent_activities: [], deals: [], tickets: [] } };
  }

  async createLead(payload: CrmContactCreatePayload): Promise<CrmAdapterWriteResult & { kind: CrmObjectKind }> {
    const s = await this.schema();
    const email = normalizeEmail(payload.email);
    const phone = normalizePhone(payload.phone);
    const name = payload.display_name || [payload.first_name, payload.last_name].filter(Boolean).join(" ").trim();
    if (!email && !phone && !name) return { ok: false, kind: "contact", reason: "identifier_required" };
    const fields: Record<string, unknown> = {};
    if (name && s.fieldMap.display_name) fields[s.fieldMap.display_name] = name;
    if (email && s.fieldMap.email) fields[s.fieldMap.email] = email;
    if (phone && s.fieldMap.phone) fields[s.fieldMap.phone] = phone;
    if (Object.keys(fields).length === 0) return { ok: false, kind: "contact", reason: "no_mapped_fields" };
    const r = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "airtable.create_record", args: { fields } });
    if (!r.ok) return { ok: false, kind: "contact", reason: r.reason };
    const id = (r.result as any)?.id;
    return { ok: true, kind: "contact", id: id != null ? String(id) : undefined };
  }

  private async appendToNoteField(contactId: string, body: string): Promise<CrmAdapterWriteResult> {
    const s = await this.schema();
    if (!s.notesField) return { ok: false, reason: "notes_field_not_mapped" };
    let existing = "";
    const cur = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "airtable.get_record", args: { record_id: contactId } });
    if (cur.ok && (cur.result as any)?.fields) {
      const v = (cur.result as any).fields[s.notesField];
      if (typeof v === "string") existing = v;
    }
    const next = existing ? `${existing}\n\n${body}` : body;
    const r = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "airtable.update_record", args: { record_id: contactId, fields: { [s.notesField]: next } } });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: contactId, was_update: true };
  }

  async createNote(args: CreateNoteArgs): Promise<CrmAdapterWriteResult> {
    const body = augmentBodyWithMarker(args.body, args.source_interaction_id, args.source_outbox_id, args.payload_version);
    return this.appendToNoteField(args.contact_id, body);
  }

  async appendInteraction(args: AppendInteractionArgs): Promise<CrmAdapterWriteResult> {
    const body = augmentBodyWithMarker(renderInteractionBody(args.interaction), args.interaction.source_interaction_id, args.source_outbox_id, args.payload_version);
    return this.appendToNoteField(args.contact_id, body);
  }

  async enrichContact(args: CrmEnrichArgs): Promise<CrmAdapterWriteResult> {
    const s = await this.schema();
    const fields: Record<string, unknown> = {};
    const email = normalizeEmail(args.update.email);
    const phone = normalizePhone(args.update.phone);
    if (email && s.fieldMap.email) fields[s.fieldMap.email] = email;
    if (phone && s.fieldMap.phone) fields[s.fieldMap.phone] = phone;
    if (args.update.display_name && s.fieldMap.display_name) fields[s.fieldMap.display_name] = args.update.display_name;
    if (Object.keys(fields).length === 0) return { ok: true };
    const r = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "airtable.update_record", args: { record_id: args.contact_id, fields } });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: args.contact_id, was_update: true };
  }

  async updateRecord(args: { id: string; kind: CrmObjectKind; fields: Record<string, unknown> }): Promise<CrmAdapterWriteResult> {
    const s = await this.schema();
    const map: Record<string, string | undefined> = {
      email: s.fieldMap.email, phone: s.fieldMap.phone,
      display_name: s.fieldMap.display_name, name: s.fieldMap.display_name,
      stage: s.fieldMap.stage, notes: s.notesField,
    };
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args.fields ?? {})) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      const col = k in map ? map[k] : k; // pass through unknown keys as literal column names
      if (col) fields[col] = v;
    }
    if (Object.keys(fields).length === 0) return { ok: true, id: args.id, was_update: false };
    const r = await executeAdapterTool({ tenantId: this.tenantId, toolFunctionName: "airtable.update_record", args: { record_id: args.id, fields } });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, id: args.id, was_update: true };
  }

  async listRecentNotes(): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> { return { ok: true, activities: [] }; }
  async listRecentActivities(): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> { return { ok: true, activities: [] }; }
}

export class NoOpCRMAdapter implements CRMAdapter {
  readonly vendor: CrmVendor = "custom_api"; // placeholder vendor
  readonly capabilities: CrmAdapterCapabilities = { ...DEFAULT_CAPABILITIES.custom_api, is_stub: true };
  constructor(public readonly tenantId: string) {}

  private fail<T extends { ok: boolean; reason?: string }>(extra?: Partial<T>): T {
    return { ok: false, reason: "no_crm_configured", ...(extra as any) } as T;
  }
  async findCustomer(_query?: { phone?: string; email?: string; external_id?: string }): Promise<CrmAdapterFindResult> {
    return this.fail<CrmAdapterFindResult>({ contacts: [] });
  }
  async getCustomerContext(_args?: { contact_id: string; kind: CrmObjectKind }): Promise<CrmAdapterContextResult> {
    return this.fail<CrmAdapterContextResult>();
  }
  async createLead(_payload?: CrmContactCreatePayload): Promise<CrmAdapterWriteResult & { kind: CrmObjectKind }> {
    return { ok: false, reason: "no_crm_configured", kind: "contact" };
  }
  async createNote(_args?: CreateNoteArgs): Promise<CrmAdapterWriteResult> { return this.fail<CrmAdapterWriteResult>(); }
  async appendInteraction(_args?: AppendInteractionArgs): Promise<CrmAdapterWriteResult> { return this.fail<CrmAdapterWriteResult>(); }
  async enrichContact(_args?: CrmEnrichArgs): Promise<CrmAdapterWriteResult> { return this.fail<CrmAdapterWriteResult>(); }
  async updateRecord(_args?: { id: string; kind: CrmObjectKind; fields: Record<string, unknown> }): Promise<CrmAdapterWriteResult> {
    return this.fail<CrmAdapterWriteResult>();
  }
  async createTask(_args?: unknown): Promise<CrmAdapterWriteResult> {
    return this.fail<CrmAdapterWriteResult>();
  }
  async findByCustomField(_args?: CrmFindByCustomFieldArgs): Promise<CrmAdapterFindResult> {
    return this.fail<CrmAdapterFindResult>({ contacts: [] });
  }
  async mergeContacts(_args?: CrmMergeArgs): Promise<CrmMergeResult> {
    return { ok: false, reason: "no_crm_configured" };
  }
  async listTasks(_args?: { contact_id: string; kind: CrmObjectKind; openOnly?: boolean; limit?: number }): Promise<{ ok: boolean; tasks: CrmTask[]; reason?: string }> {
    return { ok: false, tasks: [], reason: "no_crm_configured" };
  }
  async listRecentNotes(_args?: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> {
    return { ok: false, activities: [], reason: "no_crm_configured" };
  }
  async listRecentActivities(_args?: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }> {
    return { ok: false, activities: [], reason: "no_crm_configured" };
  }
}

// ─── Body marker helper ────────────────────────────────────

/**
 * Append GOTCHA idempotency markers to a note body. Read-then-write style:
 * a future write looking for source_interaction_id in the body can detect
 * "this is our own write" and PATCH vs create.
 *
 * v1 stores markers inline in the body. Phase 2 moves to vendor custom fields
 * via GOTCHA_CUSTOM_FIELDS (HubSpot custom note properties, SF External Id,
 * Zoho custom fields).
 */
/**
 * Pull the GOTCHA conversation id back out of a marked-up note body.
 * Used when projecting CRM activities back into GOTCHA's history view —
 * lets us link CRM notes to the original conversation when known.
 */
function extractGotchaMarker(body: string | null | undefined): string | null {
  if (!body) return null;
  const m = String(body).match(/gotcha_source_interaction_id=([\w-]+)/);
  return m ? m[1] : null;
}

/**
 * Strip the bookkeeping `[gotcha_* = ...]` marker lines we append to CRM
 * notes/activities. We need the markers in the CRM for dedup + traceback,
 * but they're noise when the body is rendered to a human in the side panel.
 */
function stripGotchaMarkers(body: string | null | undefined): string {
  if (!body) return "";
  return String(body)
    // Marker block(s) like "[gotcha_source_interaction_id=cmp... gotcha_source_outbox_id=... v=1]"
    .replace(/\[\s*gotcha_[^\]]*\]/g, "")
    // Collapse runs of blank lines the strip leaves behind.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function augmentBodyWithMarker(
  body: string,
  sourceInteractionId?: string,
  sourceOutboxId?: string,
  payloadVersion?: number,
): string {
  const trimmed = (body || "").trim();
  if (!sourceInteractionId && !sourceOutboxId) return trimmed;
  const parts: string[] = [];
  if (sourceInteractionId) parts.push(`${GOTCHA_CUSTOM_FIELDS.source_interaction_id}=${sourceInteractionId}`);
  if (sourceOutboxId) parts.push(`${GOTCHA_CUSTOM_FIELDS.source_outbox_id}=${sourceOutboxId}`);
  if (payloadVersion) parts.push(`v=${payloadVersion}`);
  // Don't double-append if the marker is already present.
  const marker = `[${parts.join(" ")}]`;
  if (trimmed.includes(marker)) return trimmed;
  // Strip any prior gotcha marker line then append the new one.
  const stripped = trimmed.replace(/\n\[gotcha_source_interaction_id=[^\]]*\]\s*$/m, "").trim();
  return `${stripped}\n\n${marker}`;
}
