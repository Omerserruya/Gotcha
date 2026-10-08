/**
 * ★ A person changing a contact's opt-out (POST /api/contacts/:id/opt-out)
 * leaves the same record as a customer's "הסר" / "START" reply: a consent
 * ledger row and an audit entry with who did it. The channel is stored
 * uppercase and removed without case (a reply writes "WHATSAPP"). Through the
 * real route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ contacts: [] as any[], consent: [] as any[], audits: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => pass,
    requireRole: () => pass,
    requirePermissionOrRole: () => pass,
    auditUser: async (...a: any[]) => { H.audits.push(a); },
    prisma: {
      contact: {
        findFirst: async (a: any) => H.contacts.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId) ?? null,
        update: async (a: any) => { const c = H.contacts.find((x) => x.id === a.where.id); Object.assign(c, a.data); return c; },
      },
      consentRecord: { create: async (a: any) => { H.consent.push(a.data); return a.data; } },
    },
  };
});

import router from "../routes/contacts";
const app = express();
app.use(express.json());
app.use("/api/contacts", router);

beforeEach(() => {
  H.contacts = [{ id: "k1", tenantId: "T", optOutChannels: [], optedOutAt: null }];
  H.consent = []; H.audits = [];
});

describe("★ the admin opt-out route records like the reply does", () => {
  it("opting out: uppercase channel, a withdrawal in the ledger, an audit entry naming the person", async () => {
    const r = await request(app).post("/api/contacts/k1/opt-out").send({ channel: "whatsapp", optOut: true });
    expect(r.status).toBe(200);
    expect(H.contacts[0].optOutChannels).toEqual(["WHATSAPP"]);
    expect(H.consent).toEqual([expect.objectContaining({ subjectId: "k1", purpose: "marketing_whatsapp", granted: false, source: "admin" })]);
    expect(H.audits).toEqual([["T", "u1", "gdpr.consent_withdrawn", { type: "contact", id: "k1" }, expect.objectContaining({ source: "admin", channel: "WHATSAPP" })]]);
  });

  it("opting back in: removed without case, a grant in the ledger, an audit entry", async () => {
    H.contacts[0].optOutChannels = ["whatsapp", "EMAIL"];
    await request(app).post("/api/contacts/k1/opt-out").send({ channel: "WHATSAPP", optOut: false });
    expect(H.contacts[0].optOutChannels).toEqual(["EMAIL"]);
    expect(H.consent[0]).toMatchObject({ granted: true, source: "admin" });
    expect(H.audits[0]![2]).toBe("gdpr.consent_granted");
  });

  it("no channel: refused, nothing written", async () => {
    const r = await request(app).post("/api/contacts/k1/opt-out").send({ optOut: true });
    expect(r.status).toBe(400);
    expect([H.consent.length, H.audits.length]).toEqual([0, 0]);
  });
});
