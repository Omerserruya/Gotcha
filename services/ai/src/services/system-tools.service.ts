/**
 * System Copilot - read-only system tools + propose_plan.
 *
 * These tools are EXCLUSIVE to the System Copilot (Command Center). They
 * do not appear in the customer-bot tool surface. All system_* tools are
 * read-only and tenant-scoped. `propose_plan` is the agent's escape hatch
 * for risky multi-step operations: it creates an ApprovalRequest backed
 * by the existing action-planner /execute path so the human approval UI
 * Just Works.
 *
 * Why a separate file: keeping these out of `packages/shared/agent-tools.ts`
 * stops them from leaking into the customer bot's tool surface and keeps
 * operator-side semantics isolated.
 */

import { prisma, visibilityClause, readDurableSetting, parseBusinessHours, REAL_CONVERSATION, type Viewer } from "@chatcenter/shared";
import { normalizeQuery, queryConversations, sourceLabel, type ConversationQuery } from "./assistant-query.service";
import { normalizeOrderQuery, queryOrders, queryProductStock } from "./assistant-commerce-query.service";
import { findCustomersResult } from "./assistant-customers.service";
import { readConversationResult } from "./assistant-conversation-read.service";
import { customerCardResult } from "./assistant-customer-card.service";
import { listApprovalsResult, listKnowledgeGapsResult } from "./assistant-work.service";
import { preparePlan, PlanRefused } from "./assistant-plan.service";
import { privateNumbers, privateConversationsClause } from "../lib/private-numbers";

/** The last n days, today included (UTC days: a caller with a workspace period passes it). */
function lastDays(n: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - (n - 1) * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
import {
  buildAgentToolsForAIAgent,
  evaluateToolGate,
  dispatchToolCall,
} from "@chatcenter/shared";
import type { AgentToolContext } from "@chatcenter/shared";
import { createApprovalRequest } from "@chatcenter/shared";

// ─── Tool schemas (OpenAI function-calling format) ──────────

const SYSTEM_COUNT_CONVERSATIONS = {
  type: "function" as const,
  function: {
    name: "system_count_conversations",
    description:
      "Count the business's conversations, optionally filtered by status, channel, or when they started. " +
      "Use for questions like 'how many open conversations do we have?' or 'how many WhatsApp chats this week?'.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["OPEN", "WAITING", "CLOSED", "ANY"],
          description: "Filter by conversation status. Default: ANY. WAITING means waiting for the CUSTOMER to reply. For conversations waiting for the team (\"what is waiting for us\", \"who needs an answer\"), use system_get_metric with waiting_for_person instead.",
        },
        channel: {
          type: "string",
          description:
            "Channel filter (WHATSAPP / MESSENGER / INSTAGRAM / EMAIL / GMAIL / OUTLOOK / SLACK / VOICE / WEBCHAT). Omit for all.",
        },
        sinceISO: {
          type: "string",
          description: "Lower bound for when the conversation STARTED (createdAt), ISO 8601. Omit it for the current state (how many are open now): an open conversation may have started long ago.",
        },
      },
    },
  },
};

const SYSTEM_GET_METRIC = {
  type: "function" as const,
  function: {
    name: "system_get_metric",
    description:
      "How many of something the business has right now, the same figure the owner sees on Home. Metrics: " +
      "'waiting_for_person' (conversations waiting for someone on the team to answer: the number on Home and the inbox queue; " +
      "conversations the AI is answering are NOT waiting), " +
      "'pending_approvals' (actions waiting for someone's approval, as on Home and the Approvals page), " +
      "'open_conversations' (all conversations still open, including the ones the AI is answering), " +
      "'closed_today' (conversations closed since midnight), " +
      "'inbound_messages_24h' (customer messages in the last 24 hours). " +
      "Each result has a 'label' saying what the number is: use those words, never the metric key.",
    parameters: {
      type: "object",
      required: ["metric"],
      properties: {
        metric: {
          type: "string",
          enum: [
            "waiting_for_person",
            "pending_approvals",
            "open_conversations",
            "closed_today",
            "inbound_messages_24h",
          ],
        },
      },
    },
  },
};

const SYSTEM_FIND_CUSTOMERS = {
  type: "function" as const,
  function: {
    name: "system_find_customers",
    description:
      "Find whether the business has a customer, by name, email or phone (\"is there\", \"do we have\", \"find\"). For \"tell me about X\", \"what do we know about X\" or \"who is X\", call system_customer_card directly with the name instead: it finds them itself. " +
      "Every word must match (any order, any case); phones match whatever their format. " +
      "Names are often stored in another script: ALWAYS pass several spellings in one call: as written, in the other script (Hebrew or Latin letters, e.g. \"עומר צרויה\" and \"Omer Serruya\"), and the first name alone. " +
      "Each match comes with its channels, how many open conversations it has and the last contact, shown to the user as a card with a link to the customer. " +
      "Never say a customer was not found before searching all those spellings.",
    parameters: {
      type: "object",
      required: ["queries"],
      properties: {
        queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4, description: "1 to 4 spellings of the same customer (name, email or phone)." },
      },
    },
  },
};

const SYSTEM_READ_CONVERSATION = {
  type: "function" as const,
  function: {
    name: "system_read_conversation",
    description:
      "Read one conversation: its last messages, its summary when it has one, its state and who has it, shown as a card linking to it in the inbox. " +
      "Say which: customerId (from system_find_customers), or the customer's name as spellings (customer: as written, in the other script, the first name alone), or a conversationId. " +
      "With a customer it reads their latest conversation the user can see, an open one first. If several customers match a name, the result lists them: ask which one. In Ctrl+K, with a conversation selected, it reads that one when nothing else is named.",
    parameters: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "A customer's id from system_find_customers." },
        customer: { type: "array", items: { type: "string" }, maxItems: 4, description: "The customer's name, 1 to 4 spellings." },
        conversationId: { type: "string" },
        limit: { type: "number", description: "Messages to read, default 20, max 50." },
      },
    },
  },
};

