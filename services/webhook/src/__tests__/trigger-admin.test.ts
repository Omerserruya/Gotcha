import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Authenticated management API. The auth/tenant middleware is mocked to a
// pass-through that pins a tenant + ADMIN user, so the tests exercise the route
// logic (validation, tenant scoping, token/secret minting) against a mocked
// Prisma client.
vi.mock("@chatcenter/shared", () => {
  const mockPrisma = {
    webhookTrigger: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    chatbotFlow: { findFirst: vi.fn() },
  };

  const passUser = (req: any, _res: any, next: any) => {
    req.tenantId = "tenant-1";
    req.user = { userId: "user-1", role: "ADMIN", tenantId: "tenant-1" };
    next();
  };

  return {
    prisma: mockPrisma,
    authenticate: passUser,
    resolveTenant: (_req: any, _res: any, next: any) => next(),
    requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requireRole: () => (_req: any, _res: any, next: any) => next(),
  };
});

import triggerAdminRoutes from "../routes/trigger-admin";
import { prisma } from "@chatcenter/shared";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/webhook-triggers", triggerAdminRoutes);
  return app;
}

const TRIGGER = {
  id: "trig-1",
  tenantId: "tenant-1",
  workflowId: "flow-1",
  token: "tok-abc",
  secret: "s3cr3t",
  enabled: true,
  targetMode: "flow",
  bodySchema: [{ key: "phone_number", type: "string" }],
};

