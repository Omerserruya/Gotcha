/**
 * Automations at runtime: the runner over the real flow walker, with an
 * in-memory Prisma double and a fake channel adapter.
 *
 *   - ★ one run per event (dedupe), the loop guard, one responder per inbound
 *   - ★ wait for reply: parks, takes the tapped button, the timeout branch,
 *     gives the conversation back to its previous owner
 *   - ★ a timed wait is moved only by its timer (an inbound used to run the
 *     rest of the flow, and the timer ran it again)
 *   - ★ a failed send ends the run failed and the conversation goes to a person
 *   - hand to AI / run a skill, paused automations, stale timers
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  db: {} as Record<string, any[]>,
  seq: 0,
  sent: [] as Array<{ kind: string; body: string; extra?: any }>,
  failSend: false,
  queued: [] as any[],
  notifications: [] as any[],
  hours: { open: true, configured: true },
}));

const { processAIBot } = vi.hoisted(() => ({ processAIBot: vi.fn(async () => true) }));
vi.mock("../services/ai-bot.service", () => ({
  processAIBot,
  getBusinessHoursState: async () => ({ cfg: null, state: { configured: H.hours.configured, open: H.hours.open, nextOpening: null, timezone: "UTC" } }),
}));
vi.mock("../services/identity-link.service", () => ({ tryLinkIdentifierFromInbound: vi.fn() }));

function m(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (v instanceof Date) return +row[k] === +v;
    if (v && typeof v === "object") {
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return row[k] !== v.not;
      if ("gte" in v) return row[k] >= v.gte;
      return true;
    }
    return (row[k] ?? null) === v;
  });
}
function table(name: string) {
  const rows = () => (H.db[name] ??= []);
  return {
    findMany: async (a: any = {}) => rows().filter((r) => m(r, a.where)).map((r) => ({ ...r })),
    findFirst: async (a: any = {}) => {
      let r = rows().filter((x) => m(x, a.where));
      if (a.orderBy?.createdAt === "desc") r = [...r].sort((x, y) => +y.createdAt - +x.createdAt);
      const x = r[0];
      if (!x) return null;
      return a.include?.channelAccount ? { ...x, channelAccount: { externalId: "phone-1", credentials: {} } } : { ...x };
    },
    findUnique: async (a: any) => { const x = rows().find((r) => r.id === a.where.id || (a.where.tenantId && r.tenantId === a.where.tenantId)); return x ? { ...x } : null; },
    count: async (a: any = {}) => rows().filter((r) => m(r, a.where)).length,
    create: async (a: any) => {
      if (name === "automationRun" && rows().some((r) => r.flowId === a.data.flowId && r.eventKey === a.data.eventKey)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      const x = { id: `${name}_${++H.seq}`, createdAt: new Date(Date.now() + H.seq), startedAt: new Date(), ...a.data };
      rows().push(x);
      return { ...x };
    },
    createMany: async (a: any) => { for (const d of a.data) rows().push({ id: `${name}_${++H.seq}`, at: new Date(), ...d }); return { count: a.data.length }; },
    update: async (a: any) => {
      const x = rows().find((r) => r.id === a.where.id);
      if (!x) throw new Error(`${name} ${a.where.id} not found`);
      for (const [k, v] of Object.entries(a.data)) x[k] = (v as any)?.increment ? (x[k] ?? 0) + (v as any).increment : v;
      return { ...x };
    },
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
    sendTextMessage: async (_c: any, _a: any, _r: any, body: string) => {
      if (H.failSend) throw new Error("provider said no");
      H.sent.push({ kind: "text", body });
      return `wamid.${++H.seq}`;
    },
    sendInteractiveMessage: async (_c: any, _a: any, _r: any, body: string, buttons: any[]) => {
      if (H.failSend) throw new Error("provider said no");
      H.sent.push({ kind: "buttons", body, extra: buttons });
      return `wamid.${++H.seq}`;
    },
  }),
  decryptCredentials: () => ({}),
  publishEvent: async () => undefined,
  flowResumeQueue: { add: async (_n: string, data: any, opts: any) => { H.queued.push({ data, opts }); } },
  notificationsQueue: { add: async (_n: string, data: any) => { H.notifications.push(data); } },
  describeSendError: () => ({ sendError: { message: "provider said no" }, errorMessage: "provider said no" }),
  safeFetch: vi.fn(),
}));

import {
  runAutomationsForEvent, resumeAutomationRun, automationsForInbound, triggerMatches, scheduleDue,
  stepsFromTrace, statusAfter, runDueSchedules, LOOP_GUARD_PER_MIN,
} from "../services/automation-runner.service";
import { replyBranch, executeSubFlow } from "../services/flow-executor.service";
import { timerIsCurrent } from "../workers/flow-resume.worker";

const T = "T";
const CONV = "c1";
const flow = (id: string, nodes: any[], edges: any[], o: any = {}) => ({
  id, tenantId: T, isActive: true, triggerType: "message_received", triggerConfig: {}, activatedAt: new Date(0), nodes, edges, ...o,
});
const trig = { id: "t", type: "automation_trigger", data: {} };
const e = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });

/** Buttons → wait for reply → per button. */
const buttonsFlow = () => flow("f_btn", [
  trig,
  { id: "b", type: "send_buttons", data: { text: "Hi {{first_name}}", buttons: [{ id: "call", title: "Call me back" }, { id: "write", title: "Write here" }] } },
  { id: "w", type: "wait_for_reply", data: { timeoutMs: 1_800_000 } },
  { id: "call_msg", type: "send_message_text", data: { text: "We will call you" } },
  { id: "late", type: "send_message_text", data: { text: "Still there?" } },
  { id: "ai", type: "hand_to_ai", data: { aiAgentId: "maya" } },
], [e("t", "b"), e("b", "w"), e("w", "call_msg", "btn:call"), e("w", "ai", "btn:write"), e("w", "late", "timeout")]);

