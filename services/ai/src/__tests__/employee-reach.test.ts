/**
 * ★ Where an employee answers, from the playbook (the runtime's own routing),
 * per channel the workspace has:
 *   - a channel's own entry, else the first entry (as the flow executor picks)
 *   - "always" on a single path to this employee; "sometimes" behind a branch
 *   - a route to another employee ends that branch (the conversation is theirs)
 *   - GET /:id/reachability returns it beside `reachable`
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ canvas: null as any, accounts: [] as any[] }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (_q: any, _s: any, n: any) => n();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => pass,
    requirePermissionOrRole: () => pass,
    requireEntitlement: () => pass,
    requireCapacity: () => pass,
    prisma: {
      aIAgent: { findFirst: async (a: any) => (a.where.id === "maya" && a.where.tenantId === "T" ? { id: "maya" } : null) },
      flowCanvas: { findUnique: async () => H.canvas },
      channelAccount: { findMany: async (a: any) => H.accounts.filter((x) => x.tenantId === a.where.tenantId && x.isActive === a.where.isActive) },
    },
  };
});

import { reachFrom } from "../services/employee-reach.service";
import router from "../routes/ai-agents";

const n = (id: string, type: string, data: any = {}) => ({ id, type, data });
const e = (source: string, target: string) => ({ source, target });
const app = () => { const a = express(); a.use(express.json()); a.use("/api/ai-agents", router); return a; };

beforeEach(() => {
  H.accounts = [
    { tenantId: "T", channel: "WHATSAPP", isActive: true }, { tenantId: "T", channel: "WHATSAPP", isActive: true },
    { tenantId: "T", channel: "WEBCHAT", isActive: true }, { tenantId: "T", channel: "INSTAGRAM", isActive: true },
    { tenantId: "T", channel: "VOICE", isActive: false },
  ];
  H.canvas = {
    nodes: [
      n("wa", "channel_entry", { channelType: "whatsapp" }),
      n("web", "channel_entry", { channelType: "webchat" }),
      n("hours", "condition"),
      n("toMaya", "route", { routeType: "agent", targetId: "maya" }),
      n("toDan", "route", { routeType: "agent", targetId: "dan" }),
      n("toTeam", "route", { routeType: "department", targetId: "support" }),
    ],
    // WhatsApp: straight to Maya. Web chat: hours decide Maya or the team.
    edges: [e("wa", "toMaya"), e("web", "hours"), e("hours", "toMaya"), e("hours", "toTeam")],
  };
});

describe("reachFrom", () => {
  it("always on a single path, sometimes behind a branch", () => {
    expect(reachFrom("wa", H.canvas.nodes, H.canvas.edges, "maya")).toBe("always");
    expect(reachFrom("web", H.canvas.nodes, H.canvas.edges, "maya")).toBe("sometimes");
    expect(reachFrom("wa", H.canvas.nodes, H.canvas.edges, "dan")).toBeNull();
  });

  it("a route to another employee ends that branch", () => {
    const edges = [e("wa", "toDan"), e("toDan", "toMaya")];
    expect(reachFrom("wa", H.canvas.nodes, edges, "maya")).toBeNull();
    expect(reachFrom("wa", H.canvas.nodes, edges, "dan")).toBe("always");
  });

  it("behind a branch too: past another employee's route is not this one's", () => {
    const edges = [e("wa", "hours"), e("hours", "toDan"), e("toDan", "toMaya"), e("hours", "toTeam")];
    expect(reachFrom("wa", H.canvas.nodes, edges, "maya")).toBeNull();
    expect(reachFrom("wa", H.canvas.nodes, edges, "dan")).toBe("sometimes");
  });
});

describe("★ GET /:id/reachability says where", () => {
  it("per active channel of the workspace; a channel with no entry of its own uses the first entry", async () => {
    const r = await request(app()).get("/api/ai-agents/maya/reachability");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ hasCanvas: true, reachable: true });
    // Instagram has no entry: the first one (WhatsApp's) takes it, so Maya always answers there too.
    // (Each channel also lists its accounts since A7; pinned in its own case.)
    expect(r.body.data.channels.map(({ channel, reach }: any) => ({ channel, reach }))).toEqual([
      { channel: "INSTAGRAM", reach: "always" },
      { channel: "WEBCHAT", reach: "sometimes" },
      { channel: "WHATSAPP", reach: "always" },
    ]);
  });

  it("★ a playbook with only a start node (no channel entries) routes every channel from it", async () => {
    H.canvas = { nodes: [n("s", "start"), n("toMaya", "route_target", { routeType: "agent", targetId: "maya" })], edges: [e("s", "toMaya")] };
    expect((await request(app()).get("/api/ai-agents/maya/reachability")).body.data.channels.map(({ channel, reach }: any) => ({ channel, reach }))).toEqual([
      { channel: "INSTAGRAM", reach: "always" }, { channel: "WEBCHAT", reach: "always" }, { channel: "WHATSAPP", reach: "always" },
    ]);
  });

  it("★ A7: each reached channel names its accounts (WhatsApp with its number)", async () => {
    H.accounts = [
      { id: "wa1", tenantId: "T", channel: "WHATSAPP", isActive: true, displayName: "Urban Supply", platformMeta: { displayPhoneNumber: "+972 54-111-1111" } },
      { id: "wa2", tenantId: "T", channel: "WHATSAPP", isActive: true, displayName: null, platformMeta: { verifiedName: "Urban Outlet", displayPhoneNumber: "+972 54-222-2222" } },
      { id: "ig1", tenantId: "T", channel: "INSTAGRAM", isActive: true, displayName: "@urbansupply", platformMeta: {} },
      { id: "off", tenantId: "T", channel: "WHATSAPP", isActive: false, displayName: "Old" },
    ];
    const by = Object.fromEntries((await request(app()).get("/api/ai-agents/maya/reachability")).body.data.channels.map((c: any) => [c.channel, c.accounts]));
    expect(by.WHATSAPP).toEqual([
      { channelAccountId: "wa1", displayName: "Urban Supply", detail: "+972 54-111-1111" },
      { channelAccountId: "wa2", displayName: "Urban Outlet", detail: "+972 54-222-2222" },
    ]);
    expect(by.INSTAGRAM).toEqual([{ channelAccountId: "ig1", displayName: "@urbansupply", detail: null }]);
  });

  it("no playbook: nowhere", async () => {
    H.canvas = null;
    expect((await request(app()).get("/api/ai-agents/maya/reachability")).body.data).toEqual({ hasCanvas: false, reachable: false, channels: [] });
  });
});
