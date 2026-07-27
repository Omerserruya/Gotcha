/**
 * Who may change what every customer is charged.
 *
 * These routes set the exchange rate. Getting the guard wrong would let any
 * authenticated tenant user decide what every Israeli customer's card is
 * debited - and unlike most authorization mistakes, nothing about the product
 * would look broken while it happened.
 *
 * The guard was written and asserted in review but never actually exercised, so
 * this drives every route through a real Express stack with the roles a request
 * can plausibly carry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The identity the stubbed `authenticate` will attach to the next request. */
let currentUser: Record<string, unknown> | null = null;

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    // Stands in for real token verification: this suite is about what happens
    // AFTER authentication, which is the part with the interesting failure.
    authenticate: (req: any, res: any, next: any) => {
      if (!currentUser) return res.status(401).json({ error: "unauthenticated" });
      req.user = currentUser;
      next();
    },
  };
});

import express from "express";
import request from "supertest";
import adminRouter from "../routes/admin-exchange-rates";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", adminRouter);
  return a;
}

/** Every route on this surface, with a request that would otherwise be valid. */
const ROUTES: Array<{ method: "get" | "post"; path: string; body?: unknown }> = [
  { method: "get", path: "/api/admin/billing/exchange-rates" },
  { method: "post", path: "/api/admin/billing/exchange-rates", body: { rate: "3.65" } },
  { method: "post", path: "/api/admin/billing/exchange-rates/r1/approve" },
  { method: "post", path: "/api/admin/billing/exchange-rates/r1/retire" },
  { method: "post", path: "/api/admin/billing/exchange-rates/preview", body: { rate: "3.65", amount: "499" } },
  { method: "get", path: "/api/admin/billing/reconciliations" },
  { method: "post", path: "/api/admin/billing/reconciliations/sweep" },
  { method: "get", path: "/api/admin/billing/enforcement-preview" },
];

beforeEach(() => {
  currentUser = null;
});

describe("nobody but a platform admin gets in", () => {
  it.each(ROUTES)("rejects an anonymous request to $method $path", async ({ method, path, body }) => {
    currentUser = null;
    const res = await request(app())[method](path).send(body as any);
    expect(res.status).toBe(401);
  });

  it.each(ROUTES)("rejects an ordinary tenant user on $method $path", async ({ method, path, body }) => {
    // The dangerous case: a real, authenticated customer of the product.
    currentUser = { userId: "u1", role: "USER", tenantId: "t1" };
    const res = await request(app())[method](path).send(body as any);
    expect(res.status).toBe(403);
  });

  it.each(ROUTES)("rejects a tenant ADMIN on $method $path", async ({ method, path, body }) => {
    // A tenant admin runs their own organization. The exchange rate is not
    // theirs to set - it governs every customer on the platform.
    currentUser = { userId: "u2", role: "ADMIN", tenantId: "t1" };
    const res = await request(app())[method](path).send(body as any);
    expect(res.status).toBe(403);
  });

  it("rejects a role that merely looks close", async () => {
    for (const role of ["SYSTEM", "SUPER_ADMIN", "system_admin", "OWNER", ""]) {
      currentUser = { userId: "u3", role };
      const res = await request(app()).get("/api/admin/billing/exchange-rates");
      expect(res.status, `role ${role} must not pass`).toBe(403);
    }
  });

  it("rejects a request whose user carries no role at all", async () => {
    currentUser = { userId: "u4" };
    const res = await request(app()).get("/api/admin/billing/exchange-rates");
    expect(res.status).toBe(403);
  });

  it("lets a platform admin through", async () => {
    currentUser = { userId: "admin1", role: "SYSTEM_ADMIN" };
    const res = await request(app()).post("/api/admin/billing/exchange-rates/preview").send({ rate: "3.65", amount: "499" });
    // Proves the guard is discriminating rather than simply closed - a guard
    // that rejects everyone would pass every test above and be useless.
    expect(res.status).toBe(200);
    expect(res.body.data.charge).toBe("1821.35");
  });
});

describe("the refusal gives nothing away", () => {
  it("returns no detail a caller could probe with", async () => {
    currentUser = { userId: "u1", role: "USER", tenantId: "t1" };
    const res = await request(app()).get("/api/admin/billing/exchange-rates");
    expect(res.body).toEqual({ error: "forbidden" });
    // No rate, no tenant list, no hint about what is behind the door.
    const body = JSON.stringify(res.body);
    for (const leak of ["rate", "tenant", "affected", "reconcil"]) {
      expect(body.toLowerCase()).not.toContain(leak);
    }
  });
});

describe("the internal surface stays internal", () => {
  const internal = readFileSync(join(__dirname, "../routes/internal.ts"), "utf8");

  it("guards the whole prefix, not route by route", () => {
    // A per-route guard is one forgotten line away from an unguarded endpoint.
    // Guarding the prefix means a new route is covered by existing code.
    expect(internal).toContain('router.use("/internal/billing", requireInternalKey)');
    const guardAt = internal.indexOf("requireInternalKey)");
    const firstRoute = internal.search(/router\.(get|post|put|delete)\(/);
    // The guard has to be registered before any route it protects.
    expect(guardAt).toBeLessThan(firstRoute);
  });

  it("keeps a way to record a chargeback", () => {
    // Removing the webhook handler left applyChargeback with no caller at all -
    // intact but unreachable, which is not the same as preserved. Dispute
    // windows are short, so there has to be a door, just not one strangers can
    // open.
    expect(internal).toContain('/internal/billing/chargeback"');
    expect(internal).toContain("applyChargeback");
    expect(internal).toContain('/internal/billing/refund-confirmation"');
  });

  it("declares every route under the guarded prefix", () => {
    const paths = Array.from(internal.matchAll(/router\.(?:get|post|put|delete)\("([^"]+)"/g), (m) => m[1]);
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) {
      // A route registered outside /internal/billing would be reachable with no
      // key at all - and these can issue refunds and grant credits.
      expect(p, `${p} sits outside the guarded prefix`).toMatch(/^\/internal\/billing\//);
    }
  });

  it("is not exposed through the public gateway", () => {
    const nginx = readFileSync(join(__dirname, "../../../../nginx/nginx.conf.template"), "utf8");
    // No location routes /api/internal, and there is no catch-all /api that
    // would pick it up.
    expect(nginx).not.toMatch(/location\s+\/api\/internal/);
    expect(nginx).not.toMatch(/location\s+\/api\s*\{/);
  });

  it("strips the internal key from public traffic", () => {
    const nginx = readFileSync(join(__dirname, "../../../../nginx/nginx.conf.template"), "utf8");
    // Defence in depth: even if a location were added by mistake, a header
    // supplied by a caller must never reach a service as the internal key.
    const stripped = (nginx.match(/proxy_set_header X-Internal-Key ""/g) ?? []).length;
    const billingLocations = (nginx.match(/proxy_pass http:\/\/billing_service/g) ?? []).length;
    expect(stripped).toBeGreaterThanOrEqual(billingLocations);
  });
});
