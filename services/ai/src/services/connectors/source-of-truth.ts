/**
 * Source of Truth - the normalized, capability-honest facade over the
 * tenant's elected business system (a classic CRM, or Shopify elected via
 * `config.useAsCrm` / onboarding "core system").
 *
 * WHY a facade instead of using CRMAdapter directly: callers that only need
 * "who is this customer / write the summary / update fields" should neither
 * know vendor quirks nor guess which optional adapter methods exist. Every
 * operation here maps to a REAL vendor API through the adapter; nothing is
 * simulated. When a provider can't do something, `supports()` says so and
 * the operation throws UnsupportedCapabilityError - callers must branch on
 * `supports()` (or catch) and degrade honestly, never pretend.
 *
 * Shopify mapping (see ShopifyCRMAdapter + DEFAULT_CAPABILITIES.shopify):
 *  - identifyCustomer       → customer search by phone/email (real API)
 *  - getCustomerContext     → customer + orders context
 *  - relatedBusinessContext → vendor timeline (notes; orders via context)
 *  - writeConversationSummary → customer `note` projection (append-in-place)
 *  - writeInteraction       → same note timeline projection
 *  - updateCustomerFields   → customer PUT + metafields
 *  - create_task / merge_contacts → NOT supported (core Shopify has neither)
 *    and therefore never advertised.
 *
 * Tenant scoping: everything flows through getCrmAdapter(tenantId), which
 * resolves ONLY that tenant's TenantIntegration rows.
 */

import { getCrmAdapter } from "./crm-adapter-resolver";
import { NoOpCRMAdapter } from "./crm-adapter.impl";
import type {
  CRMAdapter,
  CrmVendor,
  CrmObjectKind,
  CrmAdapterFindResult,
  CrmAdapterContextResult,
  CrmAdapterWriteResult,
} from "./crm-adapter.types";

export type SourceOfTruthCapability =
  | "identify_customer"
  | "customer_context"
  | "related_business_context"
  | "write_conversation_summary"
  | "write_interaction"
  | "update_customer_fields"
  | "create_task"
  | "merge_contacts";

export class UnsupportedCapabilityError extends Error {
  readonly capability: SourceOfTruthCapability;
  readonly vendor: CrmVendor;
  constructor(vendor: CrmVendor, capability: SourceOfTruthCapability) {
    super(`source-of-truth provider "${vendor}" does not support "${capability}"`);
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
    this.vendor = vendor;
  }
}

export interface SourceOfTruthProvider {
  readonly vendor: CrmVendor;
  readonly tenantId: string;
  supports(capability: SourceOfTruthCapability): boolean;
  /** All capabilities this provider truthfully supports. */
  capabilities(): SourceOfTruthCapability[];

  identifyCustomer(query: { phone?: string; email?: string; external_id?: string }): Promise<CrmAdapterFindResult>;
  getCustomerContext(args: { contact_id: string; kind: CrmObjectKind }): Promise<CrmAdapterContextResult>;
  /** Vendor timeline (notes/tasks/orders projections) beyond the core context. */
  getRelatedBusinessContext(args: { contact_id: string; kind: CrmObjectKind; limit?: number }): Promise<{ ok: boolean; activities: unknown[]; reason?: string }>;
  writeConversationSummary(args: { contact_id: string; kind: CrmObjectKind; body: string; source_interaction_id?: string }): Promise<CrmAdapterWriteResult>;
  writeInteraction(args: WriteInteractionArgs): Promise<CrmAdapterWriteResult>;
  updateCustomerFields(args: { contact_id: string; kind: CrmObjectKind; fields: Record<string, unknown> }): Promise<CrmAdapterWriteResult>;
}

/** Normalized interaction write - mapped onto the adapter's envelope. */
export interface WriteInteractionArgs {
  contact_id: string;
  kind: CrmObjectKind;
  /** GOTCHA conversation id - the adapters' idempotency anchor. */
  source_interaction_id: string;
  channel: "voice" | "whatsapp" | "instagram" | "messenger" | "webchat" | "email" | "sms";
  direction: "inbound" | "outbound";
  started_at: string;
  summary?: string;
  ended_at?: string;
  message_count?: number;
}

/** Truthful capability derivation: adapter capability flags AND method presence. */
export function deriveCapabilities(adapter: CRMAdapter): SourceOfTruthCapability[] {
  const caps: SourceOfTruthCapability[] = [
    // Required CRMAdapter surface - every real adapter maps these to live APIs.
    "identify_customer",
    "customer_context",
    "write_conversation_summary",
    "write_interaction",
  ];
  if (typeof adapter.listRecentActivities === "function" || typeof adapter.listRecentNotes === "function") {
    caps.push("related_business_context");
  }
  if (typeof adapter.updateRecord === "function") caps.push("update_customer_fields");
  if (typeof adapter.createTask === "function" && adapter.capabilities.task_supported) caps.push("create_task");
  if (typeof adapter.mergeContacts === "function" && adapter.capabilities.merge_supported) caps.push("merge_contacts");
  return caps;
}

class AdapterBackedProvider implements SourceOfTruthProvider {
  readonly vendor: CrmVendor;
  readonly tenantId: string;
  private readonly caps: Set<SourceOfTruthCapability>;
  constructor(private readonly adapter: CRMAdapter) {
    this.vendor = adapter.vendor;
    this.tenantId = adapter.tenantId;
    this.caps = new Set(deriveCapabilities(adapter));
  }

  supports(capability: SourceOfTruthCapability): boolean { return this.caps.has(capability); }
  capabilities(): SourceOfTruthCapability[] { return [...this.caps]; }

  private require(capability: SourceOfTruthCapability): void {
    if (!this.caps.has(capability)) throw new UnsupportedCapabilityError(this.vendor, capability);
  }

  identifyCustomer(query: { phone?: string; email?: string; external_id?: string }) {
    return this.adapter.findCustomer(query);
  }

  getCustomerContext(args: { contact_id: string; kind: CrmObjectKind }) {
    return this.adapter.getCustomerContext(args);
  }

  async getRelatedBusinessContext(args: { contact_id: string; kind: CrmObjectKind; limit?: number }) {
    this.require("related_business_context");
    const fn = this.adapter.listRecentActivities ?? this.adapter.listRecentNotes;
    const r = await fn!.call(this.adapter, args);
    return { ok: r.ok, activities: r.activities ?? [], reason: r.reason };
  }

  writeConversationSummary(args: { contact_id: string; kind: CrmObjectKind; body: string; source_interaction_id?: string }) {
    return this.adapter.createNote(args);
  }

  writeInteraction(args: WriteInteractionArgs) {
    const { contact_id, kind, ...envelope } = args;
    return this.adapter.appendInteraction({ contact_id, kind, interaction: envelope });
  }

  async updateCustomerFields(args: { contact_id: string; kind: CrmObjectKind; fields: Record<string, unknown> }) {
    this.require("update_customer_fields");
    return this.adapter.updateRecord!({ id: args.contact_id, kind: args.kind, fields: args.fields });
  }
}

/**
 * The tenant's Source of Truth, or null when none is connected/elected
 * (callers show an accurate "not configured" state - never a NoOp pretender).
 */
export async function getSourceOfTruth(tenantId: string): Promise<SourceOfTruthProvider | null> {
  const adapter = await getCrmAdapter(tenantId);
  if (!adapter || adapter instanceof NoOpCRMAdapter) return null;
  return new AdapterBackedProvider(adapter);
}
