/**
 * The emails of a per-merchant Shopify custom app (2026-11-22): who gets which, in which language.
 * The mail itself is a double: dev sends live mail, so no test may reach it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ sent: [] as any[], users: [] as any[], tenant: { name: "Acme", defaultLocale: "he" } as any, admin: null as any }));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig<any>()),
  requireInternalKey: (req: any, res: any, n: any) => (req.headers["x-internal-key"] === "k" ? n() : res.status(401).json({ error: "no" })),
  resolveAppPublicUrl: () => "https://app.gotcha.co.il",
  prisma: {
    tenant: { findUnique: async () => H.tenant },
    user: {
      findFirst: async (a: any) => H.users.find((u) => u.id === a.where.id && u.tenantId === a.where.tenantId && (a.where.isActive === undefined || u.isActive === a.where.isActive)) ?? null,
      findMany: async (a: any) => H.users.filter((u) => u.tenantId === a.where.tenantId && u.role === a.where.role && u.isActive === a.where.isActive),
    },
  },
}));
vi.mock("../services/notification.service", () => ({
  sendPaymentSucceededEmail: vi.fn(),
  sendShopifyCustomAppEmail: vi.fn(async (a: any) => { H.sent.push(a); }),
}));
vi.mock("../services/invitation.service", () => ({ tenantAdminEntry: async () => H.admin }));

import router from "../routes/internal";
const app = () => { const a = express(); a.use(express.json()); a.use("/api", router); return a; };
const send = (body: any) => request(app()).post("/api/internal/auth/shopify-custom-app-email").set("X-Internal-Key", "k").send(body);

beforeEach(() => {
  H.sent = [];
  H.users = [
    { id: "u1", tenantId: "T1", email: "dana@acme.co.il", role: "AGENT", isActive: true },
    { id: "a1", tenantId: "T1", email: "owner@acme.co.il", role: "ADMIN", isActive: true },
    { id: "a2", tenantId: "T1", email: "Dana@acme.co.il", role: "ADMIN", isActive: true },
    { id: "a3", tenantId: "T1", email: "gone@acme.co.il", role: "ADMIN", isActive: false },
    { id: "x1", tenantId: "OTHER", email: "x@other.co", role: "ADMIN", isActive: true },
  ]; H.tenant = { name: "Acme", defaultLocale: "he" }; H.admin = null; delete process.env.SHOPIFY_CUSTOM_APP_NOTIFY_EMAIL; });

describe("the custom-app emails", () => {
  it("★ the install link goes to EVERY active admin and the person who asked, once each, in the workspace's language (Omer)", async () => {
    const r = await send({ kind: "install_link", tenantId: "T1", userId: "u1", shopDomain: "s.myshopify.com", installLink: "https://admin.shopify.com/x", expiresAt: "2026-11-29T20:00:00Z" });
    expect(r.body).toEqual({ ok: true, sent: true, recipients: 2 });
    // Dana is both the requester and an admin (another case of the same address): one email.
    expect(H.sent.map((m) => m.to)).toEqual(["owner@acme.co.il", "Dana@acme.co.il"]);
    expect(H.sent[0]).toMatchObject({ kind: "install_link", locale: "he", tenantName: "Acme", installLink: "https://admin.shopify.com/x" });
  });
  it("never an inactive admin or anyone of another workspace", async () => {
    await send({ kind: "install_link", tenantId: "T1", userId: "x1", shopDomain: "s.myshopify.com", installLink: "https://admin.shopify.com/x" });
    expect(H.sent.map((m) => m.to)).not.toContain("gone@acme.co.il");
    expect(H.sent.map((m) => m.to)).not.toContain("x@other.co");
  });
  it("a workspace with no admin and no requester: nothing sent", async () => {
    H.users = [];
    expect((await send({ kind: "install_link", tenantId: "T1", shopDomain: "s.myshopify.com", installLink: "https://admin.shopify.com/x" })).body).toEqual({ ok: true, sent: false, reason: "no_recipient" });
  });
  it("★ the internal notice goes to SHOPIFY_CUSTOM_APP_NOTIFY_EMAIL in English; unset, nothing is sent", async () => {
    expect((await send({ kind: "request_notice", tenantId: "T1", shopDomain: "s.myshopify.com" })).body).toEqual({ ok: true, sent: false, reason: "no_recipient" });
    process.env.SHOPIFY_CUSTOM_APP_NOTIFY_EMAIL = "ops@gotcha.co.il";
    await send({ kind: "request_notice", tenantId: "T1", shopDomain: "s.myshopify.com", requestedAt: "x" });
    expect(H.sent[0]).toMatchObject({ kind: "request_notice", to: "ops@gotcha.co.il", consoleUrl: "https://app.gotcha.co.il/system/shopify-custom-apps" });
  });
  it("internal only, and validated", async () => {
    expect((await request(app()).post("/api/internal/auth/shopify-custom-app-email").send({})).status).toBe(401);
    expect((await send({ kind: "spam", tenantId: "T1", shopDomain: "s" })).status).toBe(400);
  });
});
