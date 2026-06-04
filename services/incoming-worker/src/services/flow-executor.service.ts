/**
 * Flow Canvas graph executor.
 *
 * Walks the node/edge graph saved by the Main Playbook editor (FlowCanvas) — or
 * by the Sub-flow editor (ChatbotFlow.nodes/edges). The executor does exactly
 * what the graph says: every edge is followed literally, every node's behavior
 * is defined in one place, and there is no "rule fallback" path that bypasses
 * the canvas.
 *
 * Supported node types (shared between Main Playbook and Sub-flow):
 *   - channel_entry        — main-flow entry; matched by inbound channel
 *   - start                — sub-flow entry (or main-flow with no channel_entry)
 *   - condition_group      — branches on "true" / "false" handle
 *   - send_message_text    — outbound text
 *   - send_message_interactive — outbound text with CTA link appended
 *   - send_message_quick_reply — outbound interactive with reply buttons; pauses
 *   - send_message_image   — outbound image by URL (+ caption)
 *   - send_message_file    — outbound document by URL (+ filename, caption)
 *   - send_message_template — outbound WABA template (WhatsApp only); re-opens 24h window
 *   - route_target         — dispatch: AI agent / sub-flow / human / department
 *   - default_fallback     — same as route_target but visually distinct
 *   - end                  — terminate: close / handoff_human / wait_for_reply
 *
 * When no FlowCanvas exists for a tenant, the caller falls back to the legacy
 * RouterRule-list evaluator in routing.service.ts. That is the only escape hatch.
 */

import { prisma, getOutboundAdapter, decryptCredentials, publishEvent, flowResumeQueue } from "@chatcenter/shared";
import type { ChannelCredentials } from "@chatcenter/shared";
import { processAIBot } from "./ai-bot.service";
import { tryLinkIdentifierFromInbound } from "./identity-link.service";

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
  // Null for context-free runs (webhook triggers — see executeWebhookFlow).
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
  // store it into the named variable and then continue — see walk().
  resumingCollectInputVar?: string | null;
  // Scope tag used for flow-resume jobs (Wait node). "main" = FlowCanvas;
  // "sub" = ChatbotFlow row identified by `flowId`.
  flowScope: "main" | "sub";
  flowId?: string;
  trace: Array<{ nodeId: string; type: string; action: string; detail?: any }>;
}

export interface FlowExecutionResult {
  executed: boolean;      // true when a FlowCanvas was found and walked
  halted: boolean;        // true when we reached a terminal node or paused
  reason?:
    | "end_node"
    | "route_dispatched"
    | "wait_for_reply"
    | "no_outgoing_edge"
    | "loop_guard"
    | "no_adapter"
    | "no_entry";
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
    if (paused) {
      if (paused.type === "collect_input") {
        // The inbound `message` is the reply the user just sent; store it into
        // the configured variable and proceed.
        resumingVar = String(paused.data?.variable || "").trim() || null;
        const out = edges.find((e) => e.source === paused.id);
        startId = out?.target ?? null;
      } else if (paused.type === "send_message_quick_reply") {
        // Reply payload picks the matching edge, else fall through first edge.
        const out = edges.filter((e) => e.source === paused.id);
        const payload = opts.message.toLowerCase().trim();
        const selected = out.find((e) => String(e.sourceHandle || "").toLowerCase() === payload) || out[0];
        startId = selected?.target ?? null;
      } else {
        // Generic resume (Wait, etc) — continue from first outgoing edge.
        const out = edges.find((e) => e.source === paused.id);
        startId = out?.target ?? null;
      }
    }
  }

  if (!startId) {
    const entry = pickMainFlowEntry(nodes, opts.channel, opts.message);
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
}): Promise<FlowExecutionResult> {
  const flow = await prisma.chatbotFlow.findFirst({
    where: { id: opts.flowId, tenantId: opts.tenantId, isActive: true },
  });
  if (!flow) return { executed: false, halted: false, trace: [] };

  const nodes = (flow.nodes as unknown as GraphNode[]) || [];
  const edges = (flow.edges as unknown as GraphEdge[]) || [];
  if (nodes.length === 0) return { executed: false, halted: false, trace: [] };

  let startId: string | null = null;
  let resumingVar: string | null = null;
  if (opts.resumeNodeId) {
    const paused = nodes.find((n) => n.id === opts.resumeNodeId);
    if (paused) {
      if (paused.type === "collect_input") {
        resumingVar = String(paused.data?.variable || "").trim() || null;
        const out = edges.find((e) => e.source === paused.id);
        startId = out?.target ?? null;
      } else if (paused.type === "send_message_quick_reply") {
        const out = edges.filter((e) => e.source === paused.id);
        const payload = opts.message.toLowerCase().trim();
        const selected = out.find((e) => String(e.sourceHandle || "").toLowerCase() === payload) || out[0];
        startId = selected?.target ?? null;
      } else {
        const out = edges.find((e) => e.source === paused.id);
        startId = out?.target ?? null;
      }
    }
  }
  if (!startId) {
    const startNode = nodes.find((n) => n.type === "start");
    const out = startNode ? edges.find((e) => e.source === startNode.id) : null;
    startId = out?.target ?? (startNode?.id ?? null);
  }
  if (!startId) return { executed: false, halted: false, reason: "no_entry", trace: [] };

  const ctx = await buildCtx(opts, { flowScope: "sub", flowId: opts.flowId });
  ctx.resumingCollectInputVar = resumingVar;
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
  // two paths share walk() — only entry resolution + which graph differs.
  targetMode?: "flow" | "connected";
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
  };
  return walk(startId, nodes, edges, ctx);
}