const inbound = (o: any = {}) => runAutomationsForEvent({
  tenantId: T, types: ["message_received"], eventKey: "msg:m1", conversationId: CONV, channel: "whatsapp", message: "hello", ...o,
});
const run = () => H.db.automationRun[0];
const conv = () => H.db.conversation.find((c) => c.id === CONV);

beforeEach(() => {
  H.seq = 0; H.sent = []; H.failSend = false; H.queued = []; H.notifications = [];
  H.hours = { open: true, configured: true };
  processAIBot.mockClear();
  H.db = {
    conversation: [{ id: CONV, tenantId: T, channel: "WHATSAPP", customerExternalId: "9725", handledBy: "ai_agent", status: "OPEN", chatbotNodeId: null, chatbotFlowId: null, automationRunId: null, assignedAgentId: null, isHandedOver: false, flowVariables: null, createdAt: new Date(1) }],
    chatbotFlow: [], automationRun: [], automationRunStep: [], message: [], contact: [], flowCanvas: [],
  };
});

describe("matching and scheduling (pure)", () => {
  it("keywords: contains / exact / any word; channels filter", () => {
    const f = (c: any) => ({ triggerType: "message_received", triggerConfig: c });
    expect(triggerMatches(f({ keywords: ["catalogue"] }), { type: "message_received", channel: "WHATSAPP", message: "send me the Catalogue please" })).toBe(true);
    expect(triggerMatches(f({ keywords: ["catalogue"], match: "exact" }), { type: "message_received", message: "the catalogue" })).toBe(false);
    expect(triggerMatches(f({ keywords: ["קטלוג"], match: "any_word" }), { type: "message_received", message: "שלחו קטלוג!" })).toBe(true);
    expect(triggerMatches(f({ keywords: ["cat"], match: "any_word" }), { type: "message_received", message: "catalogue" })).toBe(false);
    expect(triggerMatches(f({ channels: ["INSTAGRAM"] }), { type: "message_received", channel: "WHATSAPP", message: "x" })).toBe(false);
    expect(triggerMatches({ triggerType: "tag_added", triggerConfig: { tags: ["VIP"] } }, { type: "tag_added", tag: "vip" })).toBe(true);
  });

  it("a schedule is due on its minute in its timezone, on its days, once (the key)", () => {
    const now = new Date("2026-10-06T06:00:20Z"); // 09:00 in Jerusalem, a Tuesday
    expect(scheduleDue({ at: "09:00", timezone: "Asia/Jerusalem" }, now)).toBe("sched:2026-10-06T09:00");
    expect(scheduleDue({ at: "09:00", timezone: "Asia/Jerusalem", days: ["mon"] }, now)).toBeNull();
    expect(scheduleDue({ at: "09:01", timezone: "Asia/Jerusalem" }, now)).toBeNull();
    expect(scheduleDue({ at: "06:00", timezone: "UTC", days: ["tue"] }, now)).toBe("sched:2026-10-06T06:00");
  });

  it("run status and steps from a walk", () => {
    expect(statusAfter({ executed: true, halted: true, reason: "wait_for_reply", trace: [] }, null)).toBe("waiting");
    expect(statusAfter({ executed: false, halted: true, reason: "automation_inactive", trace: [] }, null)).toBe("skipped");
    expect(statusAfter(null, new Error("x"))).toBe("failed");
    expect(stepsFromTrace([{ nodeId: "h", type: "opening_hours", action: "evaluated", detail: { branch: "open" } }, { nodeId: "x", type: "http_request", action: "http_error" }]))
      .toMatchObject([{ nodeId: "h", status: "ok", branch: "open" }, { nodeId: "x", status: "failed", branch: null }]);
  });

  it("★ a timer acts only while the conversation is still parked on its node and run", () => {
    const job = { resumeNodeId: "w", automationRunId: "r1" };
    expect(timerIsCurrent(job, { chatbotNodeId: "w", automationRunId: "r1", status: "OPEN" })).toBe(true);
    expect(timerIsCurrent(job, { chatbotNodeId: null, automationRunId: null, status: "OPEN" })).toBe(false);
    expect(timerIsCurrent(job, { chatbotNodeId: "w", automationRunId: "r2", status: "OPEN" })).toBe(false);
    expect(timerIsCurrent(job, { chatbotNodeId: "w", automationRunId: "r1", status: "CLOSED" })).toBe(false);
  });

  it("wait for reply: the tapped button by payload, or its title typed, else reply", () => {
    const f = buttonsFlow();
    const w = f.nodes.find((n: any) => n.id === "w");
    expect(replyBranch(w, f.nodes, f.edges, "Write here", "call")).toBe("btn:call");
    expect(replyBranch(w, f.nodes, f.edges, "write here", null)).toBe("btn:write");
    expect(replyBranch(w, f.nodes, f.edges, "something else", null)).toBe("reply");
  });
});

