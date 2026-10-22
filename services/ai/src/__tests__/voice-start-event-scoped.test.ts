/**
 * voice.session.starting carries the customer's phone, name and the agent's
 * notes. It goes to that conversation's room, not to every tab in the tenant.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ events: [] as any[] }));

vi.mock("@chatcenter/shared", () => ({
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "agent1" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  verifyInternalServiceKey: () => false,
  publishEvent: async (e: any) => { H.events.push(e); },
  prisma: {
    conversation: {
      findFirst: async () => ({ id: "conv1" }),
      update: async () => ({}),
      create: async () => ({}),
    },
  },
}));
vi.mock("../services/voice-assist.service", () => ({ handleVoiceStream: vi.fn() }));

import voiceRouter from "../routes/ai-assist-voice";

const app = express();
app.use(express.json());
app.use("/api/ai-assist/voice", voiceRouter);

describe("voice.session.starting", () => {
  it("★ is published to conv:{id}, so the bridge does not send the customer's phone tenant-wide", async () => {
    const r = await request(app).post("/api/ai-assist/voice/start")
      .send({ type: "voice_start", conversationId: "conv1", context: { phone: "+972501234567", contactName: "Dana", notes: "VIP" } });
    expect(r.status).toBe(202);
    const e = H.events.find((x) => x.event === "voice.session.starting");
    expect(e.data.channel).toBe("conv:conv1");
  });
});