const SYSTEM_CUSTOMER_CARD = {
  type: "function" as const,
  function: {
    name: "system_customer_card",
    description:
      "Everything about one customer, as their customer page shows it: channels and how to reach them, tags, what GOTCHA learned about them, the team's notes, their conversations on every channel, and their latest orders when a store is connected. " +
      "Use it for \"tell me about X\", \"what do we know about X\", \"who is X\": call it directly with the name (customer), without searching first. " +
      "Shown as a card linking to the customer, with their conversations under it. Pass customerId from system_find_customers, or their name as spellings (customer); a name matching several people returns them to choose from.",
    parameters: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "A customer's id from system_find_customers." },
        customer: { type: "array", items: { type: "string" }, maxItems: 4, description: "The customer's name, 1 to 4 spellings." },
      },
    },
  },
};

const SYSTEM_LIST_APPROVALS = {
  type: "function" as const,
  function: {
    name: "system_list_approvals",
    description:
      "The actions waiting for someone's approval (\"what's waiting for me?\"), as the Approvals screen lists them: what each one is, about which customer, the amount when there is one, and since when, each linking to it. Shown as a card; cite the source.",
    parameters: { type: "object", properties: {} },
  },
};

const SYSTEM_LIST_KNOWLEDGE_GAPS = {
  type: "function" as const,
  function: {
    name: "system_list_knowledge_gaps",
    description:
      "The questions customers asked that the AI could not answer yet, latest first, with how often and by how many people, each linking to where the owner answers them (the answer becomes knowledge). Shown as a card; cite the source.",
    parameters: { type: "object", properties: {} },
  },
};

const SYSTEM_RECENT_ACTIVITY = {
  type: "function" as const,
  function: {
    name: "system_recent_activity",
    description:
      "The latest messages customers sent, on every channel: when, who, the channel, when their conversation started, and the text. " +
      "Useful for 'what's new today' / triage questions.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many messages to return, max 50, default 20." },
      },
    },
  },
};

import { PLAN_ACTIONS } from "../lib/plan-actions";
export { PLAN_ACTIONS };

const PROPOSE_PLAN_TOOL = {
  type: "function" as const,
  function: {
    name: "propose_plan",
    description:
      "Bundle a multi-step or risky operation into an approval plan. The platform will surface it in the operator's approval queue; the operator clicks Approve to execute the steps via the action-planner runtime. " +
      "Use this for: sending a customer a message, tagging customers, a follow-up or a meeting, building or scheduling a broadcast, creating a workflow, or linking and merging a customer's identities, when a person should review it before anything changes. " +
      "Also: claiming, assigning or closing a conversation, returning it to GOTCHA, adding a note to a customer, and answering a question customers asked (an unanswered question becomes knowledge). " +
      "Only the actions listed in the steps can run: refunds, CRM updates, tickets and tasks cannot be proposed yet. " +
      "Do NOT use this for read-only operations or single low-risk actions (those you can call directly).",
    parameters: {
      type: "object",
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["tool", "params", "reason"],
            properties: {
              tool: {
                type: "string",
                enum: [...PLAN_ACTIONS],
                description: "The action to carry out. Only these can run; anything else (refunds, CRM updates, tickets, tasks) cannot be proposed yet. Conversation and note actions run as the person who approves them.",
              },
              params: { type: "object", description: "The action's parameters. Conversation actions take the conversation (conversationId, or customerId from system_find_customers for their open one) and, to assign, assignee: \"me\" or a person's id. add_note: contactId and body. answer_question: unansweredQuestionId and answer." },
              reason: { type: "string", description: "Why this step is included." },
              riskLevel: { type: "string", enum: ["low", "medium", "high"] },
            },
          },
        },
      },
    },
  },
};

const SYSTEM_QUERY_CONVERSATIONS = {
  type: "function" as const,
  function: {
    name: "system_query_conversations",
    description:
      "The business's conversations over a period: how many, by day, by channel, by status, by who handled them (GOTCHA or the team), " +
      "by intent or sentiment (recorded only for some conversations: the result says for how many), or which conversations mention a word. " +
      "The numbers are shown to the user as cards; you get a short summary and a source id. Cite it after the claim as [^<id>] and do not repeat every number. " +
      "One call per split: \"by channel\" is ONE call with groupBy channel, never one call per channel; \"by day and by channel\" is two calls (groupBy day, groupBy channel). " +
      "A period counts the conversations that STARTED in it. For the current state (\"how many are open\", \"how many are waiting\", \"how many of them are on WhatsApp\" after an open count) use now: true with the status: it counts every conversation in that state now, whenever it started, the same figure as system_get_metric open_conversations.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "First day, YYYY-MM-DD (the workspace's days). Default: the conversation's period." },
        to: { type: "string", description: "Last day, YYYY-MM-DD, inclusive. Default: the conversation's period." },
        channels: { type: "array", items: { type: "string" }, description: "Channel keys (WHATSAPP, INSTAGRAM, MESSENGER, EMAIL, WEBCHAT, SHOPIFY_LIVE_CHAT, VOICE...). Omit for all." },
        status: { type: "string", enum: ["OPEN", "WAITING", "CLOSED"], description: "Only conversations in this state. WAITING means waiting for the customer." },
        groupBy: { type: "string", enum: ["day", "channel", "status", "handler", "intent", "sentiment"], description: "How to split the count. Default: day." },
        mention: { type: "string", description: "Only conversations where a message in the period contains this word or phrase (any case)." },
        now: { type: "boolean", description: "The current state instead of a period: every conversation in `status` (OPEN or WAITING, required) right now, whenever it started. from/to are ignored; groupBy day is not possible. Default: false." },
      },
    },
  },
};

