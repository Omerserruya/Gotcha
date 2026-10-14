/**
 * Flow Canvas graph executor.
 *
 * Walks the node/edge graph saved by the Main Playbook editor (FlowCanvas) - or
 * by the Sub-flow editor (ChatbotFlow.nodes/edges). The executor does exactly
 * what the graph says: every edge is followed literally, every node's behavior
 * is defined in one place, and there is no "rule fallback" path that bypasses
 * the canvas.
 *
 * Supported node types (shared between Main Playbook and Sub-flow):
 *   - channel_entry        - main-flow entry; matched by inbound channel
 *   - start                - sub-flow entry (or main-flow with no channel_entry)
 *   - condition_group      - branches on "true" / "false" handle
 *   - send_message_text    - outbound text
 *   - send_message_interactive - outbound text with CTA link appended
 *   - send_message_quick_reply - outbound interactive with reply buttons; pauses
 *   - send_message_image   - outbound image by URL (+ caption)
 *   - send_message_file    - outbound document by URL (+ filename, caption)
 *   - send_message_template - outbound WABA template (WhatsApp only); re-opens 24h window
 *   - route_target         - dispatch: AI agent / sub-flow / human / department
 *   - default_fallback     - same as route_target but visually distinct
 *   - end                  - terminate: close / handoff_human / wait_for_reply
 *
 * When no FlowCanvas exists for a tenant, the caller falls back to the legacy
 * RouterRule-list evaluator in routing.service.ts. That is the only escape hatch.
 */

import { prisma, getOutboundAdapter, decryptCredentials, publishEvent, flowResumeQueue, describeSendError, safeFetch as sharedSafeFetch } from "@chatcenter/shared";
import type { ChannelCredentials } from "@chatcenter/shared";
import { processAIBot, getBusinessHoursState } from "./ai-bot.service";
import { tryLinkIdentifierFromInbound } from "./identity-link.service";
import { withRemovalLine, hasRemovalLine, isOptedOutOn } from "@chatcenter/shared/src/lib/marketing-optout";
import { hasReplyWindow, lastInboundAtForRecipient, replyWindowFor, sendAllowed } from "@chatcenter/shared/src/lib/reply-window";

// ─── Graph shapes (ReactFlow-compatible) ─────────────────────

