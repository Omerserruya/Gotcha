/**
 * ★ GET /api/onboarding/status is for every member of the workspace
 * (2026-10-09): every page reads it to send an unpaid or still-onboarding
 * workspace to the right screen, and it was gated on analytics:workspace:read,
 * which the built-in Agent role no longer holds.
 *   - an agent with no analytics permission gets their own workspace's status
 *   - it reads only the workspace the request resolved to
 *   - /setup-map keeps its analytics:workspace:read gate
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => { process.env.NODE_ENV = "test"; });
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); publish = vi.fn(); subscribe = vi.fn(); async get() { return null; } async set() { return "OK"; } async del() { return 0; } } }));

const H = vi.hoisted(() => ({ asked: [] as string[], tenantReads: [] as any[] }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const byTenant = (a: any) => { H.tenantReads.push(a.where); return null; };
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "a1", role: "AGENT", tenantId: "T" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    // The agent holds no analytics permission; any gate on it refuses.
    requirePermission: (key: string) => (_q: any, res: any, n: any) => { H.asked.push(key); return key === "analytics:workspace:read" ? res.status(403).json({ error: "Permission denied" }) : n(); },
    prisma: {
      tenant: { findUnique: async (a: any) => { H.tenantReads.push(a.where); return { id: "T", name: "Acme", slug: "acme", status: "ACTIVE", defaultLocale: "he" }; } },
      tenantOnboarding: { findUnique: async (a: any) => byTenant(a) },
      businessProfile: { findUnique: async (a: any) => byTenant(a) },
      department: { findMany: async (a: any) => { H.tenantReads.push(a.where); return []; } },
      aIAgent: { count: async (a: any) => { H.tenantReads.push(a.where); return 0; } },
    },
  };
});
vi.mock("../services/onboarding-state.service", async (importOriginal) => ({ ...(await importOriginal<any>()), connectedCoreSystem: async () => null }));

import router from "../routes/onboarding";

const app = express();
app.use(express.json());
app.use("/api/onboarding", router);

beforeEach(() => { H.asked = []; H.tenantReads = []; });

describe("★ the onboarding status is every member's", () => {
  it("an agent with no analytics permission gets their workspace's status", async () => {
    const r = await request(app).get("/api/onboarding/status");
    expect(r.status).toBe(200);
    expect(r.body.data.tenant).toMatchObject({ id: "T", status: "ACTIVE" });
    expect(H.asked).not.toContain("analytics:workspace:read");
  });

  it("only the workspace the request resolved to is read, whatever the query names", async () => {
    await request(app).get("/api/onboarding/status").query({ tenantId: "OTHER" });
    expect(H.tenantReads.length).toBeGreaterThan(0);
    for (const w of H.tenantReads) expect(w.tenantId ?? w.id).toBe("T");
  });

  it("/setup-map keeps its gate", async () => {
    const r = await request(app).get("/api/onboarding/setup-map");
    expect(r.status).toBe(403);
    expect(H.asked).toContain("analytics:workspace:read");
  });
});
