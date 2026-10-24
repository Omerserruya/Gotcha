/**
 * ★ Who answers the website widget (2026-10-22: AUTOMATIONS decide). Through
 * the real routes.
 *   - read: a workspace with "New conversation" automations is answered by
 *     them (the channel's own first, else one for every channel); one with
 *     none yet still reads the playbook canvas (not migrated)
 *   - ★ a write creates or updates the widget channel's OWN automation
 *     (trigger -> hand to AI), never another channel's, never the canvas
 *   - ★ the channel's own automation with conditions is refused, nothing written
 *   - an active employee only; a widget must exist; every write audited
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  canvas: null as any, accounts: [] as any[], agents: [] as any[], audits: [] as any[],
  canvasWrites: 0, flows: [] as any[], flowWrites: 0, role: "ADMIN",
}));

const order = (rows: any[], orderBy: any) => {
  const key = orderBy && Object.keys(orderBy)[0];
  return key ? [...rows].sort((a, b) => +new Date(a[key] ?? 0) - +new Date(b[key] ?? 0)) : rows;
};

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: H.role }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    auditUser: async (...a: any[]) => { H.audits.push(a); },
    prisma: {
      flowCanvas: {
        findUnique: async () => H.canvas,
        update: async () => { H.canvasWrites++; },
        upsert: async () => { H.canvasWrites++; },
      },
      chatbotFlow: {
        findMany: async (a: any) => order(H.flows.filter((f) =>
          f.tenantId === a.where.tenantId
          && (a.where.isActive === undefined || f.isActive === a.where.isActive)
          && (a.where.triggerType === undefined || f.triggerType === a.where.triggerType)), a.orderBy),
        create: async (a: any) => { H.flowWrites++; const f = { id: `f${H.flows.length + 1}`, createdAt: new Date(), ...a.data }; H.flows.push(f); return f; },
        updateMany: async (a: any) => {
          H.flowWrites++;
          const f = H.flows.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId);
          if (f) Object.assign(f, a.data);
          return { count: f ? 1 : 0 };
        },
      },
      channelAccount: {
        findMany: async (a: any) => H.accounts.filter((x) => (a.where.isActive ? x.isActive : true) && (a.where.channel?.in ? a.where.channel.in.includes(x.channel) : true)),
      },
      aIAgent: { findMany: async () => H.agents },
    },
  };
});

import router from "../routes/website-widget";

const app = express();
app.use(express.json());
app.use("/api/website-widget", router);

const route = (id: string, targetId: string | null, routeType = "agent") => ({ id, type: "route_target", data: { routeType, targetId }, position: { x: 750, y: 100 } });
const edge = (s: string, t: string) => ({ id: `e-${s}-${t}`, source: s, target: t });
const get = () => request(app).get("/api/website-widget/assignment");
const put = (body: any) => request(app).put("/api/website-widget/assignment").send(body);
const webchat = (body: any) => body.channels.find((c: any) => c.channel === "WEBCHAT");

/** A routing automation: trigger -> hand to AI (or anything given). */
const routing = (id: string, channels: string[], aiAgentId: string, extra: Partial<any> = {}) => ({
  id, tenantId: "T", triggerType: "conversation_started", triggerConfig: channels.length ? { channels } : {},
  isActive: true, activatedAt: new Date(2026, 0, 1), createdAt: new Date(2026, 0, 1),
  nodes: [{ id: "trigger", type: "automation_trigger", data: {} }, { id: "h", type: "hand_to_ai", data: { aiAgentId } }],
  edges: [edge("trigger", "h")],
  ...extra,
});

beforeEach(() => {
  H.role = "ADMIN"; H.audits = []; H.canvasWrites = 0; H.flowWrites = 0; H.flows = [];
  H.accounts = [
    { id: "wc1", channel: "WEBCHAT", isActive: true, createdAt: 1 },
    { id: "wa1", channel: "WHATSAPP", isActive: true, createdAt: 1 },
  ];
  H.agents = [{ id: "maya", name: "Maya", status: "ACTIVE" }, { id: "noa", name: "Noa", status: "ACTIVE" }, { id: "draft", name: "Draft", status: "DRAFT" }];
  // Not migrated yet: one start for every channel -> Maya.
  H.canvas = { id: "fc", nodes: [{ id: "s", type: "start", data: {} }, route("r", "maya")], edges: [edge("s", "r")] };
});

