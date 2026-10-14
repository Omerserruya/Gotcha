/**
 * The missed-call message goes out only as a template a person APPROVED (B1,
 * 2026-10-14): voice-copilot reads the approved missed_call_callback row,
 * sends it in that row's language from the number it is approved on, and
 * creates nothing at Meta. ensure-template, which used to create it there by
 * itself, is gone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ templates: [] as any[], accounts: [] as any[], messages: [] as any[], queued: [] as any[], locale: "he" }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    verifyInternalServiceKey: (k: any) => k === "ik",
    getInternalServiceKey: () => "ik",
    outgoingMessageQueue: { add: async (_n: string, data: any) => { H.queued.push(data); } },
    prisma: {
      voiceCallSession: {
        findUnique: async () => ({ id: "s1", tenantId: "T", channelId: "ch1", customerNumber: "+972500000001", conversationId: "c1", meta: {}, state: "MISSED", direction: "inbound", assignedAgentId: null }),
        update: async () => ({}),
      },
      communicationChannel: {
        findUnique: async () => ({ id: "ch1", voiceChannel: { inboundMode: "FORWARD_TO_AGENT", outboundMode: "AGENT_FIRST", defaultAgent: { id: "u1", phoneNumber: "+972500000009", name: "Noa" } } }),
      },
      messageTemplate: {
        findMany: async (a: any) => H.templates.filter((t) => t.tenantId === a.where.tenantId && t.name === a.where.name && t.status === a.where.status && t.isActive === a.where.isActive),
      },
      tenant: { findUnique: async () => ({ defaultLocale: H.locale }) },
      channelAccount: {
        findFirst: async (a: any) => H.accounts.find((x) => x.tenantId === a.where.tenantId && x.isActive && (a.where.id === undefined || x.id === a.where.id)) ?? null,
      },
      contact: { findFirst: async () => ({ displayName: "Dana" }) },
      message: { create: async (a: any) => { const m = { id: `m${H.messages.length + 1}`, ...a.data }; H.messages.push(m); return m; } },
    },
  };
});

import { createVoiceCallbackRouter, approvedMissedCallTemplate } from "../routes/voice-callback";

const app = express();
app.use(express.json());
app.use("/api/voice-copilot", createVoiceCallbackRouter({
  resolveProvider: (async () => { throw new Error("unused"); }) as any,
  resolveProviderByChannelId: async () => { throw new Error("unused"); },
  publicBaseUrl: "https://voice.example.co.il",
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
}));
const fire = () => request(app).post("/api/voice-copilot/callbacks/missed-template").set("x-internal-key", "ik").send({ sessionId: "s1" });
const tpl = (o: any) => ({ tenantId: "T", name: "missed_call_callback", status: "APPROVED", isActive: true, channel: "WHATSAPP", channelAccountId: null, language: "he", ...o });

beforeEach(() => {
  H.templates = []; H.messages = []; H.queued = []; H.locale = "he";
  H.accounts = [{ id: "wa1", tenantId: "T", channel: "WHATSAPP", isActive: true }, { id: "wa2", tenantId: "T", channel: "WHATSAPP", isActive: true }];
});

describe("POST /callbacks/missed-template", () => {
  it("★ none approved: 409 template_not_approved, no message row, nothing queued", async () => {
    H.templates = [tpl({ id: "d", status: "DRAFT" })];
    const r = await fire();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("template_not_approved");
    expect(H.messages).toEqual([]);
    expect(H.queued).toEqual([]);
  });

  it("★ the approved row decides the name, the language and the number", async () => {
    H.templates = [tpl({ id: "a", language: "he", channelAccountId: "wa2" })];
    const r = await fire();
    expect(r.status).toBe(200);
    expect(H.queued).toHaveLength(1);
    expect(H.queued[0]).toMatchObject({ templateName: "missed_call_callback", templateLanguage: "he", channelAccountId: "wa2", recipientExternalId: "+972500000009" });
    expect(H.queued[0].templateComponents[0]).toEqual({ type: "body", parameters: [{ type: "text", text: "Dana" }] });
  });
});

describe("approvedMissedCallTemplate", () => {
  it("the workspace's language first, then a number-bound one", async () => {
    H.templates = [tpl({ id: "en_bound", language: "en", channelAccountId: "wa1" }), tpl({ id: "he_unbound", language: "he" }), tpl({ id: "he_bound", language: "he", channelAccountId: "wa1" })];
    expect((await approvedMissedCallTemplate("T"))?.id).toBe("he_bound");
    H.locale = "en";
    expect((await approvedMissedCallTemplate("T"))?.id).toBe("en_bound");
  });

  it("another tenant's approved row is not this tenant's", async () => {
    H.templates = [tpl({ id: "x", tenantId: "OTHER" })];
    expect(await approvedMissedCallTemplate("T")).toBeNull();
  });
});

describe("ensure-template", () => {
  it("★ is gone: nothing in voice-copilot creates the template at Meta", async () => {
    const r = await request(app).post("/api/voice-copilot/callbacks/ensure-template").set("x-internal-key", "ik").send({ tenantId: "T" });
    expect(r.status).toBe(404);
  });
});