interface GraphNode {
  id: string;
  type: string;
  data: Record<string, any>;
  position?: { x: number; y: number };
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

interface ChannelSendContext {
  channel: string; // stored uppercase ("WHATSAPP", "MESSENGER", ...)
  channelAccountExternalId: string;
  credentials: ChannelCredentials;
  recipientId: string;
}

interface FlowExecCtx {
  tenantId: string;
  // Null for context-free runs (webhook triggers - see executeWebhookFlow).
  // Conversation-bound flows (message / comment triggered) always carry a real
  // id. Every Conversation read/write below is guarded on this being non-null,
  // so both paths share one walker without the context-free path ever touching
  // a Conversation row.
  conversationId: string | null;
  message: string;
  channel: string; // inbound channel, lowercased for comparisons
  sendCtx: ChannelSendContext | null;
  // Per-conversation variable store. Read from Conversation.flowVariables at
  // the start of a walk; mutated in-place by Set Variable / HTTP Request / AI
  // Generate / Collect Input / Bring User Data; persisted back on halt.
  // Interpolated into Send* node text via {{var_name}} placeholders.
  vars: Record<string, any>;
  // When this walk came from executeSubFlow's resumeNodeId path, the current
  // inbound message carries the user's reply to a paused Collect Input. We
  // store it into the named variable and then continue - see walk().
  resumingCollectInputVar?: string | null;
  // Scope tag used for flow-resume jobs (Wait node). "main" = FlowCanvas;
  // "sub" = ChatbotFlow row identified by `flowId`.
  flowScope: "main" | "sub";
  flowId?: string;
  trace: Array<{ nodeId: string; type: string; action: string; detail?: any }>;
  // Set when this walk is an automation run (Studio > Automations): the run
  // log, the one-responder rule and the cursor all key on it.
  run?: AutomationRunCtx;
}

export interface AutomationRunCtx {
  id: string;
  flowId: string;
  // This run responded to the inbound that fired or resumed it: it sent
  // something that arrived, parked waiting for the customer, or handed the
  // conversation on. The AI employee then does not also answer that message.
  answered: boolean;
  currentNodeId: string | null;
  // Who owned the conversation before the run claimed it (restored at the end).
  prevOwner: string | null;
  // A marketing run (MARKETING_TRIGGERS): its messages carry the removal line.
  marketing?: boolean;
}

/**
 * Triggers whose messages are marketing (opt-out model, docs/product/
 * ai-studio-skills-automations.md §6): every message carries the removal line.
 * A review request joins this set when it exists.
 */
export const MARKETING_TRIGGERS = new Set(["cart_abandoned"]);

/**
 * Triggers whose messages become marketing AFTER a wait: an order's status
 * update is transactional, but "order fulfilled → wait 3 days → ask for a
 * review" is not (a review, an upsell, a follow-up). A send after a wait
 * happens in a resumed walk, so `afterWait` is "this walk resumed a run".
 */
export const MARKETING_AFTER_WAIT = new Set(["order_event"]);

export function isMarketingRun(triggerType: string | null | undefined, afterWait: boolean): boolean {
  const t = String(triggerType ?? "");
  return MARKETING_TRIGGERS.has(t) || (afterWait && MARKETING_AFTER_WAIT.has(t));
}

/**
 * Has the customer opted out on this conversation's channel since the run
 * started? The gate ran when the event arrived; a "הסר" during a wait (between
 * two cart reminders, before a review request) must still win at send time.
 */
async function optedOutNow(ctx: FlowExecCtx): Promise<boolean> {
  if (!ctx.conversationId) return false;
  const conv = await prisma.conversation.findUnique({ where: { id: ctx.conversationId }, select: { customerExternalId: true, channel: true } }).catch(() => null);
  if (!conv?.customerExternalId) return false;
  const contact = await prisma.contact.findFirst({
    where: { tenantId: ctx.tenantId, channel: conv.channel as any, externalId: conv.customerExternalId },
    select: { optOutChannels: true },
  }).catch(() => null);
  return isOptedOutOn(contact?.optOutChannels, String(conv.channel));
}

export interface FlowExecutionResult {
  executed: boolean;      // true when a FlowCanvas was found and walked
  halted: boolean;        // true when we reached a terminal node or paused
  reason?:
    | "end_node"
    | "route_dispatched"
    | "wait_for_reply"
    | "no_outgoing_edge"
    // A quick-reply tap that matched none of the labelled exits. The cursor is
    // deliberately left where it is rather than guessing a branch.
    | "quick_reply_unresolved"
    | "loop_guard"
    | "no_adapter"
    | "no_entry"
    // An inbound arrived while the flow sits on a timed Wait: the timer, not
    // the message, moves it on (resuming here ran the rest of the flow twice).
    | "waiting_on_timer"
    // A Wait-for-reply had no exit for what the customer did.
    | "no_branch"
    // The automation was paused or deleted while a run was parked.
    | "automation_inactive";
  matchedNodeId?: string | null;
  endKind?: "close" | "handoff_human" | "wait_for_reply";
  route?: { routeType: "AI_AGENT" | "FLOW" | "HUMAN" | "DEPARTMENT"; targetId: string | null };
  trace: Array<{ nodeId: string; type: string; action: string; detail?: any }>;
}

// ─── Public entry: main flow (FlowCanvas) ────────────────────

export async function executeMainFlow(opts: {
  tenantId: string;
  conversationId: string;
  message: string;
  channel: string; // "whatsapp", "messenger", ...
  resumeNodeId?: string | null; // set when the main flow resumes after a Wait
  /**
   * The button id the customer actually tapped, when this inbound is an
   * interactive reply. Distinct from `message`, which carries the button's
   * visible TITLE - the two are different strings in every flow whose author
   * gave a reply a machine-readable payload.
   */
  replyPayload?: string | null;
  /** The flow-resume worker's timer, not an inbound message. */
  fromTimer?: boolean;
}): Promise<FlowExecutionResult> {
  const canvas = await prisma.flowCanvas.findUnique({ where: { tenantId: opts.tenantId } });
  const nodes = (canvas?.nodes as unknown as GraphNode[]) || [];
  const edges = (canvas?.edges as unknown as GraphEdge[]) || [];

  if (!canvas || nodes.length === 0) {
    return { executed: false, halted: false, trace: [] };
  }

  // Resume path: if Wait / Collect Input paused at a known node, restart there.
  let startId: string | null = null;
  let resumingVar: string | null = null;
  if (opts.resumeNodeId) {
    const paused = nodes.find((n) => n.id === opts.resumeNodeId);
    if (paused?.type === "wait" && !opts.fromTimer) return waitingOnTimer(paused);
    if (paused) {
      if (paused.type === "collect_input") {
        // The inbound `message` is the reply the user just sent; store it into
        // the configured variable and proceed.
        resumingVar = String(paused.data?.variable || "").trim() || null;
        const out = edges.find((e) => e.source === paused.id);
        startId = out?.target ?? null;
      } else if (paused.type === "send_message_quick_reply") {
        const pick = pickQuickReplyEdge(paused, edges, opts.message, opts.replyPayload);
        // Unresolved means "we could not tell which branch". Falling through
        // to the entry picker below would restart the flow and re-send every
        // message the customer already has.
        if (pick.unresolved) {
          reportUnresolvedQuickReply({
            tenantId: opts.tenantId,
            conversationId: opts.conversationId,
            nodeId: paused.id,
            message: opts.message,
            replyPayload: opts.replyPayload,
            edges,
          });
          return {
            executed: false,
            halted: true,
            reason: "quick_reply_unresolved",
            matchedNodeId: paused.id,
            trace: [{ nodeId: paused.id, type: paused.type, action: "quick_reply_unresolved" }],
          };
        }
        startId = pick.target;
      } else {
        // Generic resume (Wait, etc) - continue from first outgoing edge.
        const out = edges.find((e) => e.source === paused.id);
        startId = out?.target ?? null;
      }
    }
  }

  if (!startId) {
    // Read the ad origin only when a campaign entry actually exists. Most
    // tenants have none, and this runs on every inbound message.
    const campaign = nodes.some((n) => n.type === "campaign_entry")
      ? await loadCampaignOrigin(opts.tenantId, opts.conversationId)
      : null;
    const entry = pickMainFlowEntry(nodes, opts.channel, opts.message, campaign);
    if (!entry) return { executed: false, halted: false, reason: "no_entry", trace: [] };
    startId = entry.id;
  }

  const ctx = await buildCtx(opts, { flowScope: "main" });
  ctx.resumingCollectInputVar = resumingVar;
  return walk(startId, nodes, edges, ctx);
}

// ─── Public entry: sub flow (ChatbotFlow) ────────────────────

export async function executeSubFlow(opts: {
  tenantId: string;
  conversationId: string;
  message: string;
  channel: string;
  flowId: string;
  resumeNodeId?: string | null; // set when continuing after quick_reply / Wait / collect_input
  /** See executeMainFlow - the tapped button id, not its visible title. */
  replyPayload?: string | null;
  /** See executeMainFlow. */
  fromTimer?: boolean;
  /** A Wait-for-reply timeout fired (take its "timeout" exit). */
  timeout?: boolean;
  /** This walk is an automation run. */
  run?: AutomationRunCtx;
  /** The triggering event's variables ({{cart_url}}, {{order_number}}, ...). */
  vars?: Record<string, unknown>;
}): Promise<FlowExecutionResult> {
  const flow = await prisma.chatbotFlow.findFirst({
    where: { id: opts.flowId, tenantId: opts.tenantId, isActive: true },
  });
  if (!flow) {
    return opts.run
      ? { executed: false, halted: true, reason: "automation_inactive", trace: [] }
      : { executed: false, halted: false, trace: [] };
  }

  const nodes = (flow.nodes as unknown as GraphNode[]) || [];
  const edges = (flow.edges as unknown as GraphEdge[]) || [];
  if (nodes.length === 0) return { executed: false, halted: false, trace: [] };

  let startId: string | null = null;
  let resumingVar: string | null = null;
  let resumeTrace: FlowExecCtx["trace"] = [];
  if (opts.resumeNodeId) {
    const paused = nodes.find((n) => n.id === opts.resumeNodeId);
    if (paused?.type === "wait" && !opts.fromTimer) return waitingOnTimer(paused);
    if (paused?.type === "wait_for_reply") {
      // A timer that is not this node's timeout, or a reply after the
      // timeout already fired, does not move it.
      if (opts.fromTimer && !opts.timeout) return waitingOnTimer(paused);
      const branch = opts.timeout ? "timeout" : replyBranch(paused, nodes, edges, opts.message, opts.replyPayload);
      const out = edges.find((e) => e.source === paused.id && e.sourceHandle === branch);
      resumeTrace = [{ nodeId: paused.id, type: paused.type, action: out ? "resumed" : "no_branch", detail: { branch } }];
      if (!out) {
        return { executed: true, halted: true, reason: "no_branch", matchedNodeId: paused.id, trace: resumeTrace };
      }
      startId = out.target;
    } else if (paused) {
      if (paused.type === "collect_input") {
        resumingVar = String(paused.data?.variable || "").trim() || null;
        const out = edges.find((e) => e.source === paused.id);
        startId = out?.target ?? null;
      } else if (paused.type === "send_message_quick_reply") {
        const pick = pickQuickReplyEdge(paused, edges, opts.message, opts.replyPayload);
        if (pick.unresolved) {
          reportUnresolvedQuickReply({
            tenantId: opts.tenantId,
            conversationId: opts.conversationId,
            nodeId: paused.id,
            message: opts.message,
            replyPayload: opts.replyPayload,
            edges,
          });
          return {
            executed: false,
            halted: true,
            reason: "quick_reply_unresolved",
            matchedNodeId: paused.id,
            trace: [{ nodeId: paused.id, type: paused.type, action: "quick_reply_unresolved" }],
          };
        }
        startId = pick.target;
      } else {
        const out = edges.find((e) => e.source === paused.id);
        startId = out?.target ?? null;
      }
    }
  }
  if (!startId && !opts.resumeNodeId) {
    // An automation enters at its trigger step; a playbook sub-flow at Start.
    const startNode = nodes.find((n) => n.type === "automation_trigger") ?? nodes.find((n) => n.type === "start");
    startId = startNode?.id ?? null;
    if (startNode?.type === "start") {
      const out = edges.find((e) => e.source === startNode.id);
      startId = out?.target ?? startNode.id;
    }
  }
  if (!startId) return { executed: false, halted: false, reason: "no_entry", trace: resumeTrace };

  const ctx = await buildCtx(opts, { flowScope: "sub", flowId: opts.flowId });
  ctx.resumingCollectInputVar = resumingVar;
  ctx.run = opts.run;
  if (opts.run) Object.assign(ctx.vars, await runVariables(ctx), opts.vars ?? {});
  ctx.trace.push(...resumeTrace);
  return walk(startId, nodes, edges, ctx);
}

// ─── Public entry: context-free webhook run ──────────────────
//
// Fired by an inbound WebhookTrigger (resolved by token in services/webhook,
// enqueued as a "webhook-trigger" job, consumed by the incoming worker). There
// is NO conversation and NO customer: the flow runs purely off the payload.
//
// The incoming JSON is exposed as flow variables under `body` (n8n style), so
// downstream nodes read `{{body.order_id}}`, `{{body.customer.email}}`, etc.
// via the same interpolation + dotted-path resolver every other node uses.
//
// Conversation-bound concerns degrade gracefully: Send* nodes no-op (no
// sendCtx), pause nodes (Collect Input / Quick Reply / Wait) halt without
// persisting resume state (there is no thread to resume), and Route / End /
// customer-data nodes skip their Conversation/Contact writes. Resolving a
// customer to attach context is a separate future in-flow node (out of scope).
export async function executeWebhookFlow(opts: {
  tenantId: string;
  workflowId: string;
  payload: unknown;
  // "flow" (default) runs the associated ChatbotFlow; "connected" walks the
  // nodes wired to the webhook trigger node on the Main Playbook canvas. The
  // two paths share walk() - only entry resolution + which graph differs.
  targetMode?: "flow" | "connected";
  /** This walk is an automation run (schedule / webhook automations). */
  run?: AutomationRunCtx;
}): Promise<FlowExecutionResult> {
  if (opts.targetMode === "connected") {
    return executeWebhookConnectedNodes(opts);
  }

  const flow = await prisma.chatbotFlow.findFirst({
    where: { id: opts.workflowId, tenantId: opts.tenantId, isActive: true },
  });
  if (!flow) return { executed: false, halted: false, trace: [] };

  const nodes = (flow.nodes as unknown as GraphNode[]) || [];
  const edges = (flow.edges as unknown as GraphEdge[]) || [];
  if (nodes.length === 0) return { executed: false, halted: false, trace: [] };

  // Entry resolution mirrors executeSubFlow but also honors a dedicated
  // `webhook_trigger` entry node when present (the trigger-node UI is ticket 4;
  // walking through one here is forward-compatible and harmless for flows that
  // still start from a plain `start` node).
  const entryNode =
    nodes.find((n) => n.type === "automation_trigger") ||
    nodes.find((n) => n.type === "webhook_trigger") ||
    nodes.find((n) => n.type === "start") ||
    null;
  let startId: string | null = null;
  if (entryNode) {
    const out = edges.find((e) => e.source === entryNode.id);
    startId = out?.target ?? entryNode.id;
  } else {
    startId = nodes[0]?.id ?? null;
  }
  if (!startId) return { executed: false, halted: false, reason: "no_entry", trace: [] };

  // Bookkeeping parity with sub-flow dispatch.
  await prisma.chatbotFlow
    .update({ where: { id: flow.id }, data: { runCount: { increment: 1 } } })
    .catch(() => {});

  const ctx: FlowExecCtx = {
    tenantId: opts.tenantId,
    conversationId: null,
    message: "",
    channel: "",
    sendCtx: null,
    // n8n-style payload exposure. `{{body.<field>}}` resolves through the same
    // getByPath used for every other variable.
    vars: { body: opts.payload ?? {} },
    flowScope: "sub",
    flowId: flow.id,
    trace: [],
    run: opts.run,
  };
  return walk(startId, nodes, edges, ctx);
}

// ─── Public entry: context-free webhook run (connected-nodes mode) ──
//
// Sibling of executeWebhookFlow's default path. Instead of running a separate
// ChatbotFlow, this walks the nodes wired to the webhook trigger node on the
// tenant's Main Playbook canvas (FlowCanvas) - the same canvas the trigger node
// lives on. Everything downstream is identical to the flow-mode webhook run:
// the payload is exposed as `{{body.*}}`, there is no conversation/customer, and
// every Conversation-bound concern degrades gracefully (Send* no-op, pause nodes
// halt without persisting resume state, etc).
//
// The trigger node is identified by its associated `workflowId` (the same anchor
// flow-mode uses); we prefer the node whose `data.workflowId` matches, then fall
// back to any webhook trigger node on the canvas.
async function executeWebhookConnectedNodes(opts: {
  tenantId: string;
  workflowId: string;
  payload: unknown;
}): Promise<FlowExecutionResult> {
  const canvas = await prisma.flowCanvas.findUnique({ where: { tenantId: opts.tenantId } });
  const nodes = (canvas?.nodes as unknown as GraphNode[]) || [];
  const edges = (canvas?.edges as unknown as GraphEdge[]) || [];
  if (!canvas || nodes.length === 0) return { executed: false, halted: false, trace: [] };

  const entryNode =
    nodes.find(
      (n) => n.type === "webhook_trigger" && String(n.data?.workflowId || "") === opts.workflowId,
    ) ||
    nodes.find((n) => n.type === "webhook_trigger") ||
    null;
  if (!entryNode) return { executed: false, halted: false, reason: "no_entry", trace: [] };

  const ctx: FlowExecCtx = {
    tenantId: opts.tenantId,
    conversationId: null,
    message: "",
    channel: "",
    sendCtx: null,
    vars: { body: opts.payload ?? {} },
    // Main Playbook canvas. Irrelevant for context-free runs (no resume jobs are
    // scheduled when conversationId is null) but tagged honestly.
    flowScope: "main",
    trace: [],
  };
  // Manual field mapper (Card 5): bind declared body.* fields onto the first
  // connected node's inputs before we walk into it. Mutates the in-memory node
  // copy only - never persisted.
  applyWebhookFieldMapping(entryNode, nodes, edges);
  // Start at the trigger node itself - walk()'s `webhook_trigger` case enters it
  // and continues to its first outgoing edge, so an unwired trigger halts cleanly
  // with no_outgoing_edge instead of crashing.
  return walk(entryNode.id, nodes, edges, ctx);
}

// ─── Manual field mapper (Card 5) ──────────────────────────────────
//
// The webhook trigger node can carry a user-authored `data.fieldMapping`:
//   [{ source: "<declared body field>", target: "<input key>" }]
// where `target` is either a plain input key on the first connected node
// ("recipient", "text", …) or a template-variable target encoded as
// "var:<placeholder>" (→ data.variables[placeholder]).
//
// We resolve a mapping by writing a `{{body.<source>}}` reference into the
// target node's data - deliberately reusing the existing interpolation path
// (interpolate/getByPath) so the runtime substitution and the long-standing
// `{{body.*}}` reference behavior stay identical. The mapper is just a UI over
// those references; an author who hand-types `{{body.x}}` gets the same result.
//
// Only the FIRST connected node (first outgoing edge of the trigger) is mapped -
// that is exactly the node the user binds against in the Inspector.
function applyWebhookFieldMapping(
  entryNode: GraphNode,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const mapping = entryNode.data?.fieldMapping;
  if (!Array.isArray(mapping) || mapping.length === 0) return;
  const firstEdge = edges.find((e) => e.source === entryNode.id);
  if (!firstEdge) return;
  const target = nodes.find((n) => n.id === firstEdge.target);
  if (!target) return;
  target.data = target.data || {};
  for (const m of mapping) {
    const source = String(m?.source ?? "").trim();
    const targetKey = String(m?.target ?? "").trim();
    if (!source || !targetKey) continue;
    const ref = `{{body.${source}}}`;
    if (targetKey.startsWith("var:")) {
      const varName = targetKey.slice(4).trim();
      if (!varName) continue;
      const vars =
        target.data.variables && typeof target.data.variables === "object"
          ? { ...target.data.variables }
          : {};
      vars[varName] = ref;
      target.data.variables = vars;
    } else {
      target.data[targetKey] = ref;
    }
  }
}

// ─── Internals ───────────────────────────────────────────────

async function buildCtx(
  opts: {
    tenantId: string;
    conversationId: string;
    message: string;
    channel: string;
  },
  scope: { flowScope: "main" | "sub"; flowId?: string },
): Promise<FlowExecCtx> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: opts.conversationId, tenantId: opts.tenantId },
    include: { channelAccount: true },
  });

  let sendCtx: ChannelSendContext | null = null;
  if (conversation?.channelAccount) {
    const raw = (conversation.channelAccount as any).credentials;
    const creds =
      typeof raw === "string" ? decryptCredentials(raw) : ((raw as any) || {});
    sendCtx = {
      channel: conversation.channel as unknown as string,
      channelAccountExternalId: (conversation.channelAccount as any).externalId,
      credentials: creds as ChannelCredentials,
      recipientId: conversation.customerExternalId,
    };
  }

  // Load the per-conversation variable store. Anything missing is treated as
  // an empty object; individual nodes are responsible for setting values.
  const existingVars =
    conversation && (conversation as any).flowVariables
      ? (conversation as any).flowVariables
      : {};

  return {
    tenantId: opts.tenantId,
    conversationId: opts.conversationId,
    message: opts.message,
    channel: opts.channel.toLowerCase(),
    sendCtx,
    vars: typeof existingVars === "object" && existingVars !== null ? { ...existingVars } : {},
    flowScope: scope.flowScope,
    flowId: scope.flowId,
    trace: [],
  };
}

/**
 * Which edge a quick-reply tap resumes down.
 *
 * The editor writes one exit per reply and sets its handle id to the reply's
 * lowercased PAYLOAD (see `send_message_quick_reply.getSources` in
 * frontend/.../node-registry.tsx). What used to be matched against it was
 * `opts.message` - and for an interactive reply the webhook sets the message
 * body to the button's TITLE, not its payload:
 *
 *   services/webhook/.../webhook.ts
 *     body = content.interactiveReply.title || content.text || ""
 *
 * So the comparison only succeeded when a button's label and payload happened
 * to be the same word. That is true of the default reply the editor seeds
 * (`label: "Yes", payload: "yes"`), and false for essentially every real flow.
 * On a miss the old code fell through to `out[0]` - the first outgoing edge in
 * PERSISTED ARRAY ORDER, which is not a choice any author made and is not
 * visible anywhere on the canvas. A customer tapping "Continue" could be sent
 * down the "Talk to sales" branch, skipping the deterministic steps that were
 * supposed to run first and landing on an AI handoff early.
 *
 * The invariant now: a branch is selected by what the customer actually
 * pressed, never by edge order.
 *
 *   1. the interactive reply payload
 *   2. the visible label, resolved through the node's own replies to a payload
 *      (so a customer who TYPES "Continue" instead of tapping still works)
 *   3. an exit the author deliberately left unlabelled - the catch-all
 *   4. the only exit, when there is exactly one and nothing can be got wrong
 *   5. otherwise: unresolved. Never a guess.
 */
