
/**
 * Comment-trigger pipeline.
 *
 * Public comments on FB / IG don't fit the conversation+message model the
 * rest of the engine is built around. They fan out 0..N flow runs, each one
 * scoped to a single comment, and the bot's first reply must use the
 * Private Reply API (recipient.comment_id) — Meta's only path to DM a
 * commenter who hasn't messaged us first.
 *
 * Lifecycle:
 *   webhook → incomingMessageQueue.add("process-comment", IncomingCommentJob)
 *           → this service.processCommentTrigger(job)
 *           → for each flow whose comment_trigger node targets this post,
 *             walk its graph; first send_message_* uses sendPrivateReply,
 *             subsequent sends use the PSID Meta returned.
 */

import { Job } from "bullmq";
import {
  prisma,
  decryptCredentials,
  getOutboundAdapter,
  type IncomingCommentJob,
  type ChannelCredentials,
} from "@chatcenter/shared";
import { generateOneShotReply } from "./ai-bot.service";

interface GraphNode {
  id: string;
  type: string;
  data: Record<string, any>;
}
interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

interface CommentSendCtx {
  channel: "INSTAGRAM" | "MESSENGER";
  channelAccountId: string;
  channelAccountExternalId: string;
  credentials: ChannelCredentials;
  commentId: string;
  // Captured from the Private Reply response on the first send. Once set,
  // subsequent send_message_* nodes go through the regular DM endpoint.
  recipientPsid: string | null;
}

export async function processCommentTrigger(job: Job<IncomingCommentJob>): Promise<void> {
  const { tenantId, channel, channelAccountId, comment } = job.data;

  // Tenant gate — skip work for non-active tenants (mirrors message worker).
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  });
  if (!tenant || tenant.status !== "ACTIVE") {
    console.log(`[comment-trigger] Skipping for non-active tenant ${tenantId} (${tenant?.status})`);
    return;
  }

  // Resolve outbound credentials once.
  const channelAccount = await prisma.channelAccount.findUnique({
    where: { id: channelAccountId },
  });
  if (!channelAccount || !channelAccount.isActive) {
    console.warn(`[comment-trigger] Inactive/missing channel account ${channelAccountId}`);
    return;
  }
  const rawCreds = (channelAccount as any).credentials;
  const credentials =
    typeof rawCreds === "string" ? decryptCredentials(rawCreds) : ((rawCreds as any) || {});

  // Comment triggers can live in two places:
  //   1) FlowCanvas — the Main Playbook (one canvas per tenant). This is where
  //      the CommentTriggerBody UI in node-registry.tsx writes.
  //   2) ChatbotFlow — sub-flows that opted into comment_trigger via the
  //      unified-graph set in chatbot-engine.service.ts. Less common but
  //      supported. We pull from both and merge.
  type FlowSource = { id: string; nodes: GraphNode[]; edges: GraphEdge[] };
  const sources: FlowSource[] = [];

  const canvas = await prisma.flowCanvas.findUnique({ where: { tenantId } });
  if (canvas) {
    sources.push({
      id: `canvas:${tenantId}`,
      nodes: (canvas.nodes as unknown as GraphNode[]) || [],
      edges: (canvas.edges as unknown as GraphEdge[]) || [],
    });
  }
  const subFlows = await prisma.chatbotFlow.findMany({
    where: { tenantId, isActive: true },
  });
  for (const f of subFlows) {
    sources.push({
      id: f.id,
      nodes: (f.nodes as unknown as GraphNode[]) || [],
      edges: (f.edges as unknown as GraphEdge[]) || [],
    });
  }

  let matched = 0;
  for (const src of sources) {
    const triggerNodes = src.nodes.filter((n) => n.type === "comment_trigger");
    if (triggerNodes.length === 0) continue;

    for (const trig of triggerNodes) {
      if (!matchesTrigger(trig, channel, channelAccountId, comment.postId)) continue;
      matched++;
      console.log(
        `[comment-trigger] Match: source=${src.id} trigger=${trig.id} post=${comment.postId} commenter=${comment.fromUsername || comment.fromUserId}`,
      );
      try {
        await runCommentFlow({
          tenantId,
          nodes: src.nodes,
          edges: src.edges,
          startNodeId: firstOutgoingTarget(src.edges, trig.id),
          comment,
          // canvas source has id "canvas:<tenantId>"; only sub-flows have
          // real ChatbotFlow ids that the resume path can store as
          // conversation.chatbotFlowId.
          sourceChatbotFlowId: src.id.startsWith("canvas:") ? null : src.id,
          send: {
            channel,
            channelAccountId,
            channelAccountExternalId: channelAccount.externalId,
            credentials: credentials as ChannelCredentials,
            commentId: comment.commentId,
            recipientPsid: null,
          },
        });
      } catch (err) {
        console.error(`[comment-trigger] Flow ${src.id} failed:`, (err as Error).message);
      }
    }
  }

  if (matched === 0) {
    // Help authors debug: dump every comment_trigger we *did* see and why
    // it didn't match. Keeps the diagnostic in the worker log instead of
    // forcing a DB dump.
    const seen: Array<{ source: string; channelId: string; postId: string }> = [];
    for (const src of sources) {
      for (const t of src.nodes.filter((n) => n.type === "comment_trigger")) {
        seen.push({
          source: src.id,
          channelId: String(t.data?.channelId || ""),
          postId: String(t.data?.postId || ""),
        });
      }
    }
    console.log(
      `[comment-trigger] No match for inbound channelAccountId=${channelAccountId} post=${comment.postId}. ` +
        `Seen triggers: ${seen.length === 0 ? "(none — playbook has no comment_trigger nodes)" : JSON.stringify(seen)}`,
    );
  }
}

