/**
 * contactId on conversations - read-only, batched.
 *
 * Pinned: a conversation with a contact gets its id; a merged contact
 * resolves to the contact it was merged INTO; no contact is null and nothing
 * is created; a page of 50 is ONE contacts query (plus one per merge hop only
 * when there are merges); another tenant's contact is never returned. And
 * GET /api/conversations/:id carries it, through the real router.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ contacts: [] as any[], contactQueries: 0, creates: 0, conv: null as any, page: [] as any[] }));

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
    return row[k] === v;
  });
}

vi.mock("@chatcenter/shared", () => ({
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  latestHandover: async () => null,
  getInternalServiceKey: () => "k",
  readDurableSetting: async () => null,
  recordHandover: async () => undefined,
  publishEvent: async () => undefined,
  withHistoricalRecords: (x: any) => x,
  outgoingMessageQueue: { add: async () => undefined },
  notificationsQueue: { add: async () => undefined },
  prisma: {
    contact: {
      findMany: async (a: any) => {
        if (!a.where.tenantId) throw new Error("tenant guard");
        H.contactQueries++;
        return H.contacts.filter((c) => matches(c, a.where));
      },
      create: async () => { H.creates++; return {}; },
      upsert: async () => { H.creates++; return {}; },
    },
    conversation: {
      findFirst: async (a: any) => (a.where.id === H.conv?.id && a.where.tenantId === "T" ? H.conv : null),
      findMany: async () => H.page,
      count: async () => H.page.length,
    },
  },
}));

import { contactIdsFor, contactIdOf } from "../lib/conversation-contact";
import router from "../routes/conversations";
import { list } from "../services/conversation.service";

const ct = (id: string, externalId: string, o: any = {}) => ({ id, tenantId: "T", channel: "WHATSAPP", externalId, mergedIntoId: null, ...o });

beforeEach(() => {
  H.contacts = [
    ct("k1", "9721"),
    ct("k_old", "9722", { mergedIntoId: "k_mid" }),
    ct("k_mid", "x-mid", { mergedIntoId: "k_new" }),
    ct("k_new", "x-new"),
    ct("k_other_tenant", "9723", { tenantId: "X" }),
  ];
  H.contactQueries = 0;
  H.creates = 0;
});

describe("contactIdsFor", () => {
  it("★ a contact; a merged contact → its final target; none → null; never creates", async () => {
    const rows = [
      { channel: "WHATSAPP", customerExternalId: "9721" },
      { channel: "WHATSAPP", customerExternalId: "9722" },
      { channel: "WHATSAPP", customerExternalId: "9999" },
      { channel: "WHATSAPP", customerExternalId: "9723" }, // exists only in another tenant
      { channel: "INSTAGRAM", customerExternalId: "9721" }, // same id, other channel
      { channel: "WHATSAPP", customerExternalId: null },
    ];
    const map = await contactIdsFor("T", rows);
    expect(rows.map((r) => contactIdOf(map, r))).toEqual(["k1", "k_new", null, null, null, null]);
    expect(H.creates).toBe(0);
  });

  it("★ a page of 50 without merges is ONE contacts query", async () => {
    H.contacts = Array.from({ length: 50 }, (_, i) => ct(`k${i}`, `97${i}`));
    const rows = H.contacts.map((c) => ({ channel: "WHATSAPP", customerExternalId: c.externalId }));
    const map = await contactIdsFor("T", rows);
    expect(H.contactQueries).toBe(1);
    expect(contactIdOf(map, rows[49])).toBe("k49");
  });

  it("merges cost one query per hop, for the whole page at once", async () => {
    await contactIdsFor("T", [{ channel: "WHATSAPP", customerExternalId: "9722" }]);
    expect(H.contactQueries).toBe(3); // the page, then k_mid, then k_new
  });

  it("a merge cycle resolves to null, not a hang or a guess", async () => {
    H.contacts = [ct("a", "1", { mergedIntoId: "b" }), ct("b", "2", { mergedIntoId: "a" })];
    const map = await contactIdsFor("T", [{ channel: "WHATSAPP", customerExternalId: "1" }]);
    expect(contactIdOf(map, { channel: "WHATSAPP", customerExternalId: "1" })).toBeNull();
  });
});

describe("GET /api/conversations/:id", () => {
  it("★ carries contactId, through the real router", async () => {
    H.conv = { id: "c1", tenantId: "T", channel: "WHATSAPP", customerExternalId: "9722", messages: [] };
    const app = express();
    app.use("/api/conversations", router);
    const r = await request(app).get("/api/conversations/c1");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: "c1", contactId: "k_new" });
  });
});

describe("the list", () => {
  it("★ every row of a page carries contactId, from one contacts query (keyset and offset)", async () => {
    H.page = [
      { id: "c1", channel: "WHATSAPP", customerExternalId: "9721", lastMessageAt: new Date(2), messages: [] },
      { id: "c2", channel: "WHATSAPP", customerExternalId: "9999", lastMessageAt: new Date(1), messages: [] },
    ];
    for (const cursor of ["", undefined]) {
      H.contactQueries = 0;
      const r: any = await list("T", { userRole: "ADMIN", userId: "u1", cursor } as any);
      expect(r.data.map((c: any) => c.contactId)).toEqual(["k1", null]);
      expect(H.contactQueries).toBe(1);
    }
  });
});
