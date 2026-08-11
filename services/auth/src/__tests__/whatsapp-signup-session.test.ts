/**
 * Signup session lifecycle, and what /inspect is allowed to do.
 *
 * Every case here is a way the two-path connect flow could go wrong in a way
 * the customer would not see until much later:
 *
 *   * a relaunch reusing a token from the authorization they abandoned
 *   * the business token reaching the browser
 *   * inspection quietly writing rows before anyone chose a number
 *   * a second attempt duplicating the first one's records
 *   * one workspace replaying another's session id
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── In-memory Redis and Prisma ──────────────────────────────

const redisStore = new Map<string, string>();

const state = {
  /** Anything a route tried to write. Must stay empty during inspection. */
  writes: [] as Array<{ model: string; op: string }>,
  numbers: [] as any[],
  channels: [] as any[],
  /** Authorization codes handed to Meta, to catch a stale-code re-exchange. */
  exchangedCodes: [] as string[],
};

const mocks = vi.hoisted(() => ({ prismaMock: {} as any }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: mocks.prismaMock,
    getRedis: () => ({
      get: async (k: string) => redisStore.get(k) ?? null,
      set: async (k: string, v: string) => {
        redisStore.set(k, v);
        return "OK";
      },
      del: async (k: string) => (redisStore.delete(k) ? 1 : 0),
    }),
    // Pass-through middleware: this suite is about the route's own behaviour,
    // and the auth gate has its own tests.
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: "user_1" };
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => {
      req.tenantId = req.headers["x-test-tenant"] || "tenant_a";
      next();
    },
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
    requireCapacity: () => (_req: any, _res: any, next: any) => next(),
    validate: (schema: any) => (req: any, res: any, next: any) => {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid" });
      req.body = parsed.data;
      next();
    },
    MetaWhatsAppClient: class {
      static async exchangeCode({ code }: { code: string }) {
        // Meta rejects a code that has already been redeemed. Modelling that
        // is the only way to prove we never try to reuse one.
        if (state.exchangedCodes.includes(code)) {
          throw new Error("This authorization code has already been used");
        }
        state.exchangedCodes.push(code);
        return `token-for-${code}`;
      }
    },
    // Inspection itself is exercised in the shared package; here it is stubbed
    // so the test is about the route, not about Meta.
    inspectMetaAssets: async () => ({
      inspectedAt: "2026-08-05T00:00:00.000Z",
      grantedScopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      missingPermissions: [],
      degraded: false,
      degradedReasons: [],
      portfolios: [],
      wabas: [],
      numbers: [],
      errors: [],
    }),
    selectFlow: () => ({
      scenario: "NEW_NUMBER",
      reason: "stub",
      customerMessage: "stub",
      automatedSteps: [],
      customerAction: null,
      blockers: [],
    }),
  };
});

import whatsappRouter from "../routes/whatsapp-numbers";
import {
  startSignupSession,
  readSignupSession,
  signupSessionKey,
} from "../services/whatsapp/signup-session";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/channels/whatsapp", whatsappRouter);
  return a;
}

beforeEach(() => {
  redisStore.clear();
  state.writes = [];
  state.numbers = [];
  state.channels = [];
  state.exchangedCodes = [];

  const recording = (model: string) => ({
    findMany: async () => (model === "whatsAppNumber" ? state.numbers : state.channels),
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    create: async (args: any) => {
      state.writes.push({ model, op: "create" });
      return args.data;
    },
    update: async (args: any) => {
      state.writes.push({ model, op: "update" });
      return args.data;
    },
    upsert: async (args: any) => {
      state.writes.push({ model, op: "upsert" });
      return args.create;
    },
  });
  mocks.prismaMock.whatsAppNumber = recording("whatsAppNumber");
  mocks.prismaMock.channelAccount = recording("channelAccount");
  mocks.prismaMock.whatsAppNumberEvent = recording("whatsAppNumberEvent");

  process.env.META_APP_ID = "app_1";
  process.env.META_APP_SECRET = "secret_1";
});

// ─── Session lifecycle ───────────────────────────────────────

describe("signup session lifecycle", () => {
  it("replaces the previous session when the customer relaunches", async () => {
    // A relaunch is a fresh authorization. The old token belongs to a grant
    // the customer walked away from, and switching paths is exactly when the
    // granted assets change.
    const first = await startSignupSession("tenant_a", { accessToken: "tok1", path: "new" });
    const second = await startSignupSession("tenant_a", {
      accessToken: "tok2",
      path: "business-app",
    });

    expect(second).not.toBe(first);
    expect(await readSignupSession("tenant_a", first)).toBeNull();
    expect((await readSignupSession("tenant_a", second))?.accessToken).toBe("tok2");
  });

  it("does not let one workspace read another's session", async () => {
    const id = await startSignupSession("tenant_a", { accessToken: "tok1", path: "new" });
    expect(await readSignupSession("tenant_b", id)).toBeNull();
  });

  it("keeps each workspace's session alive independently", async () => {
    // Relaunching in one tenant must not invalidate another's in-flight flow.
    const a = await startSignupSession("tenant_a", { accessToken: "tokA", path: "new" });
    const b = await startSignupSession("tenant_b", { accessToken: "tokB", path: "new" });
    await startSignupSession("tenant_a", { accessToken: "tokA2", path: "business-app" });

    expect(await readSignupSession("tenant_a", a)).toBeNull();
    expect((await readSignupSession("tenant_b", b))?.accessToken).toBe("tokB");
  });

  it("returns null for a malformed session rather than throwing", async () => {
    redisStore.set(signupSessionKey("tenant_a", "sid"), "{not json");
    expect(await readSignupSession("tenant_a", "sid")).toBeNull();
  });
});

