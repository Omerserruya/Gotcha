/**
 * Prod 2026-11-11 alphamom.co.il and 2026-11-15 chanivainberger.co.il: the Woo
 * connect failed "key validation failed: http_403". From prod's IP both stores
 * answer /wp-json/wc/v3/system_status with Cloudflare's bot challenge (403,
 * cf-mitigated: challenge, "Just a moment...", challenge-platform), whatever the
 * keys. The keys were never checked, so the merchant must be told to allow us,
 * not to make new keys: reason "store_firewall_challenge".
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@chatcenter/shared", async (orig) => ({ ...(await orig() as any), assertPublicUrl: async () => undefined }));

import Woo, { validateWooKeys, isFirewallChallenge, STORE_FIREWALL_CHALLENGE } from "../services/connectors/woocommerce.adapter";

// What prod received (headers and the markers of the body), 2026-11-15.
const CHALLENGE_BODY = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script></body></html>";
const respond = (status: number, body: string, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  json: async () => JSON.parse(body),
  text: async () => body,
});
const fetchOf = (...answers: any[]) => {
  const calls: string[] = [];
  const f = vi.fn(async (url: string) => { calls.push(url); return answers[Math.min(calls.length - 1, answers.length - 1)]; });
  return { f: f as any, calls };
};

describe("a firewall answered, not the store", () => {
  it("prod's challenge (403, cf-mitigated: challenge): store_firewall_challenge, and the orders path is not tried", async () => {
    const { f, calls } = fetchOf(respond(403, CHALLENGE_BODY, { "cf-mitigated": "challenge", server: "cloudflare" }));
    expect(await validateWooKeys("https://chanivainberger.co.il", "ck", "cs", f)).toEqual({ ok: false, reason: STORE_FIREWALL_CHALLENGE });
    expect(calls).toEqual(["https://chanivainberger.co.il/wp-json/wc/v3/system_status"]);
  });

  it("the challenge page without the header, a 503 challenge, and Cloudflare's block page", () => {
    const h = { get: () => null };
    expect(isFirewallChallenge(403, h, CHALLENGE_BODY)).toBe(true);
    expect(isFirewallChallenge(503, h, "<script>window._cf_chl_opt={}</script>")).toBe(true);
    expect(isFirewallChallenge(403, h, "<title>Attention Required! | Cloudflare</title>")).toBe(true);
    // Cloudflare's header alone is enough (a challenge with a page we do not recognise).
    expect(isFirewallChallenge(403, { get: (n: string) => (n === "cf-mitigated" ? "challenge" : null) }, "")).toBe(true);
  });

  it("WooCommerce's own refusal is not a firewall: wrong keys stay http_401 / http_403", async () => {
    const woo403 = JSON.stringify({ code: "woocommerce_rest_cannot_view", message: "Sorry, you cannot list resources.", data: { status: 403 } });
    expect(await validateWooKeys("https://s.example.com", "ck", "cs", fetchOf(respond(403, woo403)).f)).toEqual({ ok: false, reason: "http_403" });
    expect(await validateWooKeys("https://s.example.com", "ck", "cs", fetchOf(respond(401, "{\"code\":\"woocommerce_rest_authentication_error\"}")).f)).toEqual({ ok: false, reason: "http_401" });
    // A server's plain "403 Forbidden" page is a refusal, not a challenge we can explain.
    expect(await validateWooKeys("https://s.example.com", "ck", "cs", fetchOf(respond(403, "<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center><hr><center>nginx</center></body></html>")).f)).toEqual({ ok: false, reason: "http_403" });
    expect(isFirewallChallenge(200, { get: () => "challenge" }, CHALLENGE_BODY)).toBe(false);
    expect(isFirewallChallenge(404, { get: () => null }, CHALLENGE_BODY)).toBe(false);
  });

  it("keys that work still pass", async () => {
    expect(await validateWooKeys("https://s.example.com", "ck", "cs", fetchOf(respond(200, "{\"environment\":{}}")).f)).toEqual({ ok: true });
  });
});

describe("the merchant is told what to do", () => {
  it("pasted keys: a 422 code store_firewall_challenge, and the exact Cloudflare rule in the message", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => respond(403, CHALLENGE_BODY, { "cf-mitigated": "challenge" })) as any;
    try {
      const v: any = await (Woo as any).validate({ ctx: {}, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: "https://chanivainberger.co.il" } });
      expect(v).toMatchObject({ ok: false, code: STORE_FIREWALL_CHALLENGE });
      expect(v.error).toMatch(/URI Path starts with \/wp-json\/wc\//);
      expect(v.error).toMatch(/Skip/);
      expect(v.error).toMatch(/Super Bot Fight Mode/);
    } finally { globalThis.fetch = real; }
    const route = readFileSync(join(__dirname, "../routes/integrations.ts"), "utf8");
    expect(route).toContain('...((verdict as any).code ? { code: (verdict as any).code } : {})');
  });

  it("the store's own connect (wc-auth): the return page gets error=store_firewall_challenge", () => {
    const src = readFileSync(join(__dirname, "../routes/woocommerce-oauth.ts"), "utf8");
    expect(src).toContain('await record(valid.reason === "store_firewall_challenge" ? "error:store_firewall_challenge" : "error:validation_failed");');
    expect(src).toMatch(/WOO_ERROR_CODES = new Set\(\[[\s\S]*"store_firewall_challenge",[\s\S]*\]\);/);
  });
});
