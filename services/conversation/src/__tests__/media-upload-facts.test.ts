/**
 * metadata.media for an agent's upload (2026-10-09), through the real route:
 *   - ★ { mimeType, byteSize, originalName } from what busboy received
 *   - the name is capped for rendering; the type drops its parameters
 *   - the thread read returns it at data[i].metadata.media
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";

const H = vi.hoisted(() => {
  const os = require("os"); const p = require("path"); const f = require("fs");
  const dir = f.mkdtempSync(p.join(os.tmpdir(), "upl-facts-"));
  process.env.UPLOADS_DIR = dir;
  return { dir, written: [] as any[], rows: [] as any[] };
});

vi.mock("@chatcenter/shared", () => {
  const prisma: any = {
    conversation: {
      findFirst: async (a: any) => (a.where.id === "c1" && a.where.tenantId === "T"
        ? { id: "c1", tenantId: "T", channel: "WHATSAPP", channelAccountId: "ca1", customerExternalId: "9725", channelAccount: { id: "ca1", credentials: "enc" } }
        : null),
      update: async () => ({}),
    },
    message: {
      create: async (a: any) => { H.written.push(a.data); return { id: "m1", createdAt: new Date(), ...a.data }; },
      findMany: async () => H.rows,
      count: async () => H.rows.length,
    },
  };
  prisma.$transaction = async (fn: any) => fn(prisma);
  return {
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", email: "agent@x.test", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    validate: () => (_q: any, _s: any, n: any) => n(),
    decryptCredentials: () => ({ accessToken: "tok" }),
    outgoingMessageQueue: { add: async () => undefined },
    publishEvent: async () => undefined,
    withHistoricalRecords: (fn: any) => fn(),
    prisma,
  };
});
vi.mock("../lib/socket", () => ({ getIO: () => ({ to: () => ({ emit: () => undefined }) }) }));
vi.mock("../lib/require-visible-conversation", () => ({ requireVisibleConversation: (_q: any, _s: any, n: any) => n() }));

import router from "../routes/messages";

const app = express();
app.use(express.json());
app.use("/api/conversations", router);

beforeEach(() => { H.written = []; H.rows = []; });
afterAll(() => { fs.rmSync(H.dir, { recursive: true, force: true }); });

describe("★ an agent's upload keeps its media facts on the row", () => {
  it("type, bytes received and original name land at metadata.media", async () => {
    const bytes = Buffer.alloc(1234, 7);
    const r = await request(app)
      .post("/api/conversations/c1/messages/media")
      .field("caption", "the quote")
      .attach("file", bytes, { filename: "Quote 2026.pdf", contentType: "application/pdf" });

    expect(r.status).toBe(201);
    expect(H.written[0].metadata).toEqual({ media: { mimeType: "application/pdf", byteSize: 1234, originalName: "Quote 2026.pdf" } });
    expect(r.body.data.metadata.media.byteSize).toBe(1234);
  });

  it("an overlong name is capped; the type drops parameters", async () => {
    const long = `${"n".repeat(300)}.txt`;
    const r = await request(app)
      .post("/api/conversations/c1/messages/media")
      .attach("file", Buffer.from("x"), { filename: long, contentType: "Text/Plain; charset=utf-8" });

    expect(r.status).toBe(201);
    expect(H.written[0].metadata.media).toEqual({ mimeType: "text/plain", byteSize: 1, originalName: "n".repeat(180) });
    // The message's own fileName is untouched by this.
    expect(H.written[0].fileName).toBe(long);
  });
});

describe("the thread read serves metadata.media", () => {
  it("GET /:conversationId/messages returns data[i].metadata.media as stored", async () => {
    const media = { mimeType: "image/webp", byteSize: 2048, originalName: null };
    H.rows = [{ id: "m9", messageType: "sticker", body: "[Sticker]", mediaUrl: "/api/uploads/x.webp", metadata: { media } }];

    const r = await request(app).get("/api/conversations/c1/messages");

    expect(r.status).toBe(200);
    expect(r.body.data[0].metadata.media).toEqual(media);
    expect(r.body.data[0].messageType).toBe("sticker");
  });
});
