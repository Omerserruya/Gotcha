/**
 * Smoke tests for the CRM identity-resolution service.
 *
 * Covers:
 *   • normalizeEmail / normalizePhone happy paths + obvious rejects
 *   • linkOrCreateCrmContact 0/1/2+ flow against a hand-rolled CRMAdapter mock
 *   • Channel custom-field passthrough on create
 *   • Strong vs weak merge signal classification
 *   • search_only vs create_if_missing mode behaviour
 *   • allow_auto_merge gate (default off → needs_approval even with strong signal)
 */

import { describe, it, expect, vi } from "vitest";
import {
  normalizeEmail,
  normalizePhone,
  linkOrCreateCrmContact,
  CHANNEL_FIELD_PLAN,
  type IdentityHints,
} from "../services/connectors/crm-identity.service";
import type {
  CRMAdapter,
  CanonicalCrmContact,
} from "../services/connectors/crm-adapter.types";
import { DEFAULT_CAPABILITIES } from "../services/connectors/crm-adapter.types";

// ─── Normalization ──────────────────────────────────────────

describe("normalizeEmail", () => {
  it("lowercases + trims + accepts simple addresses", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
    expect(normalizeEmail("user.name+tag@host.io")).toBe("user.name+tag@host.io");
  });
  it("rejects malformed input", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail("foo")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail("a b@c.com")).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("accepts already-E.164 numbers", () => {
    expect(normalizePhone("+972501234567")).toBe("+972501234567");
    expect(normalizePhone("+1 (212) 555-1234")).toBe("+12125551234");
  });
  it("uses the region hint for local-format numbers", () => {
    expect(normalizePhone("0501234567", "IL")).toBe("+972501234567");
    expect(normalizePhone("050-123-4567", "IL")).toBe("+972501234567");
    expect(normalizePhone("(212) 555-1234", "US")).toBe("+12125551234");
  });
  it("handles bare digit strings (already-E.164 missing the +)", () => {
    expect(normalizePhone("972501234567")).toBe("+972501234567");
  });
  it("rejects garbage", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("+12")).toBeNull(); // too short
  });
});

// ─── Adapter mock ──────────────────────────────────────────

function makeContact(over: Partial<CanonicalCrmContact>): CanonicalCrmContact {
  return {
    id: over.id ?? "c1",
    kind: over.kind ?? "contact",
    display_name: over.display_name ?? null,
    email: over.email ?? null,
    phone: over.phone ?? null,
    owner_id: over.owner_id ?? null,
    stage: over.stage ?? null,
    custom_fields: over.custom_fields ?? {},
    vendor_updated_at: over.vendor_updated_at ?? "2026-05-12T10:00:00Z",
    fetched_at: "2026-05-12T10:00:00Z",
    vendor: over.vendor ?? "hubspot",
  };
}

function makeAdapter(overrides: Partial<CRMAdapter> = {}): CRMAdapter {
  const base: CRMAdapter = {
    vendor: "hubspot",
    tenantId: "t1",
    capabilities: { ...DEFAULT_CAPABILITIES.hubspot },
    findCustomer: vi.fn(async () => ({ ok: true, contacts: [] })),
    getCustomerContext: vi.fn(async ({ contact_id, kind }) => ({
      ok: true,
      context: {
        contact: makeContact({ id: contact_id, kind }),
        recent_activities: [],
        deals: [],
        tickets: [],
      },
    })),
    createLead: vi.fn(async () => ({ ok: true, id: "new_id", kind: "contact" as const })),
    createNote: vi.fn(async () => ({ ok: true, id: "n1" })),
    appendInteraction: vi.fn(async () => ({ ok: true, id: "a1" })),
    enrichContact: vi.fn(async () => ({ ok: true, was_update: true })),
    findByCustomField: vi.fn(async () => ({ ok: true, contacts: [] })),
    mergeContacts: vi.fn(async () => ({ ok: true, primary_id: "p", merged_count: 1 })),
  };
  return { ...base, ...overrides };
}

// ─── 0/1/2+ flow ────────────────────────────────────────────

