/**
 * Saving a voice number's routing never submits anything to Meta (B1,
 * 2026-10-14). Switching to forward-to-agent + agent-first used to fire
 * voice-copilot's ensure-template, which created the missed-call template at
 * Meta by itself. The template is now a required template a person approves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ voice: null as any, fetches: [] as string[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => pass,
    requireRole: () => pass,
    requireEntitlement: () => pass,
    requireCapacity: () => pass,
    prisma: {
      tenant: { findUnique: async () => ({ voiceCopilotEnabled: true }) },
      communicationChannel: {
        findUnique: async (a: any) => (a.where.id === "ch1" ? { id: "ch1", tenantId: "T", channelType: "VOICE", voiceChannel: { ...H.voice } } : null),
      },
      voiceChannel: { update: async (a: any) => { Object.assign(H.voice, a.data); return { ...H.voice }; } },
    },
  };
});

import router from "../routes/voice-channels";
const app = express();
app.use(express.json());
app.use("/api/voice-channels", router);

beforeEach(() => {
  H.voice = { id: "vc1", inboundMode: "IN_PLATFORM", outboundMode: "IN_PLATFORM", openWorkspaceOnAgentFirst: true };
  H.fetches = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { H.fetches.push(String(url)); return { ok: true, status: 200, json: async () => ({}), text: async () => "" }; }));
});
afterEach(() => vi.unstubAllGlobals());

describe("PUT /:id/routing", () => {
  it("★ switching on forward-to-agent + agent-first saves the modes and calls nothing outside", async () => {
    const r = await request(app).put("/api/voice-channels/ch1/routing").send({ inboundMode: "FORWARD_TO_AGENT", outboundMode: "AGENT_FIRST" });
    expect(r.status).toBe(200);
    expect(H.voice).toMatchObject({ inboundMode: "FORWARD_TO_AGENT", outboundMode: "AGENT_FIRST" });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(H.fetches).toEqual([]);
  });
});