const SYSTEM_LIST_CONVERSATIONS = {
  type: "function" as const,
  function: {
    name: "system_list_conversations",
    description:
      "The business's conversations as rows the user can open: the customer, the channel, its state, who has it (a person, GOTCHA, or waiting for a person), the last message and when, each linking to the conversation. " +
      "Use it to list or find conversations: \"list them\", \"show the 2 WhatsApp ones\", \"is there an open conversation with X\" (pass customerId from system_find_customers), \"what is waiting for a person\", \"what is assigned to me\". " +
      "Without from/to it lists the current state, whenever they started (open ones unless you pass a status, a customer or waitingForPerson); with from/to, the conversations that STARTED in the period. Shown as a card; cite the source.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["OPEN", "WAITING", "CLOSED"], description: "Only conversations in this state. WAITING means waiting for the customer." },
        channels: { type: "array", items: { type: "string" }, description: "Channel keys (WHATSAPP, INSTAGRAM, MESSENGER, EMAIL, WEBCHAT, SHOPIFY_LIVE_CHAT, VOICE...). Omit for all." },
        customerId: { type: "string", description: "A customer's id from system_find_customers: their conversations on every channel." },
        assignee: { type: "string", description: "Who has it: \"me\" (the user), \"gotcha\", \"unassigned\", or a person's user id." },
        waitingForPerson: { type: "boolean", description: "Only conversations waiting for someone on the team to answer (the inbox queue, the number on Home)." },
        mention: { type: "string", description: "Only conversations where a message in the period says this word or phrase." },
        from: { type: "string", description: "First day, YYYY-MM-DD, for conversations that started in a period." },
        to: { type: "string", description: "Last day, YYYY-MM-DD, inclusive." },
      },
    },
  },
};

const SYSTEM_QUERY_ORDERS = {
  type: "function" as const,
  function: {
    name: "system_query_orders",
    description:
      "The connected store's orders over a period, read live from the store: how many, total sales, or refunds, by day or by product " +
      "(by product the figure is units sold or refunded), or refunds by reason. Refunds are those on orders placed in the period. " +
      "The numbers are shown to the user as cards; you get a short summary and a source id. Cite it after the claim as [^<id>]. " +
      "If the result is ok:false, say its message in your own words and do not guess figures.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "First day, YYYY-MM-DD (the workspace's days). Default: the conversation's period." },
        to: { type: "string", description: "Last day, YYYY-MM-DD, inclusive. Default: the conversation's period." },
        measure: { type: "string", enum: ["orders", "revenue", "refunds"], description: "What to count. Default: orders." },
        groupBy: { type: "string", enum: ["day", "product", "reason"], description: "How to split it. Default: day. reason: refunds only (the reason the store recorded)." },
      },
    },
  },
};

const SYSTEM_PRODUCT_STOCK = {
  type: "function" as const,
  function: {
    name: "system_product_stock",
    description:
      "A product's stock in the connected store, per variant, read live. Shown to the user as a card; cite the source id as [^<id>].",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The product's name or part of it." } },
      required: ["query"],
    },
  },
};

// ─── Tool surface for the System Copilot ────────────────────

/**
 * Build the operator-side tool surface:
 *  - Every tenant integration tool the agent has been granted (we use the
 *    seeded "system" agent's row, falling back to "all enabled" when no
 *    grants exist for the operator-tenant pair).
 *  - All system_* read tools above.
 *  - propose_plan.
 *
 * Returns shapes ready for chat.completions.create({ tools }).
 */
export async function buildSystemAgentTools(opts: {
  tenantId: string;
  /** Optional AIAgent ID to inherit per-agent tool grants. If omitted we
   * fall back to "every TenantTool that's enabled and CONNECTED" so the
   * Command Center is useful out of the box on a fresh tenant. */
  aiAgentId?: string | null;
  /** The caller may read store orders AND a store is connected. */
  commerce?: boolean;
  /** The caller may read the knowledge screen. */
  knowledge?: boolean;
}): Promise<Array<Record<string, unknown>>> {
  const integrationTools = opts.aiAgentId
    ? await buildAgentToolsForAIAgent(opts.tenantId, opts.aiAgentId, {
        identityLinking: false,
        escalation: false,
      })
    : await loadAllTenantIntegrationTools(opts.tenantId);

  return [
    ...integrationTools,
    SYSTEM_COUNT_CONVERSATIONS,
    SYSTEM_GET_METRIC,
    SYSTEM_FIND_CUSTOMERS,
    SYSTEM_READ_CONVERSATION,
    SYSTEM_CUSTOMER_CARD,
    SYSTEM_LIST_APPROVALS,
    ...(opts.knowledge ? [SYSTEM_LIST_KNOWLEDGE_GAPS] : []),
    SYSTEM_RECENT_ACTIVITY,
    SYSTEM_QUERY_CONVERSATIONS,
    SYSTEM_LIST_CONVERSATIONS,
    ...(opts.commerce ? [SYSTEM_QUERY_ORDERS, SYSTEM_PRODUCT_STOCK] : []),
    PROPOSE_PLAN_TOOL,
  ];
}

async function loadAllTenantIntegrationTools(
  tenantId: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const rows = await prisma.tenantTool.findMany({
      where: {
        tenantId,
        isEnabled: true,
        tenantIntegration: { status: "CONNECTED" },
      },
      include: { catalogTool: true },
    });
    return rows.map((r: any) => {
      const ct = r.catalogTool;
      const parameters =
        ct.inputSchema && typeof ct.inputSchema === "object" && !Array.isArray(ct.inputSchema)
          ? ct.inputSchema
          : { type: "object", properties: {} };
      return {
        type: "function",
        function: {
          name: `integration_${ct.slug}`,
          description: ct.description || ct.name,
          parameters,
        },
      };
    });
  } catch (err: any) {
    console.warn("[system-tools] integration load failed:", err?.message);
    return [];
  }
}

// ─── Dispatcher ─────────────────────────────────────────────

