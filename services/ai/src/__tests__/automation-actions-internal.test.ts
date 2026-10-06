/**
 * POST /api/internal/automation-actions/create-task through the real router:
 * the CRM path's reason comes back as a reason (never a pretend success), the
 * conversation must be the tenant's, and every attempt is audited.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const H = vi.hoisted(() => ({ convs: [{ id: "c1", tenantId: "T" }], audits: [] as any[], crm: { ok: true, outcome: "task", kind: "contact", crmContactId: "x", taskId: "t9" } as any, calls: [] as any[] }));
vi.mock("@chatcenter/shared", () => ({
  requireInternalKey: (req: any, res: any, next: any) => (req.headers["x-internal-key"] === "k" ? next() : res.status(401).json({ error: "no" })),
  writeAudit: async (e: any) => { H.audits.push(e); },
  prisma: { conversation: { findFirst: async (a: any) => H.convs.find((c) => c.id === a.where.id && c.tenantId === a.where.tenantId) ?? null } },
}));
vi.mock("../services/post-conversation-crm.service", () => ({
  createCrmTaskKindAware: async (args: any) => { H.calls.push(args); return H.crm; },
}));

import routes from "../routes/automation-actions-internal";
const app = express();
app.use(express.json());
app.use("/api/internal/automation-actions", routes);
const post = (body: any, key = "k") => request(app).post("/api/internal/automation-actions/create-task").set("X-Internal-Key", key).send(body);

beforeEach(() => { H.audits = []; H.calls = []; H.crm = { ok: true, outcome: "task", kind: "contact", crmContactId: "x", taskId: "t9" }; });

describe("create-task for an automation", () => {
  it("internal only", async () => {
    expect((await post({ tenantId: "T", conversationId: "c1", title: "Call back" }, "wrong")).status).toBe(401);
  });

  it("creates the task on the customer's CRM record, with a due time, and audits it", async () => {
    const r = await post({ tenantId: "T", conversationId: "c1", title: " Call back now ", body: "asked for a call", dueInMinutes: 15 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, taskId: "t9" });
    expect(H.calls[0]).toMatchObject({ tenantId: "T", conversationId: "c1", task: { subject: "Call back now", body: "asked for a call" } });
    expect(Date.parse(H.calls[0].task.due_at) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(H.audits[0]).toMatchObject({ action: "automation.create_task", targetId: "c1", metadata: { ok: true } });
  });

  it("★ no CRM link is a reason (422), not a success", async () => {
    H.crm = { ok: false, outcome: "skipped", kind: null, crmContactId: null, reason: "no-crm-link" };
    const r = await post({ tenantId: "T", conversationId: "c1", title: "x" });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ ok: false, reason: "no-crm-link" });
    expect(H.audits[0].metadata).toMatchObject({ ok: false, reason: "no-crm-link" });
  });

  it("another tenant's conversation is 404; a missing title is 400", async () => {
    expect((await post({ tenantId: "X", conversationId: "c1", title: "x" })).status).toBe(404);
    expect((await post({ tenantId: "T", conversationId: "c1", title: " " })).status).toBe(400);
    expect(H.calls).toEqual([]);
  });
});
