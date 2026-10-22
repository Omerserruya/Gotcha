/** GET /api/conversations/:id carries replyWindow (B7, 2026-10-12): what may be sent now. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ windows: new Map<string, any>(), calls: [] as any[], fail: false }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "AGENT" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    replyWindowsFor: vi.fn(async (tenantId: string, ids: string[]) => {
      H.calls.push({ tenantId, ids });
      if (H.fail) throw new Error("db down");
      return new Map(ids.filter((id) => H.windows.has(id)).map((id) => [id, H.windows.get(id)]));
    }),
  };
});
vi.mock("../lib/require-visible-conversation", () => ({ requireVisibleConversation: (_q: any, _s: any, n: any) => n() }));
vi.mock("../services/conversation.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, getById: vi.fn(async (_t: string, id: string) => (id === "c1" ? { id: "c1", channel: "INSTAGRAM" } : null)) };
});

import router from "../routes/conversations";
const app = express();
app.use(express.json());
app.use("/conversations", router);

beforeEach(() => {
  H.calls = []; H.fail = false;
  H.windows = new Map([["c1", { channel: "INSTAGRAM", open: false, closesAt: null, mode: "closed" }]]);
});

describe("detail replyWindow", () => {
  it("is the conversation's window, read under the tenant", async () => {
    const r = await request(app).get("/conversations/c1");
    expect(r.status).toBe(200);
    expect(r.body.data.replyWindow).toEqual({ channel: "INSTAGRAM", open: false, closesAt: null, mode: "closed" });
    expect(H.calls).toEqual([{ tenantId: "t1", ids: ["c1"] }]);
  });
  it("null when it cannot be read; the conversation still loads", async () => {
    H.fail = true;
    const r = await request(app).get("/conversations/c1");
    expect(r.status).toBe(200);
    expect(r.body.data.replyWindow).toBeNull();
  });
});