// ─── Public entry: context-free webhook run (connected-nodes mode) ──
//
// Sibling of executeWebhookFlow's default path. Instead of running a separate
// ChatbotFlow, this walks the nodes wired to the webhook trigger node on the
// tenant's Main Playbook canvas (FlowCanvas) — the same canvas the trigger node
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
  // copy only — never persisted.
  applyWebhookFieldMapping(entryNode, nodes, edges);
  // Start at the trigger node itself — walk()'s `webhook_trigger` case enters it
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
// target node's data — deliberately reusing the existing interpolation path
// (interpolate/getByPath) so the runtime substitution and the long-standing
// `{{body.*}}` reference behavior stay identical. The mapper is just a UI over
// those references; an author who hand-types `{{body.x}}` gets the same result.
//
// Only the FIRST connected node (first outgoing edge of the trigger) is mapped —
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

function pickMainFlowEntry(nodes: GraphNode[], channel: string, message?: string): GraphNode | null {
  const wanted = channel.toLowerCase();
  const msg = (message || "").toLowerCase();

  // 1) Keyword trigger that matches this inbound wins — bypasses channel entry.
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
  // 4) A Start node — rare for the main flow, but supported
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
    // or phone — bridges the conversation to the existing CRM record so the
    // FlowCanvas path matches what the autonomous AI agent does via
    // link_customer_identifier. Idempotent at the conversation-service end,
    // so the universal incoming.worker hook can safely re-fire. Only relevant
    // to conversation-bound runs — context-free webhook runs never set
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
      return { executed: true, halted: true, reason: "loop_guard", trace: ctx.trace };
    }
    visited.add(currentId);

    const node = nodes.find((n) => n.id === currentId);
    if (!node) {
      ctx.trace.push({ nodeId: currentId, type: "?", action: "node_not_found" });
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
        ctx.trace.push({
          nodeId: node.id,
          type: "condition_group",
          action: matched ? "match" : "no_match",
        });
        const handle = matched ? "true" : "false";
        const next = outgoing.find((e) => e.sourceHandle === handle) || null;
        currentId = next?.target || null;
        break;
      }

      case "send_message_text": {
        // Conversation-bound runs use ctx.sendCtx (unchanged). Context-free
        // webhook runs carry no sendCtx — resolve an explicit recipient from the
        // node so the text still dispatches through the existing outbound path.
        const sendCtx = ctx.sendCtx ?? (await buildExplicitSendCtx(node.data || {}, ctx));
        await sendText(String(node.data?.text || ""), ctx, sendCtx);
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "sent" });
        // Optional pause: when the author flipped "Wait for user reply", halt
        // here and resume on next inbound. Resume path (executeMainFlow's
        // generic branch) continues from the first outgoing edge.
        if (node.data?.waitForReply) {
          await persistVars(ctx);
          if (ctx.conversationId) {
            await prisma.conversation.update({
              where: { id: ctx.conversationId },
              data: { chatbotNodeId: node.id, handledBy: "flow" },
            });
          }
          ctx.trace.push({ nodeId: node.id, type: node.type, action: "paused_for_reply" });
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
            const extId = await adapter.sendInteractiveMessage(
              ctx.sendCtx.credentials,
              ctx.sendCtx.channelAccountExternalId,
              ctx.sendCtx.recipientId,
              body,
              buttons,
            );
            await persistOutbound(ctx, body, "interactive", extId, { buttons });
          }
        }
        // Pause and remember where we are. Next inbound resumes from here by
        // matching the reply payload against sourceHandle on outgoing edges.
        await persistVars(ctx);
        if (ctx.conversationId) {
          await prisma.conversation.update({
            where: { id: ctx.conversationId },
            data: { chatbotNodeId: node.id, handledBy: "flow" },
          });
        }
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
          node.data?.filename,
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
        // conversations fall through with a trace entry — flows mixing
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

      // ─── Trigger entries — walk through like `start` ───────────
      case "keyword_trigger":
      case "comment_trigger":
      case "schedule_trigger":
      case "webhook_trigger": {
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "trigger_enter" });
        currentId = outgoing[0]?.target || null;
        break;
      }

      // ─── Set Variable — programmatic assignment ────────────────
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

      // ─── Collect Input — send prompt, pause, resume with reply ─
      case "collect_input": {
        const prompt = interpolate(String(node.data?.prompt || ""), ctx.vars);
        if (prompt) await sendText(prompt, ctx);
        await persistVars(ctx);
        if (ctx.conversationId) {
          await prisma.conversation.update({
            where: { id: ctx.conversationId },
            data: { chatbotNodeId: node.id, handledBy: "flow" },
          });
        }
        ctx.trace.push({ nodeId: node.id, type: node.type, action: "prompted_and_paused" });
        return {
          executed: true, halted: true, reason: "wait_for_reply",
          matchedNodeId: node.id, trace: ctx.trace,
        };
      }

      // ─── Wait / Delay — schedule delayed resume, halt ──────────
      case "wait": {
        const amount = Math.max(1, Number(node.data?.amount ?? 1));
        const unit = String(node.data?.unit || "seconds");
        const delayMs =
          unit === "hours"   ? amount * 3600_000 :
          unit === "minutes" ? amount * 60_000 :
                               amount * 1000;
        await persistVars(ctx);
        // Context-free runs have no thread to resume — record the halt and stop
        // rather than scheduling a resume job that could never fire.
        if (ctx.conversationId) {
          await prisma.conversation.update({
            where: { id: ctx.conversationId },
            data: { chatbotNodeId: node.id, handledBy: "flow" },
          });
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

      // ─── HTTP Request — call external API, capture response ────
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
          // Fall through to next node — authors can wire a Condition on the
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

      // ─── AI Generate — single-shot LLM (author-only for now) ───
      case "ai_generate": {
        const prompt = interpolate(String(node.data?.prompt || ""), ctx.vars);
        const responseVar = String(node.data?.responseVariable || "ai_output").trim() || "ai_output";
        // The ai-service internal endpoint for raw single-shot generation is
        // not yet exposed. We log author intent, stash the prompt, and move
        // on — wiring this to services/ai is the follow-up bug. Treat it as
        // "returned empty string" so downstream interpolation doesn't crash.
        ctx.vars[responseVar] = "";
        ctx.trace.push({
          nodeId: node.id, type: node.type, action: "ai_stub",
          detail: { prompt: prompt.slice(0, 200), variable: responseVar },
        });
        currentId = outgoing[0]?.target || null;
        break;
      }

      // ─── Update Customer — tag / attribute on the contact row ──
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

      // ─── Bring User Data — load contact fields into variables ──
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
    return { executed: true, halted: true, reason: "no_outgoing_edge", trace: ctx.trace };
  }
  return { executed: true, halted: true, reason: "loop_guard", trace: ctx.trace };
}