describe("★ dispatch", () => {
  it("a matching automation sends, the run completes with its steps, and it answered the message", async () => {
    H.db.chatbotFlow.push(flow("f1", [trig, { id: "s", type: "send_message_text", data: { text: "Hi" } }], [e("t", "s")], { triggerConfig: { keywords: ["hello"] } }));
    const r = await inbound();
    expect(r.answered).toBe(true);
    expect(H.sent.map((s) => s.body)).toEqual(["Hi"]);
    expect(run()).toMatchObject({ status: "completed", answeredInbound: true, conversationId: CONV, eventKey: "msg:m1" });
    expect(H.db.automationRunStep.map((s) => [s.nodeId, s.status])).toEqual([["t", "ok"], ["s", "ok"]]);
    expect(conv().handledBy).toBe("ai_agent"); // never claimed: nothing to give back
  });

  it("★ the same event never runs the same automation twice", async () => {
    H.db.chatbotFlow.push(flow("f1", [trig, { id: "s", type: "send_message_text", data: { text: "Hi" } }], [e("t", "s")]));
    await inbound();
    const again = await inbound();
    expect(again).toEqual({ answered: false, runs: [] });
    expect(H.sent).toHaveLength(1);
    expect(H.db.automationRun).toHaveLength(1);
  });

  it("no match (keyword, inactive, other trigger) → no run, not answered", async () => {
    H.db.chatbotFlow.push(
      flow("kw", [trig], [], { triggerConfig: { keywords: ["catalogue"] } }),
      flow("off", [trig], [], { isActive: false }),
      flow("tag", [trig], [], { triggerType: "tag_added" }),
      flow("legacy", [trig], [], { triggerType: null }),
    );
    expect(await inbound()).toEqual({ answered: false, runs: [] });
  });

  it(`★ loop guard: a conversation that ran ${LOOP_GUARD_PER_MIN} automations this minute runs no more`, async () => {
    H.db.chatbotFlow.push(flow("f1", [trig, { id: "s", type: "send_message_text", data: { text: "Hi" } }], [e("t", "s")]));
    for (let i = 0; i < LOOP_GUARD_PER_MIN; i++) H.db.automationRun.push({ id: `old${i}`, tenantId: T, conversationId: CONV, flowId: "x", eventKey: `k${i}`, startedAt: new Date() });
    expect((await inbound()).runs).toEqual([]);
    expect(H.sent).toEqual([]);
  });

  it("★ one responder: once an automation answered, the next matching one does not run", async () => {
    H.db.chatbotFlow.push(
      flow("first", [trig, { id: "s", type: "send_message_text", data: { text: "First" } }], [e("t", "s")], { activatedAt: new Date(1) }),
      flow("second", [trig, { id: "s", type: "send_message_text", data: { text: "Second" } }], [e("t", "s")], { activatedAt: new Date(2) }),
    );
    const r = await inbound();
    expect(r.runs.map((x) => x.flowId)).toEqual(["first"]);
    expect(H.sent.map((s) => s.body)).toEqual(["First"]);
  });

  it("an automation that only did internal work did not answer: the AI still answers", async () => {
    H.db.contact.push({ id: "k1", tenantId: T, channel: "WHATSAPP", externalId: "9725", tags: [] });
    H.db.chatbotFlow.push(flow("f1", [trig, { id: "tag", type: "add_tag", data: { tag: "lead" } }], [e("t", "tag")]));
    expect((await inbound()).answered).toBe(false);
    expect(H.db.contact[0].tags).toEqual(["lead"]);
  });

  it("opening hours branches open / closed", async () => {
    H.hours.open = false;
    H.db.chatbotFlow.push(flow("f1", [
      trig, { id: "h", type: "opening_hours", data: {} },
      { id: "o", type: "send_message_text", data: { text: "open" } }, { id: "c", type: "send_message_text", data: { text: "closed" } },
    ], [e("t", "h"), e("h", "o", "open"), e("h", "c", "closed")]));
    await inbound();
    expect(H.sent.map((s) => s.body)).toEqual(["closed"]);
    expect(H.db.automationRunStep.find((s) => s.nodeId === "h").branch).toBe("closed");
  });
});

