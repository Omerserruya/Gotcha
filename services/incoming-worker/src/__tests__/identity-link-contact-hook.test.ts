/**
 * A phone or email the customer types links their contact to the contact
 * whose channel proves it (2026-10-11), next to - and never blocking - the CRM
 * auto-link the same function already did.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  autoLink: vi.fn(async () => ({ outcome: "linked", targetContactId: "wa1" })),
  resolve: vi.fn(async () => ({ id: "ig1" })),
  conv: { channel: "INSTAGRAM", customerExternalId: "1031990639501705" } as any,
}));
vi.mock("@chatcenter/shared", () => ({
  getInternalServiceKey: () => "k",
  prisma: {
    tenant: { findUnique: vi.fn(async () => ({ defaultCountryCode: "IL" })) },
    conversation: { findUnique: vi.fn(async () => H.conv) },
  },
  resolveContactByChannelId: H.resolve,
  autoLinkByIdentifier: H.autoLink,
}));

import { tryLinkIdentifierFromInbound } from "../services/identity-link.service";

const crm = vi.fn(async () => new Response(JSON.stringify({ ok: true, outcome: "linked", crmContactId: "crm1" }), { status: 200 }));

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).fetch = crm;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the inbound identity hook links contacts", () => {
  it("a typed phone: the sender's contact, the E.164 value, then the CRM link as before", async () => {
    const r = await tryLinkIdentifierFromInbound({ tenantId: "t1", conversationId: "c1", text: "my number is 054-111-1111" });

    expect(H.resolve).toHaveBeenCalledWith("t1", "INSTAGRAM", "1031990639501705");
    expect(H.autoLink).toHaveBeenCalledWith({ tenantId: "t1", senderContactId: "ig1", identifier: { type: "phone", value: "+972541111111" } });
    expect(crm).toHaveBeenCalledTimes(1);
    expect(r.linked).toBe(true);
  });

  it("no identifier in the text: no contact link", async () => {
    await tryLinkIdentifierFromInbound({ tenantId: "t1", conversationId: "c1", text: "hello there" });
    expect(H.autoLink).not.toHaveBeenCalled();
  });

  it("a contact-link failure never blocks the CRM link", async () => {
    H.autoLink.mockRejectedValueOnce(new Error("db blip"));
    const r = await tryLinkIdentifierFromInbound({ tenantId: "t1", conversationId: "c1", text: "dana@example.com" });
    expect(crm).toHaveBeenCalledTimes(1);
    expect(r.linked).toBe(true);
  });
});
