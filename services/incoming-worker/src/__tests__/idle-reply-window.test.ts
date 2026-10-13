/**
 * Idle reminders and auto-close respect the customer-service window (B8,
 * 2026-10-12). Outside it the reminder or close message is skipped and
 * logged (free text there failed at Meta, 131047); the close still happens;
 * a skipped reminder is marked handled for this silence. Settings are read
 * durably (TenantSetting "idleAutomation"), not from Redis alone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  config: null as any,
  reads: [] as any[],
  convs: [] as any[],
  created: [] as any[],
  queued: [] as any[],
  updates: [] as any[],
  lastInbound: null as Date | null,
  lookups: [] as any[],
  templates: [] as any[],
  locale: "he",
}));

vi.mock("@chatcenter/shared", async () => {
  const tc = await vi.importActual<any>("../../../../packages/shared/src/lib/template-components");
  return {
  buildTemplateComponents: tc.buildTemplateComponents,
  renderTemplateText: tc.renderTemplateText,
  prisma: {
    tenant: { findUnique: vi.fn(async () => ({ defaultLocale: H.locale })) },
    messageTemplate: {
      findMany: vi.fn(async (a: any) => H.templates.filter((t) => t.tenantId === a.where.tenantId && t.name === a.where.name && t.status === a.where.status
        && t.isActive === a.where.isActive && a.where.OR.some((o: any) => o.channelAccountId === t.channelAccountId))),
    },
    conversation: {
      findMany: vi.fn(async (a: any) => H.convs.filter((c) => c.tenantId === a.where.tenantId)),
      update: vi.fn(async (a: any) => { H.updates.push({ id: a.where.id, ...a.data }); return {}; }),
    },
    message: { create: vi.fn(async (a: any) => { H.created.push(a.data); return { id: `m${H.created.length}` }; }) },
  },
  createWorker: vi.fn(),
  idleConversationQueue: { add: vi.fn() },
  outgoingMessageQueue: { add: vi.fn(async (_n: string, d: any) => { H.queued.push(d); }) },
  publishEvent: vi.fn(async () => undefined),
  readDurableSetting: vi.fn(async (t: string, k: string) => { H.reads.push([t, k]); return H.config ? JSON.stringify(H.config) : null; }),
  };
});
vi.mock("@chatcenter/shared/src/lib/reply-window", async () => {
  const actual = await vi.importActual<any>("../../../../packages/shared/src/lib/reply-window");
  return { ...actual, lastInboundAtForRecipient: vi.fn(async (a: any) => { H.lookups.push(a); return H.lastInbound; }) };
});

import { idleAutomationForTenant } from "../workers/idle-conversation.worker";

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);
const conv = (channel: string, idleMs: number, over: any = {}) => ({
  id: `c-${channel}`, tenantId: "T", channel, channelAccountId: "ca1", customerExternalId: channel === "GMAIL" ? "a@b.c" : "972541111111",
  status: "OPEN", reminderSentAt: null,
  messages: [{ direction: "OUTBOUND", createdAt: ago(idleMs), messageType: "text" }],
  channelAccount: { id: "ca1", channel }, assignedAgent: { id: "u1", name: "Dana" }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  H.reads = []; H.created = []; H.queued = []; H.updates = []; H.lookups = [];
  H.lastInbound = null;
  H.templates = [];
  H.locale = "he";
  H.config = { reminderEnabled: true, reminderDelayMinutes: 60, reminderMessage: "Still there?", autoCloseEnabled: true, autoCloseDelayMinutes: 48 * 60, autoCloseMessage: "Closing this chat." };
});

describe("★ the reminder", () => {
  it("WhatsApp, customer silent > 24h: skipped, nothing queued, marked handled", async () => {
    H.convs = [conv("WHATSAPP", 2 * HOUR)];
    H.lastInbound = ago(30 * HOUR);
    const r = await idleAutomationForTenant("T");
    expect(r).toEqual({ reminders: 0, closes: 0, skippedOutsideWindow: 1 });
    expect(H.queued).toHaveLength(0);
    expect(H.created).toHaveLength(0);
    expect(H.updates[0]).toMatchObject({ id: "c-WHATSAPP", reminderSentAt: expect.any(Date) });
  });

  it("WhatsApp inside the window: sent as before", async () => {
    H.convs = [conv("WHATSAPP", 2 * HOUR)];
    H.lastInbound = ago(3 * HOUR);
    const r = await idleAutomationForTenant("T");
    expect(r).toMatchObject({ reminders: 1, skippedOutsideWindow: 0 });
    expect(H.queued).toEqual([expect.objectContaining({ body: "Still there?", messageType: "text", recipientExternalId: "972541111111" })]);
  });

  it("email has no window: sent, no lookup", async () => {
    H.convs = [conv("GMAIL", 2 * HOUR)];
    await idleAutomationForTenant("T");
    expect(H.queued).toHaveLength(1);
    expect(H.lookups).toHaveLength(0);
  });
});

describe("★ the auto-close", () => {
  it("Instagram past the window: closed, without the close message", async () => {
    H.convs = [conv("INSTAGRAM", 50 * HOUR)];
    H.lastInbound = ago(60 * HOUR);
    const r = await idleAutomationForTenant("T");
    expect(r).toMatchObject({ closes: 1, skippedOutsideWindow: 1 });
    expect(H.queued).toHaveLength(0);
    expect(H.updates.find((u) => u.status === "CLOSED")).toBeTruthy();
    // Only the system "auto_closed" row is written.
    expect(H.created.map((c) => c.messageType)).toEqual(["system"]);
  });

  it("inside the window: the close message goes, then the close", async () => {
    H.convs = [conv("WHATSAPP", 50 * HOUR)];
    H.lastInbound = ago(1 * HOUR);
    await idleAutomationForTenant("T");
    expect(H.queued).toEqual([expect.objectContaining({ body: "Closing this chat." })]);
    expect(H.updates.find((u) => u.status === "CLOSED")).toBeTruthy();
  });
});

describe("settings", () => {
  it("read durably, for this tenant", async () => {
    H.convs = [];
    await idleAutomationForTenant("T");
    expect(H.reads).toEqual([["T", "idleAutomation"]]);
  });
  it("none set, or both off: nothing happens", async () => {
    H.convs = [conv("WHATSAPP", 50 * HOUR)];
    H.config = null;
    expect(await idleAutomationForTenant("T")).toEqual({ reminders: 0, closes: 0, skippedOutsideWindow: 0 });
    H.config = { reminderEnabled: false, autoCloseEnabled: false };
    expect(await idleAutomationForTenant("T")).toEqual({ reminders: 0, closes: 0, skippedOutsideWindow: 0 });
    expect(H.updates).toHaveLength(0);
  });
});

describe("★ past WhatsApp's window, the approved follow-up template (B9, 2026-10-13)", () => {
  const tpl = (over: any) => ({ id: "t", tenantId: "T", name: "gotcha_followup", status: "APPROVED", isActive: true, channel: "WHATSAPP", channelAccountId: "ca1", language: "he",
    body: "היי {{1}}, לא שמענו ממך.", variables: [{ key: "1", sample: "דנה" }], ...over });

  it("sends the template in place of the free-text reminder, with the customer's name", async () => {
    H.convs = [conv("WHATSAPP", 2 * HOUR, { customerName: "נועה" })];
    H.lastInbound = ago(30 * HOUR);
    H.templates = [tpl({})];
    const r = await idleAutomationForTenant("T");
    expect(r).toEqual({ reminders: 1, closes: 0, skippedOutsideWindow: 0 });
    expect(H.queued).toEqual([expect.objectContaining({
      messageType: "template", templateName: "gotcha_followup", templateLanguage: "he", body: "היי נועה, לא שמענו ממך.",
      templateComponents: [{ type: "body", parameters: [{ type: "text", text: "נועה" }] }],
    })]);
    expect(H.created[0]).toMatchObject({ messageType: "template", metadata: { source: "idle_followup", template: { id: "t", name: "gotcha_followup", language: "he" } } });
    expect(H.updates[0]).toMatchObject({ reminderSentAt: expect.any(Date) });
  });

  it("this number's own template first, in the workspace's language", async () => {
    H.convs = [conv("WHATSAPP", 2 * HOUR)];
    H.lastInbound = ago(30 * HOUR);
    H.templates = [tpl({ id: "unbound-he", channelAccountId: null }), tpl({ id: "mine-en", language: "en" }), tpl({ id: "mine-he" })];
    await idleAutomationForTenant("T");
    expect(H.created[0].metadata.template.id).toBe("mine-he");
  });

  it("no approved follow-up: skipped as before", async () => {
    H.convs = [conv("WHATSAPP", 2 * HOUR)];
    H.lastInbound = ago(30 * HOUR);
    H.templates = [tpl({ status: "PENDING_APPROVAL" }), tpl({ id: "x", channelAccountId: "ca9" })];
    expect(await idleAutomationForTenant("T")).toEqual({ reminders: 0, closes: 0, skippedOutsideWindow: 1 });
    expect(H.queued).toHaveLength(0);
  });

  it("Instagram past the window: no template exists there, skipped", async () => {
    H.convs = [conv("INSTAGRAM", 2 * HOUR)];
    H.lastInbound = ago(30 * HOUR);
    H.templates = [tpl({})];
    expect((await idleAutomationForTenant("T")).skippedOutsideWindow).toBe(1);
    expect(H.queued).toHaveLength(0);
  });
});
