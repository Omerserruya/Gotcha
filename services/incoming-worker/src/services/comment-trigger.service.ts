
/**
 * Comment-trigger pipeline.
 *
 * Public comments on FB / IG don't fit the conversation+message model the
 * rest of the engine is built around. They fan out 0..N flow runs, each one
 * scoped to a single comment, and the bot's first reply must use the
 * Private Reply API (recipient.comment_id) - Meta's only path to DM a
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
  flowResumeQueue,
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

  // Tenant gate - skip work for non-active tenants (mirrors message worker).
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

  // Automations (trigger comment_received) first. When one ran - or this
  // exact comment already ran one (a Meta retry) - the comment is answered,
  // and the playbook's comment_trigger nodes do not answer it again.
  if (await runCommentAutomations({ tenantId, channel, channelAccountId, comment, channelAccount, credentials: credentials as ChannelCredentials })) {
    return;
  }

  // Comment triggers can live in two places:
  //   1) FlowCanvas - the Main Playbook (one canvas per tenant). This is where
  //      the CommentTriggerBody UI in node-registry.tsx writes.
  //   2) ChatbotFlow - sub-flows that opted into comment_trigger via the
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

  // Find every candidate trigger across all sources and score by specificity.
  // Priority (higher wins):
  //   3 - keyword match AND specific postId
  //   2 - keyword match (any post)  OR  specific postId (any keywords)
  //   1 - any comment (no keyword filter, any post)
  // Ties are broken by source order (canvas before sub-flows) then trigger id.
  type Candidate = {
    src: { id: string; nodes: GraphNode[]; edges: GraphEdge[] };
    trig: GraphNode;
    score: number;
  };
  const candidates: Candidate[] = [];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (!src) continue;
    for (const trig of src.nodes.filter((n) => n.type === "comment_trigger")) {
      const score = scoreTriggerMatch(trig, channel, channelAccountId, comment);
      if (score > 0) candidates.push({ src, trig, score });
    }
  }

  let matched = 0;
  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const ai = sources.indexOf(a.src);
      const bi = sources.indexOf(b.src);
      if (ai !== bi) return ai - bi;
      return a.trig.id.localeCompare(b.trig.id);
    });
    const winner = candidates[0]!;
    matched = 1;
    console.log(
      `[comment-trigger] Match (score=${winner.score}): source=${winner.src.id} `
      + `trigger=${winner.trig.id} post=${comment.postId} `
      + `commenter=${comment.fromUsername || comment.fromUserId} `
      + `(${candidates.length - 1} lower-priority candidate(s) skipped)`,
    );
    try {
      await runCommentFlow({
        tenantId,
        nodes: winner.src.nodes,
        edges: winner.src.edges,
        startNodeId: firstOutgoingTarget(winner.src.edges, winner.trig.id),
        comment,
        sourceChatbotFlowId: winner.src.id.startsWith("canvas:") ? null : winner.src.id,
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
      console.error(`[comment-trigger] Flow ${winner.src.id} failed:`, (err as Error).message);
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
        `Seen triggers: ${seen.length === 0 ? "(none - playbook has no comment_trigger nodes)" : JSON.stringify(seen)}`,
    );
  }
}

// ─── Automations: trigger comment_received ──────────────────

/**
 * Runs the first live comment automation that accepts this comment (in the
 * order they went live). One run per comment (eventKey comment:<id>): a
 * redelivered comment finds its run and does nothing. Returns true when the
 * comment belongs to an automation (ran now, or already ran).
 */