// ─── /inspect ────────────────────────────────────────────────

describe("POST /inspect", () => {
  it("never returns the business token to the browser", async () => {
    const res = await request(app())
      .post("/api/channels/whatsapp/inspect")
      .send({ code: "code_1", path: "new" });

    expect(res.status).toBe(200);
    // Belt and braces: no field named like a token, and the actual token value
    // must not appear anywhere in the serialised body.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("token-for-code_1");
    expect(body).not.toMatch(/accessToken/i);
    expect(res.body.data.sessionId).toBeTruthy();
  });

  it("writes nothing to the database", async () => {
    // Requirement: no number is mutated until inspection AND explicit
    // selection are complete. Inspection alone must be inert.
    await request(app())
      .post("/api/channels/whatsapp/inspect")
      .send({ code: "code_1", path: "new" });

    expect(state.writes).toEqual([]);
  });

  it("no longer demands a path, because v4 is one unified flow", async () => {
    // Embedded Signup v4 presents the onboarding choices inside Meta's own UI,
    // so GOTCHA stops pre-selecting a door. The parameter survives, defaulted,
    // for the Coexistence-specific flow a configuration can still enable.
    const res = await request(app())
      .post("/api/channels/whatsapp/inspect")
      .send({ code: "code_1" });
    expect(res.status).toBe(200);
    expect(res.body.data.path).toBe("new");
  });

  it("reports the outcome so the UI never shows a bare empty state", async () => {
    const res = await request(app())
      .post("/api/channels/whatsapp/inspect")
      .send({ code: "code_1", path: "new" });

    expect(res.body.data.outcome).toBeTruthy();
    expect(res.body.data.outcome.reason).toBe("NO_CANDIDATES");
    // Standard flow found nothing, so the Business app flow is the next try.
    expect(res.body.data.outcome.switchTo).toBe("business-app");
  });

  it("suggests the standard flow when the Business app flow finds nothing", async () => {
    const res = await request(app())
      .post("/api/channels/whatsapp/inspect")
      .send({ code: "code_2", path: "business-app" });

    expect(res.body.data.outcome.switchTo).toBe("new");
  });

  it("exchanges each authorization code exactly once", async () => {
    // Meta's codes are single-use. A relaunch must bring its own code; reusing
    // the first one fails at Meta and would look like a random outage.
    await request(app()).post("/api/channels/whatsapp/inspect").send({ code: "code_1", path: "new" });
    await request(app())
      .post("/api/channels/whatsapp/inspect")
      .send({ code: "code_2", path: "business-app" });

    expect(state.exchangedCodes).toEqual(["code_1", "code_2"]);
  });

  it("surfaces a reused code as a clear failure, not a crash", async () => {
    await request(app()).post("/api/channels/whatsapp/inspect").send({ code: "code_1", path: "new" });
    const again = await request(app())
      .post("/api/channels/whatsapp/inspect")
      .send({ code: "code_1", path: "business-app" });

    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/try connecting again/i);
  });

  it("issues a distinct session per relaunch and retires the old one", async () => {
    const first = await request(app())
      .post("/api/channels/whatsapp/inspect")
      .send({ code: "code_1", path: "new" });
    const second = await request(app())
      .post("/api/channels/whatsapp/inspect")
      .send({ code: "code_2", path: "business-app" });

    const a = first.body.data.sessionId;
    const b = second.body.data.sessionId;
    expect(a).not.toBe(b);
    expect(await readSignupSession("tenant_a", a)).toBeNull();
    expect((await readSignupSession("tenant_a", b))?.path).toBe("business-app");
  });
});

// ─── /connect ────────────────────────────────────────────────

describe("POST /connect", () => {
  it("refuses a session that a relaunch has retired", async () => {
    // The exact hazard of the cross-path fallback: the picker from the first
    // attempt is still on screen when the customer switches paths.
    const first = await request(app())
      .post("/api/channels/whatsapp/inspect")
      .send({ code: "code_1", path: "new" });
    const staleSession = first.body.data.sessionId;

    await request(app())
      .post("/api/channels/whatsapp/inspect")
      .send({ code: "code_2", path: "business-app" });

    const res = await request(app())
      .post("/api/channels/whatsapp/connect")
      .send({ sessionId: staleSession, phoneNumberId: "pn_1" });

    expect(res.status).toBe(410);
    expect(state.writes).toEqual([]);
  });

  it("requires a specific number, never connecting whatever it finds", async () => {
    // The original implementation looped over every number on the account.
    const res = await request(app())
      .post("/api/channels/whatsapp/connect")
      .send({ sessionId: "whatever" });

    expect(res.status).toBe(400);
    expect(state.writes).toEqual([]);
  });

  it("refuses another workspace's session id", async () => {
    const mine = await request(app())
      .post("/api/channels/whatsapp/inspect")
      .set("x-test-tenant", "tenant_a")
      .send({ code: "code_1", path: "new" });

    const res = await request(app())
      .post("/api/channels/whatsapp/connect")
      .set("x-test-tenant", "tenant_b")
      .send({ sessionId: mine.body.data.sessionId, phoneNumberId: "pn_1" });

    expect(res.status).toBe(410);
    expect(state.writes).toEqual([]);
  });
});