// ─── Trigger matching ────────────────────────────────────────

function matchesTrigger(
  trig: GraphNode,
  channel: "INSTAGRAM" | "MESSENGER",
  channelAccountId: string,
  postId: string,
): boolean {
  // The CommentTrigger UI saves:
  //   data.channelId    — ChannelAccount.id selected by the author
  //   data.postId       — post / IG media id (or "" for wildcard)
  //   data.postSource   — "page" | "group"
  // We require the trigger's channelId to match (so a flow on one IG account
  // doesn't fire for another), and either (a) postId equals the inbound, or
  // (b) postId is empty/undefined (wildcard — matches every post on that
  // channel). No-op if neither field is set.
  const trigChannelId = String(trig.data?.channelId || "").trim();
  if (!trigChannelId) return false;
  if (trigChannelId !== channelAccountId) return false;

  const trigPostId = String(trig.data?.postId || "").trim();
  if (trigPostId && trigPostId !== postId) return false;

  // Channel sanity — a comment_trigger only ever fires for FB/IG, but guard
  // anyway in case the UI lets a future channel slip through.
  if (channel !== "INSTAGRAM" && channel !== "MESSENGER") return false;

  return true;
}

function firstOutgoingTarget(edges: GraphEdge[], fromId: string): string | null {
  return edges.find((e) => e.source === fromId)?.target || null;
}

// ─── Walker (subset-of-flow-executor specialised for comments) ───────────────

interface WalkArgs {
  tenantId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  startNodeId: string | null;
  comment: IncomingCommentJob["comment"];
  send: CommentSendCtx;
  // Set when the trigger lives in a ChatbotFlow row (sub-flow). Null for
  // FlowCanvas (Main Playbook) — the resume path then keys off
  // conversation.chatbotNodeId without a flowId.
  sourceChatbotFlowId: string | null;
}