function normalizeReplyKey(v: unknown): string {
  return String(v ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

/** The handle id the editor would have written for a reply. */
function replyHandleId(r: any): string {
  return normalizeReplyKey(r?.payload || r?.label || r?.id || "");
}

export interface QuickReplyPick {
  target: string | null;
  unresolved: boolean;
  /** Machine-readable, for the diagnostic the caller emits. */
  how: "payload" | "label" | "catch_all" | "sole_exit" | "no_exits" | "unresolved";
}

function pickQuickReplyEdge(
  paused: GraphNode,
  edges: GraphEdge[],
  message: string,
  replyPayload?: string | null,
): QuickReplyPick {
  const out = edges.filter((e) => e.source === paused.id);
  if (out.length === 0) return { target: null, unresolved: false, how: "no_exits" };

  const handle = (e: GraphEdge) => normalizeReplyKey(e.sourceHandle);
  const payload = normalizeReplyKey(replyPayload);
  const text = normalizeReplyKey(message);

  // 1. Exact payload - the button the customer actually pressed.
  if (payload) {
    const hit = out.find((e) => handle(e) === payload);
    if (hit) return { target: hit.target, unresolved: false, how: "payload" };
  }

  // 2. Visible label. Resolve it through the node's replies to the payload the
  //    editor keyed the edge on, so a Hebrew label over an ASCII payload
  //    ("המשך" -> "continue_shopping") still lands on the right branch. Falling
  //    back to the raw text covers a customer who types the payload itself.
  if (text) {
    const replies: any[] = Array.isArray(paused.data?.replies) ? paused.data.replies : [];
    const byLabel = replies.find((r) => normalizeReplyKey(r?.label) === text);
    const wanted = byLabel ? replyHandleId(byLabel) : text;
    const hit = out.find((e) => handle(e) === wanted);
    if (hit) return { target: hit.target, unresolved: false, how: "label" };
  }

  // 3. An exit the author left unlabelled is the explicit "anything else".
  const catchAll = out.find((e) => !handle(e));
  if (catchAll) return { target: catchAll.target, unresolved: false, how: "catch_all" };

  // 4. One exit: there is no branch to get wrong.
  if (out.length === 1) return { target: out[0].target, unresolved: false, how: "sole_exit" };

  // 5. Several labelled branches, none matched. Guessing here is the defect.
  return { target: null, unresolved: true, how: "unresolved" };
}

/**
 * Say - loudly and in one place - that a tap could not be resolved. Silence is
 * what let a wrong-branch jump look like a working flow.
 */
function reportUnresolvedQuickReply(opts: {
  tenantId: string;
  conversationId?: string | null;
  nodeId: string;
  message: string;
  replyPayload?: string | null;
  edges: GraphEdge[];
}): void {
  const exits = opts.edges
    .filter((e) => e.source === opts.nodeId)
    .map((e) => normalizeReplyKey(e.sourceHandle) || "(unlabelled)");
  console.warn(
    `[flow] quick_reply_unresolved node=${opts.nodeId} conversation=${opts.conversationId ?? "-"} ` +
      `payload="${normalizeReplyKey(opts.replyPayload)}" text="${normalizeReplyKey(opts.message)}" ` +
      `exits=[${exits.join(",")}] - cursor kept, flow not advanced`,
  );
  publishEvent({
    event: "flow:quick_reply_unresolved",
    tenantId: opts.tenantId,
    data: {
      conversationId: opts.conversationId ?? null,
      nodeId: opts.nodeId,
      replyPayload: opts.replyPayload ?? null,
      messageText: opts.message,
      exits,
    },
  }).catch(() => {});
}

/**
 * The conversation's ad origin. Null when there is no conversation (a
 * context-free webhook run) or when the row cannot be read - a campaign entry
 * then simply does not match, which is the safe direction: a paid lead routed
 * to the normal flow is a missed opportunity, while a normal lead routed into
 * a campaign flow is a wrong conversation.
 */
async function loadCampaignOrigin(
  tenantId: string,
  conversationId: string | null,
): Promise<CampaignOrigin | null> {
  if (!conversationId) return null;
  try {
    const row = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { fromAdCampaign: true, referralSourceId: true, referralHeadline: true },
    });
    return row ?? null;
  } catch (err: any) {
    console.warn("[flow-executor] could not read campaign origin:", err?.message ?? err);
    return null;
  }
}

/** The conversation's ad origin, for entries that filter on it. */
export interface CampaignOrigin {
  fromAdCampaign: boolean;
  referralSourceId?: string | null;
  referralHeadline?: string | null;
}

/**
 * Does a `campaign_entry` node match this conversation?
 *
 * Two modes, and the difference matters commercially:
 *   * ANY ad - "everyone who came from advertising", the common case;
 *   * a SPECIFIC ad id - one campaign gets its own greeting and its own flow.
 *
 * An ad id typed by a person is matched leniently (trimmed, case-insensitive)
 * because it is copied out of Meta's UI by hand and a stray space should not
 * silently route a paid lead into nothing.
 */
export function campaignEntryMatches(node: GraphNode, origin: CampaignOrigin | null): boolean {
  if (!origin?.fromAdCampaign) return false;
  const scope = String(node.data?.scope || "any");
  if (scope !== "specific") return true;

  const wantedIds: string[] = (Array.isArray(node.data?.sourceIds) ? node.data.sourceIds : [])
    .map((v: unknown) => String(v ?? "").trim().toLowerCase())
    .filter(Boolean);
  if (wantedIds.length === 0) {
    // Configured for one ad but no ad named. Refusing to match is the safe
    // reading: firing on every campaign would be the opposite of what the
    // author asked for, and silently.
    return false;
  }
  const actual = String(origin.referralSourceId ?? "").trim().toLowerCase();
  return actual.length > 0 && wantedIds.includes(actual);
}

function pickMainFlowEntry(
  nodes: GraphNode[],
  channel: string,
  message?: string,
  campaign?: CampaignOrigin | null,
): GraphNode | null {
  const wanted = channel.toLowerCase();
  const msg = (message || "").toLowerCase();

  // 0) Campaign entry outranks everything.
  //
  // A lead the business PAID for, arriving with a specific ad in mind, is the
  // most specific thing we know about an inbound message - more specific than
  // the channel it came in on, and more specific than a keyword that happens
  // to appear in their text. A flow author who wires a campaign entry means
  // "when someone comes from this ad, do THIS", and any other entry winning
  // would make that unreliable.
  const campaignEntries = nodes.filter((n) => n.type === "campaign_entry");
  // Specific-ad entries are considered before catch-alls, so a general
  // "from any ad" flow cannot shadow a per-campaign one.
  const ordered = [
    ...campaignEntries.filter((n) => String(n.data?.scope || "any") === "specific"),
    ...campaignEntries.filter((n) => String(n.data?.scope || "any") !== "specific"),
  ];
  for (const entry of ordered) {
    if (campaignEntryMatches(entry, campaign ?? null)) return entry;
  }

  // 1) Keyword trigger that matches this inbound wins - bypasses channel entry.
  //    Lets authors wire "menu", "help", "start over" flows that fire no matter
  //    where the conversation currently is.
  const keywordTriggers = nodes.filter((n) => n.type === "keyword_trigger");
  for (const kw of keywordTriggers) {
    const list: string[] = Array.isArray(kw.data?.keywords) ? kw.data.keywords : [];
    const mt = String(kw.data?.matchType || "any");
    const cs = !!kw.data?.caseSensitive;
    const haystack = cs ? (message || "") : msg;
    const needles = list.map((k) => (cs ? k : k.toLowerCase())).filter(Boolean);
    if (needles.length === 0) continue;
    const hit =
      mt === "exact"
        ? needles.some((n) => haystack.trim() === n.trim())
        : mt === "all"
        ? needles.every((n) => haystack.includes(n))
        : needles.some((n) => haystack.includes(n));
    if (hit) return kw;
  }

  // 2) Channel-specific entry
  const specific = nodes.find(
    (n) => n.type === "channel_entry" && String(n.data?.channelType || "").toLowerCase() === wanted,
  );
  if (specific) return specific;
  // 3) Any channel_entry (covers flows authored without channel-binding)
  const anyChannel = nodes.find((n) => n.type === "channel_entry");
  if (anyChannel) return anyChannel;
  // 4) A Start node - rare for the main flow, but supported
  return nodes.find((n) => n.type === "start") || null;
}

