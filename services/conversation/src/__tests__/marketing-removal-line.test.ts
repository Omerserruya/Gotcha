/**
 * ★ Every marketing message carries the removal line ("להסרה השיבו הסר" /
 * "Reply STOP to unsubscribe"; opt-out model, Omer 2026-10-08, docs/product/
 * ai-studio-skills-automations.md §6). On WhatsApp it is part of the
 * template's text (an approved text cannot change at send time):
 *   - a MARKETING template gets the line on create, update and duplicate, in
 *     its own language; an older one without it is not submitted to Meta
 *   - a campaign with a template that lacks it is refused before anything is
 *     queued; a text campaign gets it appended to every message
 * Through the real routes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ templates: [] as any[], broadcasts: [] as any[], recipients: [] as any[], queued: [] as any[], seq: 0 }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => pass,
    requireRole: () => pass,
    requireEntitlement: () => pass,
    publishEvent: async () => undefined,
    broadcastQueue: { add: async (_n: string, d: any) => { H.queued.push(d); } },
    prisma: {
      messageTemplate: {
        create: async (a: any) => { const t = { id: `t${++H.seq}`, ...a.data }; H.templates.push(t); return t; },
        update: async (a: any) => { const t = H.templates.find((x) => x.id === a.where.id); Object.assign(t, a.data); return t; },
        findFirst: async (a: any) => H.templates.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId) ?? null,
      },
      channelAccount: { findFirst: async () => null },
      broadcast: {
        findFirst: async (a: any) => H.broadcasts.find((b) => b.id === a.where.id) ?? null,
        findUnique: async (a: any) => H.broadcasts.find((b) => b.id === a.where.id) ?? null,
        update: async (a: any) => { const b = H.broadcasts.find((x) => x.id === a.where.id); Object.assign(b, a.data); return b; },
      },
      broadcastRecipient: {
        count: async (a: any) => H.recipients.filter((r) => r.broadcastId === a.where.broadcastId).length,
        findMany: async (a: any) => H.recipients.filter((r) => r.broadcastId === a.where.broadcastId),
      },
    },
  };
});

import templatesRouter from "../routes/templates";
import broadcastsRouter from "../routes/broadcasts";

const app = express();
app.use(express.json());
app.use("/api/templates", templatesRouter);
app.use("/api/broadcasts", broadcastsRouter);

beforeEach(() => { H.templates = []; H.broadcasts = []; H.recipients = []; H.queued = []; H.seq = 0; });

describe("★ a marketing template carries the removal line", () => {
  it("added on create, in the template's language; other categories untouched", async () => {
    const he = await request(app).post("/api/templates").send({ name: "promo", body: "מבצע סוף עונה", category: "MARKETING", language: "he", channel: "WHATSAPP" });
    expect(he.body.data.body).toBe("מבצע סוף עונה\n\nלהסרה השיבו הסר");
    const en = await request(app).post("/api/templates").send({ name: "promo_en", body: "Season sale", category: "marketing", language: "en_US" });
    expect(en.body.data.body).toBe("Season sale\n\nReply STOP to unsubscribe");
    const util = await request(app).post("/api/templates").send({ name: "shipped", body: "ההזמנה נשלחה", category: "UTILITY", language: "he" });
    expect(util.body.data.body).toBe("ההזמנה נשלחה");
  });

  it("not added twice", async () => {
    const r = await request(app).post("/api/templates").send({ name: "p", body: "מבצע\n\nלהסרה השיבו הסר", category: "MARKETING", language: "he" });
    expect(r.body.data.body).toBe("מבצע\n\nלהסרה השיבו הסר");
  });

  it("on update: a body edit, or a template turned marketing, gets it", async () => {
    const t = (await request(app).post("/api/templates").send({ name: "x", body: "שלום", category: "UTILITY", language: "he" })).body.data;
    const r = await request(app).patch(`/api/templates/${t.id}`).send({ category: "MARKETING" });
    expect(r.body.data.body).toBe("שלום\n\nלהסרה השיבו הסר");
    const r2 = await request(app).patch(`/api/templates/${t.id}`).send({ body: "מבצע חדש" });
    expect(r2.body.data.body).toBe("מבצע חדש\n\nלהסרה השיבו הסר");
  });

  // 2026-10-09: the line is for MARKETING only; UTILITY and AUTHENTICATION
  // texts are transactional and never gain it, on any path.
  it("UTILITY and AUTHENTICATION never get it: create, update, duplicate", async () => {
    for (const category of ["UTILITY", "utility", "AUTHENTICATION", "authentication"]) {
      const c = (await request(app).post("/api/templates").send({ name: `t_${category}`, body: "הקוד שלך 1234", category, language: "he" })).body.data;
      expect(c.body).toBe("הקוד שלך 1234");
      const u = await request(app).patch(`/api/templates/${c.id}`).send({ body: "ההזמנה נשלחה" });
      expect(u.body.data.body).toBe("ההזמנה נשלחה");
      const d = await request(app).post(`/api/templates/${c.id}/duplicate`).send({});
      expect(d.body.data.body).toBe("ההזמנה נשלחה");
    }
    // MARKETING on the same three paths still gets it.
    const m = (await request(app).post("/api/templates").send({ name: "m", body: "מבצע", category: "MARKETING", language: "he" })).body.data;
    expect(m.body).toBe("מבצע\n\nלהסרה השיבו הסר");
    expect((await request(app).post(`/api/templates/${m.id}/duplicate`).send({})).body.data.body).toBe("מבצע\n\nלהסרה השיבו הסר");
  });

  it("a UTILITY or AUTHENTICATION template without it is not refused at submit", async () => {
    for (const category of ["UTILITY", "AUTHENTICATION"]) {
      H.templates.push({ id: category, tenantId: "T", name: category, body: "ההזמנה נשלחה", category, language: "he", channel: "WHATSAPP", status: "DRAFT", channelAccountId: null });
      const r = await request(app).post(`/api/templates/${category}/submit-to-meta`).send({});
      expect(r.body.code).not.toBe("MISSING_REMOVAL_LINE");
      expect(r.status).not.toBe(422);
    }
  });

  it("an older marketing template without it is not submitted to Meta", async () => {
    H.templates.push({ id: "old", tenantId: "T", name: "old", body: "מבצע", category: "MARKETING", language: "he", channel: "WHATSAPP", status: "DRAFT" });
    const r = await request(app).post("/api/templates/old/submit-to-meta").send({});
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("MISSING_REMOVAL_LINE");
  });
});

describe("★ a campaign carries the removal line", () => {
  const bc = (o: any = {}) => ({ id: "b1", tenantId: "T", status: "DRAFT", channel: "WHATSAPP", channelAccountId: "acct", templateId: null, body: "מבצע סוף עונה", variables: {}, scheduledAt: null, audience: null, ...o });

  it("a template without it: refused, nothing queued, the campaign untouched", async () => {
    H.templates.push({ id: "tp", tenantId: "T", body: "מבצע", category: "MARKETING" });
    H.broadcasts.push(bc({ templateId: "tp" }));
    H.recipients.push({ id: "r1", broadcastId: "b1", externalId: "9725" });
    const r = await request(app).post("/api/broadcasts/b1/send").send({});
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("MISSING_REMOVAL_LINE");
    expect(H.queued).toEqual([]);
    expect(H.broadcasts[0].status).toBe("DRAFT");
  });

  it("a template with it is sent", async () => {
    H.templates.push({ id: "tp", tenantId: "T", body: "מבצע\n\nלהסרה השיבו הסר", category: "MARKETING" });
    H.broadcasts.push(bc({ templateId: "tp" }));
    H.recipients.push({ id: "r1", broadcastId: "b1", externalId: "9725" });
    expect((await request(app).post("/api/broadcasts/b1/send").send({})).status).toBe(200);
    expect(H.queued).toHaveLength(1);
  });

  // 2026-10-09: a UTILITY or AUTHENTICATION template is not marketing, so a
  // campaign with one is sent as approved, with no removal line required.
  it("a UTILITY or AUTHENTICATION template without it is sent, unchanged", async () => {
    for (const category of ["UTILITY", "AUTHENTICATION", "utility"]) {
      H.templates = []; H.broadcasts = []; H.recipients = []; H.queued = [];
      H.templates.push({ id: "tp", tenantId: "T", body: "ההזמנה שלך נשלחה", category });
      H.broadcasts.push(bc({ templateId: "tp", body: "ההזמנה שלך נשלחה" }));
      H.recipients.push({ id: "r1", broadcastId: "b1", externalId: "9725" });
      const r = await request(app).post("/api/broadcasts/b1/send").send({});
      expect(r.status).toBe(200);
      expect(H.queued).toHaveLength(1);
      expect(H.queued[0].body).toBe("ההזמנה שלך נשלחה");
    }
  });

  it("a text campaign: every message gets the line", async () => {
    H.broadcasts.push(bc({ channel: "EMAIL", body: "Season sale this week" }));
    H.recipients.push({ id: "r1", broadcastId: "b1", externalId: "a@b.test" }, { id: "r2", broadcastId: "b1", externalId: "c@d.test" });
    await request(app).post("/api/broadcasts/b1/send").send({});
    expect(H.queued.map((q) => q.body)).toEqual(Array(2).fill("Season sale this week\n\nReply STOP to unsubscribe"));
  });

  it("a text that already carries it is not given a second one", async () => {
    H.broadcasts.push(bc({ body: "מבצע\n\nלהסרה השיבו הסר" }));
    H.recipients.push({ id: "r1", broadcastId: "b1", externalId: "9725" });
    await request(app).post("/api/broadcasts/b1/send").send({});
    expect(H.queued[0].body).toBe("מבצע\n\nלהסרה השיבו הסר");
  });
});