export interface SystemToolDispatchCtx {
  tenantId: string;
  userId: string;
  /** Resolved from agent-context.service. */
  selectedConversationId?: string | null;
  selectedContactId?: string | null;
  /** Pass-through for downstream services (Bearer). */
  authToken?: string;
  /** Who is asking. Conversation data follows the inbox's visibility rule. */
  viewer?: Viewer;
  /** The interface language: result labels are written in it. */
  locale?: "he" | "en";
  /** The period a query defaults to (a Home chat thread's scope); else the last 7 days. */
  defaultPeriod?: { from: string; to: string };
  /** Ids for the cards and sources of this answer ("b1", "s1"...), shared across its tool calls. */
  nextId?: (kind: "b" | "s") => string;
  /** The caller holds customer:commerce:read. Absent = no: the store tools refuse. */
  canReadCommerce?: boolean;
  /** The caller holds crm:contacts:read (or is ADMIN): every customer, as on the customers screen. */
  canReadContacts?: boolean;
  /** The caller holds ai:knowledge:read (or is ADMIN). Absent = no. */
  canReadKnowledge?: boolean;
  /** Who is asking, by name (the requester of a proposed plan). */
  userName?: string;
  /** Where they asked: a Home thread or the Ctrl+K palette. */
  surface?: "home" | "command_bar";
}

/** The visibility OR-clause for this caller, or null when unrestricted. */
function clauseOf(ctx: { viewer?: Viewer }): Record<string, unknown>[] | null {
  return ctx.viewer ? visibilityClause(ctx.viewer) : null;
}

export interface SystemToolResult {
  toolCallId: string;
  /** JSON-stringified result fed back into the chat loop. */
  content: string;
  /** Surfaced to the route layer for SSE event emission. */
  sideEffect?:
    | { kind: "proposed_plan"; approvalRequestId: string; planSummary: string }
    | { kind: "denied"; tool: string; reason: string }
    | { kind: "awaiting_approval"; approvalRequestId: string; tool: string };
  /** Stage 2: cards and their source, computed here and shown as they are (never by the model). */
  artifacts?: { blocks: unknown[]; source: unknown };
}

/**
 * Dispatch a single tool call. system_* tools and propose_plan are handled
 * locally; everything else delegates to `dispatchToolCall` so HITL gating
 * (evaluateToolGate) and the standard audit trail apply identically.
 */
export async function dispatchSystemToolCall(
  toolCall: { id: string; function: { name: string; arguments: string } },
  ctx: SystemToolDispatchCtx,
): Promise<SystemToolResult> {
  const name = toolCall.function?.name || "";
  let args: any = {};
  try {
    args = JSON.parse(toolCall.function?.arguments || "{}");
  } catch {
    return {
      toolCallId: toolCall.id,
      content: JSON.stringify({ ok: false, error: "invalid JSON arguments" }),
    };
  }

  if (name.startsWith("system_")) {
    return dispatchSystemTool(name, args, toolCall.id, ctx);
  }
  if (name === "propose_plan") {
    return dispatchProposePlan(args, toolCall.id, ctx);
  }

  // Everything else (integration_*, link_customer_identifier, escalate_to_human,
  // tag_contact, etc.) flows through the universal dispatcher with the same
  // gate, dedupe, and audit logic the customer bot uses.
  const agentCtx: AgentToolContext = {
    tenantId: ctx.tenantId,
    conversationId: ctx.selectedConversationId ?? undefined,
    contactId: ctx.selectedContactId ?? undefined,
    authToken: ctx.authToken,
    mode: "agent",
  };
  const r = await dispatchToolCall(toolCall, agentCtx);
  if (r.sideEffect?.awaitingApproval) {
    return {
      toolCallId: r.toolCallId,
      content: r.content,
      sideEffect: {
        kind: "awaiting_approval",
        approvalRequestId: r.sideEffect.awaitingApproval.approvalRequestId,
        tool: r.sideEffect.awaitingApproval.tool,
      },
    };
  }
  if (r.sideEffect?.denied) {
    return {
      toolCallId: r.toolCallId,
      content: r.content,
      sideEffect: { kind: "denied", tool: r.sideEffect.denied.tool, reason: r.sideEffect.denied.reason },
    };
  }
  return { toolCallId: r.toolCallId, content: r.content };
}

// ─── system_* implementations ───────────────────────────────

