/**
 * CRMAdapter - capability-based CRM abstraction.
 *
 * This is the v2 contract from the GOTCHA migration plan: every CRM vendor
 * presents the same surface to the rest of the system, declares what it CAN
 * do via `CrmAdapterCapabilities`, and the caller adapts to vendor diversity
 * (Salesforce Person Accounts, HubSpot Engagements vs Salesforce Tasks, etc.).
 *
 * v1 scope (this PR): findCustomer, getCustomerContext, createLead, createNote,
 * appendInteraction. The full surface (createTask, createTicket, mergeContacts,
 * splitContacts, webhook subscribe/poll) is reserved for later steps.
 *
 * Coexists with the legacy `CrmConnector` interface in `./types.ts`. Once every
 * caller has migrated, the legacy interface goes away.
 */

// ─── Vendor + entity model ──────────────────────────────────

export type CrmVendor = "hubspot" | "salesforce" | "zoho" | "shopify" | "fireberry" | "pipedrive" | "monday" | "airtable" | "custom_api" | "custom_db";

export type CrmObjectKind = "contact" | "lead" | "person_account" | "organization_member" | "company";

// ─── Capability flags ───────────────────────────────────────

export interface CrmAdapterCapabilities {
  /** Which object kinds this vendor models. */
  entity_kinds_supported: CrmObjectKind[];
  /** Default entity kind when creating from an inbound interaction. */
  default_entity_kind_for_inbound: CrmObjectKind;
  /** Activity kinds the adapter can attach. */
  activity_kinds_supported: ("note" | "task" | "call" | "email" | "meeting")[];
  /** Whether the vendor allows PATCH-in-place on an existing activity body. */
  activity_update_in_place: boolean;
  /** Whether the vendor's Lead has a distinct "convert to Contact" lifecycle event. */
  lead_to_contact_conversion_event: boolean;
  /** How the vendor exposes change notifications. */
  webhook_subscription: "app_level" | "portal_level" | "cdc_license" | "polling_only";
  /** Whether the vendor lets us store our own idempotency key on a custom field. */
  idempotency_via_custom_field: boolean;
  /** Which identifier kinds the vendor's search supports. */
  search_by_identifier: ("phone" | "email" | "external_id")[];
  /** Field name (vendor-specific) that holds the row's last-modified timestamp. */
  version_token_field: string;
  /** Sustained rate cap from the vendor for this tenant's tier (best-effort default). */
  rate_limit_per_minute: number;
  /** Whether merge / split are exposed via API. */
  merge_supported: boolean;
  split_supported: boolean;
  /** Whether the adapter can create CRM Tasks. */
  task_supported: boolean;
  /** Whether the adapter can create CRM Tickets / Cases. */
  ticket_supported: boolean;
  /** True for stub adapters whose methods return `not_implemented`. */
  is_stub?: boolean;
}

// ─── Canonical payloads ─────────────────────────────────────

export interface CanonicalCrmContact {
  id: string;
  kind: CrmObjectKind;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  /** CRM-side owner user id, if any. Used to route Tasks. */
  owner_id: string | null;
  /** Best-effort current deal/lifecycle stage for display. */
  stage: string | null;
  /** Free-form vendor-specific fields the bot may read but should not write. */
  custom_fields: Record<string, unknown>;
  /** Vendor-specific timestamp (HubSpot updatedAt, SF LastModifiedDate, ...). */
  vendor_updated_at: string;
  /** When we fetched this row from the vendor. */
  fetched_at: string;
  /** Tenant-scoped vendor name. */
  vendor: CrmVendor;
}

export interface CrmActivity {
  id: string;
  kind: "note" | "task" | "call" | "email" | "meeting";
  body: string;
  occurred_at: string;
  source_interaction_id: string | null;
}

export interface CrmDeal {
  id: string;
  name: string;
  stage: string | null;
  amount: number | null;
  close_date: string | null;
}

export interface CrmTicket {
  id: string;
  subject: string;
  status: string | null;
  priority: string | null;
}

export interface CrmTask {
  id: string;
  /** Title / summary line. */
  subject: string;
  /** Body / details. */
  description: string | null;
  /** Vendor-specific task status. `open` means not-yet-completed for unified rendering. */
  status: string | null;
  is_open: boolean;
  due_at: string | null;
  owner_id: string | null;
  priority: string | null;
  created_at: string;
  vendor: CrmVendor;
}

