/**
 * B3 (Smoovee 2026-11-09): a conversation only the AI employee answers gets a
 * reminder after the bot's last message, then a closing message and a close.
 * "idleAutomation" acted only on conversations a person holds. Never on a
 * conversation handed to a person; never after the customer replied.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ config: null as any, convs: [] as any[], msgs: [] as any[], queued: [] as any[], seq: 0 }));

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("notIn" in v) return row[k] != null && !v.notIn.includes(row[k]);
      if ("not" in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", async () => ({
  prisma: {
    conversation: {
      findMany: vi.fn(async (a: any) => H.convs.filter((c) => matches(c, a.where)).map((c) => ({ ...c, channelAccount: { id: c.channelAccountId, channel: c.channel } }))),
      findFirst: vi.fn(async (a: any) => H.convs.find((c) => matches(c, a.where)) ?? null),
      update: vi.fn(async (a: any) => { Object.assign(H.convs.find((c) => c.id === a.where.id), a.data); return {}; }),
    },
    message: {
      findFirst: vi.fn(async (a: any) => {
        const rows = H.msgs.filter((m) => m.conversationId === a.where.conversationId && (a.where.messageType?.not ? m.messageType !== a.where.messageType.not : true));
        return rows.sort((x, y) => +y.createdAt - +x.createdAt)[0] ?? null;
      }),
      create: vi.fn(async (a: any) => { const m = { id: `m${++H.seq}`, createdAt: new Date(), ...a.data }; H.msgs.push(m); return m; }),
    },
  },
  createWorker: vi.fn(),
  idleConversationQueue: { add: vi.fn() },
  outgoingMessageQueue: { add: vi.fn(async (_n: string, d: any) => { H.queued.push(d); }) },
  publishEvent: vi.fn(async () => undefined),
  readDurableSetting: vi.fn(async (_t: string, k: string) => (k === "botIdleAutomation" && H.config ? JSON.stringify(H.config) : null)),
  buildTemplateComponents: vi.fn(),
  renderTemplateText: vi.fn(),
}));

import { botIdleForTenant, botIdleStep, parseBotIdleConfig } from "../workers/idle-conversation.worker";

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const A = "היי, עדיין כאן?";
const B = "סוגרת את השיחה בינתיים.";
const conv = (id: string, over: any = {}) => ({
  id, tenantId: "T", channel: "WEBCHAT", channelAccountId: "ca_web", customerExternalId: `sess_${id}`, status: "OPEN",
  assignedAgentId: null, isHandedOver: false, automationRunId: null, handledBy: "ai_agent", lastMessageAt: new Date(), reminderSentAt: null, ...over,
});
const msg = (conversationId: string, direction: string, minutesAgo: number, over: any = {}) =>
  H.msgs.push({ id: `m${++H.seq}`, conversationId, direction, messageType: "text", createdAt: ago(minutesAgo * MIN), senderName: direction === "OUTBOUND" ? "AI Bot" : "Visitor", metadata: direction === "OUTBOUND" ? { source: "ai_bot" } : null, ...over });
const sent = (id: string) => H.queued.filter((q) => q.conversationId === id).map((q) => q.body);

beforeEach(() => {
  H.convs = []; H.msgs = []; H.queued = []; H.seq = 0;
  H.config = { reminderEnabled: true, reminderDelayMinutes: 10, reminderMessage: A, autoCloseEnabled: true, autoCloseDelayMinutes: 10, autoCloseMessage: B, channels: ["WEBCHAT"] };
});

describe("the bot's conversation: reminder, then close", () => {
  it("10 minutes after the bot: the reminder (tagged), not yet closed; 10 after the reminder: B and closed", async () => {
    H.convs = [conv("bot")];
    msg("bot", "INBOUND", 13);
    msg("bot", "OUTBOUND", 12);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 1, closes: 0 });
    expect(sent("bot")).toEqual([A]);
    expect(H.msgs.at(-1)).toMatchObject({ body: A, metadata: { source: "idle_reminder" }, senderName: "AI Bot" });
    expect(H.convs[0].status).toBe("OPEN");
    // The next sweep, five minutes on: the reminder is too fresh to close on.
    H.msgs.at(-1).createdAt = ago(5 * MIN);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    // Ten minutes after the reminder.
    H.msgs.at(-1).createdAt = ago(11 * MIN);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 1 });
    expect(sent("bot")).toEqual([A, B]);
    expect(H.convs[0].status).toBe("CLOSED");
    expect(H.msgs.find((m) => m.messageType === "system")?.metadata).toEqual({ systemEvent: "auto_closed", reason: "bot_idle" });
    // Closed: nothing more.
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
  });

  it("not yet 10 minutes: nothing", async () => {
    H.convs = [conv("fresh")];
    msg("fresh", "OUTBOUND", 9);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
  });
});

describe("never touched", () => {
  it("handed to a person, assigned, a flow's, awaiting approval, or another channel: nothing", async () => {
    H.convs = [
      conv("handed", { isHandedOver: true, handledBy: "human", status: "WAITING" }),
      // The widget's "talk to a person" sets isHandedOver + WAITING and leaves handledBy.
      conv("asked", { isHandedOver: true, status: "WAITING" }),
      conv("assigned", { assignedAgentId: "u1" }),
      conv("flow", { automationRunId: "run1", handledBy: "flow" }),
      conv("approval", { handledBy: "awaiting_approval" }),
      conv("wa", { channel: "WHATSAPP" }),
    ];
    for (const c of H.convs) msg(c.id, "OUTBOUND", 30);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.queued).toHaveLength(0);
  });

  it("the customer replied after the bot, or a person wrote last: nothing", async () => {
    H.convs = [conv("replied"), conv("person")];
    msg("replied", "OUTBOUND", 40);
    msg("replied", "INBOUND", 30);
    msg("person", "OUTBOUND", 30, { senderName: "dana@shop.co.il", metadata: null });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
  });

  it("handed over between the check and the send: nothing sent", async () => {
    H.convs = [conv("race")];
    msg("race", "OUTBOUND", 30);
    const { prisma } = (await import("@chatcenter/shared")) as any;
    prisma.conversation.findFirst.mockImplementationOnce(async () => { H.convs[0].isHandedOver = true; return null; });
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(H.queued).toHaveLength(0);
  });

  it("no setting, or both steps off: nothing read further", async () => {
    H.config = null;
    H.convs = [conv("bot")];
    msg("bot", "OUTBOUND", 30);
    expect(await botIdleForTenant("T")).toEqual({ reminders: 0, closes: 0 });
    expect(parseBotIdleConfig(JSON.stringify({ reminderEnabled: false, autoCloseEnabled: false }))).toBeNull();
  });
});

describe("the step rule", () => {
  const cfg = parseBotIdleConfig(JSON.stringify({ reminderEnabled: true, reminderDelayMinutes: 10, reminderMessage: A, autoCloseEnabled: true, autoCloseDelayMinutes: 10, autoCloseMessage: B }))!;
  const m = (minutes: number, over: any = {}) => ({ direction: "OUTBOUND", createdAt: ago(minutes * MIN), metadata: { source: "ai_bot" }, senderName: "AI Bot", ...over });
  it("channels default to WEBCHAT", () => expect(cfg.channels).toEqual(["WEBCHAT"]));
  it("bot → remind; reminder → close; our close → never again; a customer → null", () => {
    expect(botIdleStep(m(11), cfg)).toBe("remind");
    expect(botIdleStep(m(11, { metadata: { source: "idle_reminder" } }), cfg)).toBe("close");
    expect(botIdleStep(m(60, { metadata: { source: "idle_close" } }), cfg)).toBeNull();
    expect(botIdleStep({ direction: "INBOUND", createdAt: ago(60 * MIN) }, cfg)).toBeNull();
  });
  it("no reminder step: the close counts from the bot", () => {
    const closeOnly = { ...cfg, reminderEnabled: false };
    expect(botIdleStep(m(11), closeOnly)).toBe("close");
    expect(botIdleStep(m(9), closeOnly)).toBeNull();
  });
});
