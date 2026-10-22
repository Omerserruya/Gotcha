/**
 * ★ Who answers the website widget, written to THE PLAYBOOK (one source;
 * docs/api/website-widget-v1.md §4). Through the real routes.
 *   - read: per widget channel, the employee its path reaches, how
 *     (always / conditional / team / flow / none), and the other channels
 *     that reach the same route
 *   - ★ a route shared with other channels is never changed silently
 *     (409 PLAYBOOK_SHARED; includeShared changes it for all of them)
 *   - ★ a playbook with channel entries gets a dedicated web chat entry
 *     APPENDED: WhatsApp keeps its employee (the playbook's rule is "own
 *     entry, else the FIRST entry, else start")
 *   - a conditional channel is refused with nothing written
 *   - role ADMIN (like the playbook editor); an active employee only
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ canvas: null as any, accounts: [] as any[], agents: [] as any[], audits: [] as any[], writes: 0, role: "ADMIN" }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: H.role }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    auditUser: async (...a: any[]) => { H.audits.push(a); },
    prisma: {
      flowCanvas: {
        findUnique: async () => H.canvas,
        update: async (a: any) => { H.writes++; Object.assign(H.canvas, a.data); return H.canvas; },
        upsert: async (a: any) => { H.writes++; H.canvas = { id: "fc", ...a.create }; return H.canvas; },
      },
      channelAccount: {
        findMany: async (a: any) => H.accounts.filter((x) => (a.where.isActive ? x.isActive : true) && (a.where.channel?.in ? a.where.channel.in.includes(x.channel) : true)),
      },
      aIAgent: { findMany: async () => H.agents },
    },
  };
});

import router from "../routes/website-widget";
import { pathFor } from "../services/widget-assignment.service";
import { entryFor } from "../services/employee-reach.service";

const app = express();
app.use(express.json());
app.use("/api/website-widget", router);

const route = (id: string, targetId: string | null, routeType = "agent") => ({ id, type: "route_target", data: { routeType, targetId }, position: { x: 750, y: 100 } });
const entry = (id: string, channelType: string) => ({ id, type: "channel_entry", data: { channelType }, position: { x: 400, y: 100 } });
const edge = (s: string, t: string) => ({ id: `e-${s}-${t}`, source: s, target: t });
const get = () => request(app).get("/api/website-widget/assignment");
const put = (body: any) => request(app).put("/api/website-widget/assignment").send(body);

beforeEach(() => {
  H.role = "ADMIN"; H.audits = []; H.writes = 0;
  H.accounts = [
    { id: "wc1", channel: "WEBCHAT", isActive: true, createdAt: 1 },
    { id: "wa1", channel: "WHATSAPP", isActive: true, createdAt: 1 },
  ];
  H.agents = [{ id: "maya", name: "Maya", status: "ACTIVE" }, { id: "noa", name: "Noa", status: "ACTIVE" }, { id: "draft", name: "Draft", status: "DRAFT" }];
  // dev's shape: one start for every channel → Maya
  H.canvas = { id: "fc", nodes: [{ id: "s", type: "start", data: {} }, route("r", "maya")], edges: [edge("s", "r")] };
});

describe("★ read", () => {
  it("who answers, how, and which other channels share the route", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.data.channels).toEqual([{ channel: "WEBCHAT", employee: { id: "maya", name: "Maya" }, how: "always", editable: true, dedicated: false, sharedWith: ["WHATSAPP"], movesWith: ["WHATSAPP"] }]);
    expect(r.body.data.employees).toEqual([{ id: "maya", name: "Maya", active: true }, { id: "noa", name: "Noa", active: true }, { id: "draft", name: "Draft", active: false }]);
  });

  it("role ADMIN, like the playbook editor", async () => {
    H.role = "AGENT";
    expect((await get()).status).toBe(403);
    expect((await put({ employeeId: "noa" })).status).toBe(403);
  });
});

describe("★ a shared route is never changed silently", () => {
  it("409 PLAYBOOK_SHARED with the channels it would change, nothing written", async () => {
    const r = await put({ employeeId: "noa" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "PLAYBOOK_SHARED", channels: ["WEBCHAT"], sharedWith: ["WHATSAPP"] });
    expect(H.writes).toBe(0);
  });

  it("includeShared: the route changes, for WhatsApp too, and says so", async () => {
    const r = await put({ employeeId: "noa", includeShared: true });
    expect(r.status).toBe(200);
    expect(H.canvas.nodes.find((n: any) => n.id === "r").data).toEqual({ routeType: "agent", targetId: "noa" });
    expect(r.body.data.changed).toEqual([
      { channel: "WEBCHAT", from: { id: "maya", name: "Maya" }, created: false },
      { channel: "WHATSAPP", from: { id: "maya", name: "Maya" }, created: false },
    ]);
    expect(H.audits[0]).toEqual(["T", "u1", "playbook.route_updated", { type: "flow_canvas", id: "fc" }, expect.objectContaining({ employeeId: "noa", channels: ["WEBCHAT", "WHATSAPP"] })]);
    expect(H.canvas.updatedBy).toBe("u1");
  });
});

describe("★ a playbook with channel entries", () => {
  beforeEach(() => {
    H.canvas = { id: "fc", nodes: [entry("ew", "whatsapp"), route("rw", "maya")], edges: [edge("ew", "rw")] };
  });

  it("web chat (falling back to WhatsApp's entry) gets its own entry, APPENDED; WhatsApp keeps Maya", async () => {
    // The read says so before any write: shared, but nothing else would move.
    expect((await get()).body.data.channels[0]).toMatchObject({ sharedWith: ["WHATSAPP"], movesWith: [] });
    const r = await put({ employeeId: "noa" });
    expect(r.status).toBe(200);
    expect(r.body.data.changed).toEqual([{ channel: "WEBCHAT", from: { id: "maya", name: "Maya" }, created: true }]);
    const { nodes, edges } = H.canvas;
    // The playbook's fallback (the FIRST entry) is still WhatsApp's.
    expect(nodes.find((n: any) => n.type === "channel_entry").id).toBe("ew");
    expect(entryFor(nodes, "WEBCHAT")).toMatchObject({ type: "channel_entry", data: { channelType: "webchat", channelId: "wc1" } });
    expect(pathFor(nodes, edges, "WEBCHAT")).toMatchObject({ how: "always", employeeId: "noa", dedicated: true });
    expect(pathFor(nodes, edges, "WHATSAPP")).toMatchObject({ how: "always", employeeId: "maya" });
  });

  it("a dedicated web chat entry: only its route changes; a team route becomes an employee route", async () => {
    H.canvas.nodes.push(entry("ec", "webchat"), route("rc", null, "human"));
    H.canvas.edges.push(edge("ec", "rc"));
    expect((await get()).body.data.channels[0]).toMatchObject({ how: "team", employee: null, dedicated: true, sharedWith: [], movesWith: [] });
    const r = await put({ employeeId: "noa" });
    expect(r.status).toBe(200);
    expect(H.canvas.nodes.find((n: any) => n.id === "rc").data).toEqual({ routeType: "agent", targetId: "noa" });
    expect(H.canvas.nodes.find((n: any) => n.id === "rw").data.targetId).toBe("maya");
  });

  it("★ conditions decide it: 409 PLAYBOOK_CONDITIONAL, nothing written", async () => {
    H.canvas.nodes.push(entry("ec", "webchat"), { id: "hours", type: "opening_hours", data: {} }, route("r1", "maya"), route("r2", "noa"));
    H.canvas.edges.push(edge("ec", "hours"), edge("hours", "r1"), edge("hours", "r2"));
    expect((await get()).body.data.channels[0]).toMatchObject({ how: "conditional", editable: false, employee: null });
    const r = await put({ employeeId: "noa" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "PLAYBOOK_CONDITIONAL", channels: ["WEBCHAT"] });
    expect(H.writes).toBe(0);
  });

  it("an entry follows its first edge (as the walker does): not a condition", async () => {
    H.canvas.nodes.push(entry("ec", "webchat"), route("r1", "maya"), route("r2", "noa"));
    H.canvas.edges.push(edge("ec", "r1"), edge("ec", "r2"));
    expect((await get()).body.data.channels[0]).toMatchObject({ how: "always", employee: { id: "maya", name: "Maya" } });
  });
});

describe("refused", () => {
  it("an employee that is not active, or not this workspace's", async () => {
    expect((await put({ employeeId: "draft", includeShared: true })).body.code).toBe("EMPLOYEE_NOT_FOUND");
    expect((await put({ employeeId: "other-ws", includeShared: true })).status).toBe(422);
    expect(H.writes).toBe(0);
  });

  it("no widget yet", async () => {
    H.accounts = [{ id: "wa1", channel: "WHATSAPP", isActive: true, createdAt: 1 }];
    expect((await put({ employeeId: "noa" })).body.code).toBe("WIDGET_NOT_CREATED");
  });

  it("no playbook yet: the one created answers every channel, so it is shared", async () => {
    H.canvas = null;
    expect((await put({ employeeId: "noa" })).body).toMatchObject({ code: "PLAYBOOK_SHARED", sharedWith: ["WHATSAPP"] });
    const r = await put({ employeeId: "noa", includeShared: true });
    expect(r.status).toBe(200);
    expect(pathFor(H.canvas.nodes, H.canvas.edges, "WEBCHAT")).toMatchObject({ how: "always", employeeId: "noa" });
  });
});