export async function runCommentAutomations(opts: {
  tenantId: string;
  channel: "INSTAGRAM" | "MESSENGER";
  channelAccountId: string;
  comment: IncomingCommentJob["comment"];
  channelAccount: { externalId: string };
  credentials: ChannelCredentials;
}): Promise<boolean> {
  const { triggerMatches, stepsFromTrace } = await import("./automation-runner.service");
  const flows = await prisma.chatbotFlow.findMany({
    where: { tenantId: opts.tenantId, isActive: true, triggerType: "comment_received" },
    orderBy: { activatedAt: "asc" },
    select: { id: true, triggerType: true, triggerConfig: true, nodes: true, edges: true },
  });
  const flow = (flows as any[]).find((f) =>
    triggerMatches(f, { type: "comment_received", channel: opts.channel, message: opts.comment.text, postId: opts.comment.postId }),
  );
  if (!flow) return false;

  const eventKey = `comment:${opts.comment.commentId}`;
  let runId: string;
  try {
    const row = await prisma.automationRun.create({
      data: { tenantId: opts.tenantId, flowId: flow.id, triggerType: "comment_received", eventKey, status: "running" },
      select: { id: true },
    });
    runId = row.id;
  } catch (err: any) {
    if (err?.code === "P2002") return true; // this comment already ran it
    throw err;
  }
  const nodes = (flow.nodes as GraphNode[]) || [];
  const edges = (flow.edges as GraphEdge[]) || [];
  const trig = nodes.find((n) => n.type === "automation_trigger");
  const run: CommentRunCtx = { id: runId, flowId: flow.id, trace: [], status: "completed", conversationId: null };
  let error: string | null = null;
  try {
    await runCommentFlow({
      tenantId: opts.tenantId, nodes, edges,
      startNodeId: trig ? firstOutgoingTarget(edges, trig.id) : null,
      comment: opts.comment,
      sourceChatbotFlowId: flow.id,
      send: {
        channel: opts.channel, channelAccountId: opts.channelAccountId,
        channelAccountExternalId: opts.channelAccount.externalId, credentials: opts.credentials,
        commentId: opts.comment.commentId, recipientPsid: null,
      },
      run,
    });
  } catch (err: any) {
    run.status = "failed";
    error = `failed: ${String(err?.message ?? err).slice(0, 300)}`;
  }
  const steps = stepsFromTrace(run.trace);
  if (steps.length) {
    await prisma.automationRunStep.createMany({ data: steps.map((st) => ({ tenantId: opts.tenantId, runId, ...st })) }).catch(() => undefined);
  }
  const ended = run.status !== "waiting";
  await prisma.automationRun.update({
    where: { id: runId },
    data: {
      status: run.status,
      conversationId: run.conversationId,
      // A comment automation answers the comment by what it sends.
      answeredInbound: steps.some((x) => x.status === "ok" && /^send_/.test(x.nodeType)),
      ...(error ? { error } : {}),
      ...(ended ? { endedAt: new Date() } : { currentNodeId: steps[steps.length - 1]?.nodeId ?? null }),
    },
  });
  return true;
}

// ─── Trigger matching + specificity scoring ──────────────────

/**
 * Returns a positive score when the trigger matches the inbound comment,
 * higher = more specific. Returns 0 when the trigger doesn't match at all.
 *
 *   3 - keyword match AND specific postId
 *   2 - keyword match (any post)  OR  specific postId (any keywords)
 *   1 - any-comment trigger (no keyword filter, no postId)
 *   0 - channel mismatch / channelAccount mismatch / keyword filter missed
 */
function scoreTriggerMatch(
  trig: GraphNode,
  channel: "INSTAGRAM" | "MESSENGER",
  channelAccountId: string,
  comment: { postId: string; text: string },
): number {
  if (channel !== "INSTAGRAM" && channel !== "MESSENGER") return 0;

  const trigChannelId = String(trig.data?.channelId || "").trim();
  if (!trigChannelId) return 0;
  if (trigChannelId !== channelAccountId) return 0;

  const trigPostId = String(trig.data?.postId || "").trim();
  const postSpecific = trigPostId.length > 0;
  if (postSpecific && trigPostId !== comment.postId) return 0;

  const keywords: string[] = Array.isArray(trig.data?.keywords)
    ? (trig.data.keywords as unknown[]).filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    : [];
  const caseSensitive = !!trig.data?.caseSensitive;
  const haystack = caseSensitive ? comment.text || "" : (comment.text || "").toLowerCase();
  const matchType = String(trig.data?.matchType || "any");
  const keywordsConfigured = keywords.length > 0;
  let keywordHit = false;
  if (keywordsConfigured) {
    const needles = keywords.map((k) => (caseSensitive ? k : k.toLowerCase()));
    keywordHit =
      matchType === "exact"
        ? needles.some((n) => haystack.trim() === n.trim())
        : matchType === "all"
        ? needles.every((n) => haystack.includes(n))
        : needles.some((n) => haystack.includes(n));
    if (!keywordHit) return 0; // configured filter that didn't match → reject
  }

  if (keywordsConfigured && postSpecific) return 3;
  if (keywordsConfigured || postSpecific) return 2;
  return 1;
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
  // FlowCanvas (Main Playbook) - the resume path then keys off
  // conversation.chatbotNodeId without a flowId.
  sourceChatbotFlowId: string | null;
  /** Set when this walk is an automation run (trigger comment_received). */
  run?: CommentRunCtx;
}