export interface CrmCustomerContext {
  contact: CanonicalCrmContact;
  recent_activities: CrmActivity[];
  deals: CrmDeal[];
  tickets: CrmTicket[];
}

// ─── Input payloads ─────────────────────────────────────────

export interface CrmContactCreatePayload {
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  company?: string;
  source?: string;
  /** Free-form passthrough - vendor-specific. */
  custom?: Record<string, unknown>;
}

export interface InteractionEnvelope {
  /** GOTCHA interaction (Conversation) id - written into a CRM custom field for idempotency. */
  source_interaction_id: string;
  /** Channel the interaction occurred on. */
  channel: "voice" | "whatsapp" | "instagram" | "messenger" | "webchat" | "email" | "sms";
  direction: "inbound" | "outbound";
  started_at: string;
  ended_at?: string;
  duration_seconds?: number;
  message_count?: number;
  summary?: string;
  /** Optional structured engagement (sentiment, score, action items as bullets, etc.). */
  engagement?: {
    sentiment?: string | null;
    qualification?: string | null;
    action_items?: string[];
    [k: string]: unknown;
  };
  /**
   * Tenant's effective locale - drives the label translations used by
   * renderInteractionBody ("Duration:" vs "משך:"). Falls back to "en" when
   * absent. Use SupportedLocale shape ("en" | "he").
   */
  locale?: string;
}

export interface CreateNoteArgs {
  contact_id: string;
  kind: CrmObjectKind;
  body: string;
  /** GOTCHA-side originator. Used for read-then-write idempotency when supported. */
  source_interaction_id?: string;
  /** Outbox id - for echo suppression and ledger correlation (later steps). */
  source_outbox_id?: string;
  /** Increments per logical update of the same logical artifact. */
  payload_version?: number;
}

export interface AppendInteractionArgs {
  contact_id: string;
  kind: CrmObjectKind;
  interaction: InteractionEnvelope;
  source_outbox_id?: string;
  payload_version?: number;
}

export interface CrmEnrichArgs {
  contact_id: string;
  kind: CrmObjectKind;
  /**
   * Fields to patch. Adapters normalize values (email lowercase/trim, phone
   * E.164) before writing - defense-in-depth even when the caller already
   * normalized via crm-identity.service.
   */
  update: {
    email?: string;
    phone?: string;
    display_name?: string;
    /** Custom field key → value. Per-channel keys live in CHANNEL_FIELD_PLAN. */
    custom?: Record<string, string>;
  };
}

export interface CrmFindByCustomFieldArgs {
  /** Vendor-neutral field key (e.g. `gotcha_psid_facebook`). */
  field: string;
  value: string;
}

export interface CrmMergeArgs {
  primary_id: string;
  others: string[];
  kind: CrmObjectKind;
}

export interface CrmMergeResult {
  ok: boolean;
  primary_id?: string;
  merged_count?: number;
  reason?: string;
}

// ─── Method results ─────────────────────────────────────────

export interface CrmAdapterFindResult {
  ok: boolean;
  contacts: CanonicalCrmContact[];
  /** Set when the adapter cannot honour the request (no_crm_configured, vendor down, etc.). */
  reason?: string;
}

export interface CrmAdapterContextResult {
  ok: boolean;
  context?: CrmCustomerContext;
  reason?: string;
}

/**
 * A free-text NAME search candidate. Deliberately a slim list-row shape (not
 * a CanonicalCrmContact): the search list is a picking surface, and callers
 * mask identifiers before showing it - full contact data is fetched only
 * after the human explicitly selects a candidate.
 */
export interface CrmNameSearchCandidate {
  id: string;
  kind: CrmObjectKind;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  /** Lifetime order count, when the vendor returns it (Shopify). */
  orders_count: number | null;
  /** Lifetime spend as a decimal string, when the vendor permits it. */
  total_spent: string | null;
  currency: string | null;
}

export interface CrmNameSearchResult {
  ok: boolean;
  candidates: CrmNameSearchCandidate[];
  /** e.g. "missing_scopes:read_customers", vendor-down codes, ... */
  reason?: string;
}

export interface CrmAdapterWriteResult {
  ok: boolean;
  id?: string;
  /** True when an existing row was patched in-place (vendors that support it). */
  was_update?: boolean;
  reason?: string;
}

// ─── The interface ──────────────────────────────────────────

export interface CRMAdapter {
  readonly vendor: CrmVendor;
  readonly tenantId: string;
  readonly capabilities: CrmAdapterCapabilities;

