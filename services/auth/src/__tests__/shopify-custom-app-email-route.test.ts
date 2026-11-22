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
    user: { findFirst: async (a: any) => H.users.find((u) => u.id === a.where.id && u.tenantId === a.where.tenantId) ?? null },
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

beforeEach(() => { H.sent = []; H.users = [{ id: "u1", tenantId: "T1", email: "dana@acme.co.il" }]; H.tenant = { name: "Acme", defaultLocale: "he" }; H.admin = null; delete process.env.SHOPIFY_CUSTOM_APP_NOTIFY_EMAIL; });

describe("the custom-app emails", () => {
  it("★ the install link goes to the admin who asked, in the workspace's language", async () => {
    const r = await send({ kind: "install_link", tenantId: "T1", userId: "u1", shopDomain: "s.myshopify.com", installLink: "https://admin.shopify.com/x", expiresAt: "2026-11-29T20:00:00Z" });
    expect(r.body).toEqual({ ok: true, sent: true });
    expect(H.sent[0]).toMatchObject({ kind: "install_link", to: "dana@acme.co.il", locale: "he", tenantName: "Acme", installLink: "https://admin.shopify.com/x" });
  });
  it("a user of another workspace is never the recipient: the workspace's admin instead", async () => {
    H.users = [{ id: "u1", tenantId: "OTHER", email: "x@y.z" }];
    H.admin = { user: { email: "admin@acme.co.il" } };
    await send({ kind: "install_link", tenantId: "T1", userId: "u1", shopDomain: "s.myshopify.com", installLink: "https://admin.shopify.com/x" });
    expect(H.sent[0].to).toBe("admin@acme.co.il");
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