describe("read", () => {
  it("no routing automation yet: the playbook canvas still answers (not migrated)", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(webchat(r.body.data ?? r.body)).toMatchObject({ employee: { id: "maya", name: "Maya" }, how: "always" });
  });

  it("★ with automations: the channel's own automation decides, and the canvas is ignored", async () => {
    H.flows = [routing("all", [], "maya"), routing("wc", ["WEBCHAT"], "noa", { activatedAt: new Date(2026, 5, 1) })];
    const c = webchat((await get()).body.data ?? (await get()).body);
    expect(c).toMatchObject({ employee: { id: "noa" }, how: "always", dedicated: true, sharedWith: [], editable: true });
  });

  it("a channel answered by an every-channel automation says which others share it", async () => {
    H.flows = [routing("all", [], "maya")];
    const c = webchat((await get()).body.data ?? (await get()).body);
    expect(c).toMatchObject({ employee: { id: "maya" }, dedicated: false, sharedWith: ["WHATSAPP"], editable: true });
  });
});

describe("★ a write is the widget channel's OWN automation", () => {
  it("creates one (trigger -> hand to AI, active), leaves the canvas and WhatsApp alone", async () => {
    const r = await put({ employeeId: "noa" });
    expect(r.status).toBe(200);
    expect(H.canvasWrites).toBe(0);
    expect(H.flows).toHaveLength(1);
    const f = H.flows[0];
    expect(f).toMatchObject({ triggerType: "conversation_started", triggerConfig: { channels: ["WEBCHAT"] }, isActive: true, activatedBy: "u1" });
    expect(f.nodes.map((n: any) => n.type)).toEqual(["automation_trigger", "hand_to_ai"]);
    expect(f.nodes[1].data.aiAgentId).toBe("noa");
    expect(webchat(r.body.data ?? r.body)).toMatchObject({ employee: { id: "noa" }, dedicated: true });
    expect((r.body.data ?? r.body).changed).toEqual([{ channel: "WEBCHAT", from: { id: "maya", name: "Maya" }, created: true }]);
  });

  it("a second write changes that automation's employee: no duplicate", async () => {
    await put({ employeeId: "noa" });
    await put({ employeeId: "maya" });
    expect(H.flows).toHaveLength(1);
    expect(H.flows[0].nodes[1].data.aiAgentId).toBe("maya");
  });

  it("a paused own automation is switched back on", async () => {
    H.flows = [routing("wc", ["WEBCHAT"], "maya", { isActive: false, activatedAt: null })];
    await put({ employeeId: "noa" });
    expect(H.flows[0]).toMatchObject({ isActive: true, activatedBy: "u1" });
    expect(H.flows[0].nodes[1].data.aiAgentId).toBe("noa");
  });

  it("an every-channel automation is never edited: the widget gets its own beside it", async () => {
    H.flows = [routing("all", [], "maya")];
    await put({ employeeId: "noa" });
    expect(H.flows.find((f) => f.id === "all")!.nodes[1].data.aiAgentId).toBe("maya");
    expect(H.flows).toHaveLength(2);
  });

  it("★ the channel's own automation with conditions: 409 PLAYBOOK_CONDITIONAL, nothing written", async () => {
    H.flows = [routing("wc", ["WEBCHAT"], "maya", {
      nodes: [{ id: "trigger", type: "automation_trigger", data: {} }, { id: "oh", type: "opening_hours", data: {} }, { id: "h", type: "hand_to_ai", data: { aiAgentId: "maya" } }],
      edges: [edge("trigger", "oh"), edge("oh", "h")],
    })];
    const r = await put({ employeeId: "noa" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "PLAYBOOK_CONDITIONAL", channels: ["WEBCHAT"] });
    expect(H.flowWrites).toBe(0);
  });

  it("every write is audited", async () => {
    await put({ employeeId: "noa" });
    expect(H.audits.at(-1)?.[2]).toBe("automation.route_updated");
  });
});

describe("refused", () => {
  it("an employee that is not active, or not this workspace's", async () => {
    expect((await put({ employeeId: "draft" })).status).toBe(422);
    expect((await put({ employeeId: "elsewhere" })).status).toBe(422);
    expect(H.flowWrites).toBe(0);
  });

  it("no widget yet", async () => {
    H.accounts = H.accounts.filter((a) => a.channel !== "WEBCHAT");
    expect((await put({ employeeId: "noa" })).status).toBe(409);
  });
});