describe("★ wait for reply", () => {
  it("parks: claims the conversation, remembers the owner, sets the timeout timer", async () => {
    H.db.chatbotFlow.push(buttonsFlow());
    const r = await inbound();
    expect(r.answered).toBe(true);
    expect(H.sent[0]).toMatchObject({ kind: "buttons", extra: [{ id: "call", title: "Call me back" }, { id: "write", title: "Write here" }] });
    expect(run()).toMatchObject({ status: "waiting", currentNodeId: "w" });
    expect(conv()).toMatchObject({ chatbotNodeId: "w", chatbotFlowId: "f_btn", automationRunId: run().id, handledBy: "flow" });
    expect(conv().flowVariables).toMatchObject({ __automationRunId: run().id, __automationPrevOwner: "ai_agent" });
    expect(H.queued[0]).toMatchObject({ data: { resumeNodeId: "w", automationRunId: run().id, timeout: true }, opts: { delay: 1_800_000 } });
  });

  it("★ the tapped button picks the branch; at the end the conversation goes back to its owner", async () => {
    H.db.chatbotFlow.push(buttonsFlow());
    await inbound();
    const r = await automationsForInbound({ tenantId: T, conversation: conv(), messageId: "m2", message: "Call me back", channel: "whatsapp", replyPayload: "call" });
    expect(r).toBe(true);
    expect(H.sent.map((s) => s.body)).toEqual(["Hi ", "We will call you"]);
    expect(run()).toMatchObject({ status: "completed", currentNodeId: null });
    expect(conv()).toMatchObject({ chatbotNodeId: null, chatbotFlowId: null, automationRunId: null, handledBy: "ai_agent" });
    expect(conv().flowVariables).not.toHaveProperty("__automationRunId");
    expect(H.db.automationRunStep.filter((s) => s.nodeId === "w").map((s) => [s.status, s.branch])).toEqual([["waiting", null], ["ok", "btn:call"]]);
  });

  it("the timeout takes the timeout branch", async () => {
    H.db.chatbotFlow.push(buttonsFlow());
    await inbound();
    await resumeAutomationRun({ tenantId: T, conversationId: CONV, runId: run().id, message: "", channel: "whatsapp", fromTimer: true, timeout: true });
    expect(H.sent.map((s) => s.body)).toEqual(["Hi ", "Still there?"]);
    expect(run().status).toBe("completed");
  });

  it("★ 'Hand to AI employee' hands over with the customer's message; the run ends, the AI owns it", async () => {
    H.db.chatbotFlow.push(buttonsFlow());
    await inbound();
    const answered = await automationsForInbound({ tenantId: T, conversation: conv(), messageId: "m2", message: "Write here", channel: "whatsapp", replyPayload: "write" });
    expect(answered).toBe(true);
    expect(processAIBot).toHaveBeenCalledWith(T, CONV, "Write here", "maya");
    expect(conv()).toMatchObject({ assignedAiAgentId: "maya", handledBy: "ai_agent", automationRunId: null, chatbotNodeId: null });
    expect(run().status).toBe("completed");
  });

  it("'Run a skill' passes the skill to the employee", async () => {
    H.db.chatbotFlow.push(flow("f1", [trig, { id: "sk", type: "run_skill", data: { aiAgentId: "maya", skillId: "sk_exchange" } }], [e("t", "sk")]));
    await inbound();
    expect(processAIBot).toHaveBeenCalledWith(T, CONV, "hello", "maya", "sk_exchange");
  });

  it("a reply with no matching exit ends the run without answering (the AI answers it)", async () => {
    const f = buttonsFlow();
    f.edges = f.edges.filter((x: any) => x.sourceHandle !== "btn:write");
    H.db.chatbotFlow.push(f);
    await inbound();
    expect(await automationsForInbound({ tenantId: T, conversation: conv(), messageId: "m2", message: "Write here", channel: "whatsapp", replyPayload: "write" })).toBe(false);
    expect(run().status).toBe("completed");
    expect(conv()).toMatchObject({ automationRunId: null, handledBy: "ai_agent" });
  });

  it("a run parked when its automation was paused is skipped and lets go", async () => {
    H.db.chatbotFlow.push(buttonsFlow());
    await inbound();
    H.db.chatbotFlow[0].isActive = false;
    expect(await automationsForInbound({ tenantId: T, conversation: conv(), messageId: "m2", message: "x", channel: "whatsapp", replyPayload: "call" })).toBe(false);
    expect(run()).toMatchObject({ status: "skipped", error: "automation_inactive" });
    expect(conv()).toMatchObject({ automationRunId: null, chatbotNodeId: null, handledBy: "ai_agent" });
  });

  it("no new automation starts while a run is parked on the conversation", async () => {
    H.db.chatbotFlow.push(buttonsFlow(), flow("other", [trig, { id: "s", type: "send_message_text", data: { text: "Other" } }], [e("t", "s")], { activatedAt: new Date(9) }));
    await inbound();
    await automationsForInbound({ tenantId: T, conversation: conv(), messageId: "m2", message: "Call me back", channel: "whatsapp", replyPayload: "call" });
    expect(H.sent.map((s) => s.body)).not.toContain("Other");
  });
});

