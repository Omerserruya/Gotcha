/**
 * ★ An agent's upload is stored under an allowlisted extension only
 * (2026-10-09): the uploader's "x.html" was written as <uuid>.html and served
 * as a page on the app's own domain.
 *   - a name a browser could run is stored as <uuid>.bin; the original name
 *     still goes on the message and the outgoing job
 *   - an allowlisted name keeps its extension
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";

const H = vi.hoisted(() => {
  const os = require("os"); const p = require("path"); const f = require("fs");
  const dir = f.mkdtempSync(p.join(os.tmpdir(), "upl-"));
  process.env.UPLOADS_DIR = dir;
  return { dir, created: [] as any[], queued: [] as any[] };
});

vi.mock("@chatcenter/shared", () => ({
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", email: "agent@x.test", role: "ADMIN" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  validate: () => (_q: any, _s: any, n: any) => n(),
  decryptCredentials: () => ({ accessToken: "tok" }),
  outgoingMessageQueue: { add: async (_n: string, data: any) => { H.queued.push(data); } },
  prisma: {
    conversation: {
      findFirst: async (a: any) => (a.where.id === "c1" && a.where.tenantId === "T"
        ? { id: "c1", tenantId: "T", channel: "WHATSAPP", channelAccountId: "ca1", customerExternalId: "9725", channelAccount: { id: "ca1", credentials: "enc" } }
        : null),
    },
  },
}));
vi.mock("../lib/require-visible-conversation", () => ({ requireVisibleConversation: (_q: any, _s: any, n: any) => n() }));
vi.mock("../services/message.service", () => ({ create: async (d: any) => { H.created.push(d); return { id: "m1", ...d }; } }));

import router from "../routes/messages";

const app = express();
app.use(express.json());
app.use("/api/conversations", router);
const upload = (name: string, type: string) =>
  request(app).post("/api/conversations/c1/messages/media").attach("file", Buffer.from("<script>alert(1)</script>"), { filename: name, contentType: type });

beforeEach(() => { H.created = []; H.queued = []; });
afterAll(() => { fs.rmSync(H.dir, { recursive: true, force: true }); });

describe("★ an agent's upload never keeps a runnable extension", () => {
  it("x.html is stored as <uuid>.bin; the original name stays on the message and the job", async () => {
    const r = await upload("x.html", "text/html");
    expect(r.status).toBe(201);
    expect(H.created[0].mediaUrl).toMatch(/^\/api\/uploads\/[0-9a-f-]{36}\.bin$/);
    expect(H.created[0].fileName).toBe("x.html");
    expect(H.queued[0].fileName).toBe("x.html");
    expect(fs.existsSync(path.join(H.dir, path.basename(H.created[0].mediaUrl)))).toBe(true);
  });

  it("an svg is .bin too; a pdf keeps .pdf", async () => {
    await upload("logo.svg", "image/svg+xml");
    expect(H.created[0].mediaUrl).toMatch(/\.bin$/);
    H.created = [];
    await upload("invoice.PDF", "application/pdf");
    expect(H.created[0].mediaUrl).toMatch(/\.pdf$/);
  });
});