async function walk(
  startNodeId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  ctx: FlowExecCtx,
): Promise<FlowExecutionResult> {
  let currentId: string | null = startNodeId;
  const visited = new Set<string>();
  const MAX_STEPS = 50;
  let steps = 0;

  // If we're resuming from a Collect Input node, the inbound message IS the
  // captured reply. Store it under the configured variable name before we
  // walk the next step.
  if (ctx.resumingCollectInputVar && ctx.message) {
    ctx.vars[ctx.resumingCollectInputVar] = ctx.message;
    ctx.trace.push({
      nodeId: "(resume)",
      type: "collect_input",
      action: "captured",
      detail: { variable: ctx.resumingCollectInputVar, value: ctx.message },
    });
    // Fire-and-forget identity linking when the captured value is an email
    // or phone - bridges the conversation to the existing CRM record so the
    // FlowCanvas path matches what the autonomous AI agent does via
    // link_customer_identifier. Idempotent at the conversation-service end,
    // so the universal incoming.worker hook can safely re-fire. Only relevant
    // to conversation-bound runs - context-free webhook runs never set
    // resumingCollectInputVar, but guard the id for type-safety regardless.
    if (ctx.conversationId) {
      void tryLinkIdentifierFromInbound({
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        text: ctx.message,
        reason: "flow Collect Input",
      });
    }
  }

  while (currentId && steps < MAX_STEPS) {
    steps++;
    if (visited.has(currentId)) {
      ctx.trace.push({ nodeId: currentId, type: "?", action: "loop_detected" });
      await applyOrphanedHandoff(ctx, "loop_guard", currentId);
      return { executed: true, halted: true, reason: "loop_guard", trace: ctx.trace };
    }
    visited.add(currentId);
    if (ctx.run) ctx.run.currentNodeId = currentId;

    const node = nodes.find((n) => n.id === currentId);
    if (!node) {
      ctx.trace.push({ nodeId: currentId, type: "?", action: "node_not_found" });
      await applyOrphanedHandoff(ctx, "node_not_found", currentId);
      return { executed: true, halted: true, trace: ctx.trace };
    }

    const outgoing = edges.filter((e) => e.source === currentId);

    switch (node.type) {
      case "channel_entry":
      case "start": {
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "enter" });
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "condition_group": {
        const matched = evaluateConditionNode(node, ctx);
        const handle = matched ? "true" : "false";
        ctx.trace.push({
          nodeId: node.id,
          type: "condition_group",
          action: matched ? "match" : "no_match",
          detail: { branch: handle },
        });
        const next = outgoing.find((e) => e.sourceHandle === handle) || null;
        currentId = next?.target || null;
        break;
      }

      case "send_message_text": {
        // Conversation-bound runs use ctx.sendCtx (unchanged). Context-free
        // webhook runs carry no sendCtx - resolve an explicit recipient from the
        // node so the text still dispatches through the existing outbound path.
        const sendCtx = ctx.sendCtx ?? (await buildExplicitSendCtx(node.data || {}, ctx));
        const textOutcome = await sendText(String(node.data?.text || ""), ctx, sendCtx);
        ctx.trace.push({ nodeId: node.id, type: node.type, action: textOutcome ?? "sent" });
        // Optional pause: when the author flipped "Wait for user reply", halt
        // here and resume on next inbound. Resume path (executeMainFlow's
        // generic branch) continues from the first outgoing edge.
        if (node.data?.waitForReply) {
          await park(ctx, node.id, true);
          // Optional timeout (2026-10-14): without one the run waits for the
          // reply however long it takes; with one, the same resume job as Wait
          // for reply moves it on (stale timers are dropped by flow-resume).
          const waitMs = Number(node.data?.timeoutMs);
          if (waitMs > 0 && ctx.conversationId) {
            await flowResumeQueue.add(
              "resume",
              {
                tenantId: ctx.tenantId,
                conversationId: ctx.conversationId,
                flowKind: ctx.flowScope,
                flowId: ctx.flowId,
                resumeNodeId: node.id,
                channel: ctx.channel,
                message: "",
                timeout: true,
                ...(ctx.run ? { automationRunId: ctx.run.id } : {}),
              },
              { delay: waitMs, removeOnComplete: true, removeOnFail: 100 },
            );
          }
          ctx.trace.push({ nodeId: node.id, type: node.type, action: "paused_for_reply", ...(waitMs > 0 ? { detail: { timeoutMs: waitMs } } : {}) });
          return {
            executed: true,
            halted: true,
            reason: "wait_for_reply",
            matchedNodeId: node.id,
            trace: ctx.trace,
          };
        }
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "send_message_interactive": {
        const body = String(node.data?.text || "").trim();
        const url = String(node.data?.buttonUrl || "").trim();
        const label = String(node.data?.buttonLabel || "").trim();
        const composed = url
          ? label
            ? `${body}\n\n${label}: ${url}`
            : `${body}\n\n${url}`
          : body;
        await sendText(composed, ctx);
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "sent" });
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "send_message_quick_reply": {
        const body = interpolate(String(node.data?.text || ""), ctx.vars);
        const replies = Array.isArray(node.data?.replies) ? node.data.replies : [];
        const buttons = replies
          .slice(0, 3) // WhatsApp caps at 3 quick-reply buttons
          .map((r: any) => ({
            id: String(r.payload || r.id || r.label || "").slice(0, 256),
            title: interpolate(String(r.label || r.payload || ""), ctx.vars).slice(0, 20),
          }))
          .filter((b: any) => b.title);
        if (ctx.sendCtx && buttons.length > 0) {
          const adapter = getOutboundAdapter(ctx.sendCtx.channel as any);
          if (adapter) {
            await refuseOutsideWindow(ctx, ctx.sendCtx, body, "interactive", { buttons });
            let extId: string | null;
            try {
              extId = await adapter.sendInteractiveMessage(
                ctx.sendCtx.credentials,
                ctx.sendCtx.channelAccountExternalId,
                ctx.sendCtx.recipientId,
                body,
                buttons,
              );
            } catch (err: any) {
              const { sendError } = describeSendError(err, ctx.sendCtx.channel as any);
              await persistOutbound(ctx, body, "interactive", null, { buttons, sendError });
              throw err;
            }
            await persistOutbound(ctx, body, "interactive", extId, { buttons });
          }
        }
        // Pause and remember where we are. Next inbound resumes from here by
        // matching the reply payload against sourceHandle on outgoing edges.
        await park(ctx, node.id, true);
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "sent_and_paused" });
        return {
          executed: true,
          halted: true,
          reason: "wait_for_reply",
          matchedNodeId: node.id,
          trace: ctx.trace,
        };
      }

      case "send_message_image": {
        await sendMedia(
          String(node.data?.url || ""),
          "image",
          node.data?.caption,
          undefined,
          ctx,
        );
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "sent" });
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "send_message_file": {
        await sendMedia(
          String(node.data?.url || ""),
          "document",
          node.data?.caption,
          // v2 writes fileName, the older editors filename: both are the name.
          node.data?.filename ?? node.data?.fileName,
          ctx,
        );
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "sent" });
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "send_message_template": {
        // Looks the template up by id, builds Meta `components` from the
        // author-supplied variable map (with {{var}} interpolation against
        // ctx.vars), and dispatches via the WhatsApp adapter. Non-WhatsApp
        // conversations fall through with a trace entry - flows mixing
        // channels won't crash.
        const result = await sendTemplate(node.data || {}, ctx);
        ctx.trace.push({ nodeId: node.id, type: node.type, action: result });
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "route_target":
      case "default_fallback": {
        const routeType = (node.data?.routeType || "agent") as "agent" | "flow" | "human";
        const targetId = (node.data?.targetId as string) || null;
        ctx.trace.push({
          nodeId: node.id,
          type: node.type,
          action: "route",
          detail: { routeType, targetId },
        });
        await persistVars(ctx);
        const dispatched = await dispatchRoute(routeType, targetId, ctx);
        return {
          executed: true,
          halted: true,
          reason: "route_dispatched",
          matchedNodeId: node.id,
          route: { routeType: dispatched, targetId },
          trace: ctx.trace,
        };
      }

      case "end": {
        const kind = (node.data?.kind || "wait_for_reply") as
          | "close"
          | "handoff_human"
          | "wait_for_reply";
        ctx.trace.push({ nodeId: node.id, type: "end", action: "halt", detail: { kind } });
        await persistVars(ctx);
        await applyEnd(kind, ctx);
        return {
          executed: true,
          halted: true,
          reason: "end_node",
          matchedNodeId: node.id,
          endKind: kind,
          trace: ctx.trace,
        };
      }

      // ─── Trigger entries - walk through like `start` ───────────
      case "keyword_trigger":
      case "comment_trigger":
      case "schedule_trigger":
      case "webhook_trigger": {
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "trigger_enter" });
        currentId = outgoing[0]?.target || null;
        break;
      }

      // ─── Set Variable - programmatic assignment ────────────────
      case "set_variable": {
        const name = String(node.data?.variable || "").trim();
        if (name) {
          const resolved = interpolate(String(node.data?.value ?? ""), ctx.vars);
          ctx.vars[name] = resolved;
          ctx.trace.push({
            nodeId: node.id, type: node.type, action: "set",
            detail: { variable: name, value: resolved },
          });
        } else {
          ctx.trace.push({ nodeId: node.id, type: node.type, action: "skip_noop" });
        }
        currentId = outgoing[0]?.target || null;
        break;
      }

      // ─── Collect Input - send prompt, pause, resume with reply ─
      case "collect_input": {
        const prompt = interpolate(String(node.data?.prompt || ""), ctx.vars);
        if (prompt) await sendText(prompt, ctx);
        await park(ctx, node.id, true);
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "prompted_and_paused" });
        return {
          executed: true, halted: true, reason: "wait_for_reply",
          matchedNodeId: node.id, trace: ctx.trace,
        };
      }

      // ─── Wait / Delay - schedule delayed resume, halt ──────────
      case "wait": {
        const amount = Math.max(1, Number(node.data?.amount ?? 1));
        const unit = String(node.data?.unit || "seconds");
        // `durationMs` (what the validator checks and automations send) wins;
        // amount + unit is the older editor's shape.
        const delayMs =
          typeof node.data?.durationMs === "number" && node.data.durationMs > 0 ? node.data.durationMs :
          unit === "hours"   ? amount * 3600_000 :
          unit === "minutes" ? amount * 60_000 :
                               amount * 1000;
        // Context-free runs have no thread to resume - record the halt and stop
        // rather than scheduling a resume job that could never fire.
        if (ctx.conversationId) {
          // A playbook flow owns the conversation while it waits. An
          // automation's timed wait does not: whoever answered before keeps
          // answering, and the timer moves the run on later.
          await park(ctx, node.id, !ctx.run);
          // Enqueue a delayed resume job. The flow-resume worker picks it up
          // after `delay` ms and calls executeMainFlow/executeSubFlow with
          // resumeNodeId = this node, which walks from its first outgoing edge.
          await flowResumeQueue.add(
            "resume",
            {
              tenantId: ctx.tenantId,
              conversationId: ctx.conversationId,
              flowKind: ctx.flowScope,
              flowId: ctx.flowId,
              resumeNodeId: node.id,
              channel: ctx.channel,
              message: "",
              ...(ctx.run ? { automationRunId: ctx.run.id } : {}),
            },
            { delay: delayMs, removeOnComplete: true, removeOnFail: 100 },
          );
        }
        ctx.trace.push({
          nodeId: node.id, type: node.type, action: "scheduled_resume",
          detail: { delayMs },
        });
        return {
          executed: true, halted: true, reason: "wait_for_reply",
          matchedNodeId: node.id, trace: ctx.trace,
        };
      }

      // ─── HTTP Request - call external API, capture response ────
      case "http_request": {
        const method = String(node.data?.method || "GET").toUpperCase();
        const rawUrl = interpolate(String(node.data?.url || ""), ctx.vars);
        const headers: Record<string, string> = {};
        const rawHeaders = Array.isArray(node.data?.headers) ? node.data.headers : [];
        for (const h of rawHeaders) {
          const k = String(h?.key || "").trim();
          const v = interpolate(String(h?.value || ""), ctx.vars);
          if (k) headers[k] = v;
        }
        const body = ["POST", "PUT", "PATCH"].includes(method)
          ? interpolate(String(node.data?.body || ""), ctx.vars)
          : undefined;

        const responseVar = String(node.data?.responseVariable || "response").trim() || "response";
        const jsonPath = String(node.data?.jsonPath || "").trim();

        const { ok, status, data, error } = await safeFetch(rawUrl, method, headers, body);
        if (!ok) {
          ctx.trace.push({
            nodeId: node.id, type: node.type, action: "http_error",
            detail: { status, error },
          });
          // Fall through to next node - authors can wire a Condition on the
          // response variable to branch on failure.
          ctx.vars[responseVar] = { ok: false, status, error };
        } else {
          const extracted = jsonPath ? getByPath(data, jsonPath) : data;
          ctx.vars[responseVar] = extracted;
          ctx.trace.push({
            nodeId: node.id, type: node.type, action: "http_ok",
            detail: { status, variable: responseVar, jsonPath: jsonPath || null },
          });
        }
        currentId = outgoing[0]?.target || null;
        break;
      }

      // ─── AI Generate - one message written by an AI employee ───
      // Through the ai service's one-shot (the only place LLM calls happen;
      // it logs and meters). The employee is the node's, else the
      // conversation's; with neither, nothing is written (as before).
      case "ai_generate": {
        const prompt = interpolate(String(node.data?.prompt || ""), ctx.vars);
        const responseVar = String(node.data?.responseVariable || "ai_output").trim() || "ai_output";
        const agentId = String(node.data?.aiAgentId || "").trim() || (await conversationAgentId(ctx));
        let text = "";
        if (agentId && prompt.trim()) text = await aiOneShot(ctx, agentId, prompt);
        ctx.vars[responseVar] = text;
        // Sends by default; `send: false` keeps it as a variable only.
        const shouldSend = node.data?.send !== false && !!ctx.conversationId;
        if (text && shouldSend) await sendText(text, ctx);
        ctx.trace.push({
          nodeId: node.id, type: node.type, action: !agentId ? "ai_no_agent" : text ? (shouldSend ? "sent" : "generated") : "ai_empty",
          detail: { variable: responseVar, aiAgentId: agentId || null },
        });
        currentId = outgoing[0]?.target || null;
        break;
      }

      // ─── Update Customer - tag / attribute on the contact row ──
      case "update_customer": {
        const action = String(node.data?.action || "add_tag");
        const key = interpolate(String(node.data?.key || ""), ctx.vars).trim();
        const value = interpolate(String(node.data?.value || ""), ctx.vars);
        await updateContact(ctx, action, key, value);
        ctx.trace.push({
          nodeId: node.id, type: node.type, action: "updated",
          detail: { action, key, value: action === "set_attribute" ? value : undefined },
        });
        currentId = outgoing[0]?.target || null;
        break;
      }

      // ─── Bring User Data - load contact fields into variables ──
      case "bring_user_data": {
        const fields: string[] = Array.isArray(node.data?.fields) ? node.data.fields : [];
        const prefix = String(node.data?.prefix || "customer").replace(/[^a-z0-9_]/gi, "");
        const loaded = await loadContactFields(ctx, fields, prefix);
        Object.assign(ctx.vars, loaded);
        ctx.trace.push({
          nodeId: node.id, type: node.type, action: "loaded",
          detail: { fields, prefix, count: Object.keys(loaded).length },
        });
        currentId = outgoing[0]?.target || null;
        break;
      }

      // ─── Automations (Studio > Automations) ────────────────────
      case "automation_trigger": {
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "trigger_enter" });
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "opening_hours": {
        const { state } = await getBusinessHoursState(ctx.tenantId);
        // Not configured = always open (the same reading the AI gate uses).
        const branch = state.open ? "open" : "closed";
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "evaluated", detail: { branch, configured: state.configured } });
        currentId = outgoing.find((e) => e.sourceHandle === branch)?.target ?? null;
        break;
      }

      case "split_channel": {
        const ch = String(ctx.sendCtx?.channel ?? ctx.channel ?? "").toUpperCase();
        const hit = outgoing.find((e) => e.sourceHandle === ch);
        const branch = hit ? ch : "other";
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "evaluated", detail: { branch } });
        currentId = (hit ?? outgoing.find((e) => e.sourceHandle === "other"))?.target ?? null;
        break;
      }

      case "language": {
        const lang = await conversationLanguage(ctx);
        const listed: string[] = Array.isArray(node.data?.languages) ? node.data.languages : [];
        const branch = lang && listed.includes(lang) ? lang : "other";
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "evaluated", detail: { branch, detected: lang } });
        currentId = outgoing.find((e) => e.sourceHandle === branch)?.target ?? null;
        break;
      }

      case "segment": {
        const branch = await customerSegment(ctx);
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "evaluated", detail: { branch } });
        currentId = outgoing.find((e) => e.sourceHandle === branch)?.target ?? null;
        break;
      }

      case "ab_split": {
        const pct = Number(node.data?.percentA ?? 50);
        // Stable per run (or conversation): a resumed run never changes sides.
        const branch = bucketOf(`${ctx.run?.id ?? ctx.conversationId ?? ""}:${node.id}`) < pct ? "a" : "b";
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "evaluated", detail: { branch } });
        currentId = outgoing.find((e) => e.sourceHandle === branch)?.target ?? null;
        break;
      }

      case "send_buttons": {
        const body = interpolate(String(node.data?.text || ""), ctx.vars);
        const buttons = (Array.isArray(node.data?.buttons) ? node.data.buttons : [])
          .slice(0, 3)
          .map((b: any) => ({ id: String(b?.id ?? "").slice(0, 256), title: interpolate(String(b?.title ?? ""), ctx.vars).slice(0, 20) }))
          .filter((b: any) => b.id && b.title);
        await sendButtons(body, buttons, ctx);
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "sent", detail: { buttons: buttons.length } });
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "send_list": {
        const body = interpolate(String(node.data?.text || ""), ctx.vars);
        const rows = (Array.isArray(node.data?.options) ? node.data.options : [])
          .slice(0, 10)
          .map((o: any) => ({ id: String(o?.id ?? ""), title: interpolate(String(o?.title ?? ""), ctx.vars), description: o?.description ? String(o.description) : undefined }))
          .filter((o: any) => o.id && o.title);
        await sendList(body, String(node.data?.buttonText || "Options"), rows, ctx);
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "sent", detail: { options: rows.length } });
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "wait_for_reply": {
        // Context-free runs have no customer to wait for.
        if (!ctx.conversationId) {
          ctx.trace.push({ nodeId: node.id, type: node.type, action: "skip_noop" });
          currentId = null;
          break;
        }
        const timeoutMs = Number(node.data?.timeoutMs) > 0 ? Number(node.data.timeoutMs) : 30 * 60_000;
        await park(ctx, node.id, true);
        await flowResumeQueue.add(
          "resume",
          {
            tenantId: ctx.tenantId,
            conversationId: ctx.conversationId,
            flowKind: ctx.flowScope,
            flowId: ctx.flowId,
            resumeNodeId: node.id,
            channel: ctx.channel,
            message: "",
            timeout: true,
            ...(ctx.run ? { automationRunId: ctx.run.id } : {}),
          },
          { delay: timeoutMs, removeOnComplete: true, removeOnFail: 100 },
        );
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "paused_for_reply", detail: { timeoutMs } });
        return { executed: true, halted: true, reason: "wait_for_reply", matchedNodeId: node.id, trace: ctx.trace };
      }

      case "assign": {
        if (ctx.conversationId) {
          const to = node.data?.to === "person" ? "person" : "team";
          const data: any = { handledBy: "human" };
          if (to === "person" && node.data?.userId) Object.assign(data, { assignedAgentId: String(node.data.userId), status: "OPEN" });
          else Object.assign(data, { status: "WAITING", ...(node.data?.departmentId ? { departmentId: String(node.data.departmentId) } : {}) });
          await prisma.conversation.update({ where: { id: ctx.conversationId }, data });
          publishEvent({ event: "conversation:updated", tenantId: ctx.tenantId, data: { id: ctx.conversationId, ...data } }).catch(() => {});
          // A person owns it now: the AI must not also answer this message.
          if (ctx.run) { ctx.run.answered = true; ctx.run.prevOwner = "human"; }
        }
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "assigned", detail: { to: node.data?.to ?? "team" } });
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "hand_to_ai":
      case "run_skill": {
        const aiAgentId = String(node.data?.aiAgentId || "").trim() || null;
        const skillId = node.type === "run_skill" ? String(node.data?.skillId || "").trim() || null : null;
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "handed_to_ai", detail: { aiAgentId, skillId } });
        await persistVars(ctx);
        if (ctx.run) { ctx.run.answered = true; ctx.run.prevOwner = "ai_agent"; }
        const dispatched = await dispatchRoute("agent", aiAgentId, ctx, skillId);
        return {
          executed: true, halted: true, reason: "route_dispatched", matchedNodeId: node.id,
          route: { routeType: dispatched, targetId: aiAgentId }, trace: ctx.trace,
        };
      }

      case "add_tag": {
        const tag = interpolate(String(node.data?.tag || ""), ctx.vars).trim();
        // No tag event is emitted for this write: an automation's own tag
        // must not fire tag automations (loop guard).
        await updateContact(ctx, "add_tag", tag, "");
        ctx.trace.push({ nodeId: node.id, type: node.type, action: tag ? "tagged" : "skip_noop", detail: { tag } });
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "create_task": {
        const r = await createCrmTask(ctx, {
          title: interpolate(String(node.data?.title || ""), ctx.vars),
          body: interpolate(String(node.data?.body || ""), ctx.vars),
          dueInMinutes: Number(node.data?.dueInMinutes) > 0 ? Number(node.data.dueInMinutes) : null,
        });
        ctx.trace.push({ nodeId: node.id, type: node.type, action: r.ok ? "task_created" : "task_failed", detail: r });
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "notify_team": {
        const r = await notifyTeam(ctx, {
          message: interpolate(String(node.data?.message || ""), ctx.vars),
          userIds: Array.isArray(node.data?.userIds) ? node.data.userIds.map(String) : [],
          departmentId: node.data?.departmentId ? String(node.data.departmentId) : null,
        });
        ctx.trace.push({ nodeId: node.id, type: node.type, action: r ? "notified" : "notify_failed" });
        currentId = outgoing[0]?.target || null;
        break;
      }

      case "close_conversation": {
        const text = String(node.data?.message || "");
        if (text.trim()) await sendText(text, ctx);
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "closed" });
        await persistVars(ctx);
        if (ctx.run) ctx.run.answered = true;
        await applyEnd("close", ctx);
        if (ctx.conversationId) {
          publishEvent({ event: "conversation:updated", tenantId: ctx.tenantId, data: { id: ctx.conversationId, status: "CLOSED" } }).catch(() => {});
        }
        return { executed: true, halted: true, reason: "end_node", matchedNodeId: node.id, endKind: "close", trace: ctx.trace };
      }

      default: {
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "skip_unknown" });
        currentId = outgoing[0]?.target || null;
        break;
      }
    }
  }

  await persistVars(ctx);
  if (!currentId) {
    ctx.trace.push({ nodeId: "", type: "-", action: "no_outgoing_edge" });
    await applyOrphanedHandoff(ctx, "no_outgoing_edge");
    return { executed: true, halted: true, reason: "no_outgoing_edge", trace: ctx.trace };
  }
  // MAX_STEPS exhausted. Same strandedness as a detected loop, same rescue.
  await applyOrphanedHandoff(ctx, "loop_guard", currentId);
  return { executed: true, halted: true, reason: "loop_guard", trace: ctx.trace };
}

