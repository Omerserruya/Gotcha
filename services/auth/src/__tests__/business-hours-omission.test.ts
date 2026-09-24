/**
 * An omitted field must mean "leave it alone", not "reset it".
 *
 * `PUT /settings/business-hours` validated with zod `.default()` on three
 * optional fields and then persisted `req.body` WHOLESALE. `.default()`
 * materialises a field the request never sent, so omission was an overwrite.
 *
 * ★ THE ONE THAT MATTERS IS `aiOutsideHours` REVERTING TO "active". A merchant
 * who deliberately set "silent" got the AI answering customers while the shop was
 * closed, from a request that never mentioned the field.
 *
 * ── Who reads this setting (checked before changing the write) ──
 *
 * The SHAPE is unchanged by this fix - only which values get written - so every
 * reader is unaffected. Enumerated anyway, because that is the check that should
 * have happened before the defaults were added:
 *
 *   incoming-worker/ai-bot.service.ts:137  DECIDES WHETHER THE AI REPLIES while
 *                                          closed. The consequence lives here.
 *   ai/routes/embedded-chat.ts:149         the embedded widget, via parseBusinessHours
 *   ai/routes/shopify-live-chat.ts:59      the storefront chat
 *   ai/services/shopify-live-chat.service.ts:197
 *   auth/routes/workspace.ts:56            serves it to the settings screen
 *   auth/routes/agents.ts:563              the GET
 *   shared/lib/business-hours.ts:44        types it
 *
 * Three of those seven are customer-facing chat surfaces reached through
 * `parseBusinessHours`, and none of them were in the original brief for this fix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const store = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {},
    authenticate: (_q: any, _s: any, n: any) => n(),
    resolveTenant: (q: any, _s: any, n: any) => { q.tenantId = "t1"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    readDurableSetting: async () => store.value,
    writeDurableSetting: async (_t: string, _k: string, v: string) => { store.value = v; },
  };
});

import agentsRouter from "../routes/agents";

const app = express();
app.use(express.json());
app.use("/api", agentsRouter);

/** A complete request, which is what the only existing caller sends. */
const FULL = {
  enabled: true,
  timezone: "Asia/Jerusalem",
  autoResponse: "We are closed, back at nine.",
  aiOutsideHours: "silent",
  outsideHoursHandoffMessage: "A person will reply in the morning.",
  schedule: {
    sunday: { enabled: true, open: "09:00", close: "18:00" },
    monday: { enabled: true, open: "09:00", close: "18:00" },
    tuesday: { enabled: true, open: "09:00", close: "18:00" },
    wednesday: { enabled: true, open: "09:00", close: "18:00" },
    thursday: { enabled: true, open: "09:00", close: "18:00" },
    friday: { enabled: false },
    saturday: { enabled: false },
  },
};

/** The same request with the three optional fields left out. */
const PARTIAL = {
  enabled: FULL.enabled,
  timezone: FULL.timezone,
  schedule: FULL.schedule,
};

beforeEach(() => {
  store.value = null;
});

describe("an omitted field keeps its stored value", () => {
  it("★ does not unsilence the AI when the request never mentions aiOutsideHours", async () => {
    await request(app).put("/api/settings/business-hours").send(FULL).expect(200);
    expect(JSON.parse(store.value!).aiOutsideHours).toBe("silent");

    const res = await request(app).put("/api/settings/business-hours").send(PARTIAL);

    expect(res.status).toBe(200);
    // This is the whole defect. "active" here means the AI answers customers
    // while the shop is closed, decided by ai-bot.service.ts:137, from a request
    // that said nothing about it.
    expect(JSON.parse(store.value!).aiOutsideHours).toBe("silent");
  });

  it("keeps an away-message the request omits", async () => {
    await request(app).put("/api/settings/business-hours").send(FULL).expect(200);

    await request(app).put("/api/settings/business-hours").send(PARTIAL).expect(200);

    const stored = JSON.parse(store.value!);
    expect(stored.autoResponse).toBe("We are closed, back at nine.");
    expect(stored.outsideHoursHandoffMessage).toBe("A person will reply in the morning.");
  });

  it("still applies an EXPLICIT change to any of the three", async () => {
    await request(app).put("/api/settings/business-hours").send(FULL).expect(200);

    await request(app)
      .put("/api/settings/business-hours")
      .send({ ...PARTIAL, aiOutsideHours: "active", autoResponse: "" })
      .expect(200);

    const stored = JSON.parse(store.value!);
    // Preserving an omitted field must not block setting it deliberately -
    // including setting it back to the default, and including clearing a string.
    expect(stored.aiOutsideHours).toBe("active");
    expect(stored.autoResponse).toBe("");
    // Untouched by this request, so preserved.
    expect(stored.outsideHoursHandoffMessage).toBe("A person will reply in the morning.");
  });

  it("falls back to the documented default when nothing is stored yet", async () => {
    await request(app).put("/api/settings/business-hours").send(PARTIAL).expect(200);

    const stored = JSON.parse(store.value!);
    expect(stored.aiOutsideHours).toBe("active");
    expect(stored.autoResponse).toBe("");
  });

  it("responds with what was STORED, not with the request", async () => {
    await request(app).put("/api/settings/business-hours").send(FULL).expect(200);

    const res = await request(app).put("/api/settings/business-hours").send(PARTIAL);

    // Returning req.body would report a state the store does not hold for every
    // field the caller omitted - the response would say "active".
    expect(res.body.aiOutsideHours).toBe("silent");
    expect(res.body).toEqual(JSON.parse(store.value!));
  });

  it("preserves nothing, rather than persisting undefined, when stored settings are corrupt", async () => {
    store.value = "{not json";

    await request(app).put("/api/settings/business-hours").send(PARTIAL).expect(200);

    const stored = JSON.parse(store.value!);
    // The documented default, not `undefined` in the field that decides whether
    // the AI answers a closed shop.
    expect(stored.aiOutsideHours).toBe("active");
  });
});
