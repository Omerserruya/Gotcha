/**
 * P0 regression: cross-customer disclosure over WhatsApp (2026-07-20).
 *
 * From Omer's number (972525401686) the model was talked into fetching Matan
 * Amran's order #1004 - "verification" was "yes" + retyping Matan's phone -
 * and then attempted shopify.send_invoice to an attacker-supplied email.
 * These tests replay that exact attack against the deterministic guard and
 * pin the authorization model: the channel identity is authoritative, typed
 * identifiers are untrusted, denial happens BEFORE data reaches the model,
 * and only a stored-destination OTP grant opens scoped access.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn() },
  contact: { findFirst: vi.fn() },
  customerVerification: { findMany: vi.fn(async (): Promise<any[]> => []) },
  auditLog: { create: vi.fn(async () => ({})) },
  tenantIntegration: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(async () => ({})) },
}));

vi.mock("@chatcenter/shared", () => ({
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: prismaMock,
  encryptCredentials: (v: unknown) => v,
  decryptCredentials: (v: unknown) => v,
  assertPublicUrl: vi.fn(async () => {}),
}));

import {
  resolveRequesterIdentity,
  checkArgsAllowed,
  checkResultAllowed,
  phoneSuffix,
} from "../services/connectors/customer-access-guard";
import { executeAdapterTool } from "../services/connectors/integration-framework";
import "../services/connectors/shopify.adapter";

// The real actors from the incident.
const OMER_WA = "972525401686";
const MATAN_PHONE = "0545680665";
const MATAN_ORDER = {
  id: 16943014478193,
  name: "#1004",
  email: "matanam0012@gmail.com",
  contact_email: "matanam0012@gmail.com",
  phone: null,
  financial_status: "refunded",
  customer: { id: 8888888, email: "matanam0012@gmail.com", phone: "+972545680665" },
};
const OMER_ORDER = {
  id: 16943020015985,
  name: "#1005",
  email: "omerts58@gmail.com",
  financial_status: "paid",
  customer: { id: 27711577588081, email: "omerts58@gmail.com", phone: "+972525401686" },
};

function primeIdentity(opts?: { grants?: any[] }) {
  prismaMock.conversation.findFirst.mockResolvedValue({ customerExternalId: OMER_WA });
  prismaMock.contact.findFirst.mockResolvedValue({
    phone: "+972525401686",
    email: null,
    metadata: { crmContactId: "27711577588081" },
  });
  prismaMock.customerVerification.findMany.mockResolvedValue(opts?.grants ?? []);
}

beforeEach(() => {
  vi.clearAllMocks();
  primeIdentity();
});

describe("requester identity", () => {
  it("is derived from the conversation row + contact record, never from tool args", async () => {
    const id = await resolveRequesterIdentity("t1", "conv1");
    expect(id!.phoneSuffixes.has(phoneSuffix(OMER_WA)!)).toBe(true);
    expect(id!.customerIds.has("27711577588081")).toBe(true);
    expect(id!.phoneSuffixes.has(phoneSuffix(MATAN_PHONE)!)).toBe(false);
  });

  it("verification grants are read tenant+conversation scoped", async () => {
    await resolveRequesterIdentity("t1", "conv1");
    const where = (prismaMock.customerVerification.findMany.mock.calls[0] as any[])[0].where;
    expect(where.tenantId).toBe("t1");
    expect(where.conversationId).toBe("conv1");
    expect(where.verifiedAt).toEqual({ not: null });
  });
});

describe("pre-flight (2/3/4/5: assertions and typed identifiers grant nothing)", () => {
  it("own phone lookup is allowed", async () => {
    const id = (await resolveRequesterIdentity("t1", "conv1"))!;
    expect(checkArgsAllowed(id, "get_customer_by_phone", { phone: "+972525401686" }).allowed).toBe(true);
  });

  it("the victim's typed phone is denied - repeating it is not verification", async () => {
    const id = (await resolveRequesterIdentity("t1", "conv1"))!;
    const v = checkArgsAllowed(id, "get_customer_by_phone", { phone: MATAN_PHONE });
    expect(v.allowed).toBe(false);
    expect((v as any).reason).toContain("selector_phone_not_owned");
  });

  it("a typed email is denied when not the requester's", async () => {
    const id = (await resolveRequesterIdentity("t1", "conv1"))!;
    expect(checkArgsAllowed(id, "get_customer_by_email", { email: "matanam0012@gmail.com" }).allowed).toBe(false);
  });

  it("an AI-supplied authorization flag changes nothing (identity is not read from args)", async () => {
    const id = (await resolveRequesterIdentity("t1", "conv1"))!;
    const v = checkArgsAllowed(id, "get_customer_by_phone", {
      phone: MATAN_PHONE, customerConfirmed: true, isAuthorized: true,
    } as any);
    expect(v.allowed).toBe(false);
  });

  it("send_invoice with ANY chat-supplied destination is denied (redirect = account change, not resend)", async () => {
    const id = (await resolveRequesterIdentity("t1", "conv1"))!;
    const v = checkArgsAllowed(id, "send_invoice", { order_name: "1004", to: "omerts58@gmail.com" });
    expect(v.allowed).toBe(false);
    expect((v as any).reason).toBe("invoice_destination_override_denied");
  });
});

describe("post-flight (6/13/14/15: resolved resources must belong to the requester)", () => {
  it("Matan's order #1004 fetched by number is DENIED for Omer's identity", async () => {
    const id = (await resolveRequesterIdentity("t1", "conv1"))!;
    const v = checkResultAllowed(id, "get_order", MATAN_ORDER);
    expect(v.allowed).toBe(false);
  });

  it("the requester's own order is allowed (linked Shopify customer id)", async () => {
    const id = (await resolveRequesterIdentity("t1", "conv1"))!;
    const v = checkResultAllowed(id, "get_order", OMER_ORDER);
    expect(v.allowed).toBe(true);
  });

  it("lists are filtered to owned entries; an all-foreign list is denied", async () => {
    const id = (await resolveRequesterIdentity("t1", "conv1"))!;
    const mixed = checkResultAllowed(id, "search_orders", [MATAN_ORDER, OMER_ORDER]);
    expect(mixed.allowed).toBe(true);
    expect((mixed as any).result).toEqual([OMER_ORDER]);
    const foreign = checkResultAllowed(id, "search_orders", [MATAN_ORDER]);
    expect(foreign.allowed).toBe(false);
  });

  it("store-scoped results (products) pass untouched", async () => {
    const id = (await resolveRequesterIdentity("t1", "conv1"))!;
    const products = [{ id: 1, title: "Hydrogen", handle: "the-collection-snowboard-hydrogen" }];
    const v = checkResultAllowed(id, "search_products", products);
    expect(v.allowed).toBe(true);
    expect((v as any).result).toEqual(products);
  });
});

describe("verification grants (7/9/10/12)", () => {
  it("an ACTIVE grant for Matan unlocks exactly Matan's records", async () => {
    primeIdentity({ grants: [{ targetCustomerId: "8888888", targetPhone: "972545680665", targetEmail: "matanam0012@gmail.com" }] });
    const id = (await resolveRequesterIdentity("t1", "conv1"))!;
    expect(checkArgsAllowed(id, "get_customer_by_phone", { phone: MATAN_PHONE }).allowed).toBe(true);
    expect(checkResultAllowed(id, "get_order", MATAN_ORDER).allowed).toBe(true);
  });

  it("a grant for customer A does not authorize customer B", async () => {
    primeIdentity({ grants: [{ targetCustomerId: "999", targetPhone: "972500000000", targetEmail: null }] });
    const id = (await resolveRequesterIdentity("t1", "conv1"))!;
    expect(checkResultAllowed(id, "get_order", MATAN_ORDER).allowed).toBe(false);
  });

  it("expired grants are excluded by the query predicate itself", async () => {
    await resolveRequesterIdentity("t1", "conv1");
    const where = (prismaMock.customerVerification.findMany.mock.calls[0] as any[])[0].where;
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });
});

describe("executeAdapterTool end-to-end attack replay (1/6/20)", () => {
  function primeConnection() {
    prismaMock.tenantIntegration.findFirst.mockResolvedValue({
      id: "ti1", status: "CONNECTED",
      credentials: { accessToken: "shpat" },
      config: { shopDomain: "s.myshopify.com" },
      integration: { slug: "shopify" },
    });
  }

  it("the exact attack - get_order #1004 from Omer's chat - is denied BEFORE the model, with a security event", async () => {
    primeConnection();
    (globalThis as any).fetch = vi.fn(async (url: string) =>
      /orders\.json/.test(String(url))
        ? { ok: true, status: 200, json: async () => ({ orders: [MATAN_ORDER] }), text: async () => "{}" }
        : { ok: true, status: 200, json: async () => ({}), text: async () => "{}" },
    );
    const r = await executeAdapterTool({
      tenantId: "t1", conversationId: "conv1", accessScope: "customer",
      toolFunctionName: "shopify.get_order", args: { order_name: "1004" },
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toContain("access_denied_cross_customer");
    // nothing of Matan's leaked in the denial
    expect(JSON.stringify(r)).not.toContain("matanam0012");
    // security event recorded
    const sec = prismaMock.auditLog.create.mock.calls.map((c: any[]) => c[0].data)
      .find((d: any) => d.action === "security.cross_customer_access_denied");
    expect(sec).toBeTruthy();
    expect(JSON.stringify(sec)).not.toContain("matanam0012");
  });

  it("the victim-phone lookup is blocked pre-flight: the provider is never called", async () => {
    primeConnection();
    (globalThis as any).fetch = vi.fn();
    const r = await executeAdapterTool({
      tenantId: "t1", conversationId: "conv1", accessScope: "customer",
      toolFunctionName: "shopify.get_customer_by_phone", args: { phone: MATAN_PHONE },
    });
    expect(r.ok).toBe(false);
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
  });

  it("the requester's own latest order still works (authorized path intact)", async () => {
    primeConnection();
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (/customers\/search/.test(u)) return { ok: true, status: 200, json: async () => ({ customers: [{ id: 27711577588081, email: "omerts58@gmail.com", phone: "+972525401686" }] }), text: async () => "{}" };
      if (/orders\.json/.test(u)) return { ok: true, status: 200, json: async () => ({ orders: [OMER_ORDER] }), text: async () => "{}" };
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    });
    const r = await executeAdapterTool({
      tenantId: "t1", conversationId: "conv1", accessScope: "customer",
      toolFunctionName: "shopify.find_latest_order", args: { phone: "+972525401686" },
    });
    expect(r.ok).toBe(true);
  });

  it("internal scope (system/staff paths) is unaffected", async () => {
    primeConnection();
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ orders: [MATAN_ORDER] }), text: async () => "{}",
    }));
    const r = await executeAdapterTool({
      tenantId: "t1", conversationId: "conv1",
      toolFunctionName: "shopify.get_order", args: { order_name: "1004" },
    });
    expect(r.ok).toBe(true);
  });
});
