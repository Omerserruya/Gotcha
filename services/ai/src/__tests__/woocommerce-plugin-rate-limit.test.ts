/**
 * ★ The plugin's public endpoints are bounded (2026-10-09 review: POST
 * /api/woocommerce-plugin/exchange and /signal had no limit at all).
 *   - per IP and per site: a site is the host of its siteUrl (/exchange) or
 *     its plugin token, hashed (/signal)
 *   - over the limit: 429 rate_limited, and the handler never runs
 *   - two sites do not share a bucket; one site's flood does not stop another
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => {
  process.env.WOO_PLUGIN_EXCHANGE_RPM = "3";
  process.env.WOO_PLUGIN_SIGNAL_RPM = "3";
  return { exchanged: 0, signalled: 0 };
});

vi.mock("../services/woocommerce-plugin.service", () => ({
  bindSite: async () => ({}),
  exchangeCode: async () => { H.exchanged++; return { ok: true }; },
  signal: async () => { H.signalled++; },
  removeSite: async () => true,
  PluginError: class extends Error {},
}));

const freshApp = async () => {
  vi.resetModules();
  const router = (await import("../routes/woocommerce-plugin")).default;
  const app = express();
  app.set("trust proxy", true);
  app.use("/api/woocommerce-plugin", router);
  return app;
};

beforeEach(() => { H.exchanged = 0; H.signalled = 0; });

describe("★ /exchange", () => {
  it("per site: the fourth call for one site is 429 and never reaches the handler; another site still passes", async () => {
    const app = await freshApp();
    const call = (site: string, ip: string) => request(app).post("/api/woocommerce-plugin/exchange").set("X-Forwarded-For", ip).send({ code: "c", siteUrl: `https://${site}/` });
    for (let i = 0; i < 3; i++) expect((await call("shop-a.example", `10.0.0.${i + 1}`)).status).toBe(200);
    const over = await call("shop-a.example", "10.0.0.9");
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ error: "rate_limited" });
    expect(H.exchanged).toBe(3);
    expect((await call("shop-b.example", "10.0.0.10")).status).toBe(200);
  });

  it("per IP: one address cycling sites is stopped too", async () => {
    const app = await freshApp();
    const call = (site: string) => request(app).post("/api/woocommerce-plugin/exchange").set("X-Forwarded-For", "10.9.9.9").send({ code: "c", siteUrl: `https://${site}/` });
    for (let i = 0; i < 3; i++) expect((await call(`s${i}.example`)).status).toBe(200);
    expect((await call("s9.example")).status).toBe(429);
  });
});

describe("★ /signal", () => {
  it("per site token: one plugin's flood is stopped, another plugin is not", async () => {
    const app = await freshApp();
    const call = (token: string, ip: string) => request(app).post("/api/woocommerce-plugin/signal").set("Authorization", `Bearer ${token}`).set("X-Forwarded-For", ip).send({ event: "cart" });
    for (let i = 0; i < 3; i++) expect((await call("tok-a", `10.1.0.${i + 1}`)).status).toBe(204);
    expect((await call("tok-a", "10.1.0.9")).status).toBe(429);
    expect(H.signalled).toBe(3);
    expect((await call("tok-b", "10.1.0.10")).status).toBe(204);
  });

  it("per IP across tokens", async () => {
    const app = await freshApp();
    const call = (token: string) => request(app).post("/api/woocommerce-plugin/signal").set("Authorization", `Bearer ${token}`).set("X-Forwarded-For", "10.8.8.8").send({ event: "cart" });
    for (let i = 0; i < 3; i++) expect((await call(`t${i}`)).status).toBe(204);
    expect((await call("t9")).status).toBe(429);
  });
});
