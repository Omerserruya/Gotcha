/**
 * Ready-made funnels for a hire (2026-10-13): listed in the reader's language,
 * created server-side with labels in the workspace's language, inactive unless
 * asked, and the same template twice returns the one already made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ rows: [] as any[], locale: "he" as "he" | "en", workspace: "he", invalidated: 0 }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => pass,
    requireRole: () => pass,
    prisma: {
      tenant: { findUnique: async () => ({ defaultLocale: H.workspace }) },
      tenantFunnel: {
        findFirst: async (a: any) => H.rows.find((r) => r.tenantId === a.where.tenantId && (a.where.funnelId === undefined || r.funnelId === a.where.funnelId) && (a.where.departmentId === undefined || r.departmentId === a.where.departmentId) && (a.where.id === undefined || r.id === a.where.id)) ?? null,
        create: async (a: any) => { const row = { id: `f${H.rows.length + 1}`, ...a.data }; H.rows.push(row); return row; },
      },
    },
  };
});
vi.mock("../services/funnel-config.repo", () => ({ invalidateFunnelCache: () => { H.invalidated++; } }));
vi.mock("../lib/reader-locale", () => ({ readerLocale: async () => H.locale }));

import router from "../routes/funnel-admin";
import { SAAS_DEFAULT_FUNNEL } from "../services/funnel-config.service";
const app = express();
app.use(express.json());
app.use("/api", router);

beforeEach(() => { H.rows = []; H.locale = "he"; H.workspace = "he"; H.invalidated = 0; });

describe("GET /api/funnels/templates", () => {
  it("★ each template with its name and stage labels in the reader's language", async () => {
    const he = (await request(app).get("/api/funnels/templates")).body.data;
    expect(he.map((t: any) => t.id)).toEqual(["saas-default", "service-default"]);
    expect(he[0].stages.map((s: any) => s.id)).toEqual(SAAS_DEFAULT_FUNNEL.stages.map((s) => s.id));
    expect(he[0].stages[0].label).toBe("\u05dc\u05d9\u05d3 \u05d7\u05d3\u05e9");
    H.locale = "en";
    const en = (await request(app).get("/api/funnels/templates")).body.data;
    expect(en[0]).toMatchObject({ name: "Software and digital products" });
    expect(en[0].stages[0].label).toBe("New Lead");
  });

  it("every stage of every template has a Hebrew label", async () => {
    for (const t of (await request(app).get("/api/funnels/templates")).body.data) {
      for (const s of t.stages) expect(s.label, `${t.id}:${s.id}`).toMatch(/[\u0590-\u05ff]/);
    }
  });
});

describe("POST /api/funnels {template}", () => {
  it("★ creates it server-side: the canonical stages and rules, labels in the WORKSPACE's language, inactive", async () => {
    H.locale = "en"; H.workspace = "he";
    const r = await request(app).post("/api/funnels").send({ template: "saas-default" });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    const row = H.rows[0];
    expect(row).toMatchObject({ tenantId: "T", funnelId: "saas-default", departmentId: null, isActive: false });
    expect(row.stages.map((s: any) => [s.id, s.baseStage])).toEqual(SAAS_DEFAULT_FUNNEL.stages.map((s) => [s.id, s.baseStage]));
    expect(row.stages[1].entry).toEqual(SAAS_DEFAULT_FUNNEL.stages[1].entry);
    expect(row.stages[0].label).toBe("\u05dc\u05d9\u05d3 \u05d7\u05d3\u05e9");
    expect(row.transitions).toEqual(SAAS_DEFAULT_FUNNEL.transitions);
    expect(H.invalidated).toBe(1);
  });

  it("★ the same template again returns the one already made", async () => {
    await request(app).post("/api/funnels").send({ template: "service-default" });
    const r = await request(app).post("/api/funnels").send({ template: "service-default" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: false, data: { id: "f1" } });
    expect(H.rows).toHaveLength(1);
  });

  it("isActive:true is honoured when asked", async () => {
    await request(app).post("/api/funnels").send({ template: "saas-default", isActive: true });
    expect(H.rows[0].isActive).toBe(true);
  });

  it("an unknown template: 400 with the known ones, nothing created", async () => {
    const r = await request(app).post("/api/funnels").send({ template: "nope" });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "UNKNOWN_TEMPLATE", templates: ["saas-default", "service-default"] });
    expect(H.rows).toHaveLength(0);
  });

  it("without a template the hand-made path is unchanged: stages required", async () => {
    expect((await request(app).post("/api/funnels").send({ funnelId: "x" })).status).toBe(400);
  });
});