  /** Look up a contact/lead by phone, email, or external id. */
  findCustomer(query: { phone?: string; email?: string; external_id?: string }): Promise<CrmAdapterFindResult>;

  /**
   * Free-text customer search by full or partial NAME. Optional - vendors
   * whose adapter implements it get name search in the unified
   * source-of-truth customer search; the rest fall back to the shared CRM
   * lead/contact search. Never auto-picks: always returns ALL candidates and
   * lets the human choose (ambiguous names are common).
   */
  searchByName?(name: string, limit?: number): Promise<CrmNameSearchResult>;

  /** Hydrate a contact + recent activities + open deals + open tickets. */
  getCustomerContext(args: { contact_id: string; kind: CrmObjectKind }): Promise<CrmAdapterContextResult>;

  /** Create a lead/contact when the customer didn't exist in CRM. */
  createLead(payload: CrmContactCreatePayload): Promise<CrmAdapterWriteResult & { kind: CrmObjectKind }>;

  /**
   * Manual or AI-generated note on a contact's timeline.
   * Adapters honouring read-then-write idempotency use `source_interaction_id`.
   */
  createNote(args: CreateNoteArgs): Promise<CrmAdapterWriteResult>;

  /**
   * "An interaction occurred." Adapter chooses the best vendor-native projection:
   * HubSpot → Call/Email/Note Engagement; Salesforce → Task; Zoho → Note + Activity.
   */
  appendInteraction(args: AppendInteractionArgs): Promise<CrmAdapterWriteResult>;

  /**
   * Patch identifying fields on an existing record. Used by the identity
   * service to fill in a missing phone/email/PSID after a partial-match
   * find. Optional - adapters that lack a vendor update tool may omit
   * this method, in which case enrichment is silently skipped.
   */
  enrichContact?(args: CrmEnrichArgs): Promise<CrmAdapterWriteResult>;

  /**
   * Patch arbitrary fields on an existing record. Used by the
   * post-conversation summarizer to write back the sparse `crm_patch` the
   * LLM extracted from the just-ended conversation. Routes by `kind` so
   * Leads and Contacts both get correctly updated in their native module.
   *
   * Sparse-patch contract - callers MUST send only fields that should be
   * written; missing/null/empty keys are left untouched on the record.
   * Field names are vendor-neutral keys from PostConversationConfig
   * `summaryFields[].key`; the adapter is responsible for mapping them to
   * the vendor's property names.
   *
   * Optional - adapters that don't have a generic update path return
   * `{ ok: false, reason: "..." }` and the caller falls back to
   * createNote (writing the patch as a timeline note instead).
   */
  updateRecord?(args: {
    id: string;
    kind: CrmObjectKind;
    fields: Record<string, unknown>;
  }): Promise<CrmAdapterWriteResult>;

  /**
   * Create a vendor-native task attached to a Lead or Contact. Used by the
   * post-conversation pipeline to materialize `suggested_tasks` from the
   * summarizer into the customer's CRM timeline.
   *
   * Adapters route by `kind` so a Lead's tasks land on the Lead and a
   * Contact's on the Contact. When a vendor lacks a first-class task object
   * (e.g. HubSpot's adapter tool surface), implementations degrade to a
   * "TODO: <subject>" timeline note rather than failing.
   *
   * Optional - `NoOpCRMAdapter` returns `{ ok: false, reason: "no_crm_configured" }`.
   */
  createTask?(args: {
    contact_id: string;
    kind: CrmObjectKind;
    subject: string;
    body?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    due_at?: string;
    source_interaction_id?: string;
  }): Promise<CrmAdapterWriteResult>;

  /**
   * Search by a vendor-neutral custom field (e.g. `gotcha_psid_facebook`).
   * Optional - when omitted, channel-strong-identifier lookup is unavailable
   * and the identity service falls back to phone/email anchors.
   */
  findByCustomField?(args: CrmFindByCustomFieldArgs): Promise<CrmAdapterFindResult>;

  /**
   * Collapse `others` into `primary`. Only called when:
   *   • `capabilities.merge_supported === true`, AND
   *   • caller has explicitly opted in to auto-merge (the identity service
   *     gates this behind `allow_auto_merge` + a strong merge signal - by
   *     default 2+ matches go to operator approval per CLAUDE.md rule #9).
   */
  mergeContacts?(args: CrmMergeArgs): Promise<CrmMergeResult>;

