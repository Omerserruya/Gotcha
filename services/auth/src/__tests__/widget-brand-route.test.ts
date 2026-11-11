/**
 * POST /api/system/widget-brand-candidates: platform admin only, BAD_URL,
 * SITE_UNREACHABLE / SITE_BLOCKED, and the read writes nothing. Mounted the
 * way index.ts mounts it (on /api/system, beside other routers): a request for
 * another /api/system route passes straight through it.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ page: null as any }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => { req.user = { role: String(req.headers["x-role"] || "ADMIN") }; next(); },
  };
});
vi.mock("../services/site-crawl.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, fetchPageForCrawl: async () => H.page };
});

import widgetBrandRoutes from "../routes/widget-brand";

const app = express();
app.use(express.json());
app.use("/api/system", widgetBrandRoutes);
app.get("/api/system/other", (_req, res) => { res.json({ ok: true }); });

describe("widget brand candidates", () => {
  it("platform admin only; another /api/system route is not guarded by it", async () => {
    expect((await request(app).post("/api/system/widget-brand-candidates").send({ url: "shop.example" })).status).toBe(403);
    expect((await request(app).get("/api/system/other")).body).toEqual({ ok: true });
  });

  it("BAD_URL, SITE_UNREACHABLE, SITE_BLOCKED", async () => {
    const as = (body: any) => request(app).post("/api/system/widget-brand-candidates").set("x-role", "SYSTEM_ADMIN").send(body);
    expect((await as({ url: "nope" })).body.code).toBe("BAD_URL");
    H.page = null;
    expect((await as({ url: "shop.example" })).body.code).toBe("SITE_UNREACHABLE");
    H.page = { blocked: true, reason: "challenge" };
    expect((await as({ url: "shop.example" })).body.code).toBe("SITE_BLOCKED");
  });

  it("returns the origin, the candidates and the page's context", async () => {
    H.page = { html: `<html lang="he"><head><meta name="theme-color" content="#1d4ed8"><meta name="description" content="Scarves"></head></html>`, text: "Hand made", siteName: "Shop" };
    const r = await request(app).post("/api/system/widget-brand-candidates").set("x-role", "SYSTEM_ADMIN").send({ url: "https://shop.example/about" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ url: "https://shop.example", candidates: { colors: [{ hex: "#1d4ed8" }], language: "he" }, context: { businessName: "Shop" } });
  });
});
