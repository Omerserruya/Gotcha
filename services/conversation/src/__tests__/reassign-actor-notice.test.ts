/**
 * ★ "X assigned you a conversation" names X, the person who moved it, through
 * POST /api/conversations/:id/reassign. It named the PREVIOUS assignee
 * ("Unknown" when there was none), so the notice could name someone who did
 * nothing (2026-10-08).
 *   - the actor is the signed-in person, looked up in this workspace
 *   - without an actor it was GOTCHA (no such caller today)
 *   - assigning to yourself tells nobody
 *   - the transfer divider still says from whom to whom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  viewer: { userId: "noa", role: "ADMIN" },
  convs: [] as any[],
  users: [] as any[],
  notices: [] as any[],
  dividers: [] as any[],
  userLookupFails: false,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const user = (where: any) => H.users.find((u) => u.id === where.id && (!where.tenantId || u.tenantId === where.tenantId)) ?? null;
  return {
    ...actual,
    authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.viewer, tenantId: "T" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    readDurableSetting: async () => null,
    getRedis: () => null,
    publishEvent: async () => undefined,
    notificationsQueue: { add: async (_n: string, job: any) => { H.notices.push(job); return { id: "j" }; } },
    prisma: {
      conversation: {
        findFirst: async ({ where, include }: any) => {
          const c = H.convs.find((x) => x.id === where.id && x.tenantId === where.tenantId);
          if (!c) return null;
          return include?.assignedAgent ? { ...c, assignedAgent: c.assignedAgentId ? user({ id: c.assignedAgentId }) : null } : { ...c };
        },
        update: async ({ where, data }: any) => {
          const c = H.convs.find((x) => x.id === where.id);
          Object.assign(c, data);
          return { ...c, assignedAgent: user({ id: c.assignedAgentId }) };
        },
      },
      user: {
        findFirst: async ({ where }: any) => { if (H.userLookupFails && where.id === H.viewer.userId) throw new Error("db down"); return user(where); },
        findUnique: async ({ where }: any) => user(where),
      },
    },
  };
});
vi.mock("../lib/socket", () => ({ getIO: () => ({ to: () => ({ emit: () => undefined }) }) }));
vi.mock("../services/message.service", () => ({ create: async (m: any) => { H.dividers.push(m); return { id: "m", ...m }; } }));

import router from "../routes/conversations";

const app = express();
app.use(express.json());
app.use("/api/conversations", router);
const reassign = (agentId: string) => request(app).post("/api/conversations/c1/reassign").send({ agentId });

beforeEach(() => {
  H.viewer = { userId: "noa", role: "ADMIN" };
  H.userLookupFails = false;
  H.notices = []; H.dividers = [];
  H.users = [
    { id: "noa", tenantId: "T", name: "Noa" },
    { id: "dana", tenantId: "T", name: "Dana" },
    { id: "matan", tenantId: "T", name: "Matan" },
  ];
  H.convs = [{ id: "c1", tenantId: "T", channel: "WEBCHAT", assignedAgentId: "dana", status: "OPEN" }];
});

describe("★ the assignment notice names who moved it", () => {
  it("Noa moves Dana's conversation to Matan: Matan hears it from Noa, not from Dana", async () => {
    const r = await reassign("matan");
    expect(r.status).toBe(200);
    expect(H.notices).toHaveLength(1);
    expect(H.notices[0]).toMatchObject({ type: "conversation.assigned", data: { assignedByName: "Noa", assignedToName: "Matan" }, metadata: { userId: "matan" } });
  });

  it("a conversation nobody held: still the actor, never 'Unknown'", async () => {
    H.convs[0].assignedAgentId = null;
    await reassign("matan");
    expect(H.notices[0].data.assignedByName).toBe("Noa");
  });

  it("the actor's name is read in this workspace only", async () => {
    H.users.push({ id: "outsider", tenantId: "OTHER", name: "Outsider" });
    H.viewer = { userId: "outsider", role: "ADMIN" };
    await reassign("matan");
    expect(H.notices[0].data.assignedByName).toBeNull();
  });

  it("assigning to yourself tells nobody", async () => {
    await reassign("noa");
    expect(H.notices).toEqual([]);
    expect(H.convs[0].assignedAgentId).toBe("noa");
  });

  it("a name lookup that fails: the transfer stands, the notice has no name", async () => {
    H.userLookupFails = true;
    const r = await reassign("matan");
    expect(r.status).toBe(200);
    expect(H.convs[0].assignedAgentId).toBe("matan");
    expect(H.notices[0].data.assignedByName).toBeNull();
  });

  it("the transfer divider still says from whom to whom", async () => {
    await reassign("matan");
    expect(H.dividers.map((d) => d.metadata)).toEqual([{ systemEvent: "agent_transferred", fromAgentName: "Dana", toAgentName: "Matan" }]);
  });
});

describe("★ without an actor it was GOTCHA", () => {
  it("the service called with no actor names GOTCHA", async () => {
    const { reassign: svc } = await import("../services/conversation.service");
    await svc("T", "c1", "matan");
    expect(H.notices[0].data.assignedByName).toBe("GOTCHA");
  });
});
