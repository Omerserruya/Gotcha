/**
 * ★ Disconnecting a calendar system stops every employee's bookings
 * (2026-10-10). Google Calendar and Calendly bookings run through each
 * employee's CalendarAccount, which only POST /api/calendar/disconnect (one
 * employee at a time) stopped; POST /api/connectors/:slug/disconnect left all
 * of them booking.
 *   - google_calendar / calendly: every CalendarAccount of THAT provider in
 *     THIS workspace becomes DISCONNECTED
 *   - another provider's accounts and another workspace's are untouched
 *   - any other system's disconnect touches no calendar
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.FRONTEND_URL = "https://app.gotcha.co.il";
  process.env.OAUTH_STATE_SECRET = "oauth-state-secret-for-tests-only-32chars";
  process.env.CHANNEL_ENCRYPTION_KEY = "a".repeat(64);
});
vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); async set() { return "OK"; } } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const DB = vi.hoisted(() => ({ integrations: [] as any[], calendars: [] as any[], catalog: null as any }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  const prisma = {
    tenantIntegration: {
      findMany: async (a: any) => DB.integrations.filter((r) => r.tenantId === a.where.tenantId && r.integrationId === a.where.integrationId),
      update: async (a: any) => { const r = DB.integrations.find((x) => x.id === a.where.id); Object.assign(r, a.data); return r; },
    },
    calendarAccount: {
      updateMany: async (a: any) => {
        const hit = DB.calendars.filter((c) => c.tenantId === a.where.tenantId && c.provider === a.where.provider && c.status !== a.where.status?.not);
        hit.forEach((c) => Object.assign(c, a.data));
        return { count: hit.length };
      },
    },
  };
  return {
    ...actual,
    prisma,
    authenticate: (req: any, _res: any, next: any) => { req.user = { userId: "user-1", role: "ADMIN" }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "tenant-A"; next(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../services/connector-connection.service", () => ({
  findCatalog: vi.fn(async (slug: string) => ({ id: `cat_${slug}`, slug })),
  upsertConnection: vi.fn(),
}));

import router from "../routes/connectors-admin";

const app = express();
app.use(express.json());
app.use("/api", router);
const disconnect = (slug: string) => request(app).post(`/api/connectors/${slug}/disconnect`).send({});
const cal = (id: string, tenantId: string, provider: string, aiAgentId: string | null) => ({ id, tenantId, provider, aiAgentId, status: "CONNECTED" });

beforeEach(() => {
  DB.integrations = [
    { id: "ti_g", tenantId: "tenant-A", integrationId: "cat_google_calendar", status: "CONNECTED", config: {} },
    { id: "ti_h", tenantId: "tenant-A", integrationId: "cat_hubspot", status: "CONNECTED", config: {} },
  ];
  DB.calendars = [
    cal("c1", "tenant-A", "GOOGLE_CALENDAR", "maya"),
    cal("c2", "tenant-A", "GOOGLE_CALENDAR", "dan"),
    cal("c3", "tenant-A", "GOOGLE_CALENDAR", null),
    cal("c4", "tenant-A", "CALENDLY", "maya"),
    cal("c5", "tenant-B", "GOOGLE_CALENDAR", "x"),
  ];
});

const statuses = () => Object.fromEntries(DB.calendars.map((c) => [c.id, c.status]));

describe("★ a calendar system's disconnect stops every employee's calendar", () => {
  it("google_calendar: all of this workspace's Google calendars (owned or not) stop; Calendly and tenant-B untouched", async () => {
    expect((await disconnect("google_calendar")).status).toBe(200);
    expect(statuses()).toEqual({ c1: "DISCONNECTED", c2: "DISCONNECTED", c3: "DISCONNECTED", c4: "CONNECTED", c5: "CONNECTED" });
    expect(DB.integrations[0].status).toBe("DISCONNECTED");
  });

  it("calendly: only Calendly", async () => {
    await disconnect("calendly");
    expect(statuses()).toEqual({ c1: "CONNECTED", c2: "CONNECTED", c3: "CONNECTED", c4: "DISCONNECTED", c5: "CONNECTED" });
  });

  it("another system's disconnect touches no calendar", async () => {
    await disconnect("hubspot");
    expect(Object.values(statuses()).every((s) => s === "CONNECTED")).toBe(true);
  });
});
