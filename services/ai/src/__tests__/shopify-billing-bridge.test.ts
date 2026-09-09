/**
 * The billing bridge, and the one property that matters most about it:
 *
 *   **A billing failure must never break an installation.**
 *
 * By the time the bridge is called the merchant has already authorized the app
 * on Shopify's side and the store is already linked. There is no honest way to
 * un-authorize that, so a billing service which is down, slow, misconfigured or
 * returning nonsense has to degrade into "carry on to the connected screen" -
 * never into an error page, and never into a half-completed install.
 *
 * The one exception is a cross-tenant claim, which must propagate, because
 * "this store belongs to another workspace" is something the merchant has to
 * be told rather than something to retry past.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.INTERNAL_SERVICE_KEY = "internal-key-for-tests-only-32-chars-min";
  process.env.BILLING_SERVICE_URL = "http://billing.test";
});

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const H = vi.hoisted(() => ({
  /** What getShopIdentity will do. */
  identity: {
    current: { shopId: "12345678", myshopifyDomain: "acme.myshopify.com", isDevelopmentStore: false } as any,
    throws: false,
  },
}));

vi.mock("../services/connectors/shopify-gql-shop", () => ({
  getShopIdentity: async () => {
    if (H.identity.throws) throw new Error("shop lookup exploded");
    return H.identity.current;
  },
}));

import {
  notifyShopifyConnected,
  notifyShopifyUninstalled,
  resolveShopifyBillingOutcome,
  CrossTenantShopError,
} from "../services/shopify-billing-bridge.service";

const CONNECTED = {
  connectionId: "conn-1",
  state: "PLAN_SELECTION_REQUIRED",
  grandfathered: false,
  requiresPlanSelection: true,
  planSelectionUrl: "https://admin.shopify.com/store/acme/charges/gotcha/pricing_plans",
};