// ─── Condition evaluation (graph-local, deterministic) ───────
// Intent conditions require the LLM batch path in routing.service.ts — for the
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
// +, spaces, dashes, parens) is treated as WhatsApp — the only channel that
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
// channel — callers then no-op exactly as before.
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

// `sendCtx` defaults to the conversation-bound context (ctx.sendCtx). Context-free
// callers (webhook runs with an explicit recipient) pass a one-off context built
// by buildExplicitSendCtx so the same dispatch + persist path is reused verbatim.
async function sendText(
  text: string,
  ctx: FlowExecCtx,
  sendCtx: ChannelSendContext | null = ctx.sendCtx,
) {
  const resolved = interpolate(text, ctx.vars);
  if (!resolved || !resolved.trim() || !sendCtx) return;
  const adapter = getOutboundAdapter(sendCtx.channel as any);
  if (!adapter) return;
  const extId = await adapter.sendTextMessage(
    sendCtx.credentials,
    sendCtx.channelAccountExternalId,
    sendCtx.recipientId,
    resolved,
  );
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
  if (adapter.sendMediaMessage) {
    const extId = await adapter.sendMediaMessage(
      ctx.sendCtx.credentials,
      ctx.sendCtx.channelAccountExternalId,
      ctx.sendCtx.recipientId,
      resolvedUrl,
      mediaType,
      resolvedName,
      resolvedCaption,
    );
    await persistOutbound(ctx, resolvedCaption || resolvedUrl, mediaType, extId, { url: resolvedUrl, filename: resolvedName });
    return;
  }
  // Adapter doesn't support media — fall back to text with URL so the user at
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
// Returns "" when the field can't be resolved — buildTemplateComponents
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
  // runs carry no sendCtx — resolve an explicit recipient from the node so the
  // template still dispatches through the existing WhatsApp outbound path.
  const sendCtx = ctx.sendCtx ?? (await buildExplicitSendCtx(data, ctx));
  if (!sendCtx) { console.warn(`${tag} skip no_send_ctx conv=${ctx.conversationId}`); return "skipped_no_send_ctx"; }
  const templateId = String(data.templateId || "").trim();
  if (!templateId) { console.warn(`${tag} skip no_template conv=${ctx.conversationId}`); return "skipped_no_template"; }
  // Templates are a WhatsApp-only concept — if the resolved recipient is on any
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

  const adapter = getOutboundAdapter(sendCtx.channel as any);
  if (!adapter || !adapter.sendTemplateMessage) {
    console.warn(`${tag} skip adapter_unsupported channel=${sendCtx.channel}`);
    return "skipped_adapter_unsupported";
  }

  // Look up the Contact backing this conversation so `crm:<field>` tokens
  // (set in the inspector) can resolve. Best-effort — when there's no
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
    // Fall back to the conversation's customerName when no Contact exists yet —
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
    console.error(`${tag} fail name=${tmpl.name} err=${String(err?.message || err).slice(0, 200)}`);
    // Persist a FAILED message row so the agent's history shows the attempt
    // (and the failure reason) instead of silently dropping.
    await persistOutbound(ctx, tmpl.body || tmpl.name, "template", null, {
      templateId: tmpl.id,
      templateName: tmpl.name,
      language: tmpl.language,
      components,
      error: String(err?.message || err).slice(0, 500),
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
      metadata: metadata || {},
    } as any,
  });
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
): Promise<"AI_AGENT" | "FLOW" | "HUMAN" | "DEPARTMENT"> {
  // Context-free run: no conversation to assign, hand off, or drive an agent
  // against. Map the author's intent to its terminal type without side effects.
  if (!ctx.conversationId) {
    return routeType === "agent" ? "AI_AGENT" : routeType === "flow" ? "FLOW" : "HUMAN";
  }
  if (routeType === "agent" && targetId) {
    // Persist the assigned AI agent on the conversation so subsequent inbound
    // messages resume against the same agent without re-routing through the
    // graph or the legacy RouterRule lookup.
    await prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { handledBy: "ai_agent", assignedAiAgentId: targetId },
    });
    await processAIBot(ctx.tenantId, ctx.conversationId, ctx.message, targetId);
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
      await executeSubFlow({
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        message: ctx.message,
        channel: ctx.channel,
        flowId: sub.id,
      });
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { handledBy: "flow" },
      });
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
  // Unassigned human — park the conversation in WAITING for a person to claim.
  await prisma.conversation.update({
    where: { id: ctx.conversationId },
    data: { status: "WAITING", handledBy: "human" },
  });
  return "HUMAN";
}