describe("★ timed wait", () => {
  const waitFlow = () => flow("f_wait", [
    trig, { id: "s1", type: "send_message_text", data: { text: "Hi" } },
    { id: "wt", type: "wait", data: { durationMs: 172_800_000 } }, { id: "s2", type: "send_message_text", data: { text: "Two days later" } },
  ], [e("t", "s1"), e("s1", "wt"), e("wt", "s2")]);

  it("parks WITHOUT claiming: the owner keeps answering; an inbound does not move it; the timer does", async () => {
    H.db.chatbotFlow.push(waitFlow());
    await inbound();
    expect(conv()).toMatchObject({ chatbotNodeId: "wt", automationRunId: run().id, handledBy: "ai_agent" });
    expect(H.queued[0]).toMatchObject({ data: { resumeNodeId: "wt", automationRunId: run().id }, opts: { delay: 172_800_000 } });

    const during = await automationsForInbound({ tenantId: T, conversation: conv(), messageId: "m2", message: "hi again", channel: "whatsapp" });
    expect(during).toBe(false);
    expect(H.sent.map((s) => s.body)).toEqual(["Hi"]); // nothing ran past the wait
    expect(run().status).toBe("waiting");

    await resumeAutomationRun({ tenantId: T, conversationId: CONV, runId: run().id, message: "", channel: "whatsapp", fromTimer: true });
    expect(H.sent.map((s) => s.body)).toEqual(["Hi", "Two days later"]);
    expect(run().status).toBe("completed");
    expect(conv()).toMatchObject({ automationRunId: null, chatbotNodeId: null, handledBy: "ai_agent" });
  });

  it("★ the same fix for playbook sub-flows: an inbound on a timed wait does not walk on", async () => {
    H.db.chatbotFlow.push({ ...waitFlow(), id: "sub", triggerType: null });
    Object.assign(conv(), { chatbotNodeId: "wt", chatbotFlowId: "sub", handledBy: "flow" });
    const r = await executeSubFlow({ tenantId: T, conversationId: CONV, message: "hi", channel: "whatsapp", flowId: "sub", resumeNodeId: "wt" });
    expect(r.reason).toBe("waiting_on_timer");
    expect(H.sent).toEqual([]);
  });
});