// ─── Condition evaluation (graph-local, deterministic) ───────
// Intent conditions require the LLM batch path in routing.service.ts - for the
// graph walker we treat them as false so authors wire them through a Route-to-
// agent node instead. Deterministic types are fully supported.

function evaluateConditionNode(node: GraphNode, ctx: FlowExecCtx): boolean {
  const conditions = Array.isArray(node.data?.conditions) ? node.data.conditions : [];
  if (conditions.length === 0) return true;
  const logic = String(node.data?.logic || "AND").toUpperCase();
  const results = conditions.map((c: any) => evaluateSingle(c, ctx));
  return logic === "OR" ? results.some(Boolean) : results.every(Boolean);
}

function evaluateSingle(c: any, ctx: FlowExecCtx): boolean {
  const value = String(c?.value ?? "").toLowerCase();
  const msg = ctx.message.toLowerCase();
  switch (c?.type) {
    case "keyword":
      if (c.operator === "equals") return msg === value;
      if (c.operator === "is_not") return !msg.includes(value);
      if (c.operator === "starts_with") return msg.startsWith(value);
      if (c.operator === "ends_with") return msg.endsWith(value);
      return msg.includes(value);
    case "channel": {
      const ch = ctx.channel.toLowerCase();
      if (c.operator === "is_not") return ch !== value;
      return ch === value;
    }
    case "regex": {
      try {
        const re = new RegExp(c.value, "i");
        const hit = re.test(ctx.message);
        return c.operator === "is_not" ? !hit : hit;
      } catch {
        return false;
      }
    }
    case "tag":
      // Tags aren't carried into the graph walker context yet; caller-supplied
      // evaluation lives in routing.service for now.
      return false;
    case "intent":
      return false;
    default:
      return false;
  }
}

// ─── Send helpers ───────────────────────────────────────────

// Infer the outbound channel from the shape of an explicit recipient. An "@"
// marks an email address; an otherwise phone-like value (digits with optional
// +, spaces, dashes, parens) is treated as WhatsApp - the only channel that
// carries templates today and the default for plain phone delivery. Returns
// null when the value matches neither, so the caller skips rather than guessing.
function inferChannelFromRecipient(recipient: string): string | null {
  if (recipient.includes("@")) return "EMAIL";
  if (/^\+?[\d\s().-]{6,}$/.test(recipient)) return "WHATSAPP";
  return null;
}

// Build a one-off ChannelSendContext from a send node's explicit recipient, for
// context-free webhook runs that carry no conversation (and therefore no
// ctx.sendCtx). The recipient is read from `data.recipient` and interpolated
// against flow vars so `{{body.phone_number}}` resolves; an optional
// `data.recipientChannel` overrides channel inference (forward-compat with the
// mapper UI, Card 5). Mirrors the broadcast/outgoing-worker resolution: pick an
// active ChannelAccount for the tenant+channel and decrypt its credentials.
// Returns null when no recipient is configured or no active account backs the
// channel - callers then no-op exactly as before.
async function buildExplicitSendCtx(
  data: Record<string, any>,
  ctx: FlowExecCtx,
): Promise<ChannelSendContext | null> {
  const recipientId = interpolate(String(data.recipient ?? ""), ctx.vars).trim();
  if (!recipientId) return null;
  const explicitChannel = String(data.recipientChannel ?? "").trim().toUpperCase();
  const channel = explicitChannel || inferChannelFromRecipient(recipientId);
  if (!channel) {
    console.warn(`[flow.send] skip unresolved_channel recipient=${recipientId.slice(0, 4)}***`);
    return null;
  }
  const account = await prisma.channelAccount.findFirst({
    where: { tenantId: ctx.tenantId, channel: channel as any, isActive: true },
  });
  if (!account) {
    console.warn(`[flow.send] skip no_channel_account tenant=${ctx.tenantId} channel=${channel}`);
    return null;
  }
  const raw = (account as any).credentials;
  const creds = typeof raw === "string" ? decryptCredentials(raw) : ((raw as any) || {});
  return {
    channel,
    channelAccountExternalId: account.externalId,
    credentials: creds as ChannelCredentials,
    recipientId,
  };
}

/**
 * The customer-service window for a flow's free-form send (B7, 2026-10-12): a
 * flow can resume days after its wait node, past the 24h WhatsApp window or
 * the Instagram/Messenger one. Refused here instead of at Meta (131047): the
 * same FAILED row with a reason and the same thrown error a provider failure
 * gave, without the doomed call. Templates go through sendTemplate and are not
 * checked here. Fails open: an unreadable window lets the send go.
 */
async function refuseOutsideWindow(
  ctx: FlowExecCtx,
  sendCtx: ChannelSendContext,
  body: string,
  messageType: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  let verdict: ReturnType<typeof sendAllowed> = { ok: true };
  try {
    if (!hasReplyWindow(sendCtx.channel)) return;
    const last = await lastInboundAtForRecipient({ tenantId: ctx.tenantId, channel: sendCtx.channel, channelAccountId: null, customerExternalId: sendCtx.recipientId });
    verdict = sendAllowed(replyWindowFor(sendCtx.channel, last), messageType);
  } catch (err: any) {
    console.warn(`[flow.send] reply window unreadable, sending anyway: ${err?.message}`);
    return;
  }
  if (verdict.ok) return;
  const sendError = { channel: sendCtx.channel, phase: "send", type: verdict.code, message: verdict.message, retryable: false, at: new Date().toISOString() };
  await persistOutbound(ctx, body, messageType, null, { ...extra, sendError });
  console.warn(`[flow.send] refused ${verdict.code} conv=${ctx.conversationId}`);
  throw new Error(`${verdict.code}: ${verdict.message}`);
}

// `sendCtx` defaults to the conversation-bound context (ctx.sendCtx). Context-free
// callers (webhook runs with an explicit recipient) pass a one-off context built
// by buildExplicitSendCtx so the same dispatch + persist path is reused verbatim.
async function sendText(
  text: string,
  ctx: FlowExecCtx,
  sendCtx: ChannelSendContext | null = ctx.sendCtx,
) {
  const interpolated = interpolate(text, ctx.vars);
  if (!interpolated || !interpolated.trim() || !sendCtx) return;
  if (ctx.run?.marketing && (await optedOutNow(ctx))) {
    console.warn(`[flow.text] skip opted_out conv=${ctx.conversationId}`);
    return "skipped_opted_out";
  }
  // A marketing message carries the removal line ("להסרה השיבו הסר").
  const resolved = ctx.run?.marketing ? withRemovalLine(interpolated) : interpolated;
  const adapter = getOutboundAdapter(sendCtx.channel as any);
  if (!adapter) return;
  await refuseOutsideWindow(ctx, sendCtx, resolved, "text");
  let extId: string | null;
  try {
    extId = await adapter.sendTextMessage(
      sendCtx.credentials,
      sendCtx.channelAccountExternalId,
      sendCtx.recipientId,
      resolved,
    );
  } catch (err: any) {
    // Persist a FAILED row with the full provider error before rethrowing, so
    // the flow's history shows a diagnosable failure instead of a silent drop.
    const { sendError } = describeSendError(err, sendCtx.channel as any);
    await persistOutbound(ctx, resolved, "text", null, { sendError });
    throw err;
  }
  await persistOutbound(ctx, resolved, "text", extId);
}

