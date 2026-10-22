/**
 * /api/channels/:id/email-template through the real routes (2026-10-22):
 * read, save (sanitized, size, placeholder, enabled-without-template), audit,
 * test send to the caller only, and cleanup on channel delete.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  accounts: [] as any[],
  settings: new Map<string, string>(),
  audits: [] as any[],
  sends: [] as any[],
  sendResult: "ext_1" as string | null,
  user: { email: "owner@acme.test", name: "Owner Name" } as any,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const pass = (req: any, _res: any, next: any) => { req.user = { userId: "u_1", tenantId: "t_1" }; req.tenantId = "t_1"; next(); };
  return {
    ...actual,
    authenticate: pass,
    resolveTenant: (_req: any, _res: any, next: any) => next(),
    requirePermission: (_p: string) => (_req: any, _res: any, next: any) => next(),
    prisma: {
      channelAccount: {
        findFirst: vi.fn(async ({ where }: any) => H.accounts.find((a) => a.id === where.id && a.tenantId === where.tenantId) ?? null),
      },
      user: { findUnique: vi.fn(async () => H.user) },
    },
    readDurableSetting: vi.fn(async (t: string, k: string) => H.settings.get(`${t}|${k}`) ?? null),
    writeDurableSetting: vi.fn(async (t: string, k: string, v: string | null) => {
      if (v === null) H.settings.delete(`${t}|${k}`); else H.settings.set(`${t}|${k}`, v);
    }),
    writeAudit: vi.fn(async (e: any) => { H.audits.push(e); }),
    decryptCredentials: (s: string) => ({ decrypted: s }),
    getOutboundAdapter: vi.fn(() => ({
      sendTextMessage: async (...args: any[]) => { H.sends.push(args); return H.sendResult; },
    })),
  };
});

import emailTemplateRouter, { deleteEmailTemplateFor } from "../routes/email-template";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api/channels", emailTemplateRouter);

const URL = "/api/channels/ca_gmail/email-template";
const GOOD = `<table><tr><td>{{content}}</td></tr></table>`;

beforeEach(() => {
  H.accounts = [
    { id: "ca_gmail", tenantId: "t_1", channel: "GMAIL", externalId: "support@acme.test", isActive: true, connectionStatus: "CONNECTED", credentials: "enc" },
    { id: "ca_wa", tenantId: "t_1", channel: "WHATSAPP", externalId: "123", isActive: true, connectionStatus: "CONNECTED", credentials: {} },
    { id: "ca_other", tenantId: "t_2", channel: "GMAIL", externalId: "x@other.test", isActive: true, connectionStatus: "CONNECTED", credentials: {} },
  ];
  H.settings.clear();
  H.audits.length = 0;
  H.sends.length = 0;
  H.sendResult = "ext_1";
  H.user = { email: "owner@acme.test", name: "Owner Name" };
});

describe("GET", () => {
  it("never saved: off, null html", async () => {
    const r = await request(app).get(URL);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false, html: null, updatedAt: null });
  });
  it("another tenant's account is 404, a non-email channel is 404 with its own code", async () => {
    expect((await request(app).get("/api/channels/ca_other/email-template")).body).toEqual({ error: "CHANNEL_NOT_FOUND" });
    const wa = await request(app).get("/api/channels/ca_wa/email-template");
    expect(wa.status).toBe(404);
    expect(wa.body).toEqual({ error: "EMAIL_TEMPLATE_NOT_EMAIL_CHANNEL" });
  });
});

describe("★ PUT", () => {
  it("saves the SANITIZED html, says what was removed, and GET returns it", async () => {
    const r = await request(app).put(URL).send({ enabled: true, html: `<div onclick="x()">{{content}}</div><script>bad()</script>` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, html: "<div>{{content}}</div>", removed: ["script", "on*"] });
    expect(typeof r.body.updatedAt).toBe("string");
    const g = await request(app).get(URL);
    expect(g.body).toMatchObject({ enabled: true, html: "<div>{{content}}</div>" });
  });

  it("422 when {{content}} is missing", async () => {
    const r = await request(app).put(URL).send({ enabled: true, html: "<p>hi</p>" });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: "EMAIL_TEMPLATE_CONTENT_PLACEHOLDER_MISSING" });
    expect(H.settings.size).toBe(0);
  });

  it("422 over 100 KB in UTF-8 bytes", async () => {
    const r = await request(app).put(URL).send({ enabled: true, html: "{{content}}" + "ש".repeat(60_000) });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: "EMAIL_TEMPLATE_TOO_LARGE", max: 102400 });
  });

  it("422 enabled=true with nothing saved and no html", async () => {
    const r = await request(app).put(URL).send({ enabled: true });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: "EMAIL_TEMPLATE_NOT_SET" });
  });

  it("toggling sends only `enabled` and keeps the stored html", async () => {
    await request(app).put(URL).send({ enabled: true, html: GOOD });
    const r = await request(app).put(URL).send({ enabled: false });
    expect(r.body).toMatchObject({ enabled: false, html: GOOD, removed: [] });
  });

  it("400 on wrong types", async () => {
    expect((await request(app).put(URL).send({ enabled: "yes" })).status).toBe(400);
  });

  it("★ every change is audited, with a fingerprint and not the html", async () => {
    await request(app).put(URL).send({ enabled: true, html: GOOD });
    expect(H.audits).toHaveLength(1);
    const a = H.audits[0];
    expect(a).toMatchObject({ tenantId: "t_1", actorId: "u_1", action: "channel.email_template_updated", targetId: "ca_gmail" });
    expect(a.metadata).toMatchObject({ enabled: true, htmlChanged: true, removed: [] });
    expect(a.metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(a.metadata)).not.toContain("{{content}}");
  });
});

describe("★ POST test", () => {
  it("sends to the caller's own address only, with the stored template forced on", async () => {
    await request(app).put(URL).send({ enabled: false, html: GOOD });
    const r = await request(app).post(`${URL}/test`).send({ to: "someone-else@evil.test" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sentTo: "owner@acme.test" });
    const [creds, externalId, to, , , ctx] = H.sends[0];
    expect(creds).toEqual({ decrypted: "enc" });
    expect(externalId).toBe("support@acme.test");
    expect(to).toBe("owner@acme.test");
    expect(ctx).toMatchObject({ templateOverride: GOOD, senderName: "Owner Name", customerName: "Sample customer" });
    // The sample is the content: placeholder syntax in it would arrive literally.
    expect(H.sends[0][3]).not.toMatch(/\{\{/);
  });

  it("422 when nothing is saved; 409 when the account is disconnected; 502 when the provider refuses", async () => {
    expect((await request(app).post(`${URL}/test`)).body).toEqual({ error: "EMAIL_TEMPLATE_NOT_SET" });
    await request(app).put(URL).send({ enabled: true, html: GOOD });
    H.accounts[0].connectionStatus = "DISCONNECTED";
    expect((await request(app).post(`${URL}/test`)).status).toBe(409);
    H.accounts[0].connectionStatus = "CONNECTED";
    H.sendResult = null;
    const r = await request(app).post(`${URL}/test`);
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("EMAIL_TEMPLATE_TEST_SEND_FAILED");
  });
});

describe("channel delete drops the template (tenant-scoped)", () => {
  it("removes only that tenant's key", async () => {
    H.settings.set("t_1|emailTemplate:ca_gmail", "x");
    H.settings.set("t_2|emailTemplate:ca_gmail", "y");
    await deleteEmailTemplateFor("t_1", "ca_gmail");
    expect([...H.settings.keys()]).toEqual(["t_2|emailTemplate:ca_gmail"]);
  });
});
