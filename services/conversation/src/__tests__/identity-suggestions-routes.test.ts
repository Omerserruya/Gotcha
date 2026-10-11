/**
 * The Customers card's suggestions, and undoing an automatic link
 * (2026-10-11). The card showed "No duplicates found" while a PENDING
 * suggestion existed: nothing listed them. Now GET /api/identity/suggestions
 * does - the new link records and the older AI-written rows - minus pairs a
 * person marked "not the same" and pairs that are already one person.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  settings: [] as any[],
  legacy: [] as any[],
  contacts: [] as any[],
  legacyUpdates: [] as any[],
  deleted: [] as any[],
  link: vi.fn(async () => "linked"),
  unlink: vi.fn(async () => "unlinked"),
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      tenantSetting: {
        findMany: vi.fn(async ({ where }: any) => H.settings.filter((s) => s.tenantId === where.tenantId && s.key.startsWith(where.key.startsWith))),
        deleteMany: vi.fn(async (a: any) => { H.deleted.push(a.where); return { count: 0 }; }),
      },
      identityLinkSuggestion: {
        findMany: vi.fn(async ({ where }: any) => H.legacy.filter((s) => s.tenantId === where.tenantId && s.status === where.status)),
        updateMany: vi.fn(async (a: any) => { H.legacyUpdates.push(a); return { count: 1 }; }),
      },
      contact: { findMany: vi.fn(async ({ where }: any) => H.contacts.filter((c) => c.tenantId === where.tenantId && where.id.in.includes(c.id))) },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    linkContacts: H.link,
    unlinkContacts: H.unlink,
  };
});

import router from "../routes/identity";
const app = express();
app.use(express.json());
app.use("/api/identity", router);

const LINK = "identity:link:";
beforeEach(() => {
  vi.clearAllMocks();
  H.legacyUpdates = []; H.deleted = [];
  H.contacts = [
    { id: "ig1", tenantId: "t1", displayName: null, phone: null, email: null, externalId: "1031990639501705", channel: "INSTAGRAM", personId: "p_ig" },
    { id: "wa1", tenantId: "t1", displayName: "Omer Tsruya", phone: "+972541111111", email: null, externalId: "972541111111", channel: "WHATSAPP", personId: "p_wa" },
    { id: "wa2", tenantId: "t1", displayName: "Dana", phone: null, email: "d@x.com", externalId: "972542222222", channel: "WHATSAPP", personId: "p_wa2" },
    { id: "wa3", tenantId: "t1", displayName: "Same Person", phone: null, email: null, externalId: "972543333333", channel: "WHATSAPP", personId: "p_same" },
    { id: "ig3", tenantId: "t1", displayName: "Same Person", phone: null, email: null, externalId: "1", channel: "INSTAGRAM", personId: "p_same" },
    { id: "np", tenantId: "t1", displayName: "No Person", phone: null, email: null, externalId: "972544444444", channel: "WHATSAPP", personId: null },
  ];
  H.settings = [
    { tenantId: "t1", key: `${LINK}ig1:wa1`, value: { status: "PENDING", signal: "same_name", contactIds: ["ig1", "wa1"], at: "2026-10-11T10:00:00Z" } },
    { tenantId: "t1", key: `${LINK}wa1:wa2`, value: { status: "APPLIED", signal: "shopify_customer", contactIds: ["wa1", "wa2"], at: "2026-10-11T10:00:00Z" } },
    { tenantId: "t1", key: `${LINK}ig3:wa3`, value: { status: "PENDING", signal: "same_name", contactIds: ["ig3", "wa3"], at: "2026-10-11T10:00:00Z" } },
    { tenantId: "t2", key: `${LINK}x:y`, value: { status: "PENDING", signal: "same_name", contactIds: ["x", "y"] } },
  ];
  H.legacy = [
    { id: "s1", tenantId: "t1", status: "PENDING", sourceContactId: "wa2", targetContactId: "ig1", identifierType: "EMAIL", identifierValue: "d@x.com", createdAt: new Date("2026-08-02T08:46:53Z") },
    { id: "s2", tenantId: "t1", status: "PENDING", sourceContactId: "wa1", targetContactId: "wa1", identifierType: "PHONE", identifierValue: "+1", createdAt: new Date() },
    // A conflicting value on ONE customer is not a pair of people, even when
    // that customer has no person yet.
    { id: "s3", tenantId: "t1", status: "PENDING", sourceContactId: "np", targetContactId: "np", identifierType: "PHONE", identifierValue: "+2", createdAt: new Date() },
  ];
});

describe("GET /suggestions", () => {
  it("lists new and older pending pairs with labels, never an IGSID, never another tenant's", async () => {
    const res = await request(app).get("/api/identity/suggestions");
    expect(res.status).toBe(200);
    const pairs = res.body.data.map((d: any) => [d.source, d.signal, d.contactIds.join("+")]);
    expect(pairs).toEqual([
      ["link", "same_name", "ig1+wa1"],
      ["legacy", "ai_extracted_identifier", "wa2+ig1"],
    ]);
    expect(res.body.data[0].contacts).toEqual([{ id: "ig1", label: "Instagram customer", channel: "INSTAGRAM" }, { id: "wa1", label: "Omer Tsruya", channel: "WHATSAPP" }]);
    expect(JSON.stringify(res.body)).not.toContain("1031990639501705");
  });

  it("a pair marked not-the-same is not suggested", async () => {
    H.settings.push({ tenantId: "t1", key: "identity:not-same:ig1:wa1", value: {} });
    const res = await request(app).get("/api/identity/suggestions");
    expect(res.body.data.map((d: any) => d.contactIds.join("+"))).toEqual(["wa2+ig1"]);
  });

  it("?status=APPLIED lists the automatic links, so each can be undone", async () => {
    const res = await request(app).get("/api/identity/suggestions?status=APPLIED");
    expect(res.body.data.map((d: any) => [d.signal, d.contactIds.join("+")])).toEqual([["shopify_customer", "wa1+wa2"]]);
  });
});

describe("POST /suggestions/accept and /unlink", () => {
  it("accept links the pair as decided by the person and closes the older row", async () => {
    const res = await request(app).post("/api/identity/suggestions/accept").send({ contactIds: ["wa2", "ig1"] });
    expect(res.status).toBe(200);
    expect(H.link).toHaveBeenCalledWith({ tenantId: "t1", sourceContactId: "wa2", targetContactId: "ig1", signal: "accepted_suggestion", by: "u1" });
    expect(H.legacyUpdates[0].data).toMatchObject({ status: "APPLIED", decidedBy: "u1" });
    expect(H.legacyUpdates[0].where.tenantId).toBe("t1");
  });

  it("accept on a not-same pair: 409, nothing marked applied", async () => {
    H.link.mockResolvedValueOnce("not_same" as any);
    const res = await request(app).post("/api/identity/suggestions/accept").send({ contactIds: ["wa2", "ig1"] });
    expect(res.status).toBe(409);
    expect(H.legacyUpdates).toHaveLength(0);
  });

  it("unlink restores through the shared undo; nothing linked is a 404", async () => {
    const ok = await request(app).post("/api/identity/unlink").send({ contactIds: ["wa1", "wa2"] });
    expect(ok.status).toBe(200);
    expect(H.unlink).toHaveBeenCalledWith({ tenantId: "t1", contactIds: ["wa1", "wa2"], by: "u1" });
    H.unlink.mockResolvedValueOnce("not_linked" as any);
    const none = await request(app).post("/api/identity/unlink").send({ contactIds: ["ig1", "wa2"] });
    expect(none.status).toBe(404);
  });

  it("two different customers are required", async () => {
    expect((await request(app).post("/api/identity/unlink").send({ contactIds: ["wa1", "wa1"] })).status).toBe(400);
    expect((await request(app).post("/api/identity/suggestions/accept").send({})).status).toBe(400);
  });
});
