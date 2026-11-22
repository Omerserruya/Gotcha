/**
 * A card after N days: the three places a route had to change (2026-11-22).
 *
 *   1. GET /checkout/mine says WHY an organization with nothing to pay is
 *      still closed: `reason: "card_required"`, next to `checkout: null`.
 *   2. The card session and its confirm are reachable by the admin of an
 *      organization closed for a card even when the billing permission is
 *      refused. By the card day the evaluation has ended and its licences with
 *      it, the billing permission hangs on the `settings` licence, and so the
 *      one person asked for a card was refused the page that takes one.
 *   3. A confirmed stored card opens the organization. The answer of the
 *      confirm is unchanged: the stored card and nothing else.
 *
 * The gates here are stand-ins that behave as the shared ones do (the shared
 * package tests the real ones: permission-gate.test.ts). `H.permitted = false`
 * is the lapsed licence. Nothing here reaches a provider: the tokenization
 * service is a stand-in too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  role: "ADMIN" as string,
  permitted: false,
  closed: false as boolean | "throws",
  restore: null as null | (() => Promise<unknown>),
  gates: [] as string[],
  log: [] as string[],
  started: [] as any[],
  verified: { verified: true, paymentMethodId: "pm_new" } as any,
  session: { id: "tks_1", tenantId: "T" } as any,
  checkout: null as null | { reference: string; expiresAt: Date },
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const deny = (res: any, permissions: string[]) => res.status(403).json({ error: "Permission denied", code: "PERMISSION_DENIED", permissions });
  const prisma: any = {
    tokenizationSession: { findUnique: async () => H.session },
    paymentMethod: {
      findUnique: async () => ({ id: "pm_new", billingProfileId: "bp_1", brand: "visa", last4: "4242", expMonth: 4, expYear: 2031 }),
      updateMany: async () => { H.log.push("retire-old-cards"); return { count: 1 }; },
    },
    pendingCheckout: { findFirst: async () => H.checkout },
    billableEntityTenant: { findUnique: async () => null },
  };
  return {
    ...actual,
    prisma,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", email: "admin@x.test", role: H.role }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requirePaymentSetupAccess: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: (...keys: string[]) => (_q: any, res: any, n: any) => {
      H.gates.push(`permission(${keys.join(",")})`);
      return H.permitted ? n() : deny(res, keys);
    },
    requirePermissionOrRole: (key: string, ...roles: string[]) => (req: any, res: any, n: any) => {
      H.gates.push(`permissionOrRole(${key};${roles.join(",")})`);
      return H.permitted || req.user.role === "SYSTEM_ADMIN" || roles.includes(req.user.role) ? n() : deny(res, [key]);
    },
  };
});
vi.mock("../services/card-required.service", () => ({
  closedForCard: async (tenantId: string) => {
    H.log.push(`closed?(${tenantId})`);
    if (H.closed === "throws") throw new Error("the database is away");
    return H.closed;
  },
  restoreAfterCard: async (...args: any[]) => {
    H.log.push(`restore(${args.join(",")})`);
    return H.restore ? H.restore() : { restored: true, status: "ACTIVE" };
  },
}));
vi.mock("../services/billable-entity.service", () => ({ ensureBillableEntity: async () => "ent1" }));
vi.mock("../services/tokenization.service", () => ({
  startTokenizationSession: async (input: any) => { H.started.push(input); return { session: { id: "tks_1" }, saleUrl: "https://provider.example/pay/abc" }; },
  verifyTokenizationSession: async () => { H.log.push("verify"); return H.verified; },
  TokenizationRefused: class extends Error {},
}));
vi.mock("../providers/capabilities", async (importOriginal) => ({ ...(await importOriginal<any>()), checkoutEnabled: () => true }));
vi.mock("../providers", () => ({ getCapabilities: () => ({}) }));
vi.mock("../services/subscription.service", () => ({ contractedPrice: () => 0 }));
vi.mock("../services/exchange-rate.service", () => ({ activeRate: async () => null, convert: () => 0 }));
vi.mock("../services/payment-quote.service", () => ({ quoteDisplay: () => null }));
vi.mock("../lib/checkout-auth", () => ({
  authorizeCheckout: async () => null,
  checkoutNotFound: (res: any) => res.status(404).json({ error: "not_found" }),
  optionalAuth: (_q: any, _s: any, n: any) => n(),
}));

import cardRouter from "../routes/payment-methods";
import checkoutRouter from "../routes/checkout";

const app = express();
app.use(express.json());
app.use(cardRouter);
app.use(checkoutRouter);
const startCard = (body: any = { returnTo: "payment-required" }) => request(app).post("/billing/payment-methods/session").send(body);
const confirmCard = (body: any = { sessionId: "tks_1" }) => request(app).post("/billing/payment-methods/confirm").send(body);

const ENV = { ...process.env };
beforeEach(() => {
  H.role = "ADMIN"; H.permitted = false; H.closed = false; H.restore = null;
  H.gates = []; H.log = []; H.started = [];
  H.verified = { verified: true, paymentMethodId: "pm_new" };
  H.session = { id: "tks_1", tenantId: "T" };
  H.checkout = null;
  process.env.APP_PUBLIC_URL = "https://dev.gotcha.co.il";
  delete process.env.V2_BASE_PATH;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { process.env = { ...ENV }; });

describe("GET /checkout/mine says why a closed organization has nothing to pay", () => {
  const mine = () => request(app).get("/checkout/mine");

  it("closed for a card: checkout null and reason card_required, both inside data", async () => {
    H.closed = true;
    const r = await mine();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: { checkout: null, reason: "card_required" } });
    expect(H.log).toEqual(["closed?(T)"]);
  });

  it("not closed for a card: exactly the answer it always gave, with no reason key at all", async () => {
    const r = await mine();
    expect(r.body).toEqual({ data: { checkout: null } });
    expect("reason" in r.body.data).toBe(false);
  });

  it("when the question cannot be answered it gives the plain answer, not an error", async () => {
    H.closed = "throws";
    const r = await mine();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: { checkout: null } });
  });

  it("a first payment still owed wins: the checkout is returned, no reason, and the card question is not even asked", async () => {
    H.closed = true;
    H.checkout = { reference: "chk_abc", expiresAt: new Date(Date.now() + 3_600_000) };
    const r = await mine();
    expect(r.body).toEqual({ data: { checkout: { reference: "chk_abc", expiresAt: H.checkout.expiresAt.toISOString() } } });
    expect(H.log).toEqual([]);
  });

  it("an expired checkout keeps its own answer", async () => {
    H.closed = true;
    H.checkout = { reference: "chk_abc", expiresAt: new Date(Date.now() - 1000) };
    expect((await mine()).body).toEqual({ data: { checkout: null, expired: true } });
  });
});

describe("who may open the card page", () => {
  it("closed for a card, licence lapsed: the admin starts a card session", async () => {
    H.closed = true;
    const r = await startCard();
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ redirectUrl: "https://provider.example/pay/abc", sessionId: "tks_1" });
    expect(H.gates).toEqual(["permissionOrRole(settings:billing:manage;ADMIN)"]);
  });

  it("closed for a card, licence lapsed: the admin confirms the card too", async () => {
    H.closed = true;
    const r = await confirmCard();
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe("STORED");
    expect(H.gates).toEqual(["permissionOrRole(settings:billing:manage;ADMIN)"]);
  });

  it.each([["AGENT"], ["MANAGER"], ["admin"]])("closed for a card: a %s is still refused, and nothing is started", async (role) => {
    H.closed = true; H.role = role;
    for (const call of [startCard, confirmCard]) {
      const r = await call();
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("PERMISSION_DENIED");
    }
    expect(H.started).toEqual([]);
    expect(H.log.filter((l) => l !== "closed?(T)")).toEqual([]);
  });

  it("an organization that is NOT closed for a card keeps the ordinary gate: an admin without the permission is refused", async () => {
    for (const call of [startCard, confirmCard]) expect((await call()).status).toBe(403);
    expect(H.gates).toEqual(["permission(settings:billing:manage)", "permission(settings:billing:manage)"]);
    expect(H.started).toEqual([]);
  });

  it("with the permission the ordinary gate lets a person through, closed or not", async () => {
    H.permitted = true; H.role = "AGENT";
    expect((await startCard()).status).toBe(200);
    H.closed = true;
    expect((await startCard()).status).toBe(200);
  });

  it("when it cannot be read whether the organization is closed, the ordinary gate decides", async () => {
    H.closed = "throws";
    expect((await startCard()).status).toBe(403);
    expect(H.gates).toEqual(["permission(settings:billing:manage)"]);
    H.permitted = true;
    expect((await startCard()).status).toBe(200);
  });

  it("the exception is the two card routes only: listing, removing and the billing profile keep the ordinary gate", async () => {
    H.closed = true;
    const calls = [
      request(app).get("/billing/payment-methods"),
      request(app).delete("/billing/payment-methods/pm_1"),
      request(app).get("/billing/profile"),
      request(app).put("/billing/profile").send({ billingName: "X" }),
    ];
    for (const call of calls) expect((await call).status).toBe(403);
    expect(H.gates).toEqual(Array(4).fill("permission(settings:billing:manage)"));
    expect(H.log).toEqual([]);
  });
});

describe("the card page comes back to the page the organization is held on", () => {
  it("payment-required: that page on this origin with card=1; giving up adds cancelled=1; no locale, no session id", async () => {
    H.closed = true;
    await startCard({ returnTo: "payment-required" });
    expect(H.started[0]).toMatchObject({
      successUrl: "https://dev.gotcha.co.il/v2/checkout/payment-required?card=1",
      failureUrl: "https://dev.gotcha.co.il/v2/checkout/payment-required?card=1&cancelled=1",
      cancelUrl: "https://dev.gotcha.co.il/v2/checkout/payment-required?card=1&cancelled=1",
    });
    const urls = [H.started[0].successUrl, H.started[0].failureUrl, H.started[0].cancelUrl].join(" ");
    expect(urls).not.toMatch(/tks_1|token|session|\/(he|en)\//);
  });

  it("the settings page's own return is untouched", async () => {
    H.permitted = true;
    await startCard({ returnTo: "v2" });
    expect(H.started[0]).toMatchObject({
      successUrl: "https://dev.gotcha.co.il/v2/settings/billing/payment-method",
      failureUrl: "https://dev.gotcha.co.il/v2/settings/billing/payment-method?cancelled=1",
      cancelUrl: "https://dev.gotcha.co.il/v2/settings/billing/payment-method?cancelled=1",
    });
  });

  it.each([["Payment-Required"], ["payment_required"], ["/checkout/payment-required"], ["payment-required/"]])(
    "a near miss (%s) is refused like any unknown target", async (returnTo) => {
      H.closed = true;
      const r = await startCard({ returnTo });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "invalid_return_target" });
      expect(H.started).toEqual([]);
    });

  it("a base path set to a URL yields no return URL at all, never an off-origin one", async () => {
    H.closed = true;
    process.env.V2_BASE_PATH = "https://evil.example";
    expect((await startCard({ returnTo: "payment-required" })).status).toBe(200);
    expect(H.started[0].successUrl).toBeUndefined();
    expect(H.started[0].failureUrl).toBeUndefined();
    expect(H.started[0].cancelUrl).toBeUndefined();
  });
});

describe("a confirmed stored card opens the organization", () => {
  const STORED = { data: { status: "STORED", paymentMethod: { id: "pm_new", brand: "visa", last4: "4242", expMonth: 4, expYear: 2031 } } };

  it("the restore runs once, for the caller's organization, after the provider said yes and the old card was retired", async () => {
    H.closed = true;
    const r = await confirmCard();
    expect(r.body).toEqual(STORED);
    expect(H.log).toEqual(["closed?(T)", "verify", "retire-old-cards", "restore(T)"]);
  });

  it("the answer is the stored card and nothing else, whatever the restore said", async () => {
    H.permitted = true;
    for (const outcome of [{ restored: true, status: "ACTIVE" }, { restored: false, reason: "not_closed_for_card" }, { restored: false, reason: "checkout_open" }]) {
      H.restore = async () => outcome;
      expect((await confirmCard()).body).toEqual(STORED);
    }
  });

  it("it runs for every stored card: the service decides whether there is anything to open", async () => {
    H.permitted = true;
    await confirmCard();
    expect(H.log).toContain("restore(T)");
  });

  it("a restore that throws does not turn a stored card into an error", async () => {
    H.closed = true;
    H.restore = async () => { throw new Error("the mark's row could not be written"); };
    const r = await confirmCard();
    expect(r.status).toBe(200);
    expect(r.body).toEqual(STORED);
  });

  it("a card the provider has not confirmed opens nothing", async () => {
    H.closed = true;
    H.verified = { verified: false, reason: "not_yet" };
    const r = await confirmCard();
    expect(r.body).toEqual({ data: { status: "PENDING", reason: "not_yet" } });
    expect(H.log).toEqual(["closed?(T)", "verify"]);
  });

  it("another organization's session opens nothing: 404 before the provider is asked", async () => {
    H.closed = true;
    H.session = { id: "tks_1", tenantId: "T_other" };
    expect((await confirmCard()).status).toBe(404);
    expect(H.log).toEqual(["closed?(T)"]);
  });

  it("no session id opens nothing", async () => {
    H.closed = true;
    expect((await confirmCard({})).status).toBe(400);
    expect(H.log).toEqual(["closed?(T)"]);
  });
});
