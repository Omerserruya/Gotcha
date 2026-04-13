import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const state = {
  contacts: new Map<string, any>(),
  convos: [] as any[],
  messages: [] as any[],
};

vi.mock("@chatcenter/shared", () => {
  const tx = {
    broadcastRecipient: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    contact: {
      update: vi.fn(async ({ where, data }: any) => {
        const existing = state.contacts.get(where.id);
        const next = { ...existing, ...data };
        state.contacts.set(where.id, next);
        return next;
      }),
      delete: vi.fn(async ({ where }: any) => {
        state.contacts.delete(where.id);
        return { id: where.id };
      }),
    },
  };
  return {
    prisma: {
      contact: {
        findFirst: vi.fn(async ({ where }: any) => {
          if (where.id) return state.contacts.get(where.id) ?? null;
          if (where.OR) {
            for (const clause of where.OR) {
              for (const c of state.contacts.values()) {
                if (clause.email && c.email === clause.email) return c;
                if (clause.phone && c.phone === clause.phone) return c;
              }
            }
          }
          return null;
        }),
        findMany: vi.fn(async () => Array.from(state.contacts.values())),
        create: vi.fn(async ({ data }: any) => {
          const c = { id: `c${state.contacts.size + 1}`, tags: [], ...data };
          state.contacts.set(c.id, c);
          return c;
        }),
      },
      conversation: {
        findMany: vi.fn(async () => state.convos),
      },
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    },
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { id: "u1" };
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => {
      req.tenantId = "t1";
      next();
    },
    requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    outgoingMessageQueue: {},
  };
});

import identityRoutes from "../routes/identity";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/identity", identityRoutes);
  return app;
}

describe("identity routes", () => {
  beforeEach(() => {
    state.contacts.clear();
    state.convos = [];
    state.contacts.set("c1", {
      id: "c1",
      tenantId: "t1",
      channel: "WHATSAPP",
      externalId: "+123",
      email: "ada@example.com",
      phone: "+123",
      tags: ["vip"],
      metadata: { locale: "he" },
      lastInteractionAt: new Date("2026-04-10T00:00:00Z"),
    });
  });

  it("resolve matches by email", async () => {
    const res = await request(makeApp())
      .post("/api/identity/resolve")
      .send({ email: "ada@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);
    expect(res.body.contact.id).toBe("c1");
  });

  it("resolve returns 400 when no keys given", async () => {
    const res = await request(makeApp()).post("/api/identity/resolve").send({});
    expect(res.status).toBe(400);
  });

  it("merge combines tags and deletes source", async () => {
    state.contacts.set("c2", {
      id: "c2",
      tenantId: "t1",
      channel: "EMAIL",
      externalId: "ada@example.com",
      email: null,
      phone: null,
      tags: ["newsletter"],
      metadata: null,
      lastInteractionAt: new Date("2026-04-05T00:00:00Z"),
    });
    const res = await request(makeApp())
      .post("/api/identity/merge")
      .send({ targetId: "c1", sourceId: "c2" });
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);
    expect(res.body.contact.tags).toEqual(expect.arrayContaining(["vip", "newsletter"]));
    expect(state.contacts.has("c2")).toBe(false);
  });

  it("merge rejects same id", async () => {
    const res = await request(makeApp())
      .post("/api/identity/merge")
      .send({ targetId: "c1", sourceId: "c1" });
    expect(res.status).toBe(400);
  });
});