describe("linkOrCreateCrmContact", () => {
  it("returns not_found when search_only mode finds nothing", async () => {
    const adapter = makeAdapter();
    const r = await linkOrCreateCrmContact({
      adapter,
      hints: { email: "x@y.com" },
      mode: "search_only",
    });
    expect(r.status).toBe("not_found");
    expect(adapter.findCustomer).toHaveBeenCalledWith({ email: "x@y.com" });
  });

  it("creates a new lead when no match and mode is create_if_missing", async () => {
    const adapter = makeAdapter({
      createLead: vi.fn(async () => ({ ok: true, id: "lead_42", kind: "lead" as const })) as any,
    });
    const r = await linkOrCreateCrmContact({
      adapter,
      hints: {
        email: "  NEW@x.COM ",
        phone: "+972501234567",
        display_name: "New Lead",
        channels: [{ channel: "messenger", external_id: "PSID-abc", username: "newlead.fb" }],
      },
      mode: "create_if_missing",
    });
    expect(r.status).toBe("created");
    if (r.status !== "created") throw new Error("unreachable");
    // createLead got normalized email + per-channel custom fields.
    expect(adapter.createLead).toHaveBeenCalledWith(expect.objectContaining({
      email: "new@x.com",
      phone: "+972501234567",
      custom: expect.objectContaining({
        [CHANNEL_FIELD_PLAN.messenger.external_id!]: "PSID-abc",
        [CHANNEL_FIELD_PLAN.messenger.username!]: "newlead.fb",
      }),
    }));
  });

  it("returns error when no identifiers were supplied", async () => {
    const adapter = makeAdapter();
    const r = await linkOrCreateCrmContact({
      adapter,
      hints: {},
    });
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.reason).toBe("no_identifiers");
  });

  it("links + enriches when exactly one match is missing the new phone identifier", async () => {
    const existing = makeContact({ id: "match_1", email: "jane@x.com", phone: null });
    const adapter = makeAdapter({
      findCustomer: vi.fn(async (q: any) => {
        if (q.email) return { ok: true, contacts: [existing] };
        return { ok: true, contacts: [] };
      }) as any,
    });
    const r = await linkOrCreateCrmContact({
      adapter,
      hints: { email: "jane@x.com", phone: "+972501234567" },
      mode: "search_only",
    });
    expect(r.status).toBe("linked");
    if (r.status !== "linked") throw new Error("unreachable");
    expect(r.was_enriched).toBe(true);
    expect(adapter.enrichContact).toHaveBeenCalledWith(expect.objectContaining({
      contact_id: "match_1",
      update: expect.objectContaining({ phone: "+972501234567" }),
    }));
  });

  it("links without enriching when the single match already has every identifier", async () => {
    const existing = makeContact({ id: "m2", email: "j@x.com", phone: "+972501234567" });
    const adapter = makeAdapter({
      findCustomer: vi.fn(async () => ({ ok: true, contacts: [existing] })) as any,
    });
    const r = await linkOrCreateCrmContact({
      adapter,
      hints: { email: "j@x.com", phone: "+972501234567" },
    });
    expect(r.status).toBe("linked");
    if (r.status === "linked") expect(r.was_enriched).toBe(false);
    expect(adapter.enrichContact).not.toHaveBeenCalled();
  });

  it("dedupes matches by id when multiple lookups return the same row", async () => {
    const same = makeContact({ id: "dup", email: "j@x.com", phone: "+15551234567" });
    const adapter = makeAdapter({
      findCustomer: vi.fn(async () => ({ ok: true, contacts: [same] })) as any,
    });
    const r = await linkOrCreateCrmContact({
      adapter,
      hints: { email: "j@x.com", phone: "+15551234567" },
    });
    // Single de-duped match → linked, NOT needs_approval.
    expect(r.status).toBe("linked");
  });

  it("returns needs_approval on 2+ matches when allow_auto_merge is off (default)", async () => {
    const a = makeContact({ id: "rowA", email: "j@x.com" });
    const b = makeContact({ id: "rowB", phone: "+15551234567" });
    const adapter = makeAdapter({
      findCustomer: vi.fn(async (q: any) => {
        if (q.email) return { ok: true, contacts: [a] };
        if (q.phone) return { ok: true, contacts: [b] };
        return { ok: true, contacts: [] };
      }) as any,
    });
    const r = await linkOrCreateCrmContact({
      adapter,
      hints: { email: "j@x.com", phone: "+15551234567" },
    });
    expect(r.status).toBe("needs_approval");
    if (r.status === "needs_approval") expect(r.candidates.map((c) => c.id).sort()).toEqual(["rowA", "rowB"]);
    expect(adapter.mergeContacts).not.toHaveBeenCalled();
  });

  it("auto-merges on 2+ matches when allow_auto_merge AND strong signal AND vendor supports merge", async () => {
    const a = makeContact({ id: "rowA", email: "j@x.com", phone: null, vendor_updated_at: "2026-05-12T11:00:00Z" });
    const b = makeContact({ id: "rowB", email: null, phone: "+15551234567", vendor_updated_at: "2026-05-12T09:00:00Z" });
    const adapter = makeAdapter({
      findCustomer: vi.fn(async (q: any) => {
        if (q.email) return { ok: true, contacts: [a] };
        if (q.phone) return { ok: true, contacts: [b] };
        return { ok: true, contacts: [] };
      }) as any,
    });
    const r = await linkOrCreateCrmContact({
      adapter,
      hints: { email: "j@x.com", phone: "+15551234567" },
      allow_auto_merge: true,
    });
    expect(r.status).toBe("merged");
    if (r.status !== "merged") throw new Error("unreachable");
    // Newer row is the primary.
    expect(adapter.mergeContacts).toHaveBeenCalledWith(expect.objectContaining({
      primary_id: "rowA",
      others: ["rowB"],
    }));
    expect(r.merged_from).toEqual(["rowB"]);
  });

  it("falls back to needs_approval when merge is attempted but vendor returns failure", async () => {
    const a = makeContact({ id: "rowA", email: "j@x.com", vendor_updated_at: "2026-05-12T11:00:00Z" });
    const b = makeContact({ id: "rowB", email: "j@x.com", vendor_updated_at: "2026-05-12T09:00:00Z" });
    const adapter = makeAdapter({
      findCustomer: vi.fn(async () => ({ ok: true, contacts: [a, b] })) as any,
      mergeContacts: vi.fn(async () => ({ ok: false, reason: "not_implemented" })) as any,
    });
    const r = await linkOrCreateCrmContact({
      adapter,
      hints: { email: "j@x.com" },
      allow_auto_merge: true,
    });
    expect(r.status).toBe("needs_approval");
  });

  it("does not auto-merge when vendor capability is merge_supported:false", async () => {
    const a = makeContact({ id: "z1", email: "j@x.com", vendor_updated_at: "2026-05-12T11:00:00Z" });
    const b = makeContact({ id: "z2", email: "j@x.com", vendor_updated_at: "2026-05-12T09:00:00Z" });
    const adapter = makeAdapter({
      vendor: "zoho",
      capabilities: { ...DEFAULT_CAPABILITIES.zoho }, // merge_supported: false
      findCustomer: vi.fn(async () => ({ ok: true, contacts: [a, b] })) as any,
    });
    const r = await linkOrCreateCrmContact({
      adapter,
      hints: { email: "j@x.com" },
      allow_auto_merge: true,
    });
    expect(r.status).toBe("needs_approval");
    expect(adapter.mergeContacts).not.toHaveBeenCalled();
  });

  it("calls findByCustomField for each strong channel identifier", async () => {
    const adapter = makeAdapter();
    await linkOrCreateCrmContact({
      adapter,
      hints: {
        email: "j@x.com",
        channels: [
          { channel: "instagram", external_id: "IGSID-123", username: "user.ig" },
          { channel: "messenger", external_id: "PSID-456" },
        ],
      },
      mode: "search_only",
    });
    const calls = (adapter.findByCustomField as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls).toEqual(expect.arrayContaining([
      { field: CHANNEL_FIELD_PLAN.instagram.external_id, value: "IGSID-123" },
      { field: CHANNEL_FIELD_PLAN.messenger.external_id, value: "PSID-456" },
    ]));
  });

  it("cross-platform retrieval: WA contact found via PSID custom field on the Instagram entry", async () => {
    // Customer who messaged on Instagram earlier (CRM has IGSID stored). They
    // come back via WhatsApp now; we have phone + IGSID hint from prior session.
    const linked = makeContact({
      id: "cross_1",
      email: "j@x.com",
      phone: "+972501234567",
      custom_fields: { [CHANNEL_FIELD_PLAN.instagram.external_id!]: "IGSID-xyz" },
    });
    const adapter = makeAdapter({
      // Phone search returns nothing (WA channel new).
      findCustomer: vi.fn(async () => ({ ok: true, contacts: [] })) as any,
      // But the IGSID custom-field lookup hits.
      findByCustomField: vi.fn(async () => ({ ok: true, contacts: [linked] })) as any,
    });
    const r = await linkOrCreateCrmContact({
      adapter,
      hints: {
        phone: "+972501234567",
        channels: [{ channel: "instagram", external_id: "IGSID-xyz" }],
      },
      mode: "search_only",
    });
    expect(r.status).toBe("linked");
    if (r.status !== "linked") throw new Error("unreachable");
    expect(r.contact.id).toBe("cross_1");
  });
});

// ─── Hints typing sanity ────────────────────────────────────

describe("IdentityHints shape", () => {
  it("compiles with the expected channel kinds", () => {
    const h: IdentityHints = {
      channels: [
        { channel: "whatsapp",  external_id: "+15551234567" },
        { channel: "instagram", external_id: "IGSID-1", username: "user.ig" },
        { channel: "messenger", external_id: "PSID-1",  username: "User Name" },
      ],
    };
    expect(h.channels?.length).toBe(3);
  });
});