describe("★ failures", () => {
  it("a failed send ends the run failed with the reason; nobody owned it → the team queue", async () => {
    conv().handledBy = null;
    H.failSend = true;
    H.db.chatbotFlow.push(flow("f1", [trig, { id: "s", type: "send_message_text", data: { text: "Hi" } }], [e("t", "s")]));
    const r = await inbound();
    expect(r.answered).toBe(false);
    expect(run()).toMatchObject({ status: "failed" });
    expect(run().error).toMatch(/provider said no/);
    expect(H.db.automationRunStep.find((s) => s.status === "failed")).toMatchObject({ nodeId: "s" });
    expect(conv()).toMatchObject({ status: "WAITING", handledBy: "human" });
  });

  it("a failed send on an AI-owned conversation leaves it with the AI", async () => {
    H.failSend = true;
    H.db.chatbotFlow.push(flow("f1", [trig, { id: "s", type: "send_message_text", data: { text: "Hi" } }], [e("t", "s")]));
    await inbound();
    expect(conv()).toMatchObject({ handledBy: "ai_agent", status: "OPEN" });
  });
});

describe("customer-less runs", () => {
  it("a due schedule runs once per minute; a send has no customer and does nothing", async () => {
    H.db.chatbotFlow.push(flow("sch", [trig, { id: "n", type: "notify_team", data: { message: "daily report" } }], [e("t", "n")], { triggerType: "schedule", triggerConfig: { at: "09:00", timezone: "Asia/Jerusalem" } }));
    const now = new Date("2026-10-06T06:00:05Z");
    expect(await runDueSchedules(now)).toBe(1);
    expect(await runDueSchedules(new Date("2026-10-06T06:00:35Z"))).toBe(0); // same minute: deduped
    expect(run()).toMatchObject({ status: "completed", eventKey: "sched:2026-10-06T09:00" });
    expect(run().conversationId ?? null).toBeNull();
    expect(H.notifications[0]).toMatchObject({ type: "automation.notify_team", tenantId: T, data: { message: "daily report" } });
  });
});