async function dispatchSystemTool(
  name: string,
  args: any,
  toolCallId: string,
  ctx: SystemToolDispatchCtx,
): Promise<SystemToolResult> {
  try {
    switch (name) {
      case "system_count_conversations": {
        const where: any = { tenantId: ctx.tenantId, ...REAL_CONVERSATION };
        const clause = clauseOf(ctx);
        if (clause) where.OR = clause;
        if (args.status && args.status !== "ANY") where.status = args.status;
        if (args.channel) where.channel = args.channel;
        if (args.sinceISO) where.createdAt = { gte: new Date(args.sinceISO) };
        const count = await prisma.conversation.count({ where });
        // Words, not the query: the model repeats what it is given, and the
        // owner must never read a status key ("WAITING") or a field name.
        return { toolCallId, content: JSON.stringify({ ok: true, count, label: countLabel(args, ctx.locale) }) };
      }
      case "system_get_metric": {
        const metric = METRIC_ALIASES[args.metric] ?? args.metric;
        const value = await getMetric(ctx.tenantId, metric, clauseOf(ctx), ctx.authToken);
        if (value === null) {
          return { toolCallId, content: JSON.stringify({ ok: false, error: "this figure is not available right now" }) };
        }
        const label = METRIC_LABELS[metric]?.[ctx.locale ?? "en"] ?? (ctx.locale === "he" ? "נתון" : "figure");
        // "Open" has a list behind it (the current state): a source the
        // answer can cite. Without one the model cited the figure by its
        // words ("[^שיחות פתוחות...]" on screen, 2026-10-08).
        if (metric === "open_conversations" && ctx.nextId) {
          const params: ConversationQuery = { now: true, status: "OPEN" };
          const source = { id: ctx.nextId("s"), label: sourceLabel(params, value, ctx.locale ?? "en"), kind: "conversations", count: value, deepLink: null, query: { tool: "conversations", params } };
          return { toolCallId, content: JSON.stringify({ ok: true, value, label, cite: source.id }), artifacts: { blocks: [], source } };
        }
        return { toolCallId, content: JSON.stringify({ ok: true, value, label }) };
      }
      // The old name: memory of earlier turns may still call it.
      case "system_search_customers":
      case "system_find_customers": {
        const queries: string[] = Array.isArray(args.queries) ? args.queries.map(String) : args.query ? [String(args.query)] : [];
        let seq = 0;
        const nextId = ctx.nextId ?? ((k: "b" | "s") => `${k}${++seq}`);
        const r = await findCustomersResult({ tenantId: ctx.tenantId, viewer: ctx.viewer, locale: ctx.locale ?? "en", nextId, canReadContacts: !!ctx.canReadContacts }, queries);
        return { toolCallId, content: JSON.stringify(r.summary), ...(r.source ? { artifacts: { blocks: r.blocks, source: r.source } } : {}) };
      }
      // The old name, and Ctrl+K's "this conversation": the selection when nothing else is named.
      case "system_summarize_conversation":
      case "system_read_conversation": {
        let seq = 0;
        const nextId = ctx.nextId ?? ((k: "b" | "s") => `${k}${++seq}`);
        const customer = Array.isArray(args.customer) ? args.customer.map(String) : typeof args.customer === "string" ? [args.customer] : undefined;
        const r = await readConversationResult(
          { tenantId: ctx.tenantId, viewer: ctx.viewer, locale: ctx.locale ?? "en", nextId, canReadContacts: !!ctx.canReadContacts, selectedConversationId: ctx.selectedConversationId },
          { conversationId: args.conversationId, customerId: args.customerId, customer, limit: args.limit },
        );
        return { toolCallId, content: JSON.stringify(r.summary), ...(r.source ? { artifacts: { blocks: r.blocks ?? [], source: r.source } } : {}) };
      }
      case "system_query_conversations": {
        const locale = ctx.locale ?? "en";
        const period = ctx.defaultPeriod ?? lastDays(7);
        const q = normalizeQuery({ ...period, ...args, from: args.from ?? period.from, to: args.to ?? period.to });
        if ("error" in q) return { toolCallId, content: JSON.stringify({ ok: false, error: q.error }) };
        let seq = 0;
        const nextId = ctx.nextId ?? ((k: "b" | "s") => `${k}${++seq}`);
        const r = await queryConversations({ tenantId: ctx.tenantId, viewer: ctx.viewer, locale, nextId }, q);
        return { toolCallId, content: JSON.stringify(r.summary), artifacts: { blocks: r.blocks, source: r.source } };
      }
      case "system_list_approvals":
      case "system_list_knowledge_gaps": {
        // The surface hides the gaps from a caller who may not read knowledge; this is the backstop.
        if (name === "system_list_knowledge_gaps" && !ctx.canReadKnowledge) return { toolCallId, content: JSON.stringify({ ok: false, error: "not_permitted" }) };
        let seq = 0;
        const nextId = ctx.nextId ?? ((k: "b" | "s") => `${k}${++seq}`);
        const wctx = { tenantId: ctx.tenantId, locale: ctx.locale ?? "en", nextId };
        const r: any = name === "system_list_approvals" ? await listApprovalsResult(wctx) : await listKnowledgeGapsResult(wctx);
        return { toolCallId, content: JSON.stringify(r.summary), ...(r.source ? { artifacts: { blocks: r.blocks, source: r.source } } : {}) };
      }
      case "system_customer_card": {
        let seq = 0;
        const nextId = ctx.nextId ?? ((k: "b" | "s") => `${k}${++seq}`);
        const customer = Array.isArray(args.customer) ? args.customer.map(String) : typeof args.customer === "string" ? [args.customer] : undefined;
        const r = await customerCardResult(
          { tenantId: ctx.tenantId, viewer: ctx.viewer, locale: ctx.locale ?? "en", nextId, canReadContacts: !!ctx.canReadContacts, canReadCommerce: !!ctx.canReadCommerce, authToken: ctx.authToken },
          { customerId: args.customerId, customer },
        );
        return { toolCallId, content: JSON.stringify(r.summary), ...(r.source ? { artifacts: { blocks: r.blocks ?? [], source: r.source } } : {}) };
      }
      case "system_list_conversations": {
        const locale = ctx.locale ?? "en";
        const period = ctx.defaultPeriod ?? lastDays(7);
        const inPeriod = !!(args.from || args.to || args.mention);
        const base = {
          status: args.status,
          channels: args.channels,
          customerIds: args.customerId ? [String(args.customerId)] : undefined,
          // "me" is the person asking, resolved here so the saved query replays the same rows.
          assignee: args.assignee === "me" ? ctx.userId : args.assignee,
          waitingForPerson: args.waitingForPerson === true,
          mention: args.mention,
          list: true,
        };
        let q = normalizeQuery(inPeriod ? { ...base, from: args.from ?? period.from, to: args.to ?? period.to } : { ...base, now: true });
        // A current state needs something to be the state of: open ones unless told otherwise.
        if ("error" in q && !inPeriod && !base.status) q = normalizeQuery({ ...base, status: "OPEN", now: true });
        if ("error" in q) return { toolCallId, content: JSON.stringify({ ok: false, error: q.error }) };
        let seq = 0;
        const nextId = ctx.nextId ?? ((k: "b" | "s") => `${k}${++seq}`);
        const r = await queryConversations({ tenantId: ctx.tenantId, viewer: ctx.viewer, locale, nextId }, q);
        return { toolCallId, content: JSON.stringify(r.summary), artifacts: { blocks: r.blocks, source: r.source } };
      }
      case "system_query_orders":
      case "system_product_stock": {
        // The surface hides these from a caller without the permission; this
        // is the backstop for a model that names the tool anyway.
        if (!ctx.canReadCommerce) return { toolCallId, content: JSON.stringify({ ok: false, error: "not_permitted" }) };
        const locale = ctx.locale ?? "en";
        let seq = 0;
        const nextId = ctx.nextId ?? ((k: "b" | "s") => `${k}${++seq}`);
        const qctx = { tenantId: ctx.tenantId, viewer: ctx.viewer, locale, nextId };
        let r;
        if (name === "system_product_stock") {
          const query = String(args.query ?? "").trim().slice(0, 80);
          if (!query) return { toolCallId, content: JSON.stringify({ ok: false, error: "query is required" }) };
          r = await queryProductStock(qctx, query);
        } else {
          const period = ctx.defaultPeriod ?? lastDays(7);
          const q = normalizeOrderQuery({ ...args, from: args.from ?? period.from, to: args.to ?? period.to });
          if ("error" in q) return { toolCallId, content: JSON.stringify({ ok: false, error: q.error }) };
          r = await queryOrders(qctx, q);
        }
        return { toolCallId, content: JSON.stringify(r.summary), ...(r.source ? { artifacts: { blocks: r.blocks, source: r.source } } : {}) };
      }
      case "system_recent_activity": {
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
        const clause = clauseOf(ctx);
        const rows = await prisma.message.findMany({
          where: { tenantId: ctx.tenantId, direction: "INBOUND", ...(clause ? { conversation: { OR: clause } } : {}) },
          orderBy: { createdAt: "desc" },
          take: limit,
          select: {
            conversationId: true,
            body: true,
            createdAt: true,
            conversation: {
              select: { customerName: true, customerExternalId: true, channel: true, createdAt: true },
            },
          },
        });
        // Written for a person, in the interface language: channel names, dates
        // as people say them, and when each conversation started (so "0 new
        // conversations, 7 messages" can be told as messages in ongoing ones).
        const locale = ctx.locale ?? "en";
        const tz = await tenantTimeZone(ctx.tenantId);
        return {
          toolCallId,
          content: JSON.stringify({
            ok: true,
            messageCount: rows.length,
            conversationCount: new Set(rows.map((m) => m.conversationId)).size,
            results: rows.map((m) => {
              const c = (m as any).conversation;
              return {
                when: whenText(m.createdAt, locale, tz),
                conversationId: m.conversationId,
                channel: channelName(c?.channel, locale),
                customer: c?.customerName || c?.customerExternalId || null,
                conversationStarted: c?.createdAt ? whenText(c.createdAt, locale, tz, false) : null,
                text: m.body ? m.body.slice(0, 200) : null,
              };
            }),
          }),
        };
      }
      default:
        return { toolCallId, content: JSON.stringify({ ok: false, error: `unknown system tool: ${name}` }) };
    }
  } catch (err: any) {
    console.error(`[system-tools] ${name} failed:`, err?.message);
    return { toolCallId, content: JSON.stringify({ ok: false, error: err?.message || "tool error" }) };
  }
}

