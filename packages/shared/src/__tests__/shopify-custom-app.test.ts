/**
 * Per-merchant Shopify custom apps (2026-11-22): the record, the platform switch, and every signature
 * resolved by shop. Real HMACs; the settings store is a double (never a DATABASE_URL here).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

const H = vi.hoisted(() => ({ rows: [] as any[], settings: new Map<string, string>() }));
vi.mock("../lib/prisma", () => ({
  prisma: {
    tenantSetting: { findMany: async (a: any) => H.rows.filter((r) => r.key === a.where.key) },
    tenant: { findUnique: async () => ({ id: "SYS" }) },
  },
  withCrossTenantAccess: (fn: any) => fn(),
}));
vi.mock("../lib/durable-settings", () => ({
  readDurableSetting: async (t: string, k: string) => H.settings.get(`${t}|${k}`) ?? null,
  writeDurableSetting: async (t: string, k: string, v: string | null) => { if (v === null) H.settings.delete(`${t}|${k}`); else H.settings.set(`${t}|${k}`, v); },
}));
vi.mock("../lib/encryption", () => ({
  encryptCredentials: (o: any) => `enc:${JSON.stringify(o)}`,
  decryptCredentials: (s: string) => JSON.parse(s.slice(4)),
}));

import {
  parsePrivateAppsSettings, readPrivateAppsSettings, writePrivateAppsSettings, customAppForShop, appForClientId,
  signingSecretsForShop, verifyAppEntryForShop, verifyOAuthCallbackForShop, verifyWebhookForShop, validInstallLink,
  sealClientSecret, publicCustomAppRecord, parseCustomAppRecord,
} from "../lib/shopify-custom-app";

const SHOP = "random-randomizer.myshopify.com";
const record = (o: any = {}) => ({ status: "installed", shopDomain: SHOP, requestedAt: "2026-11-22T20:00:00Z", requestedBy: "u1", clientId: "custom_client_1", clientSecretEnc: sealClientSecret("custom-secret"), ...o });
const sign = (params: Record<string, string>, secret: string) => {
  const msg = Object.keys(params).filter((k) => k !== "hmac" && k !== "signature").sort().map((k) => `${k}=${params[k]}`).join("&");
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
};
const query = (shop: string, secret: string) => {
  const q: Record<string, string> = { shop, timestamp: String(Math.floor(Date.now() / 1000)) };
  return { ...q, hmac: sign(q, secret) };
};

beforeEach(() => {
  process.env.SHOPIFY_API_KEY = "official_client";
  process.env.SHOPIFY_API_SECRET = "official-secret";
  H.rows = [{ tenantId: "T1", key: "shopifyCustomApp", value: JSON.stringify(record()) }];
  H.settings.clear();
});

describe("the platform switch", () => {
  it("off by default, 'included' by default; only enabled:true turns it on", async () => {
    expect(await readPrivateAppsSettings()).toEqual({ enabled: false, entitlement: "included" });
    expect(parsePrivateAppsSettings(JSON.stringify({ enabled: "yes", entitlement: "free" }))).toEqual({ enabled: false, entitlement: "included" });
    expect(await writePrivateAppsSettings({ enabled: true, entitlement: "manual" }, "admin")).toBe(true);
    expect(await readPrivateAppsSettings()).toEqual({ enabled: true, entitlement: "manual" });
  });
});

describe("the record", () => {
  it("never shows its secret; a malformed one is no record", () => {
    expect(publicCustomAppRecord(record() as any)).not.toHaveProperty("clientSecretEnc");
    expect(parseCustomAppRecord({ status: "weird", shopDomain: SHOP })).toBeNull();
    expect(parseCustomAppRecord({ status: "requested", shopDomain: "not a shop" })).toBeNull();
  });
});

describe("resolving the app by shop or client id", () => {
  it("★ the shop's custom app when link_sent or installed; never when requested or revoked", async () => {
    expect(await customAppForShop(SHOP)).toMatchObject({ kind: "custom", clientId: "custom_client_1", clientSecret: "custom-secret", tenantId: "T1" });
    for (const status of ["requested", "revoked"]) {
      H.rows = [{ tenantId: "T1", key: "shopifyCustomApp", value: JSON.stringify(record({ status })) }];
      expect(await customAppForShop(SHOP)).toBeNull();
    }
  });
  it("by client id: the official one, a known custom one, and null for an unknown app", async () => {
    expect(await appForClientId(null)).toMatchObject({ kind: "official", clientSecret: "official-secret" });
    expect(await appForClientId("official_client")).toMatchObject({ kind: "official" });
    expect(await appForClientId("custom_client_1")).toMatchObject({ kind: "custom", clientSecret: "custom-secret" });
    expect(await appForClientId("someone_else")).toBeNull();
  });
  it("the signing secrets for a shop: its custom app's and the official app's; another shop gets only the official", async () => {
    expect(await signingSecretsForShop(SHOP)).toEqual(["custom-secret", "official-secret"]);
    expect(await signingSecretsForShop("other.myshopify.com")).toEqual(["official-secret"]);
  });
});

describe("★ signatures, resolved by shop", () => {
  it("the app launch: signed by the shop's custom app, or the official app; another secret never", async () => {
    expect(await verifyAppEntryForShop(query(SHOP, "custom-secret"))).toMatchObject({ ok: true, shop: SHOP, app: { kind: "custom", clientId: "custom_client_1" } });
    expect(await verifyAppEntryForShop(query(SHOP, "official-secret"))).toMatchObject({ ok: true, app: { kind: "official" } });
    expect(await verifyAppEntryForShop(query(SHOP, "forged"))).toMatchObject({ ok: false, reason: "hmac_invalid" });
    // A custom app's secret signs for ITS shop only.
    expect(await verifyAppEntryForShop(query("other.myshopify.com", "custom-secret"))).toMatchObject({ ok: false });
  });
  it("the OAuth callback, the same way", async () => {
    const q = (shop: string, secret: string) => { const p: Record<string, string> = { shop, code: "c", state: "s", timestamp: String(Math.floor(Date.now() / 1000)) }; return { ...p, hmac: sign(p, secret) }; };
    expect(await verifyOAuthCallbackForShop(q(SHOP, "custom-secret"))).toMatchObject({ ok: true, app: { kind: "custom" } });
    expect(await verifyOAuthCallbackForShop(q("other.myshopify.com", "custom-secret"))).toMatchObject({ ok: false });
  });
  it("a webhook: the shop's apps only", async () => {
    const body = Buffer.from(JSON.stringify({ id: 1 }));
    const h = (secret: string) => crypto.createHmac("sha256", secret).update(body).digest("base64");
    expect(await verifyWebhookForShop(body, h("custom-secret"), SHOP)).toBe(true);
    expect(await verifyWebhookForShop(body, h("official-secret"), SHOP)).toBe(true);
    expect(await verifyWebhookForShop(body, h("custom-secret"), "other.myshopify.com")).toBe(false);
    expect(await verifyWebhookForShop(body, h("forged"), SHOP)).toBe(false);
  });
});

describe("the install link", () => {
  it("https on admin.shopify.com only", () => {
    expect(validInstallLink("https://admin.shopify.com/oauth/install_custom_app?client_id=x&signature=y")).toMatch(/^https:\/\/admin\.shopify\.com\//);
    for (const bad of ["http://admin.shopify.com/x", "https://evil.example/oauth", "javascript:alert(1)", "", null]) expect(validInstallLink(bad)).toBeNull();
  });
});
