/**
 * Two promises about linking contacts as one person (2026-10-11):
 *   - an ownership-checked order that resolves to a Shopify customer another
 *     contact already carries links the two (rememberShopifyCustomer);
 *   - ★ a link is a display fact: the order-access guard reads ONLY the
 *     conversation's own contact. A linked sibling's phone or email never
 *     becomes this requester's identity, so a link (which a typed number can
 *     create) never opens another customer's orders.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  contacts: [] as any[],
  autoLink: vi.fn(async () => ({ outcome: "linked" })),
}));
vi.mock("@chatcenter/shared", () => ({
  prisma: {
    conversation: { findFirst: vi.fn(async () => ({ customerExternalId: "ig-sender" })) },
    contact: {
      findFirst: vi.fn(async ({ where }: any) => H.contacts.find((c) =>
        c.tenantId === where.tenantId
        && (where.externalId === undefined || c.externalId === where.externalId)
        && (where.personId === undefined || c.personId === where.personId)) ?? null),
      findMany: vi.fn(async ({ where }: any) => H.contacts.filter((c) => c.tenantId === where.tenantId && (where.personId === undefined || c.personId === where.personId))),
      update: vi.fn(async () => ({})),
    },
    customerVerification: { findMany: vi.fn(async () => []) },
  },
  autoLinkByShopifyCustomer: H.autoLink,
}));

import { resolveRequesterIdentity, rememberShopifyCustomer } from "../services/connectors/customer-access-guard";

beforeEach(() => {
  vi.clearAllMocks();
  H.contacts = [
    // The Instagram sender, LINKED (same personId) to a WhatsApp customer.
    { id: "ig1", tenantId: "t1", externalId: "ig-sender", personId: "person_1", phone: null, email: null, metadata: {} },
    { id: "wa1", tenantId: "t1", externalId: "972541111111", personId: "person_1", phone: "+972541111111", email: "dana@example.com", metadata: { shopifyCustomerId: "777" } },
  ];
});

describe("★ the order-access guard never follows a link", () => {
  it("a linked sibling's phone, email and Shopify id are NOT the requester's", async () => {
    const id = await resolveRequesterIdentity("t1", "c1");
    expect([...id!.emails]).toEqual([]);
    expect([...id!.customerIds]).toEqual([]);
    expect([...id!.phoneSuffixes].some((s) => "972541111111".endsWith(s))).toBe(false);
  });
});

describe("an order resolved to a known Shopify customer links the contacts", () => {
  it("pins the customer, then asks to link this contact by that customer id", async () => {
    H.contacts[0].metadata = {};
    await rememberShopifyCustomer("t1", "c1", 777);
    expect(H.autoLink).toHaveBeenCalledWith({ tenantId: "t1", contactId: "ig1", shopifyCustomerId: "777" });
  });

  it("a link failure never fails the pin", async () => {
    H.autoLink.mockRejectedValueOnce(new Error("db blip"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(rememberShopifyCustomer("t1", "c1", 777)).resolves.toBeUndefined();
  });
});