  /**
   * List tasks attached to a contact. `openOnly=true` filters to incomplete
   * tasks - what GOTCHA surfaces as "open issues" in the side panel.
   * No new GOTCHA-side state: CRM tasks ARE the open issues.
   */
  listTasks?(args: { contact_id: string; kind: CrmObjectKind; openOnly?: boolean; limit?: number }): Promise<{ ok: boolean; tasks: CrmTask[]; reason?: string }>;

  /**
   * Pull recent notes/activities from the contact's timeline. Used by
   * customer-context aggregation to feed AI prompts + side panel "Recent
   * activity" with vendor-native history alongside GOTCHA's own summaries.
   */
  listRecentNotes?(args: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }>;

  /**
   * Unified vendor timeline: notes + tasks + calls + emails + meetings,
   * time-ordered (most-recent first). What the "Recent activity" section of
   * the side panel renders - broader than `listRecentNotes`, which is notes
   * only. Returns whatever activity kinds the vendor exposes.
   */
  listRecentActivities?(args: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: CrmActivity[]; reason?: string }>;
}

// ─── Custom-field name conventions (idempotency marker) ─────

export const GOTCHA_CUSTOM_FIELDS = {
  /** GOTCHA interaction (Conversation) id - read-then-write dedup. */
  source_interaction_id: "gotcha_source_interaction_id",
  /** GOTCHA outbox row id - echo suppression for later steps. */
  source_outbox_id: "gotcha_source_outbox_id",
  /** Marker so inbound webhooks can detect "this came from us". */
  source_marker: "gotcha_source",
};

// ─── Per-vendor default capability profiles ─────────────────
//
// Each adapter publishes its own; these are sensible 2026 defaults the adapter
// can spread + override.