function mockFetch(impl: (url: string, init: any) => Promise<any> | any) {
  const fn = vi.fn(async (url: any, init: any) => impl(String(url), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  H.identity.throws = false;
  H.identity.current = {
    shopId: "12345678",
    myshopifyDomain: "acme.myshopify.com",
    isDevelopmentStore: false,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the happy path", () => {
  it("passes the numeric shop id, never the domain, as the identity", async () => {
    const fetchMock = mockFetch(() => ok({ data: CONNECTED }));

    await resolveShopifyBillingOutcome({
      tenantId: "t1",
      shopDomain: "acme.myshopify.com",
      accessToken: "shpat_secret",
      apiVersion: "2026-07",
      acquisitionSource: "app_store",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // The domain is display and routing only. A merchant can rename it, and
    // keying the connection on it would let a rename orphan the connection or
    // collide with somebody else's store.
    expect(body.externalShopId).toBe("12345678");
    expect(body.shopDomain).toBe("acme.myshopify.com");
  });

  it("sends the internal key rather than a user token", async () => {
    const fetchMock = mockFetch(() => ok({ data: CONNECTED }));
    await notifyShopifyConnected({ tenantId: "t1", externalShopId: "1" });
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["X-Internal-Key"]).toBeTruthy();
    expect(JSON.stringify(headers)).not.toMatch(/shpat_/);
  });

  it("forwards the development-store flag it read from Shopify", async () => {
    H.identity.current.isDevelopmentStore = true;
    const fetchMock = mockFetch(() => ok({ data: CONNECTED }));
    await resolveShopifyBillingOutcome({
      tenantId: "t1",
      shopDomain: "acme.myshopify.com",
      accessToken: "x",
      apiVersion: "2026-07",
      acquisitionSource: "app_store",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).isDevelopmentStore).toBe(true);
  });

  it("returns what billing decided", async () => {
    mockFetch(() => ok({ data: CONNECTED }));
    const r = await notifyShopifyConnected({ tenantId: "t1", externalShopId: "1" });
    expect(r?.requiresPlanSelection).toBe(true);
    expect(r?.planSelectionUrl).toContain("pricing_plans");
  });
});

describe("every failure degrades to null, so the install survives", () => {
  it("billing returning 500", async () => {
    mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(await notifyShopifyConnected({ tenantId: "t1", externalShopId: "1" })).toBeNull();
  });

  it("billing unreachable", async () => {
    mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await notifyShopifyConnected({ tenantId: "t1", externalShopId: "1" })).toBeNull();
  });

  it("billing answering with a body that makes no sense", async () => {
    mockFetch(() => ok({ nonsense: true }));
    expect(await notifyShopifyConnected({ tenantId: "t1", externalShopId: "1" })).toBeNull();
  });

  it("the shop-identity lookup failing", async () => {
    H.identity.throws = true;
    const fetchMock = mockFetch(() => ok({ data: CONNECTED }));
    const r = await resolveShopifyBillingOutcome({
      tenantId: "t1",
      shopDomain: "acme.myshopify.com",
      accessToken: "x",
      apiVersion: "2026-07",
      acquisitionSource: "app_store",
    });
    expect(r).toBeNull();
    // And crucially it did NOT fall back to calling billing with the domain in
    // place of the id: that column is what stops one store being claimed by two
    // workspaces, and a merchant-changeable value there would weaken exactly
    // the guarantee it exists to provide.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Shopify returning a shop with no id", async () => {
    H.identity.current = { shopId: null, myshopifyDomain: "acme.myshopify.com", isDevelopmentStore: false };
    const fetchMock = mockFetch(() => ok({ data: CONNECTED }));
    const r = await resolveShopifyBillingOutcome({
      tenantId: "t1",
      shopDomain: "acme.myshopify.com",
      accessToken: "x",
      apiVersion: "2026-07",
      acquisitionSource: "app_store",
    });
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the one failure that must NOT be swallowed", () => {
  it("propagates a cross-tenant claim", async () => {
    mockFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: "COMMERCE_CONNECTION_CLAIMED_BY_ANOTHER_TENANT",
        message: "held by another workspace",
      }),
    }));

    await expect(
      notifyShopifyConnected({ tenantId: "t1", externalShopId: "1" }),
    ).rejects.toBeInstanceOf(CrossTenantShopError);
  });

  it("carries a code the caller can branch on", async () => {
    mockFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({ message: "held elsewhere" }),
    }));
    await notifyShopifyConnected({ tenantId: "t1", externalShopId: "1" }).catch((e) => {
      expect(e.code).toBe("shop_taken");
    });
  });
});

describe("uninstall is fire-and-forget", () => {
  it("never throws, whatever billing does", async () => {
    mockFetch(() => {
      throw new Error("down");
    });
    // The webhook has already been verified and acknowledged. Throwing here
    // would risk Shopify timing out and redelivering a webhook we handled.
    await expect(notifyShopifyUninstalled({ shopDomain: "acme.myshopify.com" })).resolves.toBeUndefined();
  });

  it("sends both the id and the domain so billing can resolve either way", async () => {
    const fetchMock = mockFetch(() => ok({ data: { tenantId: "t1", revoked: 2 } }));
    await notifyShopifyUninstalled({ externalShopId: "999", shopDomain: "acme.myshopify.com" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.externalShopId).toBe("999");
    // By uninstall time the token is revoked, so the id cannot be looked up
    // from Shopify any more. The domain is the fallback.
    expect(body.shopDomain).toBe("acme.myshopify.com");
  });
});

describe("what never reaches the wire", () => {
  it("no access token is sent to billing", async () => {
    const fetchMock = mockFetch(() => ok({ data: CONNECTED }));
    await resolveShopifyBillingOutcome({
      tenantId: "t1",
      shopDomain: "acme.myshopify.com",
      accessToken: "shpat_verysecret",
      apiVersion: "2026-07",
      acquisitionSource: "app_store",
    });
    const call = fetchMock.mock.calls[0][1];
    expect(JSON.stringify(call)).not.toMatch(/shpat_verysecret/);
  });
});
