/**
 * "Comment on a post" automations, through the real process-comment job and
 * the real walkers, with an in-memory Prisma double and a fake Meta adapter:
 *
 *   - ★ one run per comment (a Meta redelivery runs nothing), and when an
 *     automation took the comment the playbook's comment_trigger does not
 *     answer it again
 *   - matching: channel, chosen posts, keywords; the first live one wins
 *   - ★ public reply + private reply with buttons → parks on Wait for reply in
 *     the DM conversation it created, with the run on it and a timer inside
 *     Meta's 24 h bridge
 *   - ★ the customer's DM reply resumes it on the tapped button, and the
 *     bridge no longer closes that conversation
 *   - ★ a send Meta refuses is a failed step and the run ends failed
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  db: {} as Record<string, any[]>,
  seq: 0,
  sent: [] as Array<{ kind: string; body: string; extra?: any }>,
  failPrivateReply: false,
  queued: [] as any[],
}));

vi.mock("../services/ai-bot.service", () => ({
  processAIBot: vi.fn(async () => true),
  generateOneShotReply: vi.fn(async () => "AI says hi"),
  getBusinessHoursState: async () => ({ cfg: null, state: { configured: true, open: true, nextOpening: null, timezone: "UTC" } }),
}));
vi.mock("../services/identity-link.service", () => ({ tryLinkIdentifierFromInbound: vi.fn() }));

function m(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (v instanceof Date) return +row[k] === +v;
    if (v && typeof v === "object") {
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      if ("gte" in v) return row[k] >= v.gte;
      return true;
    }
    return (row[k] ?? null) === v;
  });
}
function table(name: string) {
  const rows = () => (H.db[name] ??= []);
  return {
    findMany: async (a: any = {}) => {
      let r = rows().filter((x) => m(x, a.where));
      if (a.orderBy?.activatedAt === "asc") r = [...r].sort((x, y) => +x.activatedAt - +y.activatedAt);
      return r.map((x) => ({ ...x }));
    },
    findFirst: async (a: any = {}) => {
      const x = rows().find((r) => m(r, a.where));
      if (!x) return null;
      return a.include?.channelAccount ? { ...x, channelAccount: { externalId: "ig-biz", credentials: {} } } : { ...x };
    },
    findUnique: async (a: any) => { const x = rows().find((r) => (a.where.id ? r.id === a.where.id : r.tenantId === a.where.tenantId)); return x ? { ...x } : null; },
    count: async (a: any = {}) => rows().filter((r) => m(r, a.where)).length,
    create: async (a: any) => {
      if (name === "automationRun" && rows().some((r) => r.flowId === a.data.flowId && r.eventKey === a.data.eventKey)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      const x = { id: `${name}_${++H.seq}`, createdAt: new Date(Date.now() + H.seq), startedAt: new Date(), ...a.data };
      rows().push(x);
      return { ...x };
    },
    createMany: async (a: any) => { for (const d of a.data) rows().push({ id: `${name}_${++H.seq}`, ...d }); return { count: a.data.length }; },
    update: async (a: any) => {
      const x = rows().find((r) => r.id === a.where.id);
      if (!x) throw new Error(`${name} ${a.where.id} not found`);
      Object.assign(x, a.data);
      return { ...x };
    },
    updateMany: async (a: any) => { const r = rows().filter((x) => m(x, a.where)); r.forEach((x) => Object.assign(x, a.data)); return { count: r.length }; },
  };
}

vi.mock("@chatcenter/shared", () => ({
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    tenant: table("tenant"),
    channelAccount: table("channelAccount"),
    conversation: table("conversation"),
    chatbotFlow: table("chatbotFlow"),
    automationRun: table("automationRun"),
    automationRunStep: table("automationRunStep"),
    message: table("message"),
    contact: table("contact"),
    flowCanvas: table("flowCanvas"),
    messageTemplate: { findFirst: async () => null },
  },
  getOutboundAdapter: () => ({
    sendPrivateReply: async (_c: any, _a: any, commentId: string, body: string, buttons?: any[]) => {
      if (H.failPrivateReply) return null;
      H.sent.push({ kind: "private_reply", body, extra: { commentId, buttons } });
      return { messageId: `mid.${++H.seq}`, recipientPsid: "psid-dana" };
    },
    sendCommentReply: async (_c: any, _a: any, commentId: string, body: string) => {
      H.sent.push({ kind: "comment_reply", body, extra: { commentId } });
      return `cmt.${++H.seq}`;
    },
    sendTextMessage: async (_c: any, _a: any, to: string, body: string) => { H.sent.push({ kind: "dm", body, extra: { to } }); return `mid.${++H.seq}`; },
    sendInteractiveMessage: async (_c: any, _a: any, to: string, body: string, buttons: any[]) => { H.sent.push({ kind: "dm_buttons", body, extra: { to, buttons } }); return `mid.${++H.seq}`; },
  }),
  decryptCredentials: () => ({}),
  publishEvent: async () => undefined,
  flowResumeQueue: { add: async (_n: string, data: any, opts: any) => { H.queued.push({ data, opts }); } },
  notificationsQueue: { add: async () => undefined },
  describeSendError: () => ({ sendError: { message: "provider said no" }, errorMessage: "provider said no" }),
  safeFetch: vi.fn(),
}));

import { processCommentTrigger, COMMENT_BRIDGE_WAIT_MAX_MS } from "../services/comment-trigger.service";
import { automationsForInbound, triggerMatches } from "../services/automation-runner.service";

const T = "T";
const e = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
const trig = { id: "t", type: "automation_trigger", data: {} };

/** Public reply → private reply with buttons → wait → per button. */
const commentFlow = (o: any = {}) => ({
  id: "f_cmt", tenantId: T, isActive: true, triggerType: "comment_received", triggerConfig: {}, activatedAt: new Date(1000),
  nodes: [
    trig,
    { id: "pub", type: "send_comment_reply", data: { mode: "text", text: "Sent you a DM, @{{comment.from.username}}" } },
    { id: "b", type: "send_buttons", data: { text: "Want the price list?", buttons: [{ id: "yes", title: "Yes please" }] } },
    { id: "w", type: "wait_for_reply", data: { timeoutMs: 3 * 24 * 3_600_000 } },
    { id: "list", type: "send_message_text", data: { text: "Here it is" } },
    { id: "late", type: "send_message_text", data: { text: "Still interested?" } },
  ],
  edges: [e("t", "pub"), e("pub", "b"), e("b", "w"), e("w", "list", "btn:yes"), e("w", "late", "timeout")],
  ...o,
});

