/**
 * The setup screen learns whether "Sign in with Google" exists (2026-11-22).
 *
 * The page that opens from an invitation is already inside Authentik's recovery
 * flow, and Authentik keeps one flow per browser session: starting a sign-in
 * flow to list the sources would end the recovery one. So the state the page
 * already asks for carries one more fact, `google`.
 *
 * It says only that the feature is switched on (the source slug is set). It is
 * the same for every link, a dead one too, so it tells a stranger with a made
 * up token nothing about any person.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  resolution: null as any,
  usedAt: null as Date | null,
}));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    resolveAppPublicUrl: () => "https://app.example.test",
    writeAudit: async () => {},
    withCrossTenantAccess: async (fn: any) => fn(),
    prisma: {
      tenant: { findUnique: async () => ({ name: "Acme" }) },
      setupLink: { findUnique: async () => ({ usedAt: H.usedAt, expiresAt: new Date("2026-11-24T10:00:00.000Z") }) },
    },
  };
});
vi.mock("../services/setup-link.service", () => ({
  flowOfRecoveryUrl: () => "gotcha-recovery",
  resolveSetupLink: async () => H.resolution,
  identityForSetup: async () => ({ status: "ready", pk: 7 }),
  markSetupLinkUsed: async () => {},
  ownerOfSetupToken: async () => null,
}));
vi.mock("../services/notification.service", () => ({ sendSetupLinkEmail: vi.fn() }));

import router from "../routes/setup-link";

const app = express();
app.use(express.json());
app.use("/api/auth/setup", router);

const LIVE = { ok: true, link: { id: "sl1", userId: "u1", tenantId: "t1", email: "dana@acme.com", name: "Dana", authentikSubject: "sub-1" } };
const state = async () => (await request(app).get(`/api/auth/setup/${"t".repeat(32)}/state`)).body.data;

beforeEach(() => {
  H.resolution = LIVE;
  H.usedAt = null;
  process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG = "google";
});

describe("GET /api/auth/setup/:token/state carries `google`", () => {
  it("a live link, feature on: true, beside everything it answered before", async () => {
    expect(await state()).toEqual({
      state: "valid", email: "dana@acme.com", name: "Dana", workspace: "Acme", expiresAt: "2026-11-24T10:00:00.000Z", google: true,
    });
  });

  it("a link already used, feature on: true", async () => {
    H.usedAt = new Date("2026-11-22T09:00:00.000Z");
    expect(await state()).toMatchObject({ state: "used", google: true });
  });

  it.each([["invalid"], ["expired"], ["revoked"]])("a dead link (%s), feature on: true, and still nothing about a person", async (reason) => {
    H.resolution = { ok: false, reason };
    expect(await state()).toEqual({ state: reason, email: null, name: null, workspace: null, expiresAt: null, google: true });
  });

  it.each([[undefined], [""], ["   "]])("feature off (slug %j): false on a live link", async (slug) => {
    if (slug === undefined) delete process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG; else process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG = slug;
    expect(await state()).toMatchObject({ state: "valid", google: false });
  });

  it("feature off: false on a dead link and on a used one", async () => {
    delete process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG;
    H.usedAt = new Date("2026-11-22T09:00:00.000Z");
    expect((await state()).google).toBe(false);
    H.resolution = { ok: false, reason: "expired" };
    expect((await state()).google).toBe(false);
  });

  it("it is always a boolean, never the slug itself", async () => {
    process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG = "google-workspace";
    expect((await state()).google).toBe(true);
    H.resolution = { ok: false, reason: "invalid" };
    expect(JSON.stringify(await state())).not.toContain("google-workspace");
  });

  it("the same for a live link and a dead one: it says nothing about the token", async () => {
    const live = (await state()).google;
    H.resolution = { ok: false, reason: "invalid" };
    expect((await state()).google).toBe(live);
  });
});