async function runCommentFlow(args: WalkArgs): Promise<void> {
  // Variables exposed to {{...}} interpolation for any send_message_* / set_variable
  // / condition_group nodes downstream of the trigger. Mirrors what flow
  // authors expect to be available on a comment trigger.
  const vars: Record<string, any> = {
    "comment.text": args.comment.text,
    "comment.id": args.comment.commentId,
    "comment.postId": args.comment.postId,
    "comment.postPermalink": args.comment.postPermalink || "",
    "comment.from.id": args.comment.fromUserId,
    "comment.from.username": args.comment.fromUsername || "",
  };

  let currentId: string | null = args.startNodeId;
  const visited = new Set<string>();
  const MAX_STEPS = 50;
  let steps = 0;

  while (currentId && steps < MAX_STEPS) {
    steps++;
    if (visited.has(currentId)) {
      console.warn(`[comment-trigger] Loop guard hit at node ${currentId}`);
      return;
    }
    visited.add(currentId);

    const node = args.nodes.find((n) => n.id === currentId);
    if (!node) return;

    const outgoing = args.edges.filter((e) => e.source === currentId);
    let nextId: string | null = outgoing[0]?.target || null;

    switch (node.type) {
      // Trigger entry already consumed by caller; if we ever land on one,
      // treat it as a passthrough.
      case "comment_trigger":
        break;

      case "set_variable": {
        const name = String(node.data?.variable || "").trim();
        if (name) vars[name] = interpolate(String(node.data?.value ?? ""), vars);
        break;
      }

      case "condition_group": {
        const matched = evaluateConditionGroup(node, vars);
        const handle = matched ? "true" : "false";
        nextId = outgoing.find((e) => e.sourceHandle === handle)?.target || null;
        break;
      }

      case "send_message_text": {
        const text = interpolate(String(node.data?.text || ""), vars);
        if (text.trim()) await sendOutbound(args.send, text);
        break;
      }

      case "send_message_interactive": {
        // Same fallback shape as flow-executor: append URL/label as text.
        const body = interpolate(String(node.data?.text || ""), vars).trim();
        const url = interpolate(String(node.data?.buttonUrl || ""), vars).trim();
        const label = interpolate(String(node.data?.buttonLabel || ""), vars).trim();
        const composed = url
          ? label
            ? `${body}\n\n${label}: ${url}`
            : `${body}\n\n${url}`
          : body;
        if (composed) await sendOutbound(args.send, composed);
        break;
      }

      case "send_message_image": {
        const url = interpolate(String(node.data?.url || ""), vars);
        const caption = node.data?.caption != null
          ? interpolate(String(node.data.caption), vars)
          : undefined;
        if (url.trim()) await sendOutboundMedia(args.send, url, "image", caption, undefined);
        break;
      }

      case "send_message_file": {
        const url = interpolate(String(node.data?.url || ""), vars);
        const caption = node.data?.caption != null
          ? interpolate(String(node.data.caption), vars)
          : undefined;
        const filename = node.data?.filename != null
          ? interpolate(String(node.data.filename), vars)
          : undefined;
        if (url.trim()) await sendOutboundMedia(args.send, url, "document", caption, filename);
        break;
      }

      case "send_comment_reply": {
        // Public reply on the original post — visible to everyone, distinct
        // from Private Reply DM. data.mode picks "text" or "ai":
        //   text — use data.text (interpolated). Simple announce-and-reply.
        //   ai   — call data.agentId with the inbound comment text and use
        //          the agent's response. data.fallbackText (optional) is sent
        //          when generation fails so the flow doesn't go silent.
        // Doesn't change recipientPsid — the run can still continue into
        // Private Reply / DM nodes after this.
        const mode = String(node.data?.mode || "text").toLowerCase();
        let body = "";
        if (mode === "ai") {
          const agentId = String(node.data?.agentId || "").trim();
          if (!agentId) {
            console.warn(`[comment-trigger] send_comment_reply ${node.id} mode=ai but no agentId set; skipping`);
            break;
          }
          const generated = await generateOneShotReply(
            args.tenantId,
            agentId,
            args.comment.text || "",
            { feature: "comment_reply" },
          );
          body = (generated || "").trim();
          if (!body) {
            const fallback = interpolate(String(node.data?.fallbackText || ""), vars).trim();
            if (!fallback) {
              console.warn(`[comment-trigger] AI generated empty reply at ${node.id} and no fallback; skipping`);
              break;
            }
            body = fallback;
          }
        } else {
          body = interpolate(String(node.data?.text || ""), vars).trim();
          if (!body) break;
        }
        await sendCommentReplyOutbound(args.send, body);
        break;
      }

      case "end":
      case "route_target":
      case "default_fallback": {
        // Comment-triggered runs are ephemeral — there's no Conversation row
        // to flip into HUMAN/WAITING, no session to close. Stop walking.
        console.log(`[comment-trigger] Reached terminal/route node (${node.type}); stopping`);
        return;
      }

      // Pause-y nodes — promote the comment-triggered run into a real
      // Conversation. Send the message via Private Reply (which captures
      // the PSID Meta returns), then create/find a Conversation keyed on
      // that PSID and persist the paused state. The next inbound DM from
      // this commenter resumes the flow via the normal incoming-worker
      // path (see incoming.worker.ts).
      case "send_message_quick_reply": {
        const body = interpolate(String(node.data?.text || ""), vars);
        const replies = Array.isArray(node.data?.replies) ? node.data.replies : [];
        const buttons = replies
          .slice(0, 13)
          .map((r: any) => ({
            id: String(r.payload || r.id || r.label || "").slice(0, 256),
            title: interpolate(String(r.label || r.payload || ""), vars).slice(0, 20),
          }))
          .filter((b: any) => b.title);
        const ok = await sendOutboundWithButtons(args.send, body, buttons);
        if (!ok) return;
        await promoteToConversation(args, node.id, vars);
        console.log(`[comment-trigger] Paused at quick_reply ${node.id}; conversation promoted (psid=${args.send.recipientPsid})`);
        return;
      }

      case "collect_input": {
        const prompt = interpolate(String(node.data?.prompt || ""), vars);
        if (prompt.trim()) {
          const ok = await sendOutbound(args.send, prompt);
          if (!ok) return;
        }
        await promoteToConversation(args, node.id, vars);
        console.log(`[comment-trigger] Paused at collect_input ${node.id}; conversation promoted (psid=${args.send.recipientPsid})`);
        return;
      }

      // Still unsupported in the comment context — these need infrastructure
      // we don't replicate inline (HTTP timer, AI usage, contact mutations,
      // delayed resume queue). Bail with a clear log.
      case "wait":
      case "http_request":
      case "ai_generate":
      case "update_customer":
      case "bring_user_data":
        console.warn(
          `[comment-trigger] Node type "${node.type}" not supported in comment-trigger flows; stopping at ${node.id}`,
        );
        return;

      default:
        // Unknown node — walk past it like the main executor does for safety.
        break;
    }

    currentId = nextId;
  }
}

