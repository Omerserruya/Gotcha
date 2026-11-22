/**
 * A per-merchant custom app's token is refreshed with THAT app's credentials (2026-11-22); one we no
 * longer know is refused rather than refreshed with the official secret. Shopify is a fetch double.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ apps: new Map<string, any>(), calls: [] as any[] }));
vi.mock("@chatcenter/shared/src/lib/shopify-custom-app", async (orig) => ({
  ...(await orig<any>()),
  appForClientId: async (id: any) => (!id ? { kind: "official", clientId: "official_client", clientSecret: "official-secret" } : H.apps.get(String(id)) ?? null),
}));
vi.mock("@chatcenter/shared", async (orig) => ({ ...(await orig<any>()), assertPublicUrl: async () => undefined }));

import ShopifyAdapter from "../services/connectors/shopify.adapter";

beforeEach(() => {
  H.apps.clear(); H.calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { H.calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ access_token: "new", refresh_token: "r2", expires_in: 3600, scope: "read_products" }) } as any; }));
});

describe("refreshing a token", () => {
  it("★ a custom app's connection: its own client id and secret, and it keeps saying which app", async () => {
    H.apps.set("custom_client_1", { kind: "custom", clientId: "custom_client_1", clientSecret: "custom-secret" });
    const out: any = await (ShopifyAdapter as any).refreshTokens({ shopDomain: "s.myshopify.com", accessToken: "old", refreshToken: "r1", appClientId: "custom_client_1" });
    expect(H.calls[0].body).toMatchObject({ client_id: "custom_client_1", client_secret: "custom-secret", grant_type: "refresh_token", refresh_token: "r1" });
    expect(out).toMatchObject({ accessToken: "new", refreshToken: "r2", appClientId: "custom_client_1" });
  });
  it("the official app's connection: the official credentials, nothing added", async () => {
    const out: any = await (ShopifyAdapter as any).refreshTokens({ shopDomain: "s.myshopify.com", accessToken: "old", refreshToken: "r1" });
    expect(H.calls[0].body).toMatchObject({ client_id: "official_client", client_secret: "official-secret" });
    expect(out).not.toHaveProperty("appClientId");
  });
  it("★ an app we no longer know: refused, Shopify never asked", async () => {
    await expect((ShopifyAdapter as any).refreshTokens({ shopDomain: "s.myshopify.com", accessToken: "old", refreshToken: "r1", appClientId: "gone" })).rejects.toThrow("shopify_refresh_unknown_app");
    expect(H.calls).toEqual([]);
  });
});