async function applyEnd(
  kind: "close" | "handoff_human" | "wait_for_reply",
  ctx: FlowExecCtx,
) {
  // Context-free run: no Conversation row to transition. The End node just
  // terminates the walk.
  if (!ctx.conversationId) return;
  // The flow has terminated — drop chatbot state so the next inbound is NOT
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
    // "wait_for_reply" — flow is done; release the conversation back to the
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
 * Replace `{{var_name}}` (and dotted paths like `{{customer.email}}`) in a
 * string with values from the flow's variable store. Missing keys render as
 * empty strings — flow authors can guard with a Condition on the var if they
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
  // variables to — the store lives only for the duration of the walk.
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
 * Fetch with SSRF guard + timeout. Blocks internal IP ranges (10.x, 127.x,
 * 172.16-31.x, 192.168.x, link-local, metadata endpoints) so a flow author
 * can't point HTTP Request at an internal service. This is NOT a substitute
 * for a proper allowlist — it's a floor.
 */
async function safeFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, status: 0, data: null, error: "URL must be http(s)://" };
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (isPrivateHost(host)) {
      return { ok: false, status: 0, data: null, error: `Blocked internal host: ${host}` };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const init: RequestInit = {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      signal: controller.signal,
    };
    if (body && body.length > 0) init.body = body;
    const res = await fetch(parsed.toString(), init).finally(() => clearTimeout(timer));
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: (err as Error).message };
  }
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host === "0.0.0.0" || host === "::1") return true;
  // IPv4 literal
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // Common internal names
  return /^(internal\.|intranet\.|\.internal$|\.local$)/i.test(host);
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