// ─── Promote a comment run into a real Conversation ──────────────────────────
//
// Called when the walker hits a pause-y node. After the Private Reply has
// landed (so we have a PSID), create or find a Conversation keyed on that
// PSID and persist the paused state. From here the run is indistinguishable
// from a DM-initiated flow — next inbound DM is picked up by
// incoming.worker.ts which resumes via executeMainFlow / executeSubFlow with
// resumeNodeId = conversation.chatbotNodeId.
async function promoteToConversation(
  args: WalkArgs,
  pausedNodeId: string,
  vars: Record<string, any>,
): Promise<void> {
  const psid = args.send.recipientPsid;
  if (!psid) {
    console.warn("[comment-trigger] Cannot promote: no PSID captured (Private Reply must have failed)");
    return;
  }
  const channel = args.send.channel; // "INSTAGRAM" | "MESSENGER" — matches enum
  // findFirst keyed on (tenantId, channel, customerExternalId) and not CLOSED
  // — same lookup the message worker does. We can't use a unique index
  // because Conversation has no compound unique on (tenant, channel, psid).
  let conv = await prisma.conversation.findFirst({
    where: {
      tenantId: args.tenantId,
      channel: channel as any,
      customerExternalId: psid,
      status: { not: "CLOSED" },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!conv) {
    conv = await prisma.conversation.create({
      data: {
        tenantId: args.tenantId,
        channel: channel as any,
        channelAccountId: args.send.channelAccountId,
        customerExternalId: psid,
        customerName: args.comment.fromUsername || null,
        status: "OPEN",
        chatbotFlowId: args.sourceChatbotFlowId,
        chatbotNodeId: pausedNodeId,
        flowVariables: vars as any,
      },
    });
  } else {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        chatbotFlowId: args.sourceChatbotFlowId,
        chatbotNodeId: pausedNodeId,
        flowVariables: vars as any,
      },
    });
  }
}

