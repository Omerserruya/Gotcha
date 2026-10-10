/**
 * ★ A voice activation or validation failure is kept on the channel and served
 * (2026-10-09). v2's channel row showed voice error null always, because a
 * failed /activate or /validate left nothing behind but a 502 the wizard
 * dropped. Now config.lastError holds "[CODE] sentence"; GET / and GET /:id
 * serve it split as { lastError, lastErrorCode }, and the next success that
 * disproves it clears it.
 *
 * The DB is an in-memory double that honours `where`; Twilio is stubbed at fetch.
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
  voiceUrlMissing: false,
}));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const withVoice = (r: any) => {
    const vc = DB.voice.find((v) => v.communicationChannelId === r.id);
    return {
      ...r,
      voiceChannel: vc ? { ...vc, phoneNumbers: DB.numbers.filter((n) => n.voiceChannelId === vc.id).map((n) => ({ ...n })) } : null,
    };
  };
  const prisma: any = {
    tenant: { findUnique: async () => ({ voiceCopilotEnabled: true }) },
    communicationChannel: {
      findMany: async (a: any) =>
        DB.channels
          .filter((c) => c.tenantId === a.where.tenantId && c.channelType === a.where.channelType)
          .map(withVoice),
      findUnique: async (a: any) => {
        const r = DB.channels.find((c) => c.id === a.where.id);
        return r ? withVoice(r) : null;
      },
      update: async (a: any) => {
        const r = DB.channels.find((c) => c.id === a.where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, a.data);
        return withVoice(r);
      },
    },
    voiceChannelPhoneNumber: {
      update: async (a: any) => {
        const r = DB.numbers.find((n) => n.id === a.where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, a.data);
        return { ...r };
      },
    },
  };
  return {
    ...actual,
    prisma,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    requireEntitlement: () => (_q: any, _s: any, n: any) => n(),
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
    getRedis: () => ({ incr: async () => 1, expire: async () => 1 }),
    resolveVoicePublicUrl: () => {
      if (DB.voiceUrlMissing) throw new actual.AppOriginError("voice_public_url_required_in_production");
      return "https://voice.example.test";
    },
    reportOperationalFailure: () => undefined,
  };
});

import { encryptCredentials } from "@chatcenter/shared";
import router from "../routes/voice-channels";
import { ERROR_CODES_KNOWN } from "../lib/error-code";

const app = express();
app.use(express.json());
app.use("/api/voice-channels", router);

const SECRETS = Buffer.from(encryptCredentials({ authToken: "tok", apiKeySecret: null }), "utf8");

function seedChannel(id: string, tenantId: string, config: Record<string, unknown> = {}) {
  DB.channels.push({
    id, tenantId, channelType: "VOICE", friendlyName: id, status: "ACTIVE", authType: "BYO",
    provider: "twilio", capabilities: {}, config, webhookSecret: null, healthCheckedAt: null,
    healthStatus: null, createdAt: new Date(), updatedAt: new Date(), encryptedSecrets: SECRETS,
  });
  DB.voice.push({ id: `vc_${id}`, communicationChannelId: id, accountSid: "AC_fake", twimlAppSid: null, apiKeySid: null, copilotConfig: {}, aiAgentId: null });
  DB.numbers.push({ id: `n_${id}`, voiceChannelId: `vc_${id}`, e164: `+97250000${DB.numbers.length}`, twilioSid: `PN_${id}`, friendlyName: null, isActive: false, createdAt: new Date(), updatedAt: new Date() });
}

const twilio = (status: number, body: any = {}) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })));
const fetchCalls = () => ((globalThis.fetch as any)?.mock?.calls ?? []).length;
const stored = (id: string) => DB.channels.find((c) => c.id === id)!.config.lastError;
const activate = (id: string) => request(app).post(`/api/voice-channels/${id}/numbers/n_${id}/activate`).send({});
const validate = (id: string) => request(app).post(`/api/voice-channels/${id}/validate`).send({});

beforeEach(() => {
  DB.channels = []; DB.voice = []; DB.numbers = []; DB.voiceUrlMissing = false;
  vi.unstubAllGlobals();
  seedChannel("ch_a", "tenant_a", { outboundProvisioningFailed: true });
  seedChannel("ch_b", "tenant_a");
});

describe("activation failure is kept and served", () => {
  it("★ Twilio 401: stored as [TWILIO_CREDENTIALS_INVALID] sentence, served split on GET /, config keeps its other keys", async () => {
    twilio(401, { code: 20003 });
    const r = await activate("ch_a");
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("twilio_update_failed");
    expect(r.body.lastErrorCode).toBe("TWILIO_CREDENTIALS_INVALID");
    expect(stored("ch_a")).toBe(`[TWILIO_CREDENTIALS_INVALID] ${ERROR_CODES_KNOWN.TWILIO_CREDENTIALS_INVALID}`);

    const list = await request(app).get("/api/voice-channels");
    const a = list.body.data.find((c: any) => c.id === "ch_a");
    expect(a.lastError).toBe(ERROR_CODES_KNOWN.TWILIO_CREDENTIALS_INVALID);
    expect(a.lastErrorCode).toBe("TWILIO_CREDENTIALS_INVALID");
    expect(a.config).toEqual({ outboundProvisioningFailed: true });
  });

  it("★ only the failing channel carries it - the other channel stays clean", async () => {
    twilio(401);
    await activate("ch_a");
    expect(stored("ch_b")).toBeUndefined();
    const list = await request(app).get("/api/voice-channels");
    const b = list.body.data.find((c: any) => c.id === "ch_b");
    expect(b).toMatchObject({ lastError: null, lastErrorCode: null });
    expect(DB.numbers.find((n) => n.id === "n_ch_a").isActive).toBe(false);
  });

  it("Twilio 403 is a credentials problem too", async () => {
    twilio(403);
    await activate("ch_a");
    expect(stored("ch_a")).toMatch(/^\[TWILIO_CREDENTIALS_INVALID\] /);
  });

  it("★ Twilio 404: TWILIO_NUMBER_NOT_FOUND", async () => {
    twilio(404);
    const r = await activate("ch_a");
    expect(r.body.lastErrorCode).toBe("TWILIO_NUMBER_NOT_FOUND");
    expect(stored("ch_a")).toBe(`[TWILIO_NUMBER_NOT_FOUND] ${ERROR_CODES_KNOWN.TWILIO_NUMBER_NOT_FOUND}`);
  });

  it("★ Twilio 500: TWILIO_WEBHOOK_UPDATE_FAILED", async () => {
    twilio(500);
    const r = await activate("ch_a");
    expect(r.body.lastErrorCode).toBe("TWILIO_WEBHOOK_UPDATE_FAILED");
    expect(stored("ch_a")).toMatch(/^\[TWILIO_WEBHOOK_UPDATE_FAILED\] /);
  });

  it("a network failure (fetch throws) is TWILIO_WEBHOOK_UPDATE_FAILED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await activate("ch_a");
    expect(stored("ch_a")).toMatch(/^\[TWILIO_WEBHOOK_UPDATE_FAILED\] /);
  });

  it("★ no VOICE_PUBLIC_URL: VOICE_PUBLIC_URL_MISSING, and Twilio is never called", async () => {
    twilio(200);
    DB.voiceUrlMissing = true;
    const r = await activate("ch_a");
    expect(r.status).toBe(502);
    expect(r.body.lastErrorCode).toBe("VOICE_PUBLIC_URL_MISSING");
    expect(stored("ch_a")).toBe(`[VOICE_PUBLIC_URL_MISSING] ${ERROR_CODES_KNOWN.VOICE_PUBLIC_URL_MISSING}`);
    expect(fetchCalls()).toBe(0);
  });

  it("★ the next successful activation clears it; GET /:id serves nulls and the number is active", async () => {
    twilio(404);
    await activate("ch_a");
    twilio(200, {});
    const r = await activate("ch_a");
    expect(r.status).toBe(200);
    expect(stored("ch_a")).toBeUndefined();
    expect(DB.channels.find((c) => c.id === "ch_a").config).toEqual({ outboundProvisioningFailed: true });
    const one = await request(app).get("/api/voice-channels/ch_a");
    expect(one.body.data).toMatchObject({ lastError: null, lastErrorCode: null });
    expect(DB.numbers.find((n) => n.id === "n_ch_a").isActive).toBe(true);
  });

  it("a success with nothing stored does not write config at all", async () => {
    twilio(200, {});
    const before = DB.channels.find((c) => c.id === "ch_a").config;
    await activate("ch_a");
    expect(DB.channels.find((c) => c.id === "ch_a").config).toBe(before);
  });
});

describe("validation failure is kept and served", () => {
  it("★ Twilio 401 on /validate: TWILIO_CREDENTIALS_INVALID stored and served", async () => {
    twilio(401);
    const r = await validate("ch_a");
    expect(r.body.ok).toBe(false);
    expect(r.body.lastErrorCode).toBe("TWILIO_CREDENTIALS_INVALID");
    const one = await request(app).get("/api/voice-channels/ch_a");
    expect(one.body.data).toMatchObject({
      lastError: ERROR_CODES_KNOWN.TWILIO_CREDENTIALS_INVALID,
      lastErrorCode: "TWILIO_CREDENTIALS_INVALID",
    });
  });

  it("Twilio 404 on the account fetch is a wrong SID: TWILIO_CREDENTIALS_INVALID", async () => {
    twilio(404);
    await validate("ch_a");
    expect(stored("ch_a")).toMatch(/^\[TWILIO_CREDENTIALS_INVALID\] /);
  });

  it("★ Twilio 503 on /validate: TWILIO_ACCOUNT_UNREACHABLE", async () => {
    twilio(503);
    await validate("ch_a");
    expect(stored("ch_a")).toBe(`[TWILIO_ACCOUNT_UNREACHABLE] ${ERROR_CODES_KNOWN.TWILIO_ACCOUNT_UNREACHABLE}`);
  });

  it("★ a successful /validate clears a credentials error", async () => {
    twilio(401);
    await validate("ch_a");
    twilio(200, {});
    const r = await validate("ch_a");
    expect(r.body).toEqual({ ok: true, checks: { accountReachable: true } });
    expect(stored("ch_a")).toBeUndefined();
  });

  it("★ a successful /validate does NOT clear an activation error it cannot disprove", async () => {
    DB.voiceUrlMissing = true;
    twilio(200, {});
    await activate("ch_a");
    await validate("ch_a");
    expect(stored("ch_a")).toMatch(/^\[VOICE_PUBLIC_URL_MISSING\] /);
  });
});