/**
 * A step as a person reads it ("Counting the waiting conversations"), never
 * the tool's name. The Home chat's step.start and Cmd-K's tool events use it.
 */
const STEP_TEXT: Record<string, { en: string; he: string }> = {
  system_count_conversations: { en: "Counting conversations", he: "סופרת שיחות" },
  system_get_metric: { en: "Checking the numbers", he: "בודקת את המספרים" },
  system_search_customers: { en: "Searching customers", he: "מחפשת לקוחות" },
  system_find_customers: { en: "Looking for the customer", he: "מחפשת את הלקוח" },
  system_summarize_conversation: { en: "Reading the conversation", he: "קוראת את השיחה" },
  system_read_conversation: { en: "Reading the conversation", he: "קוראת את השיחה" },
  system_customer_card: { en: "Opening the customer's card", he: "פותחת את כרטיס הלקוח" },
  system_list_approvals: { en: "Checking what waits for approval", he: "בודקת מה מחכה לאישור" },
  system_list_knowledge_gaps: { en: "Looking at the unanswered questions", he: "בודקת שאלות שלא נענו" },
  system_recent_activity: { en: "Looking at recent messages", he: "מסתכלת על ההודעות האחרונות" },
  system_query_conversations: { en: "Looking at the conversations", he: "בודקת את השיחות" },
  system_list_conversations: { en: "Finding the conversations", he: "מוצאת את השיחות" },
  system_query_orders: { en: "Reading the store's orders", he: "קוראת את ההזמנות בחנות" },
  system_product_stock: { en: "Checking the stock", he: "בודקת את המלאי" },
  propose_plan: { en: "Preparing a plan for your approval", he: "מכינה תוכנית לאישור שלך" },
};
const METRIC_STEP: Record<string, { en: string; he: string }> = {
  waiting_for_person: { en: "Counting the conversations waiting for your team", he: "סופרת את השיחות שמחכות לצוות" },
  pending_approvals: { en: "Counting the approvals waiting for you", he: "סופרת את האישורים שמחכים לך" },
  open_conversations: { en: "Counting the open conversations", he: "סופרת את השיחות הפתוחות" },
  closed_today: { en: "Counting today's closed conversations", he: "סופרת את השיחות שנסגרו היום" },
  inbound_messages_24h: { en: "Counting today's customer messages", he: "סופרת את הודעות הלקוחות מהיממה האחרונה" },
};
export function stepText(name: string, args: any, locale: "he" | "en" = "en"): string {
  // "Counting open conversations on WhatsApp", not a generic "Counting conversations".
  if (name === "system_count_conversations" && (args?.status && args.status !== "ANY" || args?.channel)) {
    return `${locale === "he" ? "סופרת" : "Counting"} ${countLabel(args, locale)}`;
  }
  if (name === "system_query_conversations" && typeof args?.mention === "string" && args.mention.trim()) {
    return locale === "he" ? `מחפשת שיחות שמזכירות “${args.mention.trim().slice(0, 40)}”` : `Finding conversations that mention “${args.mention.trim().slice(0, 40)}”`;
  }
  if (name === "system_get_metric") {
    const m = METRIC_ALIASES[args?.metric] ?? args?.metric;
    if (METRIC_STEP[m]) return METRIC_STEP[m][locale];
  }
  if (STEP_TEXT[name]) return STEP_TEXT[name][locale];
  // An integration tool: its own action, in words.
  const action = name.replace(/^integration_/, "").replace(/[._]+/g, " ").trim();
  return locale === "he" ? `מריצה ${action}` : `Running ${action}`;
}