async function sendMedia(
  url: string,
  mediaType: "image" | "document",
  caption: string | undefined,
  filename: string | undefined,
  ctx: FlowExecCtx,
) {
  const resolvedUrl = interpolate(url, ctx.vars);
  const resolvedCaption = caption != null ? interpolate(String(caption), ctx.vars) : caption;
  const resolvedName = filename != null ? interpolate(String(filename), ctx.vars) : filename;
  if (!resolvedUrl || !resolvedUrl.trim() || !ctx.sendCtx) return;
  const adapter = getOutboundAdapter(ctx.sendCtx.channel as any);
  if (!adapter) return;
  await refuseOutsideWindow(ctx, ctx.sendCtx, resolvedCaption || resolvedUrl, mediaType, { url: resolvedUrl, filename: resolvedName });
  if (adapter.sendMediaMessage) {
    let extId: string | null;
    try {
      extId = await adapter.sendMediaMessage(
        ctx.sendCtx.credentials,
        ctx.sendCtx.channelAccountExternalId,
        ctx.sendCtx.recipientId,
        resolvedUrl,
        mediaType,
        resolvedName,
        resolvedCaption,
      );
    } catch (err: any) {
      const { sendError } = describeSendError(err, ctx.sendCtx.channel as any);
      await persistOutbound(ctx, resolvedCaption || resolvedUrl, mediaType, null, { url: resolvedUrl, filename: resolvedName, sendError });
      throw err;
    }
    await persistOutbound(ctx, resolvedCaption || resolvedUrl, mediaType, extId, { url: resolvedUrl, filename: resolvedName });
    return;
  }
  // Adapter doesn't support media - fall back to text with URL so the user at
  // least gets the link instead of silent failure.
  const fallback = resolvedCaption ? `${resolvedCaption}\n${resolvedUrl}` : resolvedUrl;
  await sendText(fallback, ctx);
}

// Extract `{{var}}` placeholder keys from a string in declared order.
// Mirrors the helper used by the broadcast worker so template variables
// resolve identically across both code paths.
function extractTemplatePlaceholders(text: string | null | undefined): string[] {
  if (!text) return [];
  const re = /\{\{\s*([\w-]+)\s*\}\}/g;
  const seen = new Set<string>();
  const order: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!seen.has(m[1])) { seen.add(m[1]); order.push(m[1]); }
  }
  return order;
}

// Resolve a `crm:<field>` token against a Contact row. Mirrors the alias
// surface used by outbound/scheduled (resolveCrmFieldFromContact) so flow
// authors get the same field names regardless of which sender path runs.
// Returns "" when the field can't be resolved - buildTemplateComponents
// then falls back to the template's declared sample.
function resolveCrmField(
  field: string,
  contact: { displayName?: string | null; email?: string | null; phone?: string | null; source?: string | null; metadata?: any } | null,
): string {
  if (!contact) return "";
  const meta = (contact.metadata && typeof contact.metadata === "object" ? (contact.metadata as Record<string, unknown>) : null);
  if (meta && Object.prototype.hasOwnProperty.call(meta, field)) {
    const v = meta[field];
    if (v != null && String(v).length > 0) return String(v);
  }
  const key = field.toLowerCase().replace(/[\s_-]/g, "");
  if (key === "displayname" || key === "name" || key === "fullname") return contact.displayName || "";
  if (key === "firstname" || key === "first" || key === "givenname") {
    return (contact.displayName || "").trim().split(/\s+/)[0] || "";
  }
  if (key === "lastname" || key === "last" || key === "familyname" || key === "surname") {
    const parts = (contact.displayName || "").trim().split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(" ") : "";
  }
  if (key === "phone" || key === "mobile" || key === "phonenumber" || key === "tel" || key === "telephone" || key === "cell") {
    return contact.phone || "";
  }
  if (key === "email" || key === "mail" || key === "emailaddress") return contact.email || "";
  if (key === "source") return contact.source || "";
  return "";
}

// Build Meta `template.components` from a template + author-supplied
// variable map. Each author value is either:
//   - "crm:<field>"  → resolved against the conversation's Contact row
//   - plain text     → interpolated against ctx.vars (flow vars + {{vars}})
// Missing values fall back to the template's declared sample, then "-" (Meta
// rejects empty parameter text).
function buildTemplateComponentsForFlow(
  tmpl: { body: string | null; headerType: string | null; headerContent: string | null; variables?: any },
  authorValues: Record<string, string> | undefined,
  headerMediaOverride: string | undefined,
  ctx: FlowExecCtx,
  contact: { displayName?: string | null; email?: string | null; phone?: string | null; source?: string | null; metadata?: any } | null,
): any[] {
  const components: any[] = [];
  const declared = Array.isArray(tmpl.variables) ? tmpl.variables : [];
  const sampleByKey = new Map<string, string>();
  for (const v of declared) {
    if (v && typeof v.key === "string" && typeof v.sample === "string" && v.sample.trim()) {
      sampleByKey.set(v.key, v.sample);
    }
  }
  const valueFor = (key: string): string => {
    const raw = authorValues ? authorValues[key] : undefined;
    if (raw != null && String(raw).length > 0) {
      const s = String(raw);
      if (s.startsWith("crm:")) {
        const v = resolveCrmField(s.slice(4), contact);
        if (v.length > 0) return v;
      } else {
        const resolved = interpolate(s, ctx.vars);
        if (resolved.length > 0) return resolved;
      }
    }
    const sample = sampleByKey.get(key);
    if (sample) return sample;
    return "-";
  };
  function buildComponent(scope: "header" | "body", text: string) {
    const keys = extractTemplatePlaceholders(text);
    if (keys.length === 0) return null;
    const allNumeric = keys.every((k) => /^\d+$/.test(k));
    const componentType = scope === "header" ? "header" : "body";
    if (allNumeric) {
      const sorted = [...keys].sort((a, b) => Number(a) - Number(b));
      return { type: componentType, parameters: sorted.map((k) => ({ type: "text", text: valueFor(k) })) };
    }
    return {
      type: componentType,
      parameters: keys.map((k) => ({ type: "text", parameter_name: k, text: valueFor(k) })),
    };
  }
  if (tmpl.headerType === "TEXT" && tmpl.headerContent) {
    const h = buildComponent("header", tmpl.headerContent);
    if (h) components.push(h);
  } else if (
    tmpl.headerType === "IMAGE" || tmpl.headerType === "VIDEO" || tmpl.headerType === "DOCUMENT"
  ) {
    // Media-header override can be a flat URL, a `{{flow_var}}` mention, or
    // a `crm:<field>` token. Resolution order mirrors body variables.
    let overrideUrl = "";
    if (headerMediaOverride) {
      const s = String(headerMediaOverride);
      if (s.startsWith("crm:")) {
        overrideUrl = resolveCrmField(s.slice(4), contact);
      } else {
        overrideUrl = interpolate(s, ctx.vars);
      }
    }
    const liveUrl = overrideUrl.trim() || tmpl.headerContent || "";
    if (liveUrl) {
      const mediaType = tmpl.headerType.toLowerCase() as "image" | "video" | "document";
      components.push({
        type: "header",
        parameters: [{ type: mediaType, [mediaType]: { link: liveUrl } }],
      });
    }
  }
  if (tmpl.body) {
    const b = buildComponent("body", tmpl.body);
    if (b) components.push(b);
  }
  return components;
}

async function sendTemplate(data: Record<string, any>, ctx: FlowExecCtx): Promise<string> {
  // Every early-exit reason is visible in docker logs so flow authors can
  // diagnose "I picked a template but nothing happened" without digging into
  // the trace JSON. Keep prefix stable: `[flow.template]`.
  const tag = "[flow.template]";
  // Conversation-bound runs use ctx.sendCtx (unchanged). Context-free webhook
  // runs carry no sendCtx - resolve an explicit recipient from the node so the
  // template still dispatches through the existing WhatsApp outbound path.
  const sendCtx = ctx.sendCtx ?? (await buildExplicitSendCtx(data, ctx));
  if (!sendCtx) { console.warn(`${tag} skip no_send_ctx conv=${ctx.conversationId}`); return "skipped_no_send_ctx"; }
  const templateId = String(data.templateId || "").trim();
  if (!templateId) { console.warn(`${tag} skip no_template conv=${ctx.conversationId}`); return "skipped_no_template"; }
  // Templates are a WhatsApp-only concept - if the resolved recipient is on any
  // other channel, log and skip rather than crash. Flow author can still
  // pipe the same playbook through multiple channels safely.
  if (String(sendCtx.channel).toUpperCase() !== "WHATSAPP") {
    console.warn(`${tag} skip non_whatsapp channel=${sendCtx.channel} conv=${ctx.conversationId}`);
    return "skipped_non_whatsapp";
  }
  const tmpl = await prisma.messageTemplate.findFirst({
    where: { id: templateId, tenantId: ctx.tenantId },
  });
  if (!tmpl) { console.warn(`${tag} skip template_not_found id=${templateId} tenant=${ctx.tenantId}`); return "skipped_template_not_found"; }
  if (tmpl.status !== "APPROVED") { console.warn(`${tag} skip template_not_approved id=${templateId} status=${tmpl.status}`); return "skipped_template_not_approved"; }
  if (ctx.run?.marketing && (await optedOutNow(ctx))) {
    console.warn(`${tag} skip opted_out conv=${ctx.conversationId}`);
    return "skipped_opted_out";
  }
  // A MARKETING template must carry the removal line in its approved text:
  // never sent without it. 2026-10-09: by category only; a UTILITY or
  // AUTHENTICATION template is not marketing, even inside a marketing run.
  if (String(tmpl.category ?? "").toUpperCase() === "MARKETING" && !hasRemovalLine(tmpl.body)) {
    console.warn(`${tag} skip missing_removal_line id=${templateId} conv=${ctx.conversationId}`);
    return "skipped_missing_removal_line";
  }

  const adapter = getOutboundAdapter(sendCtx.channel as any);
  if (!adapter || !adapter.sendTemplateMessage) {
    console.warn(`${tag} skip adapter_unsupported channel=${sendCtx.channel}`);
    return "skipped_adapter_unsupported";
  }

  // Look up the Contact backing this conversation so `crm:<field>` tokens
  // (set in the inspector) can resolve. Best-effort - when there's no
  // contact row, crm tokens fall back to the template's declared sample.
  // Context-free runs have no conversation/contact: crm tokens fall back to
  // the declared sample, while plain `{{body.*}}` values still interpolate.
  let contact: { displayName?: string | null; email?: string | null; phone?: string | null; source?: string | null; metadata?: any } | null = null;
  if (ctx.conversationId) {
    const conversationRow = await prisma.conversation.findUnique({
      where: { id: ctx.conversationId },
      select: { customerExternalId: true, channel: true, customerName: true },
    });
    if (conversationRow?.customerExternalId) {
      contact = await prisma.contact.findFirst({
        where: {
          tenantId: ctx.tenantId,
          externalId: conversationRow.customerExternalId,
        },
        select: { displayName: true, email: true, phone: true, source: true, metadata: true },
      });
    }
    // Fall back to the conversation's customerName when no Contact exists yet -
    // keeps simple `crm:displayName` mappings working on first inbound.
    if (!contact && conversationRow) {
      contact = { displayName: conversationRow.customerName };
    }
  }

  const components = buildTemplateComponentsForFlow(
    { body: tmpl.body, headerType: tmpl.headerType, headerContent: tmpl.headerContent, variables: tmpl.variables },
    data.variables || {},
    data.headerMediaUrl ? String(data.headerMediaUrl) : undefined,
    ctx,
    contact,
  );

  console.log(`${tag} attempt name=${tmpl.name} lang=${tmpl.language} to=${sendCtx.recipientId} components=${components.length}`);
  let extId: string | null = null;
  try {
    extId = await adapter.sendTemplateMessage(
      sendCtx.credentials,
      sendCtx.channelAccountExternalId,
      sendCtx.recipientId,
      tmpl.name,
      tmpl.language || "en",
      components,
    );
  } catch (err: any) {
    const { sendError } = describeSendError(err, sendCtx.channel as any);
    console.error(`${tag} fail name=${tmpl.name} err=${JSON.stringify(sendError)}`);
    // Persist a FAILED message row so the agent's history shows the attempt
    // (and the full provider error) instead of silently dropping.
    await persistOutbound(ctx, tmpl.body || tmpl.name, "template", null, {
      templateId: tmpl.id,
      templateName: tmpl.name,
      language: tmpl.language,
      components,
      sendError,
    });
    return "failed";
  }

  console.log(`${tag} sent name=${tmpl.name} extId=${extId} conv=${ctx.conversationId}`);
  await persistOutbound(ctx, tmpl.body || tmpl.name, "template", extId, {
    templateId: tmpl.id,
    templateName: tmpl.name,
    language: tmpl.language,
    components,
  });
  return "sent";
}