describe("WebhookTrigger management API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/webhook-triggers", () => {
    it("400s without a workflowId", async () => {
      const res = await request(createTestApp()).get("/api/webhook-triggers");
      expect(res.status).toBe(400);
    });

    it("returns null when the workflow has no trigger", async () => {
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(null);
      const res = await request(createTestApp()).get(
        "/api/webhook-triggers?workflowId=flow-1",
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });

    it("returns the trigger (with ingest path) scoped to the tenant", async () => {
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(TRIGGER);
      const res = await request(createTestApp()).get(
        "/api/webhook-triggers?workflowId=flow-1",
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: "trig-1",
        token: "tok-abc",
        secret: "s3cr3t",
        enabled: true,
        path: "/webhooks/tok-abc",
      });
      expect(prisma.webhookTrigger.findFirst).toHaveBeenCalledWith({
        where: { tenantId: "tenant-1", workflowId: "flow-1" },
      });
    });
  });

  describe("POST /api/webhook-triggers", () => {
    it("400s without a workflowId", async () => {
      const res = await request(createTestApp())
        .post("/api/webhook-triggers")
        .send({});
      expect(res.status).toBe(400);
    });

    it("404s when the workflow is not owned by the tenant", async () => {
      (prisma.chatbotFlow.findFirst as any).mockResolvedValue(null);
      const res = await request(createTestApp())
        .post("/api/webhook-triggers")
        .send({ workflowId: "flow-x" });
      expect(res.status).toBe(404);
      expect(prisma.webhookTrigger.create).not.toHaveBeenCalled();
    });

    it("is idempotent — returns the existing trigger instead of creating", async () => {
      (prisma.chatbotFlow.findFirst as any).mockResolvedValue({ id: "flow-1" });
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(TRIGGER);
      const res = await request(createTestApp())
        .post("/api/webhook-triggers")
        .send({ workflowId: "flow-1" });
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("trig-1");
      expect(prisma.webhookTrigger.create).not.toHaveBeenCalled();
    });

    it("mints a token + secret for a new trigger", async () => {
      (prisma.chatbotFlow.findFirst as any).mockResolvedValue({ id: "flow-1" });
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(null);
      (prisma.webhookTrigger.create as any).mockImplementation(({ data }: any) => ({
        id: "trig-new",
        ...data,
      }));
      const res = await request(createTestApp())
        .post("/api/webhook-triggers")
        .send({ workflowId: "flow-1" });
      expect(res.status).toBe(201);
      const createArg = (prisma.webhookTrigger.create as any).mock.calls[0][0].data;
      expect(createArg.tenantId).toBe("tenant-1");
      expect(createArg.workflowId).toBe("flow-1");
      expect(typeof createArg.token).toBe("string");
      expect(createArg.token.length).toBeGreaterThanOrEqual(32);
      expect(typeof createArg.secret).toBe("string");
      expect(createArg.secret.length).toBeGreaterThanOrEqual(16);
      expect(createArg.enabled).toBe(true);
      // Defaults to the original flow behavior when no mode is supplied.
      expect(createArg.targetMode).toBe("flow");
      expect(res.body.data.targetMode).toBe("flow");
      expect(res.body.data.path).toBe(`/webhooks/${createArg.token}`);
    });

    it("mints a connected-mode trigger when targetMode is supplied", async () => {
      (prisma.chatbotFlow.findFirst as any).mockResolvedValue({ id: "flow-1" });
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(null);
      (prisma.webhookTrigger.create as any).mockImplementation(({ data }: any) => ({
        id: "trig-new",
        ...data,
      }));
      const res = await request(createTestApp())
        .post("/api/webhook-triggers")
        .send({ workflowId: "flow-1", targetMode: "connected" });
      expect(res.status).toBe(201);
      const createArg = (prisma.webhookTrigger.create as any).mock.calls[0][0].data;
      expect(createArg.targetMode).toBe("connected");
      expect(res.body.data.targetMode).toBe("connected");
    });

    it("reconciles the mode on an idempotent create when explicitly changed", async () => {
      (prisma.chatbotFlow.findFirst as any).mockResolvedValue({ id: "flow-1" });
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue({ ...TRIGGER, targetMode: "flow" });
      (prisma.webhookTrigger.update as any).mockImplementation(({ data }: any) => ({
        ...TRIGGER,
        ...data,
      }));
      const res = await request(createTestApp())
        .post("/api/webhook-triggers")
        .send({ workflowId: "flow-1", targetMode: "connected" });
      expect(res.status).toBe(200);
      expect(prisma.webhookTrigger.create).not.toHaveBeenCalled();
      expect((prisma.webhookTrigger.update as any).mock.calls[0][0].data).toEqual({
        targetMode: "connected",
      });
      expect(res.body.data.targetMode).toBe("connected");
    });
  });

  describe("POST /api/webhook-triggers/:id/regenerate-secret", () => {
    it("404s for an unknown / cross-tenant trigger", async () => {
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(null);
      const res = await request(createTestApp()).post(
        "/api/webhook-triggers/trig-x/regenerate-secret",
      );
      expect(res.status).toBe(404);
      expect(prisma.webhookTrigger.update).not.toHaveBeenCalled();
    });

    it("rotates the secret but keeps the token", async () => {
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(TRIGGER);
      (prisma.webhookTrigger.update as any).mockImplementation(({ data }: any) => ({
        ...TRIGGER,
        ...data,
      }));
      const res = await request(createTestApp()).post(
        "/api/webhook-triggers/trig-1/regenerate-secret",
      );
      expect(res.status).toBe(200);
      const updateArg = (prisma.webhookTrigger.update as any).mock.calls[0][0];
      expect(updateArg.where).toEqual({ id: "trig-1" });
      expect(typeof updateArg.data.secret).toBe("string");
      expect(updateArg.data.secret).not.toBe("s3cr3t");
      expect(res.body.data.token).toBe("tok-abc");
    });
  });

  describe("PATCH /api/webhook-triggers/:id", () => {
    it("400s when neither enabled nor targetMode is provided", async () => {
      const res = await request(createTestApp())
        .patch("/api/webhook-triggers/trig-1")
        .send({ enabled: "yes" });
      expect(res.status).toBe(400);
    });

    it("400s for an invalid targetMode", async () => {
      const res = await request(createTestApp())
        .patch("/api/webhook-triggers/trig-1")
        .send({ targetMode: "bogus" });
      expect(res.status).toBe(400);
    });

    it("persists a targetMode change", async () => {
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(TRIGGER);
      (prisma.webhookTrigger.update as any).mockImplementation(({ data }: any) => ({
        ...TRIGGER,
        ...data,
      }));
      const res = await request(createTestApp())
        .patch("/api/webhook-triggers/trig-1")
        .send({ targetMode: "connected" });
      expect(res.status).toBe(200);
      expect((prisma.webhookTrigger.update as any).mock.calls[0][0].data).toEqual({
        targetMode: "connected",
      });
      expect(res.body.data.targetMode).toBe("connected");
    });

    it("404s for an unknown / cross-tenant trigger", async () => {
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(null);
      const res = await request(createTestApp())
        .patch("/api/webhook-triggers/trig-x")
        .send({ enabled: false });
      expect(res.status).toBe(404);
    });

    it("persists the enabled toggle", async () => {
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(TRIGGER);
      (prisma.webhookTrigger.update as any).mockImplementation(({ data }: any) => ({
        ...TRIGGER,
        ...data,
      }));
      const res = await request(createTestApp())
        .patch("/api/webhook-triggers/trig-1")
        .send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);
      expect((prisma.webhookTrigger.update as any).mock.calls[0][0].data).toEqual({
        enabled: false,
      });
    });
  });

  describe("declared body schema (bodySchema)", () => {
    it("GET surfaces the declared body schema for the mapper", async () => {
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(TRIGGER);
      const res = await request(createTestApp()).get(
        "/api/webhook-triggers?workflowId=flow-1",
      );
      expect(res.status).toBe(200);
      expect(res.body.data.bodySchema).toEqual([
        { key: "phone_number", type: "string" },
      ]);
    });

    it("defaults bodySchema to [] on create when none is supplied", async () => {
      (prisma.chatbotFlow.findFirst as any).mockResolvedValue({ id: "flow-1" });
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(null);
      (prisma.webhookTrigger.create as any).mockImplementation(({ data }: any) => ({
        id: "trig-new",
        ...data,
      }));
      const res = await request(createTestApp())
        .post("/api/webhook-triggers")
        .send({ workflowId: "flow-1" });
      expect(res.status).toBe(201);
      expect((prisma.webhookTrigger.create as any).mock.calls[0][0].data.bodySchema).toEqual([]);
      expect(res.body.data.bodySchema).toEqual([]);
    });

    it("PATCH persists a declared schema, normalizing types and dropping blanks/dupes", async () => {
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(TRIGGER);
      (prisma.webhookTrigger.update as any).mockImplementation(({ data }: any) => ({
        ...TRIGGER,
        ...data,
      }));
      const res = await request(createTestApp())
        .patch("/api/webhook-triggers/trig-1")
        .send({
          bodySchema: [
            { key: "  name  ", type: "string" },
            { key: "age", type: "number" },
            { key: "vip", type: "bogus" }, // unknown type → "string"
            { key: "name", type: "boolean" }, // duplicate key dropped
            { key: "", type: "string" }, // blank key dropped
          ],
        });
      expect(res.status).toBe(200);
      expect((prisma.webhookTrigger.update as any).mock.calls[0][0].data.bodySchema).toEqual([
        { key: "name", type: "string" },
        { key: "age", type: "number" },
        { key: "vip", type: "string" },
      ]);
      expect(res.body.data.bodySchema).toEqual([
        { key: "name", type: "string" },
        { key: "age", type: "number" },
        { key: "vip", type: "string" },
      ]);
    });

    it("PATCH 400s when bodySchema is not an array", async () => {
      const res = await request(createTestApp())
        .patch("/api/webhook-triggers/trig-1")
        .send({ bodySchema: "nope" });
      expect(res.status).toBe(400);
      expect(prisma.webhookTrigger.update).not.toHaveBeenCalled();
    });

    it("POST 400s when bodySchema is not an array", async () => {
      const res = await request(createTestApp())
        .post("/api/webhook-triggers")
        .send({ workflowId: "flow-1", bodySchema: { phone: "string" } });
      expect(res.status).toBe(400);
      expect(prisma.webhookTrigger.create).not.toHaveBeenCalled();
    });

    it("PATCH allows bodySchema alone (no enabled/targetMode)", async () => {
      (prisma.webhookTrigger.findFirst as any).mockResolvedValue(TRIGGER);
      (prisma.webhookTrigger.update as any).mockImplementation(({ data }: any) => ({
        ...TRIGGER,
        ...data,
      }));
      const res = await request(createTestApp())
        .patch("/api/webhook-triggers/trig-1")
        .send({ bodySchema: [{ key: "text", type: "string" }] });
      expect(res.status).toBe(200);
      expect((prisma.webhookTrigger.update as any).mock.calls[0][0].data).toEqual({
        bodySchema: [{ key: "text", type: "string" }],
      });
    });
  });
});
