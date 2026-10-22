/**
 * The /join page learns WHY an invite cannot be used (2026-10-21): used,
 * expired, or invalid - through the real public routes. An unknown token is
 * always "invalid", whatever exists elsewhere.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ invite: null as any }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: { tenantInvite: { findUnique: vi.fn(async () => H.invite) } },
  };
});

import { publicInviteRouter, inviteRejection } from "../routes/onboarding";

const app = express();
app.use(express.json());
app.use("/api/public/onboarding", publicInviteRouter);

const future = new Date(Date.now() + 86_400_000);
const past = new Date(Date.now() - 86_400_000);

beforeEach(() => { H.invite = null; });

describe("★ GET /invite/:token says why it cannot be used", () => {
  it("unknown token: 404 reason invalid", async () => {
    const r = await request(app).get("/api/public/onboarding/invite/nope");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "invite_invalid_or_expired", reason: "invalid" });
  });
  it("accepted: reason used", async () => {
    H.invite = { acceptedAt: new Date(), expiresAt: future, tenant: { name: "A", slug: "a" } };
    expect((await request(app).get("/api/public/onboarding/invite/t1")).body.reason).toBe("used");
  });
  it("expired: reason expired", async () => {
    H.invite = { acceptedAt: null, expiresAt: past, tenant: { name: "A", slug: "a" } };
    expect((await request(app).get("/api/public/onboarding/invite/t1")).body.reason).toBe("expired");
  });
  it("valid: 200 with the workspace, no reason", async () => {
    H.invite = { acceptedAt: null, expiresAt: future, email: null, role: "AGENT", tenant: { name: "A", slug: "a" } };
    const r = await request(app).get("/api/public/onboarding/invite/t1");
    expect(r.status).toBe(200);
    expect(r.body.reason).toBeUndefined();
  });
});

describe("POST /invite/accept carries the same reason", () => {
  it("used invite: 404 reason used, nothing created", async () => {
    H.invite = { acceptedAt: new Date(), expiresAt: future };
    const r = await request(app).post("/api/public/onboarding/invite/accept").send({ token: "t1", name: "Dana" });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "invite_invalid_or_expired", reason: "used" });
  });
});

describe("inviteRejection", () => {
  it("used wins over expired (an accepted invite stays 'used' after it would have expired)", () => {
    expect(inviteRejection({ acceptedAt: new Date(), expiresAt: past })).toBe("used");
    expect(inviteRejection(null)).toBe("invalid");
    expect(inviteRejection({ acceptedAt: null, expiresAt: future })).toBeNull();
  });
});