async function persistOutbound(
  ctx: FlowExecCtx,
  body: string,
  messageType: string,
  extId: string | null,
  metadata?: any,
) {
  // No sendCtx (or no conversation) → nothing to attach an outbound row to.
  // Context-free runs hit the first branch since they carry neither.
  if (!ctx.sendCtx || !ctx.conversationId) return;
  // When a structured provider error rode in on metadata.sendError, lift its
  // human summary into the errorMessage column so the failed row is diagnosable
  // from the DB/UI (not just buried in the JSON blob).
  const sendErrorMessage: string | undefined =
    !extId && metadata?.sendError?.message ? String(metadata.sendError.message) : undefined;
  const m = await prisma.message.create({
    data: {
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      channel: ctx.sendCtx.channel as any,
      direction: "OUTBOUND",
      body,
      messageType,
      senderName: "Flow",
      externalMessageId: extId,
      status: extId ? "SENT" : "FAILED",
      errorMessage: sendErrorMessage,
      metadata: metadata || {},
    } as any,
  });
  // The inbox orders by `lastMessageAt` and this path never set it, so every
  // message a flow sent left the sort key stale.
  //
  // ★ ONLY WHEN THE SEND SUCCEEDED. `status` is FAILED when there is no
  // `externalMessageId`, and a message the customer never received must not make
  // the conversation look answered - the last real activity is still their
  // inbound, and moving it would sink a waiting customer down the queue on the
  // strength of a delivery that did not happen.
  if (extId) {
    if (ctx.run) ctx.run.answered = true;
    await prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { lastMessageAt: m.createdAt },
    }).catch(() => {});
  }
  publishEvent({
    event: "message:new",
    tenantId: ctx.tenantId,
    data: { message: m, conversationId: ctx.conversationId, channel: ctx.sendCtx.channel },
  }).catch(() => {});
}

// ─── Dispatchers ────────────────────────────────────────────

async function dispatchRoute(
  routeType: "agent" | "flow" | "human",
  targetId: string | null,
  ctx: FlowExecCtx,
  // An automation's "Run a skill": the employee starts this business skill.
  startSkillId: string | null = null,
): Promise<"AI_AGENT" | "FLOW" | "HUMAN" | "DEPARTMENT"> {
  // Context-free run: no conversation to assign, hand off, or drive an agent
  // against. Map the author's intent to its terminal type without side effects.
  if (!ctx.conversationId) {
    return routeType === "agent" ? "AI_AGENT" : routeType === "flow" ? "FLOW" : "HUMAN";
  }
  if (routeType === "agent" && targetId) {
    // Persist WHICH employee, so subsequent inbound messages resume against
    // the same agent without re-routing through the graph. Ownership is a
    // separate question and is not answered yet.
    await prisma.conversation.update({
      where: { id: ctx.conversationId },
      // An automation hands over for good: its cursor goes with it.
      data: { assignedAiAgentId: targetId, ...(ctx.run ? { chatbotNodeId: null, chatbotFlowId: null, automationRunId: null } : {}) },
    });

    if (startSkillId) await processAIBot(ctx.tenantId, ctx.conversationId, ctx.message, targetId, startSkillId);
    else await processAIBot(ctx.tenantId, ctx.conversationId, ctx.message, targetId);

    // Ownership transfers only once the AI employee has actually taken the
    // turn. This used to be written BEFORE the call, so a turn the AI
    // refused - no credits, suspended plan, service down - still left the
    // conversation recorded as AI-owned. `processAIBot` returns true in that
    // case too (it escalated, which is a successful outcome for IT), so the
    // return value cannot answer this; the handoff flag can.
    const after = await prisma.conversation.findFirst({
      where: { id: ctx.conversationId, tenantId: ctx.tenantId },
      select: { isHandedOver: true },
    });
    if (!after?.isHandedOver) {
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { handledBy: "ai_agent" },
      });
    }
    return "AI_AGENT";
  }
  if (routeType === "flow" && targetId) {
    const sub = await prisma.chatbotFlow.findFirst({
      where: { id: targetId, tenantId: ctx.tenantId, isActive: true },
    });
    if (sub) {
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { chatbotFlowId: sub.id, chatbotNodeId: null },
      });
      await prisma.chatbotFlow.update({
        where: { id: sub.id },
        data: { runCount: { increment: 1 } },
      });
      // Use the new graph walker for the sub-flow too, so Start / Send*
      // nodes authored there execute identically to the main playbook.
      const subResult = await executeSubFlow({
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        message: ctx.message,
        channel: ctx.channel,
        flowId: sub.id,
      });

      // Restore flow ownership ONLY when the sub-flow left the decision open.
      //
      // This write used to be unconditional, and it is the whole bug. A
      // sub-flow that routed to an AI employee, a human or a department set
      // ownership correctly on its way out, and then the parent overwrote it
      // with "flow" the moment control came back. The result was a
      // conversation that had already crossed the AI billing boundary and
      // escalated, yet still read `handledBy = "flow"` - so the next inbound
      // took the flow branch in incoming.worker, re-walked the same graph,
      // and crossed the boundary again. Every message, a fresh escalation.
      //
      // `route` is set when the sub-flow dispatched to a target; `endKind`
      // when it terminated. Either means ownership is already spoken for.
      if (!subResult.route && !subResult.endKind) {
        await prisma.conversation.update({
          where: { id: ctx.conversationId },
          data: { handledBy: "flow" },
        });
      }
    }
    return "FLOW";
  }
  if (routeType === "human" && targetId) {
    await prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { departmentId: targetId, status: "WAITING", handledBy: "human" },
    });
    return "DEPARTMENT";
  }
  // Unassigned human - park the conversation in WAITING for a person to claim.
  await prisma.conversation.update({
    where: { id: ctx.conversationId },
    data: { status: "WAITING", handledBy: "human" },
  });
  return "HUMAN";
}

/**
 * The safety net under every way a flow can stop WITHOUT saying what should
 * happen next.
 *
 * A deliberate halt always leaves a disposition: a paused node parks a cursor,
 * `route_target` dispatches, an End node closes or hands off. Three exits leave
 * nothing at all - the walk runs off the last node with no outgoing edge, an
 * edge points at a node that no longer exists, or the loop guard trips.
 *
 * Before this, those returned and touched nothing. The row kept
 * `handledBy: "flow"` with no cursor, which reads as "an automation is driving
 * this" to every consumer - and the inbox list EXCLUDES automated
 * conversations by default. So the conversation vanished from every human
 * queue while nothing was actually driving it. The customer's next message
 * arrives to no one. Those are the lost conversations.
 *
 * A flow that ends without deciding is an authoring gap, and the only safe
 * default for an authoring gap is a person. WAITING + `handledBy: "human"`
 * puts it in the queue a human actually reads. The divider carries the reason
 * so the gap is fixable rather than merely survived.
 */
async function applyOrphanedHandoff(
  ctx: FlowExecCtx,
  reason: "no_outgoing_edge" | "node_not_found" | "loop_guard",
  atNodeId?: string,
): Promise<void> {
  // Context-free run (webhook trigger): no Conversation row, nothing to strand.
  if (!ctx.conversationId) return;
  // An automation run settles the conversation itself when it ends (it
  // restores the owner it found), in automation-runner.service.
  if (ctx.run) return;
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: ctx.conversationId },
      select: { status: true, handledBy: true, isHandedOver: true, assignedAgentId: true },
    });
    // Only rescue what is actually stranded. A conversation already closed,
    // already owned by a person, or already handed over has a disposition -
    // re-opening it or yanking it back to WAITING would undo a real decision
    // somebody made.
    if (!conv || conv.status === "CLOSED" || conv.isHandedOver || conv.assignedAgentId) return;
    if (conv.handledBy !== "flow") return;

    await prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: {
        chatbotFlowId: null,
        chatbotNodeId: null,
        status: "WAITING",
        handledBy: "human",
      },
    });

    await prisma.message.create({
      data: {
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        // ctx.channel is lowercased for graph comparisons; Message.channel is
        // the ChannelType enum. Writing the lowercase form is a hard Prisma
        // reject, which would turn the rescue into the failure it exists to
        // prevent. Omitted entirely when absent - the column is nullable.
        ...(ctx.channel ? { channel: ctx.channel.toUpperCase() as any } : {}),
        direction: "INBOUND",
        body: "",
        messageType: "system",
        senderName: "System",
        status: "DELIVERED",
        metadata: {
          systemEvent: "flow_ended_handoff",
          // Which of the three gaps it was, and where. This is the difference
          // between "a flow is broken somewhere" and a node to go fix.
          flowEndReason: reason,
          ...(atNodeId ? { flowNodeId: atNodeId } : {}),
          ...(ctx.flowId ? { flowId: ctx.flowId } : {}),
        },
      },
    });
    // The handoff event itself is the last thing that happened and somebody is
    // waiting on it. The `update` above sets status/handledBy and predates the
    // message, so the ordering column is set here.
    await prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { lastMessageAt: new Date() },
    }).catch(() => {});

    await publishEvent({
      event: "conversation:updated",
      tenantId: ctx.tenantId,
      data: { id: ctx.conversationId, status: "WAITING", handledBy: "human", isHandedOver: false },
    });

    console.warn(
      `[flow-executor] flow ended with no disposition (${reason}) conv=${ctx.conversationId} ` +
        `flow=${ctx.flowId ?? "-"} node=${atNodeId ?? "-"} - handed to a human`,
    );
  } catch (err) {
    // A failed rescue must never bubble into the inbound pipeline and turn a
    // stranded conversation into a retried job that strands it again.
    console.error("[flow-executor] orphaned-handoff failed:", (err as Error).message);
  }
}

async function applyEnd(
  kind: "close" | "handoff_human" | "wait_for_reply",
  ctx: FlowExecCtx,
) {
  // Context-free run: no Conversation row to transition. The End node just
  // terminates the walk.
  if (!ctx.conversationId) return;
  // The flow has terminated - drop chatbot state so the next inbound is NOT
  // resumed back into the last paused node (which would re-capture every
  // future message into the Collect Input variable and loop the greeting).
  const clearFlow = { chatbotNodeId: null, chatbotFlowId: null } as const;
  if (kind === "close") {
    await prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { ...clearFlow, status: "CLOSED" as any, handledBy: null },
    });
  } else if (kind === "handoff_human") {
    await prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { ...clearFlow, status: "WAITING", handledBy: "human" },
    });
  } else {
    // "wait_for_reply" - flow is done; release the conversation back to the
    // inbox (handledBy=null) so the next inbound surfaces for a human and
    // does not re-enter the graph walker.
    await prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { ...clearFlow, handledBy: null },
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Park the conversation's cursor at a node. `claim` = the flow owns the
 * replies while parked (handledBy "flow"); an automation's timed wait does not
 * claim. A sub-flow also records WHICH flow, so the next inbound resumes that
 * flow and not the main canvas; an automation run records its run id.
 */
async function park(ctx: FlowExecCtx, nodeId: string, claim: boolean): Promise<void> {
  if (ctx.run && claim) {
    ctx.run.answered = true;
    // Remember the owner the run displaced, once per run, to restore it later.
    if (ctx.vars.__automationRunId !== ctx.run.id) {
      ctx.vars.__automationRunId = ctx.run.id;
      ctx.vars.__automationPrevOwner = ctx.run.prevOwner;
    }
  }
  await persistVars(ctx);
  if (!ctx.conversationId) return;
  await prisma.conversation.update({
    where: { id: ctx.conversationId },
    data: {
      chatbotNodeId: nodeId,
      ...(claim ? { handledBy: "flow" } : {}),
      ...(ctx.flowScope === "sub" && ctx.flowId ? { chatbotFlowId: ctx.flowId } : {}),
      ...(ctx.run ? { automationRunId: ctx.run.id } : {}),
    },
  });
}

function waitingOnTimer(paused: GraphNode): FlowExecutionResult {
  return {
    executed: false, halted: true, reason: "waiting_on_timer", matchedNodeId: paused.id,
    trace: [{ nodeId: paused.id, type: paused.type, action: "waiting_on_timer" }],
  };
}

/**
 * Which exit of a Wait-for-reply the customer's reply takes: the tapped
 * button / list row (by payload, or by its visible title when typed), else
 * "reply". The options are the ones the message right before it offered.
 */
export function replyBranch(paused: GraphNode, nodes: GraphNode[], edges: GraphEdge[], message: string, replyPayload?: string | null): string {
  const inbound = edges.find((e) => e.target === paused.id);
  const prev = inbound ? nodes.find((n) => n.id === inbound.source) : undefined;
  const opts: any[] = prev?.type === "send_buttons" ? prev.data?.buttons ?? [] : prev?.type === "send_list" ? prev.data?.options ?? [] : [];
  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const byId = replyPayload ? opts.find((o) => norm(o?.id) === norm(replyPayload)) : undefined;
  const byTitle = !byId && message ? opts.find((o) => norm(o?.title) === norm(message)) : undefined;
  const hit = byId ?? byTitle;
  return hit ? `btn:${hit.id}` : "reply";
}

/** 0..99, stable for a key. */
function bucketOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h) % 100;
}

