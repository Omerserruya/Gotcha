/**
 * POST /api/voice-channels with wrong Twilio credentials writes NOTHING.
 *
 * Discovery (IncomingPhoneNumbers) is the credential check. It ran AFTER the
 * channel rows were created, so every failed attempt left a channel in ERROR
 * and its id in the 502 body. Now the check comes first.
 *
 * The DB is an in-memory double that counts rows; Twilio is stubbed at fetch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});

const DB = vi.hoisted(() => ({
  channels: [] as any[],
  voice: [] as any[],
  numbers: [] as any[],
  failNumberUpsert: false,
}));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const prisma: any = {
    tenant: { findUnique: async () => ({ voiceCopilotEnabled: true }) },
    communicationChannel: {
      count: async () => DB.channels.length,
      create: async (a: any) => { const r = { id: `ch_${DB.channels.length + 1}`, ...a.data }; DB.channels.push(r); return r; },
      update: async (a: any) => { const r = DB.channels.find((c) => c.id === a.where.id); Object.assign(r, a.data); return r; },
      findUnique: async (a: any) => {
        const r = DB.channels.find((c) => c.id === a.where.id);
        return r ? { ...r, voiceChannel: { ...DB.voice.find((v) => v.communicationChannelId === r.id), phoneNumbers: [] } } : null;
      },
      delete: async (a: any) => {
        DB.channels = DB.channels.filter((c) => c.id !== a.where.id);
        DB.voice = DB.voice.filter((v) => v.communicationChannelId !== a.where.id);
        return {};
      },
    },
    voiceChannel: {
      create: async (a: any) => { const r = { id: `vc_${DB.voice.length + 1}`, ...a.data }; DB.voice.push(r); return r; },
      update: async () => ({}),
    },
    voiceChannelPhoneNumber: {
      upsert: async (a: any) => { if (DB.failNumberUpsert) throw new Error("db down"); DB.numbers.push(a.create); return a.create; },
      updateMany: async () => ({ count: 0 }),
      findMany: async () => [],
    },
  };
  prisma.$transaction = async (fn: any) => fn(prisma);
  return {
    ...actual,
    prisma,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    requireEntitlement: () => (_q: any, _s: any, n: any) => n(),
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
    getRedis: () => ({ get: async () => null, set: async () => "OK", del: async () => 0 }),
    resolveVoicePublicUrl: () => "https://voice.example.test",
    reportOperationalFailure: () => undefined,
  };
});

import router from "../routes/voice-channels";

const app = express();
app.use(express.json());
app.use("/api/voice-channels", router);

const BODY = { friendlyName: "Main line", accountSid: "AC_fake", authToken: "wrong" };
const twilio = (status: number, body: any = {}) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })));
const counts = () => ({ channels: DB.channels.length, voice: DB.voice.length });

beforeEach(() => {
  DB.channels = []; DB.voice = []; DB.numbers = []; DB.failNumberUpsert = false;
  vi.unstubAllGlobals();
});

describe("wrong Twilio credentials", () => {
  it("★ 502 twilio_discovery_failed, no channelId, and 0 rows", async () => {
    twilio(401, { code: 20003, message: "Authenticate" });
    const r = await request(app).post("/api/voice-channels").send(BODY);
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("twilio_discovery_failed");
    expect(r.body).not.toHaveProperty("channelId");
    expect(counts()).toEqual({ channels: 0, voice: 0 });
  });

  it("★ an existing channel is untouched by a failed attempt", async () => {
    DB.channels.push({ id: "ch_old", tenantId: "tenant_a", status: "ACTIVE", channelType: "VOICE" });
    twilio(401);
    await request(app).post("/api/voice-channels").send(BODY);
    expect(DB.channels).toEqual([{ id: "ch_old", tenantId: "tenant_a", status: "ACTIVE", channelType: "VOICE" }]);
  });

  it("nothing is provisioned on Twilio after a failed check - only the one discovery call", async () => {
    twilio(401);
    await request(app).post("/api/voice-channels").send(BODY);
    const calls = (globalThis.fetch as any).mock.calls.map((c: any) => String(c[0]));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/IncomingPhoneNumbers.json");
  });
});

describe("right credentials", () => {
  it("creates the channel ACTIVE with its numbers", async () => {
    twilio(200, { incoming_phone_numbers: [{ sid: "PN1", phone_number: "+972500000001" }] });
    const r = await request(app).post("/api/voice-channels").send(BODY);
    expect(r.status).toBe(201);
    expect(counts()).toEqual({ channels: 1, voice: 1 });
    expect(DB.channels[0].status).toBe("ACTIVE");
  });

  it("our own failure saving the numbers removes the half-made channel", async () => {
    twilio(200, { incoming_phone_numbers: [{ sid: "PN1", phone_number: "+972500000001" }] });
    DB.failNumberUpsert = true;
    const r = await request(app).post("/api/voice-channels").send(BODY);
    expect(r.status).toBe(500);
    expect(counts()).toEqual({ channels: 0, voice: 0 });
  });
});