const job = (o: any = {}) => ({
  data: {
    tenantId: T, channel: "INSTAGRAM", channelAccountId: "ca1",
    comment: { commentId: "cm1", postId: "post1", text: "price please?", fromUserId: "ig-dana", fromUsername: "dana", timestamp: new Date().toISOString(), ...o },
  },
}) as any;

/** A legacy playbook comment_trigger that would answer ANY comment. */
const legacyCanvas = () => ({
  id: "canvas1", tenantId: T,
  nodes: [
    { id: "ct", type: "comment_trigger", data: { channel: "instagram", channelId: "ca1", postId: "", keywords: [] } },
    { id: "lt", type: "send_message_text", data: { text: "LEGACY" } },
  ],
  edges: [e("ct", "lt")],
});

beforeEach(() => {
  H.seq = 0; H.sent = []; H.queued = []; H.failPrivateReply = false;
  H.db = {
    tenant: [{ id: T, status: "ACTIVE" }],
    channelAccount: [{ id: "ca1", tenantId: T, isActive: true, externalId: "ig-biz", credentials: {} }],
    chatbotFlow: [commentFlow()],
    flowCanvas: [legacyCanvas()],
  };
});

describe("★ one run per comment", () => {
  it("runs once; a redelivered comment runs nothing; the playbook does not answer it too", async () => {
    await processCommentTrigger(job());
    expect(H.sent.map((s) => s.kind)).toEqual(["comment_reply", "private_reply"]);
    expect(H.sent[0]).toMatchObject({ body: "Sent you a DM, @dana", extra: { commentId: "cm1" } });
    expect(H.sent[1]!.extra.buttons).toEqual([{ id: "yes", title: "Yes please" }]);
    expect(H.db.automationRun).toHaveLength(1);
    expect(H.db.automationRun![0]).toMatchObject({ triggerType: "comment_received", eventKey: "comment:cm1", answeredInbound: true });

    H.sent = [];
    await processCommentTrigger(job());
    expect(H.sent).toEqual([]); // not the automation, not LEGACY
    expect(H.db.automationRun).toHaveLength(1);
  });

  it("no automation accepts it → the playbook's comment trigger answers as before", async () => {
    H.db.chatbotFlow = [commentFlow({ triggerConfig: { postIds: ["other-post"] } })];
    await processCommentTrigger(job());
    expect(H.sent.map((s) => s.body)).toEqual(["LEGACY"]);
    expect(H.db.automationRun ?? []).toEqual([]);
  });
});

