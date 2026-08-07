/**
 * Dev integration: quick-reply routing against the REAL database.
 *
 * Everything here round-trips through Postgres - the FlowCanvas JSON is
 * written, read back by the executor through Prisma, and the resulting
 * outbound Message rows are read back again. That is what makes the
 * edge-order assertion meaningful: it exercises the persisted array, not a
 * literal in a test file.
 *
 * The ONLY stub is the channel adapter. A real `sendTextMessage` would post to
 * Meta with the channel's credentials and put messages on a real phone, which
 * is not something a test gets to do. `sendText` rethrows on provider error,
 * so an unstubbed adapter would also abort the walk and prove nothing.
 *
 * Skipped unless RUN_DB_TESTS=1, so the ordinary unit run stays hermetic.
 *
 * Run explicitly (needs the local stack up):
 *   RUN_DB_TESTS=1 DATABASE_URL=postgresql://postgres:postgres@localhost:5432/whatsapp_cc \
 *     npx vitest run src/__tests__/flow-quick-reply-resume.db.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const DB = process.env.RUN_DB_TESTS === "1";

const { sendTextMessage, sendInteractiveMessage } = vi.hoisted(() => ({
  sendTextMessage: vi.fn(),
  sendInteractiveMessage: vi.fn(),
}));
const { processAIBot } = vi.hoisted(() => ({ processAIBot: vi.fn() }));

vi.mock("../services/ai-bot.service", () => ({ processAIBot }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    // Real prisma, real everything else. Only the wire to Meta is cut.
    getOutboundAdapter: () => ({ sendTextMessage, sendInteractiveMessage }),
    decryptCredentials: () => ({ accessToken: "stub" }),
    publishEvent: async () => undefined,
  };
});

import { prisma, withCrossTenantAccess } from "@chatcenter/shared";
import { executeMainFlow } from "../services/flow-executor.service";

const SUFFIX = "qrdbtest";
const TENANT = `tenant-${SUFFIX}`;
const CONV = `conv-${SUFFIX}`;
const CHAN = `chan-${SUFFIX}`;

// label !== payload, exactly as specified.
const REPLIES = [
  { id: "r1", label: "Continue", payload: "continue_shopping" },
  { id: "r2", label: "Talk to an agent", payload: "talk_to_agent" },
];

const NODES = [
  { id: "e0", type: "channel_entry", data: { channel: "whatsapp" }, position: { x: 0, y: 0 } },
  { id: "A", type: "send_message_text", data: { text: "message A" }, position: { x: 0, y: 100 } },
  { id: "B", type: "send_message_quick_reply", data: { text: "pick one", replies: REPLIES }, position: { x: 0, y: 200 } },
  { id: "C", type: "send_message_text", data: { text: "message C" }, position: { x: 0, y: 300 } },
  { id: "AI", type: "route_target", data: { routeType: "agent", targetId: "ai-employee-1" }, position: { x: 0, y: 400 } },
  { id: "HU", type: "route_target", data: { routeType: "human", targetId: null }, position: { x: 200, y: 300 } },
];

// continue_shopping -> C -> AI ;  talk_to_agent -> human route
const EDGES_AGENT_FIRST = [
  { id: "x0", source: "e0", target: "A" },
  { id: "x1", source: "A", target: "B" },
  { id: "x2", source: "B", target: "HU", sourceHandle: "talk_to_agent" },
  { id: "x3", source: "B", target: "C", sourceHandle: "continue_shopping" },
  { id: "x4", source: "C", target: "AI" },
];
const EDGES_REVERSED = [...EDGES_AGENT_FIRST].reverse();

async function writeCanvas(edges: unknown) {
  await prisma.flowCanvas.upsert({
    where: { tenantId: TENANT },
    create: { tenantId: TENANT, nodes: NODES as any, edges: edges as any },
    update: { nodes: NODES as any, edges: edges as any },
  });
}

async function resetConversation() {
  await prisma.message.deleteMany({ where: { tenantId: TENANT, conversationId: CONV } });
  await prisma.conversation.update({
    where: { id: CONV },
    data: { chatbotNodeId: null, handledBy: null, isHandedOver: false, flowVariables: {} as any },
  });
}

/** Outbound bodies as PERSISTED, read back from the database. */
async function persistedOutbound(): Promise<string[]> {
  const rows = await prisma.message.findMany({
    where: { tenantId: TENANT, conversationId: CONV, direction: "OUTBOUND" },
    orderBy: { createdAt: "asc" },
    select: { body: true },
  });
  return rows.map((r) => r.body ?? "");
}

beforeAll(async () => {
  if (!DB) return;
  await withCrossTenantAccess(async () => {
  await prisma.tenant.upsert({
    where: { id: TENANT },
    create: { id: TENANT, name: "QR DB Test", slug: `qr-db-${SUFFIX}` },
    update: {},
  });
  await prisma.channelAccount.upsert({
    where: { id: CHAN },
    create: {
      id: CHAN, tenantId: TENANT, channel: "WHATSAPP" as any,
      externalId: "wa-test-1", displayName: "QR test number", credentials: {} as any,
    },
    update: {},
  });
  await prisma.conversation.upsert({
    where: { id: CONV },
    create: {
      id: CONV, tenantId: TENANT, channel: "WHATSAPP" as any,
      customerExternalId: "972500000000", channelAccountId: CHAN,
    },
    update: {},
  });
  });
});

