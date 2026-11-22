/**
 * A parked install (App Review 132211, 2026-11-22: an authorized store waiting for someone to sign in
 * and claim it) is a shopify_chat_installations row, but never the shop's installation: every by-shop
 * reader of the chat install skips it, so it can neither serve the storefront nor be revived as the
 * shop's row by a reinstall.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ wheres: [] as any[], rows: [] as any[] }));

vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig<any>()),
  withCrossTenantAccess: (fn: any) => fn(),
  encryptCredentials: () => "enc",
  prisma: {
    shopifyChatInstallation: {
      findFirst: async (a: any) => {
        H.wheres.push(a.where);
        const notParked = a.where?.appIdentity?.not;
        return H.rows.find((r) => r.shopDomain === a.where.shopDomain && (!notParked || r.appIdentity !== notParked)) ?? null;
      },
      update: async (a: any) => ({ ...H.rows.find((r) => r.id === a.where.id), ...a.data }),
      create: async (a: any) => ({ id: "new", ...a.data }),
    },
  },
}));

import { findLiveInstallation, findLatestInstallation, recordAuthorizedInstall } from "../services/shopify-chat-install.service";
import { PENDING_CLAIM_IDENTITY } from "../services/shopify-install-intent.service";

const SHOP = "random-randomizer.myshopify.com";
beforeEach(() => {
  H.wheres = [];
  H.rows = [{ id: "parked", shopDomain: SHOP, status: "PENDING", appIdentity: PENDING_CLAIM_IDENTITY, tenantId: null, channelAccountId: null, verifiedDomains: [], installedAt: new Date() }];
});

describe("a parked install is not the shop's installation", () => {
  it("the live and latest lookups do not find it", async () => {
    expect(await findLiveInstallation(SHOP)).toBeNull();
    expect(await findLatestInstallation(SHOP)).toBeNull();
    expect(H.wheres.every((w) => w.appIdentity?.not === PENDING_CLAIM_IDENTITY)).toBe(true);
  });

  it("a claim's authorized install makes its own row, never updating the parked one", async () => {
    const r = await recordAuthorizedInstall({ shopDomain: SHOP, accessToken: "shpat", scopes: "read_products" });
    expect(r.id).toBe("new");
    expect(H.wheres).toHaveLength(2);
    expect(H.wheres.every((w) => w.appIdentity?.not === PENDING_CLAIM_IDENTITY)).toBe(true);
  });
});