describe("★ message from an ad, button tapped, AI writes a message", () => {
  it("matching: any ad or chosen ads (lenient); a chosen button or any tap", () => {
    const f = (type: string, c: any) => ({ triggerType: type, triggerConfig: c });
    expect(triggerMatches(f("message_from_ad", {}), { type: "message_from_ad", adId: "120201" })).toBe(true);
    expect(triggerMatches(f("message_from_ad", { adIds: [" 120201 "] }), { type: "message_from_ad", adId: "120201" })).toBe(true);
    expect(triggerMatches(f("message_from_ad", { adIds: ["999"] }), { type: "message_from_ad", adId: "120201" })).toBe(false);
    expect(triggerMatches(f("button_tapped", { payloads: ["CALL_ME"] }), { type: "button_tapped", payload: "call_me" })).toBe(true);
    expect(triggerMatches(f("button_tapped", {}), { type: "button_tapped", payload: null })).toBe(false);
  });

  it("★ an ad conversation's FIRST message fires the ad automation; the next one does not", async () => {
    Object.assign(conv(), { fromAdCampaign: true, referralSourceId: "120201", handledBy: null });
    H.db.chatbotFlow.push(flow("ad", [trig, { id: "s", type: "send_message_text", data: { text: "Thanks for clicking our ad" } }], [e("t", "s")], { triggerType: "message_from_ad", triggerConfig: { adIds: ["120201"] } }));
    H.db.message.push({ id: "in1", conversationId: CONV, direction: "INBOUND" });
    expect(await automationsForInbound({ tenantId: T, conversation: conv(), messageId: "in1", message: "hi", channel: "whatsapp" })).toBe(true);
    H.db.message.push({ id: "in2", conversationId: CONV, direction: "INBOUND" });
    expect(await automationsForInbound({ tenantId: T, conversation: conv(), messageId: "in2", message: "and another", channel: "whatsapp" })).toBe(false);
    expect(H.sent.map((s) => s.body)).toEqual(["Thanks for clicking our ad"]);
  });

  it("★ a tap with no flow waiting fires the button automation; plain text does not", async () => {
    H.db.chatbotFlow.push(flow("btn", [trig, { id: "s", type: "send_message_text", data: { text: "We will call you" } }], [e("t", "s")], { triggerType: "button_tapped", triggerConfig: { payloads: ["call_me"] } }));
    H.db.message.push({ id: "m1", conversationId: CONV, direction: "INBOUND" }, { id: "m0", conversationId: CONV, direction: "INBOUND" });
    expect(await automationsForInbound({ tenantId: T, conversation: conv(), messageId: "m1", message: "Call me", channel: "whatsapp", replyPayload: "call_me" })).toBe(true);
    expect(await automationsForInbound({ tenantId: T, conversation: conv(), messageId: "m2", message: "call_me", channel: "whatsapp" })).toBe(false);
    // A different button than the one chosen does not fire it.
    expect(await automationsForInbound({ tenantId: T, conversation: conv(), messageId: "m3", message: "Write here", channel: "whatsapp", replyPayload: "write" })).toBe(false);
  });

  it("★ AI writes a message: the employee's one-shot is sent; with no employee nothing is", async () => {
    const realFetch = global.fetch;
    const calls: any[] = [];
    (global as any).fetch = async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ reply: "Hi Dana, your order ships today." }) }; };
    try {
      H.db.chatbotFlow.push(flow("ai", [trig, { id: "g", type: "ai_generate", data: { prompt: "Tell them it ships today", aiAgentId: "maya" } }], [e("t", "g")]));
      await inbound();
      expect(calls[0]).toMatchObject({ url: expect.stringMatching(/\/api\/ai-bot\/oneshot$/), body: { tenantId: T, aiAgentId: "maya", feature: "automation_ai_generate" } });
      expect(calls[0].body.userInput).toMatch(/Tell them it ships today[\s\S]*hello/);
      expect(H.sent.map((s) => s.body)).toEqual(["Hi Dana, your order ships today."]);

      H.sent = []; calls.length = 0;
      H.db.chatbotFlow = [flow("ai2", [trig, { id: "g", type: "ai_generate", data: { prompt: "x" } }], [e("t", "g")])];
      await inbound({ eventKey: "msg:other" });
      expect(calls).toEqual([]);
      expect(H.sent).toEqual([]);
    } finally { (global as any).fetch = realFetch; }
  });
});
