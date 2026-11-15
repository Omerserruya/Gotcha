/**
 * Omer 2026-11-15: a store behind Cloudflare's challenge is told to let OUR
 * address through, the primary rule ("IP Source Address equals <ip>", Skip),
 * with the /wp-json/wc/ path rule as the alternative. The address is config
 * (PUBLIC_EGRESS_IP, PUBLIC_EGRESS_IP_STABLE), never code: prod leaves from
 * 51.17.184.220 today and will move to a static address. It rides on every
 * store_firewall_challenge answer as egress { ips, stable } (null when unset).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({ redis: new Map<string, string>() }));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig() as any),
  assertPublicUrl: async () => undefined,
  getRedis: () => ({ get: async (k: string) => H.redis.get(k) ?? null, set: async (k: string, v: string) => { H.redis.set(k, v); return "OK"; } }),
  resolveAppPublicUrl: () => "https://app.test",
}));

import { egressConfig, firewallFixMessage } from "../lib/egress";
import Woo from "../services/connectors/woocommerce.adapter";
import { probeStore } from "../services/woo-store-probe.service";
import { wooReturnUrl } from "../routes/woocommerce-oauth";

const CHALLENGE = { ok: false, status: 403, headers: { get: (n: string) => (n === "cf-mitigated" ? "challenge" : null) }, text: async () => "<title>Just a moment...</title>" };
const saved = { ip: process.env.PUBLIC_EGRESS_IP, stable: process.env.PUBLIC_EGRESS_IP_STABLE };
beforeEach(() => { H.redis = new Map(); delete process.env.PUBLIC_EGRESS_IP; delete process.env.PUBLIC_EGRESS_IP_STABLE; });
afterEach(() => { process.env.PUBLIC_EGRESS_IP = saved.ip ?? ""; process.env.PUBLIC_EGRESS_IP_STABLE = saved.stable ?? ""; vi.unstubAllGlobals(); });

describe("the egress config", () => {
  it("one address, several, IPv6; invalid entries dropped; unset is null", () => {
    expect(egressConfig({ PUBLIC_EGRESS_IP: "51.17.184.220" } as any)).toEqual({ ips: ["51.17.184.220"], stable: false });
    expect(egressConfig({ PUBLIC_EGRESS_IP: " 51.17.184.220, 2001:db8::1 ,nonsense,51.17.184.220", PUBLIC_EGRESS_IP_STABLE: "true" } as any)).toEqual({ ips: ["51.17.184.220", "2001:db8::1"], stable: true });
    expect(egressConfig({} as any)).toBeNull();
    expect(egressConfig({ PUBLIC_EGRESS_IP: "localhost, example.com" } as any)).toBeNull();
  });
  it("the IP rule first, the path rule as the alternative; no address, the path rule alone", () => {
    const m = firewallFixMessage({ ips: ["51.17.184.220"], stable: false });
    expect(m.indexOf("IP Source Address equals 51.17.184.220")).toBeGreaterThan(0);
    expect(m.indexOf("IP Source Address")).toBeLessThan(m.indexOf("URI Path starts with /wp-json/wc/"));
    expect(m).toContain("may still change");
    expect(firewallFixMessage({ ips: ["51.17.184.220"], stable: true })).not.toContain("may still change");
    expect(firewallFixMessage({ ips: ["1.2.3.4", "2001:db8::1"], stable: true })).toContain("IP Source Address is in {1.2.3.4 2001:db8::1}");
    const none = firewallFixMessage(null);
    expect(none).not.toMatch(/IP Source Address/);
    expect(none).toContain("URI Path starts with /wp-json/wc/");
  });
});

describe("every store_firewall_challenge answer carries it", () => {
  it("pasted keys: the verdict's egress and message, and the 422 sends egress", async () => {
    process.env.PUBLIC_EGRESS_IP = "51.17.184.220";
    vi.stubGlobal("fetch", vi.fn(async () => CHALLENGE));
    const v: any = await (Woo as any).validate({ ctx: {}, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: "https://chanivainberger.co.il" } });
    expect(v).toMatchObject({ ok: false, code: "store_firewall_challenge", egress: { ips: ["51.17.184.220"], stable: false } });
    expect(v.error).toContain("IP Source Address equals 51.17.184.220");
    const route = readFileSync(join(__dirname, "../routes/integrations.ts"), "utf8");
    expect(route).toContain('...((verdict as any).code === "store_firewall_challenge" ? { egress: (verdict as any).egress ?? null } : {}),');
  });
  it("the wc-auth return: egress and egressStable, only for this error, every flow; nothing when unset", () => {
    process.env.PUBLIC_EGRESS_IP = "51.17.184.220";
    for (const flow of ["wp_plugin", "redesign_studio", "onboarding_systems", undefined]) {
      const u = new URL(wooReturnUrl(flow as any, { error: "store_firewall_challenge" }));
      expect(u.searchParams.get("error")).toBe("store_firewall_challenge");
      expect(u.searchParams.get("egress")).toBe("51.17.184.220");
      expect(u.searchParams.get("egressStable")).toBe("0");
    }
    expect(new URL(wooReturnUrl("wp_plugin", { error: "validation_failed" })).searchParams.get("egress")).toBeNull();
    delete process.env.PUBLIC_EGRESS_IP;
    expect(new URL(wooReturnUrl("wp_plugin", { error: "store_firewall_challenge" })).searchParams.get("egress")).toBeNull();
  });
  it("the probe: egress on a blocked answer, read now, so a config change shows within the cache minute", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => CHALLENGE));
    process.env.PUBLIC_EGRESS_IP = "51.17.184.220";
    expect((await probeStore("https://shop.example.com")).egress).toEqual({ ips: ["51.17.184.220"], stable: false });
    process.env.PUBLIC_EGRESS_IP = "3.3.3.3"; process.env.PUBLIC_EGRESS_IP_STABLE = "true";
    expect((await probeStore("https://shop.example.com")).egress).toEqual({ ips: ["3.3.3.3"], stable: true });
    delete process.env.PUBLIC_EGRESS_IP;
    expect((await probeStore("https://shop.example.com")).egress).toBeNull();
  });
  it("compose passes both values to ai, empty and false by default", () => {
    const compose = readFileSync(join(__dirname, "../../../../docker-compose.yml"), "utf8");
    expect(compose).toContain("PUBLIC_EGRESS_IP: ${PUBLIC_EGRESS_IP:-}");
    expect(compose).toContain("PUBLIC_EGRESS_IP_STABLE: ${PUBLIC_EGRESS_IP_STABLE:-false}");
  });
});
