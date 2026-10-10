/**
 * ★ A stored upload is served only through a checked route (2026-10-10,
 * uploads plan steps 2-3), never as a public /api/uploads link:
 *   - GET /api/conversations/:c/messages/:m/media/:name: logged in, this
 *     tenant, a conversation the viewer may see, and exactly the name the
 *     message stored. Range/206 and ETag; private, no-store; nosniff; sandbox;
 *     attachment unless an image, audio or video.
 *   - GET /api/media/s/:m?exp=&sig=: no login, a signature over the message
 *     and ITS tenant, unexpired.
 *   - every refusal is the same bare 404.
 *   - every message leaving the service carries the logged-in URL; the DB
 *     keeps the stored path.
 * Through the real routers, the real visibility guard and a real temp dir.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";

const H = vi.hoisted(() => {
  const os = require("os"); const p = require("path"); const f = require("fs");
  const base = f.mkdtempSync(p.join(os.tmpdir(), "media-url-"));
  const dir = p.join(base, "uploads");
  f.mkdirSync(dir);
  process.env.UPLOADS_DIR = dir;
  process.env.CHANNEL_ENCRYPTION_KEY = "test-channel-key";
  process.env.PUBLIC_URL = "https://app.example.test";
  return {
    base,
    dir,
    viewer: null as null | { userId: string; role: string; departmentId?: string; tenantId: string },
    convs: [] as any[],
    messages: [] as any[],
    lookups: 0,
    created: [] as any[],
    emitted: [] as any[],
    published: [] as any[],
    queued: [] as any[],
  };
});

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (k === "AND") return (v as any[]).every((w) => matches(row, w));
    if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", () => ({
  authenticate: (req: any, res: any, n: any) => {
    if (!H.viewer) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.user = { ...H.viewer }; n();
  },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = H.viewer!.tenantId; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  validate: () => (_q: any, _s: any, n: any) => n(),
  latestHandover: async () => null,
  readDurableSetting: async () => null,
  getInternalServiceKey: () => "k",
  recordHandover: async () => undefined,
  notificationsQueue: { add: async () => undefined },
  withHistoricalRecords: (fn: any) => fn(),
  decryptCredentials: () => ({ accessToken: "tok" }),
  publishEvent: async (e: any) => { H.published.push(e); },
  outgoingMessageQueue: { add: async (_n: string, data: any) => { H.queued.push(data); } },
  prisma: {
    conversation: {
      findFirst: async (a: any) => {
        const c = H.convs.find((x) => matches(x, a.where));
        return c ? { ...c, messages: H.messages.filter((m) => m.conversationId === c.id) } : null;
      },
      update: async () => ({}),
    },
    contact: { findMany: async () => [] },
    message: {
      findFirst: async (a: any) => { H.lookups++; return H.messages.find((m) => matches(m, a.where)) ?? null; },
      findUnique: async (a: any) => { H.lookups++; return H.messages.find((m) => m.id === a.where.id) ?? null; },
      findMany: async (a: any) => H.messages.filter((m) => matches(m, a.where)),
      count: async () => H.messages.length,
    },
    $transaction: async (fn: any) => fn({
      message: { create: async (a: any) => { H.created.push(a.data); return { id: "mNew", createdAt: new Date(), ...a.data }; } },
      conversation: { update: async () => ({}) },
    }),
  },
}));
vi.mock("../lib/socket", () => ({ getIO: () => ({ to: () => ({ emit: (_e: string, d: any) => { H.emitted.push(d); } }) }) }));

import messageRoutes from "../routes/messages";
import conversationRoutes from "../routes/conversations";
import { signedMediaHandler } from "../lib/media-serving";
import { signMediaUrl } from "@chatcenter/shared/src/lib/media-url";

const JPG = "11111111-2222-4333-8444-555555555555.jpg";
const HTML = "22222222-2222-4333-8444-555555555555.html";
const SVG = "33333333-2222-4333-8444-555555555555.svg";
const PDF = "44444444-2222-4333-8444-555555555555.pdf";
const LEGACY = "55555555-2222-4333-8444-555555555555.JPG";
const GONE = "66666666-2222-4333-8444-555555555555.jpg";
const OTHER = "77777777-2222-4333-8444-555555555555.jpg";
const BYTES = "0123456789abcdef";

for (const n of [JPG, HTML, SVG, PDF, LEGACY, OTHER]) fs.writeFileSync(path.join(H.dir, n), n === HTML || n === SVG ? "<script>alert(1)</script>" : BYTES);
// A file next to the uploads dir, the target of every traversal attempt.
fs.writeFileSync(path.join(H.base, "media-url-secret.txt"), "SECRET");

const app = express();
app.use(express.json());
// Exactly as index.ts mounts it: before any auth.
app.get("/api/media/s/:messageId", signedMediaHandler(H.dir));
app.use("/api/conversations", conversationRoutes);
app.use("/api/conversations", messageRoutes);

const msg = (id: string, mediaUrl: string | null, extra: Record<string, unknown> = {}) =>
  ({ id, tenantId: "T", conversationId: "c_sales", direction: "INBOUND", body: "", messageType: "image", mediaUrl, ...extra });

beforeEach(() => {
  H.viewer = { userId: "admin1", role: "ADMIN", tenantId: "T" };
  H.convs = [
    { id: "c_sales", tenantId: "T", departmentId: "sales", assignedAgentId: null, channel: "WHATSAPP", channelAccountId: "ca1", customerExternalId: "9725", channelAccount: { id: "ca1", credentials: "enc" } },
    { id: "c_support", tenantId: "T", departmentId: "support", assignedAgentId: null, channel: "WHATSAPP", channelAccountId: "ca1", customerExternalId: "9726", channelAccount: { id: "ca1", credentials: "enc" } },
  ];
  H.messages = [
    msg("m_jpg", `/api/uploads/${JPG}`),
    msg("m_html", `/api/uploads/${HTML}`),
    msg("m_svg", `/api/uploads/${SVG}`),
    msg("m_pdf", `/api/uploads/${PDF}`),
    msg("m_legacy", `/api/uploads/${LEGACY}`),
    msg("m_gone", `/api/uploads/${GONE}`),
    msg("m_cdn", "https://scontent.xx.fbcdn.net/v/abc.jpg?oh=1"),
    msg("m_trav", "/api/uploads/../media-url-secret.txt"),
    // an absolute link whose last segment happens to be a real stored name
    msg("m_abs", `https://elsewhere.example/x/${JPG}`),
    msg("m_support", `/api/uploads/${OTHER}`, { conversationId: "c_support" }),
    msg("m_reply", null, { messageType: "text", replyToMessageId: "m_jpg", replyTo: { id: "m_jpg", mediaUrl: `/api/uploads/${JPG}` } }),
  ];
  H.lookups = 0; H.created = []; H.emitted = []; H.published = []; H.queued = [];
});
afterAll(() => {
  fs.rmSync(H.base, { recursive: true, force: true });
});

const media = (c: string, m: string, name: string) => request(app).get(`/api/conversations/${c}/messages/${m}/media/${name}`);
const expectServed = (r: request.Response) => {
  expect(r.headers["cache-control"]).toBe("private, no-store");
  expect(r.headers["x-content-type-options"]).toBe("nosniff");
  expect(r.headers["content-security-policy"]).toBe("sandbox");
};
const expectBare404 = (r: request.Response) => {
  expect(r.status).toBe(404);
  expect(r.text).toBe("Not Found");
  expect(r.headers["content-disposition"]).toBeUndefined();
  expect(r.headers["cache-control"]).toBe("private, no-store");
};

describe("★ logged-in media route", () => {
  it("serves the message's own file with the safe headers and an ETag", async () => {
    const r = await media("c_sales", "m_jpg", JPG);
    expect(r.status).toBe(200);
    expectServed(r);
    expect(r.headers["content-disposition"]).toBeUndefined();
    expect(r.headers["content-type"]).toBe("image/jpeg");
    expect(r.headers.etag).toBeTruthy();
    expect(r.headers["content-length"]).toBe(String(BYTES.length));
  });

  it("answers a Range request with 206 (voice and video seeking)", async () => {
    const r = await media("c_sales", "m_jpg", JPG).set("Range", "bytes=2-5");
    expect(r.status).toBe(206);
    expect(r.headers["content-range"]).toBe(`bytes 2-5/${BYTES.length}`);
    expect(r.headers["content-length"]).toBe("4");
    expectServed(r);
  });

  it("a stored .html or .svg, and a pdf, download as attachments; a legacy .JPG renders", async () => {
    for (const [m, n] of [["m_html", HTML], ["m_svg", SVG], ["m_pdf", PDF]]) {
      const r = await media("c_sales", m, n);
      expect(r.status, n).toBe(200);
      expectServed(r);
      expect(r.headers["content-disposition"], n).toBe("attachment");
    }
    const legacy = await media("c_sales", "m_legacy", LEGACY);
    expect(legacy.status).toBe(200);
    expect(legacy.headers["content-disposition"]).toBeUndefined();
  });

  it("401 without a login", async () => {
    H.viewer = null;
    expect((await media("c_sales", "m_jpg", JPG)).status).toBe(401);
  });

  it("404 for another tenant, even an unrestricted admin there", async () => {
    H.viewer = { userId: "admin2", role: "ADMIN", tenantId: "T2" };
    expectBare404(await media("c_sales", "m_jpg", JPG));
  });

  it("404 for an agent who cannot see the conversation, before the message is read", async () => {
    H.viewer = { userId: "agent1", role: "AGENT", departmentId: "sales", tenantId: "T" };
    const r = await media("c_support", "m_support", OTHER);
    expect(r.status).toBe(404);
    expect(H.lookups).toBe(0);
    expect((await media("c_sales", "m_jpg", JPG)).status).toBe(200);
  });

  it("404 when the name is not exactly the one this message stored", async () => {
    // a real file, but another message's
    expectBare404(await media("c_sales", "m_jpg", OTHER));
    // the message is in another conversation than the URL says
    expectBare404(await media("c_sales", "m_support", OTHER));
    // case is not normalised
    expectBare404(await media("c_sales", "m_legacy", LEGACY.toLowerCase()));
  });

  it("404 for traversal, in the URL or in a tampered stored path", async () => {
    for (const n of ["..%2Fmedia-url-secret.txt", "..%2F..%2Fetc%2Fpasswd", `.${JPG}`, `${JPG}%00.png`, "%2E%2E"]) {
      const r = await media("c_sales", "m_jpg", n);
      expect(r.status, n).toBe(404);
      expect(r.text).not.toContain("SECRET");
    }
    const t = await media("c_sales", "m_trav", "media-url-secret.txt");
    expectBare404(t);
  });

  it("404 for a missing file, a Meta CDN link and a missing message, all alike", async () => {
    const gone = await media("c_sales", "m_gone", GONE);
    const cdn = await media("c_sales", "m_cdn", "abc.jpg");
    const none = await media("c_sales", "m_nope", JPG);
    for (const r of [gone, cdn, none]) expectBare404(r);
  });
});

describe("★ public signed route", () => {
  const signed = (id: string, o: Partial<{ tenantId: string; ttlSeconds: number; now: number }> = {}) =>
    signMediaUrl({ messageId: id, tenantId: "T", ttlSeconds: 900, ...o });
  const get = (id: string, q: Record<string, unknown>) => request(app).get(`/api/media/s/${id}`).query(q);

  it("a valid link serves the file with no login and the same headers", async () => {
    H.viewer = null;
    const r = await get("m_jpg", signed("m_jpg"));
    expect(r.status).toBe(200);
    expectServed(r);
    expect(r.headers["content-disposition"]).toBeUndefined();
    const doc = await get("m_html", signed("m_html"));
    expect(doc.status).toBe(200);
    expect(doc.headers["content-disposition"]).toBe("attachment");
    const ranged = await get("m_jpg", signed("m_jpg")).set("Range", "bytes=0-3");
    expect(ranged.status).toBe(206);
  });

  it("refuses a tampered, expired, other-message or other-tenant signature", async () => {
    const s = signed("m_jpg");
    const flip = s.sig.slice(0, -1) + (s.sig.endsWith("0") ? "1" : "0");
    expectBare404(await get("m_jpg", { exp: s.exp, sig: flip }));
    expectBare404(await get("m_jpg", { exp: s.exp + 1, sig: s.sig }));
    expectBare404(await get("m_pdf", s));
    expectBare404(await get("m_jpg", signed("m_jpg", { tenantId: "T2" })));
    expectBare404(await get("m_jpg", signed("m_jpg", { now: Date.now() - 901_000 })));
  });

  it("does not reveal whether the message exists", async () => {
    const missing = await get("m_nope", signed("m_nope"));
    const forged = await get("m_jpg", { ...signed("m_jpg"), sig: "0".repeat(64) });
    expect([missing.status, missing.text, missing.headers["cache-control"]]).toEqual([forged.status, forged.text, forged.headers["cache-control"]]);
  });

  it("garbage never reaches the database", async () => {
    for (const q of [{}, { exp: "x", sig: "y" }, { exp: "1", sig: "0".repeat(64) }, { exp: [1, 2], sig: "a" }]) {
      expectBare404(await get("m_jpg", q));
    }
    expect(H.lookups).toBe(0);
  });

  it("a validly signed message whose media is not a stored upload is 404", async () => {
    expectBare404(await get("m_cdn", signed("m_cdn")));
    expectBare404(await get("m_trav", signed("m_trav")));
    expectBare404(await get("m_gone", signed("m_gone")));
    expectBare404(await get("m_abs", signed("m_abs")));
  });

  it("the tenant is the message row's, never one the caller names", async () => {
    expectBare404(await get("m_jpg", { ...signed("m_jpg", { tenantId: "T2" }), tenantId: "T2", t: "T2" }));
  });
});

describe("★ messages leave with the logged-in URL; the DB keeps the stored path", () => {
  const presented = (m: string, n: string) => `/api/conversations/c_sales/messages/${m}/media/${n}`;

  it("the message list, including a quoted message", async () => {
    const r = await request(app).get("/api/conversations/c_sales/messages");
    const by = Object.fromEntries(r.body.data.map((m: any) => [m.id, m]));
    expect(by.m_jpg.mediaUrl).toBe(presented("m_jpg", JPG));
    expect(by.m_legacy.mediaUrl).toBe(presented("m_legacy", LEGACY));
    expect(by.m_cdn.mediaUrl).toBe("https://scontent.xx.fbcdn.net/v/abc.jpg?oh=1");
    expect(by.m_trav.mediaUrl).toBe("/api/uploads/../media-url-secret.txt");
    expect(by.m_reply.mediaUrl).toBeNull();
    expect(by.m_reply.replyTo.mediaUrl).toBe(presented("m_jpg", JPG));
    expect(JSON.stringify(r.body)).not.toContain(`/api/uploads/${JPG}`);
    // and each presented URL is one the route serves
    expect((await request(app).get(by.m_jpg.mediaUrl)).status).toBe(200);
  });

  it("the single conversation's messages", async () => {
    const r = await request(app).get("/api/conversations/c_sales");
    expect(r.status).toBe(200);
    const jpg = r.body.data.messages.find((m: any) => m.id === "m_jpg");
    expect(jpg.mediaUrl).toBe(presented("m_jpg", JPG));
    expect(JSON.stringify(r.body)).not.toContain("/api/uploads/1111");
  });

  it("an agent's upload: stored path in the DB, logged-in URL in the response, socket and bus, stored path plus origin on the job", async () => {
    const r = await request(app).post("/api/conversations/c_sales/messages/media")
      .attach("file", Buffer.from(BYTES), { filename: "photo.jpg", contentType: "image/jpeg" });
    expect(r.status).toBe(201);
    const stored = H.created[0].mediaUrl as string;
    expect(stored).toMatch(/^\/api\/uploads\/[0-9a-f-]{36}\.jpg$/);
    const name = path.basename(stored);
    const want = `/api/conversations/c_sales/messages/mNew/media/${name}`;
    expect(r.body.data.mediaUrl).toBe(want);
    expect(H.emitted[0].message.mediaUrl).toBe(want);
    expect(H.published[0].data.message.mediaUrl).toBe(want);
    // the worker signs at send time; no public /api/uploads link is queued
    expect(H.queued[0].mediaUrl).toBe(stored);
    expect(H.queued[0].publicBaseUrl).toBe("https://app.example.test");
    expect(JSON.stringify(H.queued[0])).not.toContain("https://app.example.test/api/uploads");
  });
});
