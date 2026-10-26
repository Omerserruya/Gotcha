/**
 * ★ The website widget's "talk to a person" button, through the real route
 * (2026-10-26). It had no server route: the site adapter answered it locally
 * with an empty success, so the visitor saw "handed over" and nobody knew.
 * POST /api/embedded-chat/handoff hands the conversation to the team, tells
 * them (conversation.escalated), and is refused when the merchant has not
 * turned the button on (opt-in) or the session is wrong.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  accounts: [] as any[],
  conversations: [] as any[],
  created: [] as any[],
  handovers: [] as any[],
  updates: [] as any[],
  events: [] as any[],
  emitted: [] as any[],
}));

vi.mock("express-rate-limit", () => ({ default: () => (_q: any, _r: any, n: any) => n() }));
vi.mock("../services/notifications-emit", () => ({ tryEmit: (e: any) => H.emitted.push(e) }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const match = (r: any, w: any) => Object.entries(w ?? {}).every(([k, v]: [string, any]) => r[k] === v);
  return {
    ...actual,
    withCrossTenantAccess: (fn: any) => fn(),
    readDurableSetting: async () => null,
    recordHandover: async (a: any) => { H.handovers.push(a); },
    publishEvent: async (e: any) => { H.events.push(e); },
    prisma: {
      channelAccount: { findFirst: async (a: any) => H.accounts.find((r) => match(r, a.where)) ?? null },
      conversation: {
        findUnique: async (a: any) => H.conversations.find((c) => c.id === a.where.id) ?? null,
        updateMany: async (a: any) => { H.updates.push(a); return { count: 1 }; },
      },
      message: { create: async (a: any) => { H.created.push(a.data); return { id: "m1", createdAt: new Date("2026-10-26T09:00:00Z"), ...a.data }; } },
    },
  };
});

import { normalizeWebchatConfig } from "@chatcenter/shared";
import chat from "../routes/embedded-chat";

const app = () => { const a = express(); a.use(express.json()); a.use("/api/embedded-chat", chat); return a; };
const web = (behaviour: any) => ({ id: "ca_web", tenantId: "T", channel: "WEBCHAT", credentials: normalizeWebchatConfig({ v: 2, ...(behaviour ? { behaviour } : {}) }) });
const press = (body: any = { sessionId: "conv_web", sessionToken: "sess_abc" }) => request(app()).post("/api/embedded-chat/handoff").send(body);

beforeEach(() => {
  H.created = []; H.handovers = []; H.updates = []; H.events = []; H.emitted = [];
  H.accounts = [web({ allowHumanHandoff: true })];
  H.conversations = [
    { id: "conv_web", tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: "sess_abc" },
    { id: "conv_wa", tenantId: "T", channel: "WHATSAPP", channelAccountId: "wa_1", customerExternalId: "972500000000" },
  ];
});

describe("★ POST /handoff on the website widget", () => {
  it("turned on: the conversation goes to the team, waiting, and the team is told", async () => {
    const r = await press();
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ handedOver: true });
    expect(H.handovers).toEqual([expect.objectContaining({ tenantId: "T", conversationId: "conv_web", to: "human", data: { isHandedOver: true, status: "WAITING" } })]);
    expect(H.created[0]).toEqual(expect.objectContaining({ tenantId: "T", conversationId: "conv_web", channel: "WEBCHAT", messageType: "system", metadata: { systemEvent: "visitor_requested_human" } }));
    expect(H.updates[0].where).toEqual({ id: "conv_web", tenantId: "T" });
    expect(H.events[0]).toEqual(expect.objectContaining({ event: "conversation:updated", tenantId: "T" }));
    expect(H.emitted).toEqual([expect.objectContaining({ type: "conversation.escalated", tenantId: "T", metadata: { conversationId: "conv_web" } })]);
  });
  it("never set (opt-in): refused, nothing changes, nobody is told", async () => {
    H.accounts = [web(undefined)];
    const r = await press();
    expect(r.status).toBe(403);
    expect(H.handovers).toEqual([]);
    expect(H.emitted).toEqual([]);
  });
  it("turned off: refused", async () => {
    H.accounts = [web({ allowHumanHandoff: false })];
    expect((await press()).status).toBe(403);
    expect(H.handovers).toEqual([]);
  });
  it("a wrong token, no token, or a conversation that is not a web chat: 404", async () => {
    expect((await press({ sessionId: "conv_web", sessionToken: "nope" })).status).toBe(404);
    expect((await press({ sessionId: "conv_web" })).status).toBe(404);
    expect((await press({ sessionId: "conv_wa", sessionToken: "972500000000" })).status).toBe(404);
    expect(H.handovers).toEqual([]);
  });
});
