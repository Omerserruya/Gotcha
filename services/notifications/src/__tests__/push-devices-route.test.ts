/**
 * ★ POST / DELETE /api/notifications/devices (mobile push, 2026-11-03):
 *   - behind the shared authenticate() chain, like the personal preferences
 *   - support mode is refused (support_denied:ownership), in the route and in
 *     the shared deny table authenticate() applies
 *   - a token is upserted, and re-pointed to whoever signs in on that phone
 *   - provider: given, else iOS -> apns and Android -> fcm
 *   - DELETE removes the caller's own row only, by path or by body
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { supportDenial } from "@chatcenter/shared/src/lib/support-deny";

const H = vi.hoisted(() => ({
  me: null as any,
  tenant: "T",
  authCalls: 0,
  devices: [] as any[],
}));

vi.mock("@chatcenter/shared", async () => ({
  authenticate: (req: any, res: any, n: any) => {
    H.authCalls++;
    if (!H.me) { res.status(401).json({ error: "unauthenticated" }); return; }
    req.user = H.me; n();
  },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = H.tenant; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  prisma: {
    pushDevice: {
      upsert: async (a: any) => {
        let row = H.devices.find((d) => d.token === a.where.token);
        if (row) Object.assign(row, a.update);
        else { row = { id: `d${H.devices.length + 1}`, createdAt: new Date(), ...a.create }; H.devices.push(row); }
        return { id: row.id, platform: row.platform, provider: row.provider, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt };
      },
      deleteMany: async (a: any) => {
        const before = H.devices.length;
        H.devices = H.devices.filter((d) => !(d.token === a.where.token && d.userId === a.where.userId && d.tenantId === a.where.tenantId));
        return { count: before - H.devices.length };
      },
    },
  },
}));

import router from "../routes/push-devices";
const app = express();
app.use(express.json());
app.use("/api", router);

beforeEach(() => {
  H.me = { userId: "dana", role: "AGENT" };
  H.tenant = "T";
  H.authCalls = 0;
  H.devices = [];
});

describe("★ auth", () => {
  it("goes through authenticate(); no principal, no device", async () => {
    H.me = null;
    const r = await request(app).post("/api/notifications/devices").send({ token: "abc", platform: "ios" });
    expect(r.status).toBe(401);
    expect(H.authCalls).toBe(1);
    expect(H.devices).toHaveLength(0);
  });

  it("an internal service principal is not a person with a phone", async () => {
    H.me = { userId: "svc", isInternal: true };
    const r = await request(app).post("/api/notifications/devices").send({ token: "abc", platform: "ios" });
    expect(r.status).toBe(403);
    expect(H.devices).toHaveLength(0);
  });

  it("support mode is refused, on both verbs, with the support_denied code", async () => {
    H.me = { userId: "support-actor", role: "ADMIN", support: { sessionId: "s1", adminUserId: "omer" } };
    const post = await request(app).post("/api/notifications/devices").send({ token: "abc", platform: "ios" });
    expect(post.status).toBe(403);
    expect(post.body).toEqual({ error: "Not available in support mode", code: "support_denied:ownership" });
    H.devices = [{ id: "d1", token: "abc", userId: "support-actor", tenantId: "T", platform: "ios" }];
    const del = await request(app).delete("/api/notifications/devices/abc");
    expect(del.status).toBe(403);
    expect(del.body.code).toBe("support_denied:ownership");
    expect(H.devices).toHaveLength(1);
  });

  it("the shared deny table refuses them too, before any route runs", () => {
    expect(supportDenial("POST", "/api/notifications/devices")).toBe("support_denied:ownership");
    expect(supportDenial("DELETE", "/api/notifications/devices/abc")).toBe("support_denied:ownership");
    expect(supportDenial("DELETE", "/api/notifications/devices")).toBe("support_denied:ownership");
    // Reading the bell is still fine in support mode.
    expect(supportDenial("GET", "/api/notifications")).toBeNull();
    expect(supportDenial("POST", "/api/notifications/mark-all-read")).toBeNull();
  });
});

describe("★ POST registers", () => {
  it("creates the row for the caller in their tenant", async () => {
    const r = await request(app).post("/api/notifications/devices").send({ token: " abc ", platform: "Android" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: "d1", platform: "android" });
    expect(r.body.data).not.toHaveProperty("token");
    expect(H.devices).toEqual([expect.objectContaining({ token: "abc", platform: "android", userId: "dana", tenantId: "T" })]);
  });

  it("the same token again bumps lastSeenAt, no second row", async () => {
    await request(app).post("/api/notifications/devices").send({ token: "abc", platform: "ios" });
    const first = H.devices[0].lastSeenAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await request(app).post("/api/notifications/devices").send({ token: "abc", platform: "ios" });
    expect(H.devices).toHaveLength(1);
    expect(H.devices[0].lastSeenAt.getTime()).toBeGreaterThan(first);
  });

  it("a phone that signs in as someone else (another tenant even) is re-pointed to them", async () => {
    await request(app).post("/api/notifications/devices").send({ token: "shared-phone", platform: "android" });
    H.me = { userId: "noa", role: "AGENT" };
    H.tenant = "T2";
    await request(app).post("/api/notifications/devices").send({ token: "shared-phone", platform: "android" });
    expect(H.devices).toEqual([expect.objectContaining({ token: "shared-phone", userId: "noa", tenantId: "T2" })]);
  });

  it("provider follows the platform when absent: iOS is apns, Android is fcm", async () => {
    await request(app).post("/api/notifications/devices").send({ token: "a1b2c3", platform: "ios" });
    await request(app).post("/api/notifications/devices").send({ token: "fcm-tok", platform: "android" });
    expect(H.devices.map((d) => [d.token, d.provider])).toEqual([["a1b2c3", "apns"], ["fcm-tok", "fcm"]]);
  });

  it("an explicit provider wins, and an unknown one is refused", async () => {
    const r = await request(app).post("/api/notifications/devices").send({ token: "ios-fcm", platform: "ios", provider: "FCM" });
    expect(r.status).toBe(200);
    expect(r.body.data.provider).toBe("fcm");
    expect((await request(app).post("/api/notifications/devices").send({ token: "x", platform: "ios", provider: "pushy" })).status).toBe(400);
    expect(H.devices.map((d) => d.token)).toEqual(["ios-fcm"]);
  });

  it("refuses a missing token or an unknown platform", async () => {
    expect((await request(app).post("/api/notifications/devices").send({ platform: "ios" })).status).toBe(400);
    expect((await request(app).post("/api/notifications/devices").send({ token: "abc", platform: "web" })).status).toBe(400);
    expect((await request(app).post("/api/notifications/devices").send({ token: "x".repeat(5000), platform: "ios" })).status).toBe(400);
    expect(H.devices).toHaveLength(0);
  });
});

describe("★ DELETE removes only the caller's own", () => {
  beforeEach(() => {
    H.devices = [
      { id: "d1", token: "mine", userId: "dana", tenantId: "T", platform: "ios" },
      { id: "d2", token: "theirs", userId: "noa", tenantId: "T", platform: "ios" },
    ];
  });

  it("by path", async () => {
    const r = await request(app).delete("/api/notifications/devices/mine");
    expect(r.status).toBe(204);
    expect(H.devices.map((d) => d.id)).toEqual(["d2"]);
  });

  it("by body", async () => {
    const r = await request(app).delete("/api/notifications/devices").send({ token: "mine" });
    expect(r.status).toBe(204);
    expect(H.devices.map((d) => d.id)).toEqual(["d2"]);
  });

  it("a colleague's token: nothing removed, and the answer does not say whose it was", async () => {
    const r = await request(app).delete("/api/notifications/devices/theirs");
    expect(r.status).toBe(204);
    expect(H.devices.map((d) => d.id)).toEqual(["d1", "d2"]);
  });
});