export const DEFAULT_CAPABILITIES: Record<CrmVendor, CrmAdapterCapabilities> = {
  hubspot: {
    entity_kinds_supported: ["contact", "lead", "company"],
    default_entity_kind_for_inbound: "contact",
    activity_kinds_supported: ["note", "task", "call", "email", "meeting"],
    activity_update_in_place: false, // Engagements v3: no PATCH-in-place on note body
    lead_to_contact_conversion_event: false,
    webhook_subscription: "app_level",
    idempotency_via_custom_field: true,
    search_by_identifier: ["phone", "email", "external_id"],
    version_token_field: "updatedAt",
    rate_limit_per_minute: 600,
    merge_supported: true,
    split_supported: false,
    task_supported: true,
    ticket_supported: true,
  },
  salesforce: {
    entity_kinds_supported: ["contact", "lead", "person_account", "organization_member", "company"],
    default_entity_kind_for_inbound: "lead",
    activity_kinds_supported: ["note", "task", "call", "email", "meeting"],
    activity_update_in_place: true, // Task.Description PATCH supported
    lead_to_contact_conversion_event: true,
    webhook_subscription: "cdc_license",
    idempotency_via_custom_field: true,
    search_by_identifier: ["phone", "email", "external_id"],
    version_token_field: "LastModifiedDate",
    rate_limit_per_minute: 200,
    merge_supported: true,
    split_supported: true,
    task_supported: true,
    ticket_supported: true,
  },
  zoho: {
    entity_kinds_supported: ["contact", "lead", "organization_member"],
    default_entity_kind_for_inbound: "lead",
    activity_kinds_supported: ["note", "task", "call"],
    activity_update_in_place: true,
    lead_to_contact_conversion_event: true,
    webhook_subscription: "portal_level",
    idempotency_via_custom_field: true,
    search_by_identifier: ["phone", "email", "external_id"],
    version_token_field: "Modified_Time",
    rate_limit_per_minute: 200,
    // Zoho CRM v6 does NOT expose a public merge endpoint - merge is UI-only.
    // Identity service routes 2+ matches straight to operator approval.
    merge_supported: false,
    split_supported: false,
    task_supported: true,
    ticket_supported: true,
  },
  shopify: {
    // Shopify's "customer" maps onto our canonical "contact". There is no
    // lead lifecycle - a shopper is a customer the moment they exist.
    entity_kinds_supported: ["contact"],
    default_entity_kind_for_inbound: "contact",
    // The customer record has a single free-text `note` field plus order
    // history - we project notes/interactions onto it. No first-class
    // task/ticket objects in core Shopify.
    activity_kinds_supported: ["note"],
    activity_update_in_place: true, // we PUT the customer.note field in place
    lead_to_contact_conversion_event: false,
    webhook_subscription: "app_level",
    idempotency_via_custom_field: true, // customer metafields carry our markers
    search_by_identifier: ["phone", "email"],
    version_token_field: "updated_at",
    rate_limit_per_minute: 40, // Shopify REST: 2 req/s sustained (bucket of 40)
    merge_supported: false,
    split_supported: false,
    task_supported: false,
    ticket_supported: false,
  },
  fireberry: {
    // Fireberry (formerly Powerlink) - Israeli CRM. Customer entity is the
    // Account object (objecttype 1); Contacts/Leads also exist. Field/object
    // names are tenant-customizable, so the adapter resolves them from config
    // with these defaults. Auth is a static API token (`tokenid` header) -
    // no OAuth - so no token refresh.
    entity_kinds_supported: ["contact", "lead", "company"],
    default_entity_kind_for_inbound: "contact",
    // We project notes onto a configurable text field (default `description`),
    // mirroring Shopify's single-note-field model. Tasks/tickets exist in
    // Fireberry but aren't wired yet - declare false until implemented.
    activity_kinds_supported: ["note"],
    activity_update_in_place: true,
    lead_to_contact_conversion_event: false,
    webhook_subscription: "polling_only",
    idempotency_via_custom_field: true,
    search_by_identifier: ["phone", "email"],
    version_token_field: "modifiedon",
    rate_limit_per_minute: 60,
    merge_supported: false,
    split_supported: false,
    task_supported: false,
    ticket_supported: false,
  },
  pipedrive: {
    entity_kinds_supported: ["contact", "organization_member"],
    default_entity_kind_for_inbound: "contact",
    activity_kinds_supported: ["note", "task", "call", "email", "meeting"],
    activity_update_in_place: true,
    lead_to_contact_conversion_event: false,
    webhook_subscription: "portal_level",
    idempotency_via_custom_field: true,
    search_by_identifier: ["phone", "email"],
    version_token_field: "update_time",
    rate_limit_per_minute: 100,
    merge_supported: true,
    split_supported: false,
    task_supported: true,
    ticket_supported: false,
    is_stub: true,
  },
  monday: {
    entity_kinds_supported: ["contact"],
    default_entity_kind_for_inbound: "contact",
    activity_kinds_supported: ["note"],
    activity_update_in_place: false,
    lead_to_contact_conversion_event: false,
    webhook_subscription: "portal_level",
    idempotency_via_custom_field: true,
    search_by_identifier: ["phone", "email"],
    version_token_field: "updated_at",
    rate_limit_per_minute: 60,
    merge_supported: false,
    split_supported: false,
    task_supported: true,
    ticket_supported: false,
    is_stub: true,
  },
  airtable: {
    entity_kinds_supported: ["contact"],
    default_entity_kind_for_inbound: "contact",
    activity_kinds_supported: ["note"],
    activity_update_in_place: true,
    lead_to_contact_conversion_event: false,
    webhook_subscription: "portal_level",
    idempotency_via_custom_field: true,
    search_by_identifier: ["phone", "email"],
    version_token_field: "last_modified_time",
    rate_limit_per_minute: 5,
    merge_supported: false,
    split_supported: false,
    task_supported: false,
    ticket_supported: false,
  },
  custom_api: {
    entity_kinds_supported: ["contact"],
    default_entity_kind_for_inbound: "contact",
    activity_kinds_supported: ["note"],
    activity_update_in_place: false,
    lead_to_contact_conversion_event: false,
    webhook_subscription: "polling_only",
    idempotency_via_custom_field: false,
    search_by_identifier: ["phone", "email"],
    version_token_field: "updated_at",
    rate_limit_per_minute: 60,
    merge_supported: false,
    split_supported: false,
    task_supported: false,
    ticket_supported: false,
    is_stub: true,
  },
  custom_db: {
    entity_kinds_supported: ["contact"],
    default_entity_kind_for_inbound: "contact",
    activity_kinds_supported: [],
    activity_update_in_place: false,
    lead_to_contact_conversion_event: false,
    webhook_subscription: "polling_only",
    idempotency_via_custom_field: false,
    search_by_identifier: ["phone", "email"],
    version_token_field: "updated_at",
    rate_limit_per_minute: 100,
    merge_supported: false,
    split_supported: false,
    task_supported: false,
    ticket_supported: false,
    is_stub: true,
  },
};

// ─── Helpers ────────────────────────────────────────────────

export function notImplemented(method: string, vendor: CrmVendor): CrmAdapterWriteResult {
  return { ok: false, reason: `not_implemented:${vendor}:${method}` };
}