/** An old metric key still accepted, mapped to the figure the screens show. */
const METRIC_ALIASES: Record<string, string> = { waiting_conversations: "waiting_for_person" };

/**
 * What each figure is, in the words the screens use, in the interface
 * language: the model repeats what it is given, so an English label used to
 * surface verbatim inside a Hebrew answer.
 */
export const METRIC_LABELS: Record<string, { en: string; he: string }> = {
  waiting_for_person: { en: "conversations waiting for someone on your team to answer", he: "שיחות שמחכות למענה מהצוות" },
  pending_approvals: { en: "actions waiting for your approval", he: "פעולות שמחכות לאישור שלך" },
  open_conversations: { en: "open conversations, including the ones the AI is answering", he: "שיחות פתוחות, כולל אלה שה-AI עונה בהן" },
  closed_today: { en: "conversations closed today", he: "שיחות שנסגרו היום" },
  inbound_messages_24h: { en: "customer messages in the last 24 hours", he: "הודעות מלקוחות ב-24 השעות האחרונות" },
};

const STATUS_WORDS: Record<string, { en: string; he: string }> = {
  OPEN: { en: "open conversations", he: "שיחות פתוחות" },
  WAITING: { en: "conversations waiting for the customer to reply", he: "שיחות שמחכות לתשובת הלקוח" },
  CLOSED: { en: "closed conversations", he: "שיחות שנסגרו" },
};
/** A channel as the inbox names it, in the interface language; never the enum key. */
export function channelName(channel: unknown, locale: "he" | "en" = "en"): string {
  return (CHANNEL_NAMES[String(channel ?? "").toUpperCase()] ?? OTHER_CHANNEL)[locale];
}

