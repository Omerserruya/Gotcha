/**
 * App Proxy verification - the boundary that decides whether we believe a
 * claim about who is chatting.
 *
 * Everything here is weighted toward the ways that goes wrong, because a
 * false positive means one shopper reading another's order history.
 */
import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import {
  verifyAppProxySignature,
  loggedInCustomerId,
  signCustomerIdentity,
  verifyCustomerIdentity,
  verifiedCustomerExternalId,
  isVerifiedCustomerExternalId,
  IDENTITY_TOKEN_TTL_SECONDS,
} from "../shopify-app-proxy";

const SECRET = "shpss_test_secret_value";
const SHOP = "urban-supply.myshopify.com";

/** Sign a query the way Shopify does: sorted, joined with NOTHING, hex. */
function sign(query: Record<string, string>, secret = SECRET): string {
  const message = Object.keys(query)
    .filter((k) => k !== "signature")
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join("");
  return crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

function signed(query: Record<string, string>, secret = SECRET) {
  return { ...query, signature: sign(query, secret) };
}

beforeAll(() => {
  process.env.WIDGET_SESSION_SECRET = "test-widget-session-secret";
});

describe("app proxy signature", () => {
  it("accepts a request Shopify actually signed", () => {
    const query = signed({
      shop: SHOP,
      path_prefix: "/apps/gotcha-chat",
      timestamp: "1785327743",
      logged_in_customer_id: "6820381",
    });
    expect(verifyAppProxySignature(query, SECRET)).toBe(true);
  });

  it("refuses a request signed with a different secret", () => {
    const query = signed({ shop: SHOP, timestamp: "1785327743" }, "someone-elses-secret");
    expect(verifyAppProxySignature(query, SECRET)).toBe(false);
  });

  it("refuses when any parameter is altered after signing", () => {
    // The whole point: a shopper editing the customer id must not pass.
    const query = signed({ shop: SHOP, timestamp: "1785327743", logged_in_customer_id: "1" });
    const tampered = { ...query, logged_in_customer_id: "999999" };
    expect(verifyAppProxySignature(tampered, SECRET)).toBe(false);
  });

  it("refuses when a parameter is added after signing", () => {
    const query = signed({ shop: SHOP, timestamp: "1785327743" });
    expect(verifyAppProxySignature({ ...query, extra: "1" }, SECRET)).toBe(false);
  });

  it("refuses when a parameter is removed after signing", () => {
    const query: Record<string, string> = signed({
      shop: SHOP,
      timestamp: "1785327743",
      logged_in_customer_id: "7",
    });
    delete query.logged_in_customer_id;
    expect(verifyAppProxySignature(query, SECRET)).toBe(false);
  });

  it("refuses a request with no signature at all", () => {
    expect(verifyAppProxySignature({ shop: SHOP }, SECRET)).toBe(false);
    expect(verifyAppProxySignature({ shop: SHOP, signature: "" }, SECRET)).toBe(false);
  });

  it("refuses every request when the secret is missing", () => {
    // A misconfigured deployment must fail closed, not authenticate
    // everyone with an empty key.
    const query = signed({ shop: SHOP, timestamp: "1" });
    expect(verifyAppProxySignature(query, "")).toBe(false);
  });

  it("joins repeated parameters with a comma, as Shopify does", () => {
    const base = { shop: SHOP, ids: "1,2,3" };
    const signature = sign(base);
    expect(verifyAppProxySignature({ shop: SHOP, ids: ["1", "2", "3"], signature }, SECRET)).toBe(true);
  });

  it("does not accept an OAuth-style signature", () => {
    // OAuth joins the sorted pairs with "&"; the proxy joins with nothing.
    // Getting these two confused produces a signature that never matches,
    // which looks exactly like a wrong secret.
    const query: Record<string, string> = { shop: SHOP, timestamp: "1785327743" };
    const oauthStyle = crypto
      .createHmac("sha256", SECRET)
      .update(Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join("&"), "utf8")
      .digest("hex");
    expect(verifyAppProxySignature({ ...query, signature: oauthStyle }, SECRET)).toBe(false);
  });

  it("survives a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on a length mismatch, and the throw would
    // itself leak whether the length was right.
    const query = { shop: SHOP, timestamp: "1", signature: "abc" };
    expect(() => verifyAppProxySignature(query, SECRET)).not.toThrow();
    expect(verifyAppProxySignature(query, SECRET)).toBe(false);
  });
});