describe("matching", () => {
  const f = (triggerConfig: any) => ({ triggerType: "comment_received", triggerConfig });
  const ev = (o: any = {}) => ({ type: "comment_received" as const, channel: "INSTAGRAM", message: "what is the price?", postId: "post1", ...o });

  it("channel, chosen posts, keywords", () => {
    expect(triggerMatches(f({}), ev())).toBe(true);
    expect(triggerMatches(f({ channels: ["MESSENGER"] }), ev())).toBe(false);
    expect(triggerMatches(f({ postIds: ["post1", "post2"] }), ev())).toBe(true);
    expect(triggerMatches(f({ postIds: ["post2"] }), ev())).toBe(false);
    expect(triggerMatches(f({ keywords: ["price"], match: "contains" }), ev())).toBe(true);
    expect(triggerMatches(f({ keywords: ["shipping"], match: "contains" }), ev())).toBe(false);
  });

  it("the first one that went live wins", async () => {
    H.db.chatbotFlow = [
      commentFlow({ id: "f_new", activatedAt: new Date(5000), nodes: [trig, { id: "x", type: "send_comment_reply", data: { text: "NEW" } }], edges: [e("t", "x")] }),
      commentFlow({ id: "f_old", activatedAt: new Date(1000), nodes: [trig, { id: "x", type: "send_comment_reply", data: { text: "OLD" } }], edges: [e("t", "x")] }),
    ];
    await processCommentTrigger(job());
    expect(H.sent.map((s) => s.body)).toEqual(["OLD"]);
    expect(H.db.automationRun![0]).toMatchObject({ flowId: "f_old", status: "completed" });
  });
});

describe("★ parks in the DM, resumes on the reply", () => {
  it("parks on Wait for reply in the new conversation, run on it, timer inside the 24 h bridge", async () => {
    await processCommentTrigger(job());
    const run = H.db.automationRun![0];
    const conv = H.db.conversation![0];
    expect(run).toMatchObject({ status: "waiting", currentNodeId: "w", conversationId: conv.id });
    expect(conv).toMatchObject({
      channel: "INSTAGRAM", customerExternalId: "psid-dana", automationRunId: run.id, handledBy: "flow",
      chatbotFlowId: "f_cmt", chatbotNodeId: "w", flowVariables: expect.objectContaining({ __automationRunId: run.id, __automationPrevOwner: null }),
    });
    expect(conv.flowExpiresAt).toBeInstanceOf(Date);
    expect(H.queued).toHaveLength(1);
    expect(H.queued[0].data).toMatchObject({ conversationId: conv.id, flowId: "f_cmt", resumeNodeId: "w", timeout: true, automationRunId: run.id });
    // Asked for 3 days; Meta's bridge closes at 24 h.
    expect(H.queued[0].opts.delay).toBe(COMMENT_BRIDGE_WAIT_MAX_MS);
    expect(COMMENT_BRIDGE_WAIT_MAX_MS).toBeLessThan(24 * 3_600_000);
    const steps = H.db.automationRunStep!.map((s) => [s.nodeId, s.status]);
    expect(steps).toEqual([["pub", "ok"], ["b", "ok"], ["w", "waiting"]]);
  });

  it("★ the DM reply takes the tapped button's branch; the bridge marker is cleared", async () => {
    await processCommentTrigger(job());
    const conv = H.db.conversation![0];
    H.sent = [];
    const answered = await automationsForInbound({
      tenantId: T, conversation: { ...conv }, messageId: "m1", message: "Yes please", channel: "instagram", replyPayload: "yes",
    });
    expect(answered).toBe(true);
    expect(H.sent.map((s) => [s.kind, s.body])).toEqual([["dm", "Here it is"]]);
    expect(H.db.automationRun![0]).toMatchObject({ status: "completed" });
    expect(H.db.conversation![0]).toMatchObject({ automationRunId: null, flowExpiresAt: null });
  });
});

describe("★ a refused send", () => {
  it("is a failed step; the run ends failed and nothing parks", async () => {
    H.failPrivateReply = true;
    await processCommentTrigger(job());
    expect(H.sent.map((s) => s.kind)).toEqual(["comment_reply"]);
    expect(H.db.automationRun![0]).toMatchObject({ status: "failed", answeredInbound: true });
    expect(H.db.automationRunStep!.map((s) => [s.nodeId, s.status])).toEqual([["pub", "ok"], ["b", "failed"]]);
    expect(H.queued).toEqual([]);
    expect(H.db.conversation ?? []).toEqual([]);
  });
});