afterAll(async () => {
  if (!DB) return;
  // Leave the Dev database as it was found.
  await withCrossTenantAccess(async () => {
  await prisma.message.deleteMany({ where: { tenantId: TENANT, conversationId: CONV } });
  await prisma.conversation.deleteMany({ where: { tenantId: TENANT, id: CONV } });
  await prisma.flowCanvas.deleteMany({ where: { tenantId: TENANT } });
  await prisma.channelAccount.deleteMany({ where: { tenantId: TENANT, id: CHAN } });
  await prisma.tenant.deleteMany({ where: { id: TENANT } });
  });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!DB) return;
  vi.clearAllMocks();
  sendTextMessage.mockResolvedValue("wamid.stub");
  sendInteractiveMessage.mockResolvedValue("wamid.stub.i");
  processAIBot.mockResolvedValue(true);
  await resetConversation();
});

describe.skipIf(!DB)("Dev E2E against the real database (zero AI credits assumed)", () => {
  for (const [orderName, edges] of [
    ["agent branch stored FIRST", EDGES_AGENT_FIRST],
    ["edge array REVERSED", EDGES_REVERSED],
  ] as const) {
    describe(orderName, () => {
      beforeEach(async () => {
        await writeCanvas(edges);
      });

      it("sends A and parks the real cursor on B", async () => {
        const res = await executeMainFlow({
          tenantId: TENANT, conversationId: CONV, message: "hi", channel: "whatsapp",
        });
        expect(res.reason).toBe("wait_for_reply");
        expect(await persistedOutbound()).toEqual(["message A", "pick one"]);

        const conv = await prisma.conversation.findUnique({
          where: { id: CONV },
          select: { chatbotNodeId: true, handledBy: true },
        });
        expect(conv).toEqual({ chatbotNodeId: "B", handledBy: "flow" });
      });

      it('tapping "Continue" sends C first, and only then reaches the AI node', async () => {
        await executeMainFlow({
          tenantId: TENANT, conversationId: CONV, message: "hi", channel: "whatsapp",
        });
        await prisma.message.deleteMany({ where: { tenantId: TENANT, conversationId: CONV } });

        const res = await executeMainFlow({
          tenantId: TENANT, conversationId: CONV,
          message: "Continue",             // the TITLE, as the webhook sends it
          replyPayload: "continue_shopping", // the button actually pressed
          channel: "whatsapp", resumeNodeId: "B",
        });

        expect(await persistedOutbound()).toEqual(["message C"]);
        expect(processAIBot).toHaveBeenCalledTimes(1);
        const order = res.trace.map((t: any) => t.nodeId);
        expect(order.indexOf("C")).toBeLessThan(order.indexOf("AI"));
      });

      it('tapping "Talk to an agent" takes the human branch and never touches AI', async () => {
        await executeMainFlow({
          tenantId: TENANT, conversationId: CONV, message: "hi", channel: "whatsapp",
        });
        await prisma.message.deleteMany({ where: { tenantId: TENANT, conversationId: CONV } });

        await executeMainFlow({
          tenantId: TENANT, conversationId: CONV,
          message: "Talk to an agent", replyPayload: "talk_to_agent",
          channel: "whatsapp", resumeNodeId: "B",
        });

        expect(await persistedOutbound()).toEqual([]);
        expect(processAIBot).not.toHaveBeenCalled();
        const conv = await prisma.conversation.findUnique({
          where: { id: CONV }, select: { handledBy: true },
        });
        expect(conv?.handledBy).toBe("human");
      });

      it("an unknown reply does not restart the flow or reach AI", async () => {
        await executeMainFlow({
          tenantId: TENANT, conversationId: CONV, message: "hi", channel: "whatsapp",
        });
        await prisma.message.deleteMany({ where: { tenantId: TENANT, conversationId: CONV } });

        const res = await executeMainFlow({
          tenantId: TENANT, conversationId: CONV,
          message: "who is this", channel: "whatsapp", resumeNodeId: "B",
        });

        expect(res.reason).toBe("quick_reply_unresolved");
        expect(await persistedOutbound()).toEqual([]);
        expect(processAIBot).not.toHaveBeenCalled();
        // Cursor untouched, so the next tap can still resolve.
        const conv = await prisma.conversation.findUnique({
          where: { id: CONV }, select: { chatbotNodeId: true },
        });
        expect(conv?.chatbotNodeId).toBe("B");
      });
    });
  }
});