// ─── Outbound: Private Reply, then DM by PSID ──────────────────────────────
//
// Three send shapes, all using the same first-send-is-Private-Reply rule:
//   sendOutbound            — plain text
//   sendOutboundWithButtons — quick-reply / buttons (IG+Messenger render as
//                             quick_replies; Meta supports them on the very
//                             first private reply)
//   sendOutboundMedia       — image / document. Private Reply doesn't accept
//                             media payloads, so we prime the PSID with a
//                             text private reply (caption / filename / URL)
//                             and emit the media via the regular DM endpoint.
//
// All three return boolean so the walker can bail when Private Reply fails
// (no PSID = no chance of resuming).

async function sendOutbound(send: CommentSendCtx, text: string): Promise<boolean> {
  const adapter = getOutboundAdapter(send.channel);
  if (!adapter) {
    console.warn(`[comment-trigger] No outbound adapter for ${send.channel}`);
    return false;
  }

  // First send in this run: Private Reply on the comment. Captures the PSID.
  if (!send.recipientPsid) {
    if (!adapter.sendPrivateReply) {
      console.warn(`[comment-trigger] Adapter ${send.channel} lacks sendPrivateReply`);
      return false;
    }
    const result = await adapter.sendPrivateReply(
      send.credentials,
      send.channelAccountExternalId,
      send.commentId,
      text,
    );
    if (!result) {
      console.error(`[comment-trigger] Private reply failed (${send.channel}, comment=${send.commentId})`);
      return false;
    }
    send.recipientPsid = result.recipientPsid;
    console.log(
      `[comment-trigger] Private reply sent (${send.channel}, message=${result.messageId}, psid=${result.recipientPsid || "<none>"})`,
    );
    return true;
  }

  // Subsequent sends: regular DM by PSID. The 24-hour standard messaging
  // window is open from the moment the private reply landed.
  const extId = await adapter.sendTextMessage(
    send.credentials,
    send.channelAccountExternalId,
    send.recipientPsid,
    text,
  );
  console.log(
    `[comment-trigger] Follow-up DM sent (${send.channel}, message=${extId || "<failed>"})`,
  );
  return Boolean(extId);
}

async function sendOutboundWithButtons(
  send: CommentSendCtx,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
): Promise<boolean> {
  if (!bodyText.trim()) return false;
  if (buttons.length === 0) return sendOutbound(send, bodyText);

  const adapter = getOutboundAdapter(send.channel);
  if (!adapter) {
    console.warn(`[comment-trigger] No outbound adapter for ${send.channel}`);
    return false;
  }

  // First send: Private Reply with quick_replies attached. IG and Messenger
  // adapters both pass a `quickReplies` arg straight through to Meta — buttons
  // land on the very first private reply.
  if (!send.recipientPsid) {
    if (!adapter.sendPrivateReply) {
      console.warn(`[comment-trigger] Adapter ${send.channel} lacks sendPrivateReply`);
      return false;
    }
    const result = await adapter.sendPrivateReply(
      send.credentials,
      send.channelAccountExternalId,
      send.commentId,
      bodyText,
      buttons,
    );
    if (!result) {
      console.error(`[comment-trigger] Private reply with buttons failed (${send.channel}, comment=${send.commentId})`);
      return false;
    }
    send.recipientPsid = result.recipientPsid;
    console.log(
      `[comment-trigger] Private reply (with buttons) sent (${send.channel}, message=${result.messageId}, psid=${result.recipientPsid || "<none>"})`,
    );
    return true;
  }

  // Subsequent: regular interactive DM by PSID.
  const extId = await adapter.sendInteractiveMessage(
    send.credentials,
    send.channelAccountExternalId,
    send.recipientPsid,
    bodyText,
    buttons,
  );
  console.log(
    `[comment-trigger] Follow-up interactive sent (${send.channel}, message=${extId || "<failed>"})`,
  );
  return Boolean(extId);
}