export interface CommentRunCtx {
  id: string;
  flowId: string;
  trace: Array<{ nodeId: string; type: string; action: string; detail?: any }>;
  status: "completed" | "waiting" | "failed";
  conversationId: string | null;
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
  // An automation's variables. Not {{first_name}}: a comment carries only the
  // username, which is not a name (after the Wait for reply the DM walker
  // fills it from the customer's profile as usual). The comment is also kept
  // nested, because the DM walker reads {{comment.text}} as a path.
  if (args.run) {
    vars.comment = {
      text: args.comment.text, id: args.comment.commentId, postId: args.comment.postId,
      postPermalink: args.comment.postPermalink || "", from: { id: args.comment.fromUserId, username: args.comment.fromUsername || "" },
    };
    const tenant = await prisma.tenant.findUnique({ where: { id: args.tenantId }, select: { name: true } }).catch(() => null);
    if (tenant?.name) vars.business_name = tenant.name;
  }

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
    if (node.type !== "wait_for_reply") args.run?.trace.push({ nodeId: node.id, type: node.type, action: "ok" });

    switch (node.type) {
      case "automation_trigger":
        break;

      // An automation's buttons: sent like a quick reply. When the next step
      // waits for the answer, the run moves into a real conversation (the
      // PSID the private reply returned) parked on Wait for reply - from
      // there the DM path and its timer resume it like any automation run.
      case "send_buttons": {
        const body = interpolate(String(node.data?.text || ""), vars);
        const buttons = (Array.isArray(node.data?.buttons) ? node.data.buttons : [])
          .slice(0, 3)
          .map((b: any) => ({ id: String(b?.id ?? "").slice(0, 256), title: interpolate(String(b?.title ?? ""), vars).slice(0, 20) }))
          .filter((b: any) => b.id && b.title);
        const ok = await sendOutboundWithButtons(args.send, body, buttons);
        if (!ok) { sendFailed(args); return; }
        const next = args.nodes.find((n) => n.id === nextId);
        if (next?.type === "wait_for_reply") {
          await parkForReply(args, next, vars);
          return;
        }
        break;
      }

      case "wait_for_reply": {
        await parkForReply(args, node, vars);
        return;
      }

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
        if (text.trim() && !(await sendOutbound(args.send, text)) && sendFailed(args)) return;
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
        if (composed && !(await sendOutbound(args.send, composed)) && sendFailed(args)) return;
        break;
      }

      case "send_message_image": {
        const url = interpolate(String(node.data?.url || ""), vars);
        const caption = node.data?.caption != null
          ? interpolate(String(node.data.caption), vars)
          : undefined;
        if (url.trim() && !(await sendOutboundMedia(args.send, url, "image", caption, undefined)) && sendFailed(args)) return;
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
        if (url.trim() && !(await sendOutboundMedia(args.send, url, "document", caption, filename)) && sendFailed(args)) return;
        break;
      }

      case "send_comment_reply": {
        // Public reply on the original post - visible to everyone, distinct
        // from Private Reply DM. data.mode picks "text" or "ai":
        //   text - use data.text (interpolated). Simple announce-and-reply.
        //   ai   - call data.agentId with the inbound comment text and use
        //          the agent's response. data.fallbackText (optional) is sent
        //          when generation fails so the flow doesn't go silent.
        // Doesn't change recipientPsid - the run can still continue into
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
        if (!(await sendCommentReplyOutbound(args.send, body)) && sendFailed(args)) return;
        break;
      }

      case "end":
      case "route_target":
      case "default_fallback": {
        // Comment-triggered runs are ephemeral - there's no Conversation row
        // to flip into HUMAN/WAITING, no session to close. Stop walking.
        console.log(`[comment-trigger] Reached terminal/route node (${node.type}); stopping`);
        return;
      }

      // Pause-y nodes - promote the comment-triggered run into a real
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