// ─── The production incident shape, end to end ──────────────────
//
//   START -> send_message A -> quick_reply B (label "שירות")
//         -> send_message C -> send_interactive D -> route_target AI
//
// Tenant AI balance = 0. What went wrong in production was not the routing
// inside this flow - it was the department-picker override consuming the
// "שירות" tap before the flow ever got it, nulling the cursor and calling the
// AI directly. This pins the flow half: given the reply, every deterministic
// node runs first and the AI node is reached last.
describe.skipIf(!DB)("production incident shape (label=שירות)", () => {
  const P_NODES = [
    { id: "e0", type: "channel_entry", data: { channel: "whatsapp" }, position: { x: 0, y: 0 } },
    { id: "A", type: "send_message_text", data: { text: "message A" }, position: { x: 0, y: 100 } },
    {
      id: "B", type: "send_message_quick_reply",
      data: {
        text: "במה נוכל לעזור?",
        replies: [
          { id: "r1", label: "שירות", payload: "srv_support" },
          { id: "r2", label: "מכירות", payload: "srv_sales" },
        ],
      },
      position: { x: 0, y: 200 },
    },
    { id: "C", type: "send_message_text", data: { text: "message C" }, position: { x: 0, y: 300 } },
    {
      id: "D", type: "send_message_interactive",
      data: { text: "interactive D", buttonLabel: "Open", buttonUrl: "https://example.com" },
      position: { x: 0, y: 400 },
    },
    { id: "AI", type: "route_target", data: { routeType: "agent", targetId: "ai-employee-1" }, position: { x: 0, y: 500 } },
    { id: "HU", type: "route_target", data: { routeType: "human", targetId: null }, position: { x: 200, y: 300 } },
  ];
  const P_EDGES = [
    { id: "p0", source: "e0", target: "A" },
    { id: "p1", source: "A", target: "B" },
    { id: "p2", source: "B", target: "HU", sourceHandle: "srv_sales" },
    { id: "p3", source: "B", target: "C", sourceHandle: "srv_support" },
    { id: "p4", source: "C", target: "D" },
    { id: "p5", source: "D", target: "AI" },
  ];

  beforeEach(async () => {
    await prisma.flowCanvas.upsert({
      where: { tenantId: TENANT },
      create: { tenantId: TENANT, nodes: P_NODES as any, edges: P_EDGES as any },
      update: { nodes: P_NODES as any, edges: P_EDGES as any },
    });
  });

  it("runs A, parks on B, then C and D, and only then the AI node", async () => {
    const first = await executeMainFlow({
      tenantId: TENANT, conversationId: CONV, message: "היי אני צריך עזרה", channel: "whatsapp",
    });
    expect(first.reason).toBe("wait_for_reply");
    expect(await persistedOutbound()).toEqual(["message A", "במה נוכל לעזור?"]);
    const conv = await prisma.conversation.findUnique({
      where: { id: CONV }, select: { chatbotNodeId: true, handledBy: true },
    });
    expect(conv).toEqual({ chatbotNodeId: "B", handledBy: "flow" });
    expect(processAIBot).not.toHaveBeenCalled();

    await prisma.message.deleteMany({ where: { tenantId: TENANT, conversationId: CONV } });

    const res = await executeMainFlow({
      tenantId: TENANT, conversationId: CONV,
      message: "שירות", replyPayload: "srv_support",
      channel: "whatsapp", resumeNodeId: "B",
    });

    expect(await persistedOutbound()).toEqual(["message C", "interactive D\n\nOpen: https://example.com"]);
    const order = res.trace.map((t: any) => t.nodeId);
    expect(order.indexOf("C")).toBeLessThan(order.indexOf("D"));
    expect(order.indexOf("D")).toBeLessThan(order.indexOf("AI"));
    expect(processAIBot).toHaveBeenCalledTimes(1);
    expect(res.route).toEqual({ routeType: "AI_AGENT", targetId: "ai-employee-1" });
  });

  it("the sales button still takes its own branch, never the support one", async () => {
    await executeMainFlow({
      tenantId: TENANT, conversationId: CONV, message: "היי", channel: "whatsapp",
    });
    await prisma.message.deleteMany({ where: { tenantId: TENANT, conversationId: CONV } });

    await executeMainFlow({
      tenantId: TENANT, conversationId: CONV,
      message: "מכירות", replyPayload: "srv_sales",
      channel: "whatsapp", resumeNodeId: "B",
    });

    expect(await persistedOutbound()).toEqual([]);
    expect(processAIBot).not.toHaveBeenCalled();
    const conv = await prisma.conversation.findUnique({
      where: { id: CONV }, select: { handledBy: true },
    });
    expect(conv?.handledBy).toBe("human");
  });

  it("a typed Hebrew label resolves without the payload", async () => {
    await executeMainFlow({
      tenantId: TENANT, conversationId: CONV, message: "היי", channel: "whatsapp",
    });
    await prisma.message.deleteMany({ where: { tenantId: TENANT, conversationId: CONV } });

    await executeMainFlow({
      tenantId: TENANT, conversationId: CONV, message: "שירות",
      channel: "whatsapp", resumeNodeId: "B",
    });

    expect(await persistedOutbound()).toEqual(["message C", "interactive D\n\nOpen: https://example.com"]);
  });
});