async function sendOutboundMedia(
  send: CommentSendCtx,
  mediaUrl: string,
  mediaType: "image" | "document",
  caption: string | undefined,
  filename: string | undefined,
): Promise<boolean> {
  if (!mediaUrl.trim()) return false;
  const adapter = getOutboundAdapter(send.channel);
  if (!adapter) {
    console.warn(`[comment-trigger] No outbound adapter for ${send.channel}`);
    return false;
  }

  // Prime the PSID via a text Private Reply, since Meta's Private Reply API
  // only accepts text + quick_replies — never an attachment payload. Caption
  // (when present) doubles as the priming message; otherwise filename, then
  // the URL itself, so the user always sees coherent content.
  if (!send.recipientPsid) {
    const priming =
      (caption && caption.trim()) ||
      (filename && filename.trim()) ||
      mediaUrl;
    const ok = await sendOutbound(send, priming);
    if (!ok) return false;
    // Caption already shown by the priming send — don't echo it on the media.
    caption = undefined;
  }

  if (!send.recipientPsid) {
    console.warn(`[comment-trigger] No PSID after priming send; cannot deliver ${mediaType}`);
    return false;
  }

  if (!adapter.sendMediaMessage) {
    // No native media support on this adapter — degrade to a text DM with the
    // URL so the user at least sees the link.
    const fallback = caption ? `${caption}\n${mediaUrl}` : mediaUrl;
    return sendOutbound(send, fallback);
  }

  const extId = await adapter.sendMediaMessage(
    send.credentials,
    send.channelAccountExternalId,
    send.recipientPsid,
    mediaUrl,
    mediaType,
    filename,
    caption,
  );
  console.log(
    `[comment-trigger] ${mediaType} sent (${send.channel}, message=${extId || "<failed>"})`,
  );
  return Boolean(extId);
}

// Public-comment reply (NOT a DM). IG: POST /{ig-comment-id}/replies.
// Messenger: POST /{comment-id}/comments. The walker continues regardless of
// outcome — the run is allowed to drop into a private DM afterwards.
async function sendCommentReplyOutbound(send: CommentSendCtx, text: string): Promise<boolean> {
  const adapter = getOutboundAdapter(send.channel);
  if (!adapter) {
    console.warn(`[comment-trigger] No outbound adapter for ${send.channel}`);
    return false;
  }
  if (!adapter.sendCommentReply) {
    console.warn(`[comment-trigger] Adapter ${send.channel} lacks sendCommentReply`);
    return false;
  }
  const newCommentId = await adapter.sendCommentReply(
    send.credentials,
    send.channelAccountExternalId,
    send.commentId,
    text,
  );
  console.log(
    `[comment-trigger] Public comment reply sent (${send.channel}, parent=${send.commentId}, new=${newCommentId || "<failed>"})`,
  );
  return Boolean(newCommentId);
}

// ─── Local helpers (kept inline so we don't import private flow-executor utils) ──

function interpolate(text: string, vars: Record<string, any>): string {
  if (!text) return "";
  return text.replace(/\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g, (_m, path: string) => {
    const v = vars[path] ?? getByPath(vars, path);
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try { return JSON.stringify(v); } catch { return ""; }
  });
}

function getByPath(obj: any, path: string): any {
  if (obj == null || !path) return undefined;
  const parts = path.replace(/\[(\w+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Minimal condition_group evaluator. Mirrors the canvas semantics: ALL/ANY of
// rules; each rule is { variable, operator, value } against `vars`.
function evaluateConditionGroup(node: GraphNode, vars: Record<string, any>): boolean {
  const rules: Array<{ variable: string; operator: string; value: string }> =
    Array.isArray(node.data?.rules) ? node.data.rules : [];
  if (rules.length === 0) return true;
  const mode = String(node.data?.match || "all").toLowerCase();
  const results = rules.map((r) => {
    const left = String(vars[r.variable] ?? getByPath(vars, r.variable) ?? "");
    const right = String(r.value ?? "");
    switch (r.operator) {
      case "equals":              return left === right;
      case "not_equals":          return left !== right;
      case "contains":            return left.toLowerCase().includes(right.toLowerCase());
      case "not_contains":        return !left.toLowerCase().includes(right.toLowerCase());
      case "starts_with":         return left.toLowerCase().startsWith(right.toLowerCase());
      case "ends_with":           return left.toLowerCase().endsWith(right.toLowerCase());
      case "is_empty":            return left.trim() === "";
      case "is_not_empty":        return left.trim() !== "";
      default:                    return false;
    }
  });
  return mode === "any" ? results.some(Boolean) : results.every(Boolean);
}