/** The workspace's timezone (its business hours), else UTC. */
async function tenantTimeZone(tenantId: string): Promise<string> {
  try {
    return parseBusinessHours(await readDurableSetting(tenantId, "businessHours"))?.timezone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A moment as people say it ("7 באוקטובר בשעה 14:05", "7 October at 14:05"), never ISO. */
export function whenText(d: Date, locale: "he" | "en" = "en", timeZone = "UTC", withTime = true): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", timeZone, ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) };
  try {
    return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-GB", opts).format(d);
  } catch {
    return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-GB", { ...opts, timeZone: "UTC" }).format(d);
  }
}

/** The inbox's channel names (redesign i18n channels.json `name.<ENUM>`), never the enum key. */
const CHANNEL_NAMES: Record<string, { en: string; he: string }> = {
  WHATSAPP: { en: "WhatsApp", he: "וואטסאפ" },
  INSTAGRAM: { en: "Instagram", he: "אינסטגרם" },
  MESSENGER: { en: "Messenger", he: "מסנג'ר" },
  EMAIL: { en: "Email", he: "אימייל" },
  GMAIL: { en: "Gmail", he: "Gmail" },
  OUTLOOK: { en: "Outlook", he: "Outlook" },
  SLACK: { en: "Slack", he: "Slack" },
  VOICE: { en: "Phone calls", he: "שיחות טלפון" },
  WEBCHAT: { en: "Web chat", he: "צ'אט באתר" },
  SHOPIFY_LIVE_CHAT: { en: "Shopify live chat", he: "צ'אט Shopify" },
};
const OTHER_CHANNEL = { en: "Another channel", he: "ערוץ אחר" };

function countLabel(args: any, locale: "he" | "en" = "en"): string {
  const he = locale === "he";
  const status = args?.status && args.status !== "ANY" ? STATUS_WORDS[String(args.status)]?.[locale] ?? (he ? "שיחות מתאימות" : "matching conversations") : he ? "שיחות" : "conversations";
  const parts = [status];
  const channel = args?.channel ? (CHANNEL_NAMES[String(args.channel).toUpperCase()] ?? OTHER_CHANNEL)[locale] : "";
  if (channel) parts.push(he ? `בערוץ ${channel}` : `on ${channel}`);
  // sinceISO filters by when a conversation STARTED: say so ("closed since 1
  // October" would claim something the count does not measure).
  if (args?.sinceISO && !isNaN(Date.parse(String(args.sinceISO)))) parts.push(`(${he ? "נפתחו מאז" : "started since"} ${whenText(new Date(String(args.sinceISO)), locale, "UTC", false)})`);
  return parts.join(" ");
}

const ANALYTICS_URL = () => process.env.ANALYTICS_SERVICE_URL || "http://analytics:4004";

/**
 * "Waiting for a person" is the analytics service's definition (Home's count
 * and its ranked queue share it). Asked through its API with the caller's own
 * token, never re-derived here: the assistant must say the number the screen
 * in front of the owner says. Null when it cannot be read.
 */
async function waitingForPerson(authToken?: string): Promise<number | null> {
  if (!authToken) return null;
  try {
    const r = await fetch(`${ANALYTICS_URL()}/api/analytics/queue/items?limit=1`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    return typeof j?.totalWaiting === "number" ? j.totalWaiting : null;
  } catch {
    return null;
  }
}

async function getMetric(tenantId: string, metric: string, clause: Record<string, unknown>[] | null = null, authToken?: string): Promise<number | null> {
  const now = new Date();
  const conv = clause ? { OR: clause } : {};
  switch (metric) {
    case "waiting_for_person":
      return waitingForPerson(authToken);
    case "inbound_messages_24h": {
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      return prisma.message.count({
        where: { tenantId, direction: "INBOUND", createdAt: { gte: since }, conversation: { ...REAL_CONVERSATION, ...conv } },
      });
    }
    case "open_conversations": {
      // Private numbers are never counted, as in every list (lib/private-numbers).
      const priv = privateConversationsClause(await privateNumbers(tenantId));
      return prisma.conversation.count({ where: { tenantId, ...REAL_CONVERSATION, status: "OPEN", ...conv, ...(priv ? { AND: [priv] } : {}) } });
    }
    case "closed_today": {
      const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
      return prisma.conversation.count({
        where: { tenantId, ...REAL_CONVERSATION, status: "CLOSED", closedAt: { gte: startOfDay }, ...conv },
      });
    }
    case "pending_approvals":
      // As Home and the Approvals list: still actionable, i.e. not past its expiry
      // (the sweeper that flips PENDING to EXPIRED runs on its own schedule).
      return (prisma as any).approvalRequest.count({ where: { tenantId, status: "PENDING", expiresAt: { gt: now } } });
    default:
      return null;
  }
}

// ─── propose_plan ───────────────────────────────────────────

async function dispatchProposePlan(
  args: any,
  toolCallId: string,
  ctx: SystemToolDispatchCtx,
): Promise<SystemToolResult> {
  // The model's summary is not used: the words are built from the steps.
  const stepsRaw = Array.isArray(args?.steps) ? args.steps : [];
  if (stepsRaw.length === 0) {
    return {
      toolCallId,
      content: JSON.stringify({ ok: false, error: "at least one step is required" }),
    };
  }

  // A step that cannot run is refused now, not discovered after approval.
  const unavailable = [...new Set(stepsRaw.map((s: any) => String(s?.tool || "")).filter((t: string) => !(PLAN_ACTIONS as readonly string[]).includes(t)))];
  if (unavailable.length) {
    return {
      toolCallId,
      content: JSON.stringify({
        ok: false,
        error: `these steps cannot be carried out: ${unavailable.join(", ")}`,
        instruction: "Tell the operator plainly that this cannot be done from here yet. Do not propose it again in other words.",
      }),
    };
  }

  const rawSteps = stepsRaw.map((s: any) => ({
    tool: String(s?.tool || ""),
    params: s?.params && typeof s.params === "object" ? s.params : {},
    reason: String(s?.reason || ""),
    riskLevel: (["low", "medium", "high"].includes(s?.riskLevel) ? s.riskLevel : "medium") as "low" | "medium" | "high",
  }));

  // Pinned now (lib: assistant-plan): the conversation, the assignee ("me"
  // is the requester), what the requester may see; the words are ours.
  const locale = ctx.locale ?? "en";
  let steps;
  try {
    steps = await preparePlan({ tenantId: ctx.tenantId, userId: ctx.userId, viewer: ctx.viewer, locale, canReadContacts: !!ctx.canReadContacts }, rawSteps);
  } catch (err) {
    if (err instanceof PlanRefused) return { toolCallId, content: JSON.stringify({ ok: false, error: err.message }) };
    throw err;
  }
  const planSummary = steps.map((s) => s.summary).join("; ");
  const first = steps.find((s) => s.target.conversationId || s.target.customerId)?.target;
  const source = ctx.surface === "home" ? "home_assistant" : "command_bar";
  const requester = { userId: ctx.userId, name: ctx.userName ?? null };

  // Audit each step's gate decision so the operator's approval UI can show
  // an aggregate "needs approval / cleared" status. We don't actually
  // execute anything here - the existing approval-resume path in the
  // conversation service runs the steps when the human clicks Approve.
  const stepGates = await Promise.all(
    steps.map(async (s: any) => {
      try {
        const gate = await evaluateToolGate(ctx.tenantId, s.tool);
        return { tool: s.tool, decision: gate.decision, reason: gate.reason };
      } catch (err: any) {
        return { tool: s.tool, decision: "DENY" as const, reason: err?.message || "gate error" };
      }
    }),
  );

  const asked = locale === "he"
    ? `בקשה של ${requester.name ?? "משתמש בצוות"} מ-GOTCHA ב${source === "home_assistant" ? "-Home" : "שורת הפקודה"}`
    : `${requester.name ?? "A user"} asked GOTCHA in ${source === "home_assistant" ? "Home" : "the command bar"}`;
  const approval = await createApprovalRequest({
    tenantId: ctx.tenantId,
    contactId: first?.customerId ?? ctx.selectedContactId ?? undefined,
    conversationId: first?.conversationId ?? ctx.selectedConversationId ?? undefined,
    tool: "propose_plan",
    // The steps carry their pinned params, their target and their words.
    params: { summary: planSummary, steps, requester, source },
    summary: planSummary,
    reason: asked,
    riskLevel: steps.some((s) => s.riskLevel === "high") ? "high" : "medium",
    riskTags: ["ASSISTANT", "PLAN"],
    requestedBy: `user:${ctx.userId}`,
    gate: { decision: "REQUIRE_APPROVAL", reason: asked } as any,
  });

  return {
    toolCallId,
    content: JSON.stringify({
      ok: true,
      proposed_plan: true,
      approval_request_id: approval.id,
      step_count: steps.length,
      summary: planSummary,
      step_gates: stepGates,
      instruction:
        "A plan was proposed and is waiting in the operator's approval queue. Tell the operator briefly what you proposed and that they can review and approve it. Do NOT continue calling action tools for the same goal.",
    }),
    sideEffect: {
      kind: "proposed_plan",
      approvalRequestId: approval.id,
      planSummary,
    },
  };
}