describe("logged-in customer id", () => {
  it("reads the id Shopify asserts", () => {
    expect(loggedInCustomerId({ logged_in_customer_id: "6820381" })).toBe("6820381");
  });

  it("treats a logged-out shopper as a normal, non-identified visitor", () => {
    // Shopify sends an empty value rather than omitting the parameter.
    expect(loggedInCustomerId({ logged_in_customer_id: "" })).toBeNull();
    expect(loggedInCustomerId({})).toBeNull();
  });

  it("refuses anything that is not a bare numeric id", () => {
    for (const bad of ["abc", "1; DROP", "../7", "1 OR 1=1", " 7 ", "-7", "1e5"]) {
      expect(loggedInCustomerId({ logged_in_customer_id: bad })).toBeNull();
    }
  });
});

describe("identity token", () => {
  it("round-trips for the store it was minted for", () => {
    const token = signCustomerIdentity({ shopDomain: SHOP, customerId: "6820381" });
    const identity = verifyCustomerIdentity(token, SHOP);
    expect(identity).toMatchObject({ v: 1, shopDomain: SHOP, customerId: "6820381" });
  });

  it("is opaque - the customer id is not simply readable from it", () => {
    const token = signCustomerIdentity({ shopDomain: SHOP, customerId: "6820381" });
    expect(token).not.toContain("6820381");
    expect(token).not.toContain(SHOP);
    expect(Buffer.from(token, "base64").toString("utf8")).not.toContain("customerId");
  });

  it("is refused by a different store", () => {
    // A merchant running two stores must not be able to carry an identity
    // from one into the other.
    const token = signCustomerIdentity({ shopDomain: SHOP, customerId: "1" });
    expect(verifyCustomerIdentity(token, "other-store.myshopify.com")).toBeNull();
  });

  it("is refused once expired", () => {
    const token = signCustomerIdentity({ shopDomain: SHOP, customerId: "1", ttlSeconds: -1 });
    expect(verifyCustomerIdentity(token, SHOP)).toBeNull();
  });

  it("is short-lived by default", () => {
    // It is a hand-off between two requests, not a session.
    expect(IDENTITY_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(300);
  });

  it("is refused when tampered with", () => {
    const token = signCustomerIdentity({ shopDomain: SHOP, customerId: "1" });
    const flipped = token.slice(0, -2) + (token.endsWith("A") ? "B" : "A");
    expect(verifyCustomerIdentity(flipped, SHOP)).toBeNull();
  });

  it("is refused when it is not a token at all", () => {
    for (const junk of [null, undefined, 42, {}, "", "x", "a".repeat(5000)]) {
      expect(verifyCustomerIdentity(junk as unknown, SHOP)).toBeNull();
    }
  });

  it("cannot be confused with a visitor session token", async () => {
    // Both are AES-GCM under the same secret; different key derivation is
    // what stops one being accepted where the other is expected.
    const { signVisitorSession } = await import("../shopify-live-chat");
    const visitor = signVisitorSession({
      tenantId: "t1",
      channelAccountId: "c1",
      visitorId: "v1",
      shopDomain: SHOP,
    });
    expect(verifyCustomerIdentity(visitor, SHOP)).toBeNull();
  });
});

describe("conversation keying", () => {
  it("namespaces a verified customer so it cannot collide with a visitor id", () => {
    const key = verifiedCustomerExternalId("6820381");
    expect(key).toBe("shopify-customer:6820381");
    expect(isVerifiedCustomerExternalId(key)).toBe(true);
  });

  it("does not mistake an anonymous visitor for a verified customer", () => {
    expect(isVerifiedCustomerExternalId("v_8f2c1a")).toBe(false);
    expect(isVerifiedCustomerExternalId(null)).toBe(false);
    expect(isVerifiedCustomerExternalId(undefined)).toBe(false);
  });
});
