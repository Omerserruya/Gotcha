/**
 * ★ /api/contacts/unsubscribe/:token (List-Unsubscribe, RFC 8058), through
 * the real route:
 *   - POST (one-click) opts the contact out on that channel, with a consent
 *     withdrawal and an audit entry; again is not an error and adds nothing
 *   - GET only shows the confirm page: a link scanner never unsubscribes
 *   - a bad token, or a token whose contact is not that tenant's: 404, nothing written
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ contacts: [] as any[], updates: [] as any[], consents: [] as any[], audits: [] as any[] }));

vi.mock("@chatcenter/shared", () => ({
  AuditAction: { CONSENT_WITHDRAWN: "CONSENT_WITHDRAWN" },
  auditSystem: async (...a: any[]) => { H.audits.push(a); },
  prisma: {
    contact: {
      findFirst: async (a: any) => H.contacts.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId) ?? null,
      update: async (a: any) => { H.updates.push(a); const c = H.contacts.find((x) => x.id === a.where.id); Object.assign(c, a.data); return c; },
    },
    consentRecord: { create: async (a: any) => { H.consents.push(a.data); return a.data; } },
  },
}));

import router from "../routes/unsubscribe";
import { signUnsubscribeToken } from "@chatcenter/shared/src/lib/list-unsubscribe";

const app = () => { const a = express(); a.use("/api/contacts", router); return a; };
let token: string;

beforeEach(() => {
  process.env.CHANNEL_ENCRYPTION_KEY = "k".repeat(64);
  H.contacts = [{ id: "c1", tenantId: "T", optOutChannels: ["WHATSAPP"] }];
  H.updates = []; H.consents = []; H.audits = [];
  token = signUnsubscribeToken({ tenantId: "T", contactId: "c1", channel: "GMAIL" })!;
});

describe("★ one-click", () => {
  it("POST List-Unsubscribe=One-Click: opted out on that channel, consent + audit", async () => {
    const r = await request(app()).post(`/api/contacts/unsubscribe/${token}`).type("form").send("List-Unsubscribe=One-Click");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(H.contacts[0].optOutChannels).toEqual(["WHATSAPP", "GMAIL"]);
    expect(H.contacts[0].optedOutAt).toBeInstanceOf(Date);
    expect(H.consents).toEqual([expect.objectContaining({ tenantId: "T", subjectId: "c1", purpose: "marketing_gmail", granted: false, source: "list_unsubscribe" })]);
    expect(H.audits[0]).toEqual(["T", "CONSENT_WITHDRAWN", { type: "contact", id: "c1" }, expect.objectContaining({ source: "list_unsubscribe", channel: "GMAIL", alreadyOptedOut: false })]);
  });

  it("again: 200, nothing changed on the contact", async () => {
    await request(app()).post(`/api/contacts/unsubscribe/${token}`).type("form").send("List-Unsubscribe=One-Click");
    H.updates = [];
    const r = await request(app()).post(`/api/contacts/unsubscribe/${token}`).type("form").send("List-Unsubscribe=One-Click");
    expect(r.status).toBe(200);
    expect(H.updates).toEqual([]);
  });
});

describe("★ GET never unsubscribes", () => {
  it("the confirm page, posting to the same link; the contact untouched", async () => {
    const r = await request(app()).get(`/api/contacts/unsubscribe/${token}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`action="/api/contacts/unsubscribe/${encodeURIComponent(token)}"`);
    expect(r.text).toContain('method="post"');
    expect(r.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(H.updates).toEqual([]);
    expect(H.consents).toEqual([]);
  });
});

describe("★ refused", () => {
  it("a bad token, or another tenant's contact: 404, nothing written", async () => {
    expect((await request(app()).get("/api/contacts/unsubscribe/junk")).status).toBe(404);
    expect((await request(app()).post("/api/contacts/unsubscribe/junk")).status).toBe(404);
    const foreign = signUnsubscribeToken({ tenantId: "OTHER", contactId: "c1", channel: "GMAIL" })!;
    expect((await request(app()).post(`/api/contacts/unsubscribe/${foreign}`)).status).toBe(404);
    expect(H.updates).toEqual([]);
    expect(H.consents).toEqual([]);
  });
});
