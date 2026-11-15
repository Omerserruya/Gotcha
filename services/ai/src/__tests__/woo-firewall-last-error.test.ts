/**
 * A connected store that later meets a firewall (Cloudflare's challenge, prod
 * 2026-11-15): the bot's store calls failed as "woocommerce_403: <html>",
 * and nothing on the connection said why. Now the store call raises
 * store_firewall_challenge, the connection carries lastError
 * "[STORE_FIREWALL_CHALLENGE] firewall=cloudflare: ..." (lastErrorCode for the
 * channels page) with its status unchanged, and the next call that reaches
 * the store clears it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({ row: { id: "ti1", status: "CONNECTED", lastError: null as string | null }, updates: 0 }));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig() as any),
  assertPublicUrl: async () => undefined,
  prisma: {
    tenantIntegration: {
      update: async (a: any) => { H.updates++; Object.assign(H.row, a.data); return H.row; },
      updateMany: async (a: any) => {
        // As Prisma: the id, and the lastError filter only when there is one.
        const ok = a.where.id === H.row.id && (a.where.lastError?.startsWith == null || String(H.row.lastError ?? "").startsWith(a.where.lastError.startsWith));
        if (ok) { H.updates++; Object.assign(H.row, a.data); }
        return { count: ok ? 1 : 0 };
      },
    },
  },
}));

import Woo from "../services/connectors/woocommerce.adapter";
import { noteFirewallChallenge, clearFirewallChallenge, FIREWALL_ERROR_PREFIX } from "../services/connectors/integration-framework";
import { splitErrorCode } from "../lib/error-code";

const respond = (status: number, body: string, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300, status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  text: async () => body, json: async () => JSON.parse(body),
});

beforeEach(() => { H.row = { id: "ti1", status: "CONNECTED", lastError: null }; H.updates = 0; vi.spyOn(console, "warn").mockImplementation(() => undefined); });

describe("a store call that meets the firewall", () => {
  it("raises store_firewall_challenge, naming the firewall, not woocommerce_403 with the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(403, "<title>Just a moment...</title><script src=\"/cdn-cgi/challenge-platform/x\"></script>", { "cf-mitigated": "challenge" })));
    await expect(Woo.execute({ toolName: "get_order", args: { order_id: "1" }, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: "https://shop.example.com" } } as any))
      .rejects.toThrow(/^store_firewall_challenge: the store's firewall \(cloudflare\) answered instead of WooCommerce$/);
    vi.unstubAllGlobals();
  });
  it("WooCommerce's own 403 is still woocommerce_403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(403, "{\"code\":\"woocommerce_rest_cannot_view\"}")));
    await expect(Woo.execute({ toolName: "get_order", args: { order_id: "1" }, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: "https://shop.example.com" } } as any))
      .rejects.toThrow(/^woocommerce_403: /);
    vi.unstubAllGlobals();
  });
});

describe("the connection says so, and stops saying so", () => {
  it("lastError with a code the channels page reads; the status is unchanged; written once while it holds", async () => {
    await noteFirewallChallenge("ti1", "store_firewall_challenge: the store's firewall (cloudflare) answered instead of WooCommerce");
    await noteFirewallChallenge("ti1", "store_firewall_challenge: the store's firewall (cloudflare) answered instead of WooCommerce");
    expect(H.row.status).toBe("CONNECTED");
    expect(H.row.lastError!.startsWith(FIREWALL_ERROR_PREFIX)).toBe(true);
    expect(splitErrorCode(H.row.lastError)).toMatchObject({ lastErrorCode: "STORE_FIREWALL_CHALLENGE" });
    expect(H.row.lastError).toContain("firewall=cloudflare");
    expect(H.updates).toBe(1);
  });
  it("the next call that reaches the store clears it; another error is never cleared", async () => {
    await noteFirewallChallenge("ti1", "store_firewall_challenge: the store's firewall (sucuri) answered instead of WooCommerce");
    await clearFirewallChallenge("ti1");
    expect(H.row.lastError).toBeNull();
    // A connection this process never checked (after a restart): its first
    // success tries a clear, which must leave any other error in place.
    H.row = { id: "ti3", status: "ERROR", lastError: "[TOKEN_EXPIRED] something else" };
    await clearFirewallChallenge("ti3");
    expect(H.row.lastError).toBe("[TOKEN_EXPIRED] something else");
  });
  it("the framework notes it instead of flipping the connection to ERROR, and clears it after a WooCommerce success", () => {
    const src = readFileSync(join(__dirname, "../services/connectors/integration-framework.ts"), "utf8");
    expect(src).toContain('if (message.startsWith("store_firewall_challenge")) {\n      await noteFirewallChallenge(conn.tenantIntegrationId, message);\n    } else if (isAuthError(message)) {');
    expect(src).toContain('if (slug === "woocommerce") await clearFirewallChallenge(conn.tenantIntegrationId);\n    return { ok: true, result };');
  });
});