      // Still unsupported in the comment context - these need infrastructure
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
        // Unknown node - walk past it like the main executor does for safety.
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
// from a DM-initiated flow - next inbound DM is picked up by
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
  const channel = args.send.channel; // "INSTAGRAM" | "MESSENGER" - matches enum
  // findFirst keyed on (tenantId, channel, customerExternalId) and not CLOSED
  // - same lookup the message worker does. We can't use a unique index
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
  // Meta only allows one DM per comment; the user has 24h to reply before the
  // bridge expires and we lose the right to message in that thread. Persist
  // the deadline so the inbound resume path can hard-stop after expiry.
  const flowExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  // An automation run claims the conversation for its reply and remembers
  // the owner it found, like a run parked from a DM.
  const automation = args.run
    ? {
        automationRunId: args.run.id,
        handledBy: "flow",
        chatbotFlowId: args.run.flowId,
        flowVariables: { ...vars, __automationRunId: args.run.id, __automationPrevOwner: (conv as any)?.handledBy ?? null } as any,
      }
    : {};
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
        flowExpiresAt,
        ...automation,
      },
    });
  } else {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        chatbotFlowId: args.sourceChatbotFlowId,
        chatbotNodeId: pausedNodeId,
        flowVariables: vars as any,
        flowExpiresAt,
        ...automation,
      },
    });
  }
  if (args.run) args.run.conversationId = conv.id;
}

/**
 * An automation run stops at a send Meta refused, and the run log shows that
 * step as failed. (The playbook's comment_trigger walk keeps going, as before.)
 */
function sendFailed(args: WalkArgs): boolean {
  if (!args.run) return false;
  const last = args.run.trace[args.run.trace.length - 1];
  if (last) last.action = "send_failed";
  args.run.status = "failed";
  return true;
}

/**
 * Meta's comment-to-DM bridge lasts 24 h (flowExpiresAt; the idle sweep then
 * closes the conversation). A Wait for reply on it times out inside that, so
 * its timeout branch runs before the sweep.
 */
export const COMMENT_BRIDGE_WAIT_MAX_MS = 24 * 60 * 60_000 - 10 * 60_000;

/** Park an automation run at Wait for reply, with its timeout timer. */
async function parkForReply(args: WalkArgs, waitNode: GraphNode, vars: Record<string, any>): Promise<void> {
  if (!args.run) return;
  await promoteToConversation(args, waitNode.id, vars);
  if (!args.run.conversationId) { args.run.status = "failed"; return; }
  args.run.status = "waiting";
  args.run.trace.push({ nodeId: waitNode.id, type: waitNode.type, action: "paused_for_reply" });
  const timeoutMs = Math.min(Number(waitNode.data?.timeoutMs) > 0 ? Number(waitNode.data.timeoutMs) : 30 * 60_000, COMMENT_BRIDGE_WAIT_MAX_MS);
  await flowResumeQueue.add(
    "resume",
    {
      tenantId: args.tenantId, conversationId: args.run.conversationId, flowKind: "sub", flowId: args.run.flowId,
      resumeNodeId: waitNode.id, channel: String(args.send.channel).toLowerCase(), message: "", timeout: true, automationRunId: args.run.id,
    },
    { delay: timeoutMs, removeOnComplete: true, removeOnFail: 100 },
  );
}

// ─── Outbound: Private Reply, then DM by PSID ──────────────────────────────
//
// Three send shapes, all using the same first-send-is-Private-Reply rule:
//   sendOutbound            - plain text
//   sendOutboundWithButtons - quick-reply / buttons (IG+Messenger render as
//                             quick_replies; Meta supports them on the very
//                             first private reply)
//   sendOutboundMedia       - image / document. Private Reply doesn't accept
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
  // adapters both pass a `quickReplies` arg straight through to Meta - buttons
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
  // only accepts text + quick_replies - never an attachment payload. Caption
  // (when present) doubles as the priming message; otherwise filename, then
  // the URL itself, so the user always sees coherent content.
  if (!send.recipientPsid) {
    const priming =
      (caption && caption.trim()) ||
      (filename && filename.trim()) ||
      mediaUrl;
    const ok = await sendOutbound(send, priming);
    if (!ok) return false;
    // Caption already shown by the priming send - don't echo it on the media.
    caption = undefined;
  }

  if (!send.recipientPsid) {
    console.warn(`[comment-trigger] No PSID after priming send; cannot deliver ${mediaType}`);
    return false;
  }

  if (!adapter.sendMediaMessage) {
    // No native media support on this adapter - degrade to a text DM with the
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
// outcome - the run is allowed to drop into a private DM afterwards.
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