/** he / ar / en from the conversation's detected locale, else the message's script. */
async function conversationLanguage(ctx: FlowExecCtx): Promise<string | null> {
  if (ctx.conversationId) {
    const c = await prisma.conversation.findFirst({ where: { id: ctx.conversationId, tenantId: ctx.tenantId }, select: { detectedLocale: true } });
    const loc = String((c as any)?.detectedLocale ?? "").slice(0, 2).toLowerCase();
    if (loc) return loc;
  }
  const m = ctx.message || "";
  if (/[\u0590-\u05FF]/.test(m)) return "he";
  if (/[\u0600-\u06FF]/.test(m)) return "ar";
  if (/[a-zA-Z]/.test(m)) return "en";
  return null;
}

/** vip (tagged "vip"), new (no earlier conversation), else returning. */
async function customerSegment(ctx: FlowExecCtx): Promise<"vip" | "new" | "returning"> {
  if (!ctx.conversationId) return "new";
  const conv = await prisma.conversation.findFirst({
    where: { id: ctx.conversationId, tenantId: ctx.tenantId },
    select: { customerExternalId: true, channel: true },
  });
  if (!conv) return "new";
  const contact = await prisma.contact.findFirst({
    where: { tenantId: ctx.tenantId, channel: conv.channel, externalId: conv.customerExternalId },
    select: { tags: true },
  });
  const tags = Array.isArray(contact?.tags) ? (contact!.tags as string[]).map((t) => String(t).toLowerCase()) : [];
  if (tags.includes("vip")) return "vip";
  const earlier = await prisma.conversation.count({
    where: { tenantId: ctx.tenantId, channel: conv.channel, customerExternalId: conv.customerExternalId, id: { not: ctx.conversationId } },
  });
  return earlier > 0 ? "returning" : "new";
}

async function sendButtons(body: string, buttons: Array<{ id: string; title: string }>, ctx: FlowExecCtx) {
  const sendCtx = ctx.sendCtx;
  if (!sendCtx || !body.trim() || !buttons.length) return;
  const adapter = getOutboundAdapter(sendCtx.channel as any);
  if (!adapter) return;
  await refuseOutsideWindow(ctx, sendCtx, body, "interactive", { buttons });
  let extId: string | null;
  try {
    extId = await adapter.sendInteractiveMessage(sendCtx.credentials, sendCtx.channelAccountExternalId, sendCtx.recipientId, body, buttons);
  } catch (err: any) {
    const { sendError } = describeSendError(err, sendCtx.channel as any);
    await persistOutbound(ctx, body, "interactive", null, { buttons, sendError });
    throw err;
  }
  await persistOutbound(ctx, body, "interactive", extId, { buttons });
}

async function sendList(body: string, buttonText: string, rows: Array<{ id: string; title: string; description?: string }>, ctx: FlowExecCtx) {
  const sendCtx = ctx.sendCtx;
  if (!sendCtx || !body.trim() || !rows.length) return;
  const adapter = getOutboundAdapter(sendCtx.channel as any);
  if (!adapter?.sendListMessage) {
    // The validator keeps lists on WhatsApp; a path that still reaches another
    // channel fails loudly rather than pretending it sent.
    throw new Error(`send_list: ${sendCtx.channel} has no list messages`);
  }
  await refuseOutsideWindow(ctx, sendCtx, body, "interactive", { list: rows });
  let extId: string | null;
  try {
    extId = await adapter.sendListMessage(sendCtx.credentials, sendCtx.channelAccountExternalId, sendCtx.recipientId, body, buttonText, rows);
  } catch (err: any) {
    const { sendError } = describeSendError(err, sendCtx.channel as any);
    await persistOutbound(ctx, body, "interactive", null, { list: rows, sendError });
    throw err;
  }
  await persistOutbound(ctx, body, "interactive", extId, { list: rows });
}

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";
const internalKey = () => process.env.INTERNAL_SERVICE_KEY || process.env.INTERNAL_SERVICE_TOKEN || "";

/**
 * The variables every automation can write: {{first_name}} (the customer's
 * card, first word) and {{business_name}}. Never overwrites a value the run
 * already has (a resumed run keeps what it set).
 */
async function runVariables(ctx: FlowExecCtx): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const [conv, tenant] = await Promise.all([
      ctx.conversationId
        ? prisma.conversation.findFirst({ where: { id: ctx.conversationId, tenantId: ctx.tenantId }, select: { channel: true, customerExternalId: true, customerName: true } })
        : Promise.resolve(null),
      prisma.tenant.findUnique({ where: { id: ctx.tenantId }, select: { name: true } }),
    ]);
    let name: string | null = (conv as any)?.customerName ?? null;
    if (conv) {
      const contact = await prisma.contact.findFirst({
        where: { tenantId: ctx.tenantId, channel: (conv as any).channel, externalId: (conv as any).customerExternalId },
        select: { displayName: true },
      });
      name = contact?.displayName ?? name;
    }
    const first = String(name ?? "").trim().split(/\s+/)[0];
    if (first && ctx.vars.first_name == null) out.first_name = first;
    if (tenant?.name && ctx.vars.business_name == null) out.business_name = tenant.name;
  } catch { /* variables are a nicety: a failed read leaves them empty */ }
  return out;
}

async function conversationAgentId(ctx: FlowExecCtx): Promise<string | null> {
  if (!ctx.conversationId) return null;
  const c = await prisma.conversation.findFirst({ where: { id: ctx.conversationId, tenantId: ctx.tenantId }, select: { assignedAiAgentId: true } });
  return (c as any)?.assignedAiAgentId ?? null;
}

/** One message from an AI employee (ai service one-shot). Empty on any failure. */
async function aiOneShot(ctx: FlowExecCtx, aiAgentId: string, prompt: string): Promise<string> {
  const userInput = ctx.message
    ? `${prompt}\n\nThe customer's latest message: ${ctx.message}`
    : prompt;
  try {
    const r = await fetch(`${AI_SERVICE_URL}/api/ai-bot/oneshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey() },
      body: JSON.stringify({ tenantId: ctx.tenantId, aiAgentId, userInput: userInput.slice(0, 4000), feature: "automation_ai_generate", maxTokens: 400 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return "";
    const j: any = await r.json().catch(() => ({}));
    return typeof j?.reply === "string" ? j.reply.trim() : "";
  } catch (err: any) {
    console.warn("[flow-executor] ai_generate failed:", err?.message);
    return "";
  }
}

/** A task in the tenant's connected CRM, through the ai service (it owns the CRM connectors). */
async function createCrmTask(
  ctx: FlowExecCtx,
  task: { title: string; body: string; dueInMinutes: number | null },
): Promise<{ ok: boolean; reason?: string }> {
  if (!task.title.trim()) return { ok: false, reason: "no_title" };
  try {
    const r = await fetch(`${AI_SERVICE_URL}/api/internal/automation-actions/create-task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey(), "x-tenant-id": ctx.tenantId },
      body: JSON.stringify({ tenantId: ctx.tenantId, conversationId: ctx.conversationId, ...task }),
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await r.json().catch(() => ({}));
    return r.ok ? { ok: true } : { ok: false, reason: String(j?.reason || j?.error || `http_${r.status}`) };
  } catch (err: any) {
    return { ok: false, reason: `unreachable: ${err?.message ?? err}` };
  }
}

/** An in-app notification to the chosen people (or a department), through the notifications service. */
async function notifyTeam(
  ctx: FlowExecCtx,
  n: { message: string; userIds: string[]; departmentId: string | null },
): Promise<boolean> {
  if (!n.message.trim()) return false;
  try {
    const { notificationsQueue } = await import("@chatcenter/shared");
    await notificationsQueue.add("system-event", {
      id: `automation:${ctx.run?.id ?? "flow"}:${ctx.run?.currentNodeId ?? Date.now()}`,
      type: "automation.notify_team",
      tenantId: ctx.tenantId,
      data: {
        message: n.message.slice(0, 1000),
        userIds: n.userIds,
        departmentId: n.departmentId,
        conversationId: ctx.conversationId,
        automationId: ctx.run?.flowId ?? ctx.flowId ?? null,
      },
      metadata: { source: "automation", timestamp: new Date().toISOString() },
    }, { removeOnComplete: true, removeOnFail: 100 });
    return true;
  } catch (err: any) {
    console.warn("[flow-executor] notify_team enqueue failed:", err?.message);
    return false;
  }
}

/**
 * Replace `{{var_name}}` (and dotted paths like `{{customer.email}}`) in a
 * string with values from the flow's variable store. Missing keys render as
 * empty strings - flow authors can guard with a Condition on the var if they
 * need fallback behavior.
 */
function interpolate(text: string, vars: Record<string, any>): string {
  if (!text) return "";
  return text.replace(/\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g, (_m, path: string) => {
    const v = getByPath(vars, path);
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try { return JSON.stringify(v); } catch { return ""; }
  });
}

/**
 * Safe dotted-path getter. Supports "a.b", "a.b.c", and "a[0].b" forms.
 * Returns undefined on any missing segment instead of throwing.
 */
function getByPath(obj: any, path: string): any {
  if (obj == null || !path) return undefined;
  const parts = path
    .replace(/\[(\w+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Persist the flow variable store back to the conversation row. Called before
 * every halt path so a later resume sees the same variables. No-op when the
 * store is empty and the row has no previous vars (avoids touching the row
 * for read-only walks).
 */
async function persistVars(ctx: FlowExecCtx): Promise<void> {
  // Context-free runs (webhook triggers) have no Conversation row to persist
  // variables to - the store lives only for the duration of the walk.
  if (!ctx.conversationId) return;
  try {
    await prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { flowVariables: ctx.vars as any },
    });
  } catch (err) {
    console.warn("[flow-executor] persistVars failed:", (err as Error).message);
  }
}

/**
 * Flow HTTP-node fetch, delegating to the shared SSRF-hardened safeFetch
 * (scheme allowlist, DNS-resolved private/link-local/metadata block on every
 * hop, manual redirect revalidation). The old local string-match guard was
 * bypassable via a 302 redirect or DNS rebinding; the shared primitive is the
 * single sanctioned implementation.
 */
async function safeFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  const r = await sharedSafeFetch(url, { method, headers, body, timeoutMs: 10_000 });
  let data: any = r.text;
  try { data = JSON.parse(r.text); } catch {}
  return { ok: r.ok, status: r.status, data, ...(r.error ? { error: r.error } : {}) };
}

/**
 * Apply a customer-update action to the Contact row for this conversation.
 * Stays inside the shared Prisma client (no cross-service call) because the
 * Contact model lives in the shared schema and the rest of the platform also
 * writes it directly.
 */
async function updateContact(
  ctx: FlowExecCtx,
  action: string,
  key: string,
  value: string,
): Promise<void> {
  // No key or no conversation (context-free run) → no Contact to mutate.
  if (!key || !ctx.conversationId) return;
  const conversation = await prisma.conversation.findFirst({
    where: { id: ctx.conversationId, tenantId: ctx.tenantId },
    select: { customerExternalId: true, channel: true },
  });
  if (!conversation) return;
  const contact = await prisma.contact.findFirst({
    where: {
      tenantId: ctx.tenantId,
      channel: conversation.channel,
      externalId: conversation.customerExternalId,
    },
    select: { id: true, tags: true, metadata: true },
  });
  if (!contact) return;

  if (action === "add_tag" || action === "remove_tag") {
    const existing = Array.isArray(contact.tags) ? (contact.tags as string[]) : [];
    const next = action === "add_tag"
      ? Array.from(new Set([...existing, key]))
      : existing.filter((t) => t !== key);
    await prisma.contact.update({ where: { id: contact.id }, data: { tags: next as any } });
  } else if (action === "set_attribute") {
    const meta = (contact.metadata as Record<string, any>) || {};
    meta[key] = value;
    await prisma.contact.update({ where: { id: contact.id }, data: { metadata: meta as any } });
  } else if (action === "remove_attribute") {
    const meta = (contact.metadata as Record<string, any>) || {};
    delete meta[key];
    await prisma.contact.update({ where: { id: contact.id }, data: { metadata: meta as any } });
  }
}

/**
 * Load selected Contact fields into flow variables under a given prefix.
 * Returns { `${prefix}_displayName`: "...", `${prefix}_email`: "...", ... }.
 */
async function loadContactFields(
  ctx: FlowExecCtx,
  fields: string[],
  prefix: string,
): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  // No fields requested or no conversation (context-free run) → nothing to load.
  if (fields.length === 0 || !ctx.conversationId) return out;
  const conversation = await prisma.conversation.findFirst({
    where: { id: ctx.conversationId, tenantId: ctx.tenantId },
    select: { customerExternalId: true, channel: true },
  });
  if (!conversation) return out;
  const contact = await prisma.contact.findFirst({
    where: {
      tenantId: ctx.tenantId,
      channel: conversation.channel,
      externalId: conversation.customerExternalId,
    },
  });
  if (!contact) return out;

  for (const f of fields) {
    const raw = (contact as any)[f];
    if (raw === undefined) continue;
    // Dates → ISO strings; tags/metadata stay as-is (JSON).
    const v = raw instanceof Date ? raw.toISOString() : raw;
    out[`${prefix}_${f}`] = v;
  }
  return out;
}
