/**
 * Production CrmPort - the existing CRM code BECOMES the adapter. Each method
 * delegates to one concrete production call and maps its result to the abstract port
 * shape. NO business rules here; NO reimplementation. The vendor-neutral `CRMAdapter`
 * (HubSpot/Salesforce/Zoho/Shopify/Fireberry/Airtable) is the source of truth.
 */

import { getCrmAdapter, resolveCrmVendor } from "../connectors/crm-adapter-resolver";
import { linkOrCreateCrmContact } from "../connectors/crm-identity.service";
import type { CanonicalCrmContact } from "../connectors/crm-adapter.types";
import type { CrmPort, CrmContactRef } from "./crm.port";

function toRef(c: CanonicalCrmContact): CrmContactRef {
  return { id: c.id, kind: c.kind, displayName: c.display_name, email: c.email, phone: c.phone, stage: c.stage, vendor: c.vendor };
}

export function createProdCrmPort(): CrmPort {
  return {
    async connection(ctx) {
      const vendor = await resolveCrmVendor(ctx.tenantId);
      return { connected: vendor !== null, vendor };
    },

    async searchCustomer(ctx, query) {
      const adapter = await getCrmAdapter(ctx.tenantId);
      const res = await adapter.findCustomer({
        phone: query.phone,
        email: query.email,
        external_id: query.external_id,
      });
      return { ok: res.ok, contacts: (res.contacts ?? []).map(toRef), reason: res.reason };
    },

    async upsertCustomer(ctx, hints) {
      const adapter = await getCrmAdapter(ctx.tenantId);
      // Wrap the production identity flow: 0 → create, 1 → enrich, 2+ → merge-or-approval.
      // allow_auto_merge:false keeps irreversible merges operator-gated (CLAUDE.md rule #9).
      const outcome = await linkOrCreateCrmContact({
        adapter,
        hints: {
          email: hints.email ?? ctx.customerEmail,
          phone: hints.phone ?? ctx.customerPhone,
          display_name: hints.name,
        },
        mode: "create_if_missing",
        inbound_source: "ai-agent",
        allow_auto_merge: false,
      });
      switch (outcome.status) {
        case "created": return { status: "created", contact: toRef(outcome.contact) };
        case "linked": return { status: "linked", contact: toRef(outcome.contact), wasEnriched: outcome.was_enriched };
        case "merged": return { status: "merged", contact: toRef(outcome.contact) };
        case "needs_approval": return { status: "needs_approval", candidates: outcome.candidates.map(toRef), reason: outcome.reason };
        case "not_found": return { status: "not_found", reason: outcome.reason };
        default: return { status: "error", reason: outcome.reason };
      }
    },

    async addNote(ctx, args) {
      const adapter = await getCrmAdapter(ctx.tenantId);
      const r = await adapter.createNote({
        contact_id: args.contactId,
        kind: (args.kind ?? "contact") as CanonicalCrmContact["kind"],
        body: args.body,
      });
      return { ok: r.ok, id: r.id, reason: r.reason };
    },

    async getContext(ctx, args) {
      const adapter = await getCrmAdapter(ctx.tenantId);
      const r = await adapter.getCustomerContext({
        contact_id: args.contactId,
        kind: (args.kind ?? "contact") as CanonicalCrmContact["kind"],
      });
      if (!r.ok || !r.context) return { ok: false, reason: r.reason ?? "context_unavailable" };
      const c = r.context;
      return {
        ok: true,
        context: {
          contact: toRef(c.contact),
          activities: (c.recent_activities ?? []).length,
          deals: (c.deals ?? []).map((d: any) => ({ name: d.name, stage: d.stage, amount: d.amount })),
          tickets: (c.tickets ?? []).map((t: any) => ({ subject: t.subject, status: t.status })),
        },
      };
    },

    async updateRecord(ctx, args) {
      const adapter = await getCrmAdapter(ctx.tenantId);
      if (!adapter.updateRecord) return { ok: false, reason: "vendor_does_not_support_update" };
      const r = await adapter.updateRecord({
        id: args.contactId,
        kind: (args.kind ?? "contact") as CanonicalCrmContact["kind"],
        fields: args.fields, // sparse-patch contract: only the provided fields are written
      });
      return { ok: r.ok, id: r.id, reason: r.reason };
    },

    async createTask(ctx, args) {
      const adapter = await getCrmAdapter(ctx.tenantId);
      if (!adapter.createTask) return { ok: false, reason: "vendor_does_not_support_tasks" };
      const r = await adapter.createTask({
        contact_id: args.contactId,
        kind: (args.kind ?? "contact") as CanonicalCrmContact["kind"],
        subject: args.subject,
        body: args.body,
        due_at: args.dueAt,
      });
      return { ok: r.ok, id: r.id, reason: r.reason };
    },
  };
}
