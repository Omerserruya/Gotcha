/**
 * Voice Flow Runner — bridges voice events into the existing ChatbotFlow
 * schema as an automation surface.
 *
 * Why this lives here (not in incoming-worker's flow-executor): voice
 * triggers fire from live-call events (voice.session.*, voice.frame.updated)
 * that the AI service already subscribes to. Reusing the ChatbotFlow row
 * shape means admins manage chat + voice automations side-by-side, but the
 * runtime is intentionally separate from the chat executor — chat flows
 * are turn-based; voice flows are event-stream-driven.
 *
 * Trigger types supported (in the first node's `data.triggerType`):
 *   - call.incoming           (voice.session.started where direction = inbound)
 *   - call.answered           (state transition → ACTIVE)
 *   - call.missed             (state transition → MISSED)
 *   - call.hangup_customer    (state → ENDED where endReason contains "customer")
 *   - call.hangup_agent       (state → ENDED where endReason contains "agent" / "hangup_by_")
 *   - call.intent_detected    (frame.intent.primary matches trigger config)
 *   - call.keyword_spoken     (recent utterance contains a configured keyword)
 *
 * Action nodes supported:
 *   - voice_add_participant   (dial a 3rd party into the live conference)
 *
 * The runner is best-effort: a failing flow logs and continues; one bad
 * action node does not prevent the next from running.
 */
import {
  prisma,
  subscribeToEvents,
  getOutboundAdapter,
  decryptCredentials,
  type ChannelCredentials,
  type ServiceEvent,
} from "@chatcenter/shared";

type FlowTriggerKind =
  | "call.incoming"
  | "call.answered"
  | "call.missed"
  | "call.hangup_customer"
  | "call.hangup_agent"
  | "call.intent_detected"
  | "call.keyword_spoken";

interface FlowNode {
  id: string;
  type: string;
  data?: Record<string, unknown>;
}
interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

interface FlowRow {
  id: string;
  tenantId: string;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  // Which node is the trigger we should walk from. For legacy ChatbotFlow
  // rows this is always `nodes[0].id` (those flows have exactly one entry
  // point). For Main Playbook (FlowCanvas) rows we emit one synthetic
  // FlowRow per voice_trigger node — the playbook hosts many triggers in
  // one canvas, so we MUST point at the matching one or executeFlow walks
  // from the wrong root and finds no edges.
  triggerNodeId: string;
  // Source table — used to decide whether bumping runCount is meaningful.
  source: "chatbot_flow" | "flow_canvas";
}

interface VoiceContext {
  tenantId: string;
  conversationId: string;
  callSid: string | null;
  sessionId: string | null;
  customerNumber: string | null;
}

let started = false;
const VOICE_COPILOT_URL = () => process.env.VOICE_COPILOT_URL || "http://voice-copilot:4007";
const INTERNAL_KEY = () => process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";

// In-process idempotency for flow execution.
//
// `voice.session.state` and friends fire repeatedly during a single call
// (each participant join, retry, conference status update). Without dedupe,
// a `call.answered`-driven template flow would attempt a send 2–3 times in
// quick succession. That's bad: Meta charges per template AND the customer
// sees duplicates. Key by (conversationId, flowId, triggerKind) so we fire
// each distinct trigger at most once per call.
//
// Why conversationId and not sessionId: voice.frame.updated (powers
// intent/keyword triggers) publishes ONLY {tenantId, conversationId, frame}
// — no session field. Using sessionId would fall back to a constant string
// ("no-sid:flowId:call.intent_detected") that's IDENTICAL across every call
// in the tenant, so the first refund-triggered template would dedupe every
// subsequent call's refund trigger for the TTL window. conversationId is
// always non-empty (extractContext returns null otherwise) and is 1:1 with
// the voice call, so it's the correct namespace.
//
// Map vs Redis: in-process is enough today — events for one conversation
// are serialized through this AI process, and a restart mid-call already
// loses the running LLM state. The eviction loop caps memory in long uptimes.
const firedFlows = new Map<string, number>();
const FIRED_TTL_MS = 6 * 60 * 60 * 1000; // 6h — comfortably longer than any call.
setInterval(() => {
  const cutoff = Date.now() - FIRED_TTL_MS;
  for (const [k, ts] of firedFlows) {
    if (ts < cutoff) firedFlows.delete(k);
  }
}, 30 * 60 * 1000).unref();

function firedKey(conversationId: string, flowId: string, kind: string): string {
  return `${conversationId}:${flowId}:${kind}`;
}

export function startVoiceFlowRunner(): void {
  if (started) return;
  started = true;
  try {
    subscribeToEvents((evt: ServiceEvent) => {
      // Fire-and-forget — never block the bus thread on a flow eval.
      handleEvent(evt).catch((err) => {
        console.warn("[voice-flow] handler crashed:", (err as { message?: string })?.message ?? err);
      });
    });
    console.log("[voice-flow] runner started");
  } catch (err) {
    console.warn("[voice-flow] subscribe failed:", (err as { message?: string })?.message ?? err);
  }
}

async function handleEvent(evt: ServiceEvent): Promise<void> {
  const tenantId = evt.tenantId;
  if (!tenantId) return;

  // Map the bus event to a list of trigger kinds we should try.
  const kinds = mapEventToTriggers(evt);
  if (kinds.length === 0) return;

  const ctx = extractContext(evt);
  if (!ctx) return;

  const flows = await loadActiveVoiceFlows(tenantId);
  if (flows.length === 0) return;

  for (const flow of flows) {
    const triggerNode = flow.nodes.find((n) => n.id === flow.triggerNodeId);
    if (!triggerNode) continue;
    const triggerType = readTriggerKind(triggerNode);
    if (!triggerType || !kinds.includes(triggerType)) continue;

    // Optional per-trigger predicates (intent name, keyword text).
    if (!matchesTriggerPayload(triggerNode, triggerType, evt)) continue;

    // Idempotency: each (session, flow, trigger) marks itself fired ONLY
    // after a successful action. Voice state events are noisy — a single
    // answered call fires `voice.session.state` 2–3 times as participants
    // join and Twilio updates status. We DON'T mark fired until executeFlow
    // reports at least one successful action so a stale early event
    // (`skip no_recipient` because customerNumber isn't on the session yet)
    // doesn't poison the retry path.
    const dedupeKey = firedKey(ctx.conversationId, flow.id, triggerType);
    if (firedFlows.has(dedupeKey)) {
      console.log(`[voice-flow] skip already_fired flow=${flow.id} trigger=${triggerType} conv=${ctx.conversationId}`);
      continue;
    }

    console.log(`[voice-flow] match flow=${flow.id} src=${flow.source} trigger=${triggerType} conv=${ctx.conversationId}`);
    let success = false;
    try {
      success = await executeFlow(flow, ctx);
    } catch (err) {
      console.warn(
        `[voice-flow] flow=${flow.id} (${flow.name}) action chain failed:`,
        (err as { message?: string })?.message ?? err,
      );
    }
    if (success) firedFlows.set(dedupeKey, Date.now());
    // Bump runCount for observability (best-effort). Only meaningful for
    // legacy ChatbotFlow rows — FlowCanvas has no equivalent counter.
    if (flow.source === "chatbot_flow") {
      prisma.chatbotFlow.update({
        where: { id: flow.id },
        data: { runCount: { increment: 1 } },
      }).catch(() => { /* ignore */ });
    }
  }
}

function mapEventToTriggers(evt: ServiceEvent): FlowTriggerKind[] {
  const d = (evt.data ?? {}) as Record<string, unknown>;
  switch (evt.event) {
    case "voice.session.started": {
      const sess = (d.session ?? null) as Record<string, unknown> | null;
      const dir = String(d.direction ?? sess?.direction ?? "");
      return dir === "inbound" ? ["call.incoming"] : [];
    }
    case "voice.incoming.ringing":
      // Same semantic surface as session.started for inbound — flows may
      // listen to either. We DON'T fire for the fallback re-broadcast.
      return d.routing && (d.routing as { target?: string }).target === "tenant" ? [] : ["call.incoming"];
    case "voice.session.state":
    case "voice.session.state_changed": {
      const to = String(d.state ?? d.to ?? "").toUpperCase();
      if (to === "ACTIVE") return ["call.answered"];
      if (to === "MISSED") return ["call.missed"];
      if (to === "ENDED") {
        const reason = String(d.reason ?? "").toLowerCase();
        if (reason.includes("agent") || reason.startsWith("hangup_by_")) {
          return ["call.hangup_agent"];
        }
        return ["call.hangup_customer"];
      }
      return [];
    }
    case "voice.frame.updated":
      // intent + keyword triggers both surface here — `matchesTriggerPayload`
      // narrows further per flow.
      return ["call.intent_detected", "call.keyword_spoken"];
    default:
      return [];
  }
}

function extractContext(evt: ServiceEvent): VoiceContext | null {
  const d = (evt.data ?? {}) as Record<string, unknown>;
  const session = (d.session ?? {}) as Record<string, unknown>;
  const tenantId = evt.tenantId;
  const conversationId = String(d.conversationId ?? session.conversationId ?? "");
  if (!tenantId || !conversationId) return null;
  return {
    tenantId,
    conversationId,
    callSid: (d.callSid as string) ?? (session.callSid as string) ?? null,
    sessionId: (d.sessionId as string) ?? (session.id as string) ?? null,
    customerNumber:
      (d.customerNumber as string) ?? (session.customerNumber as string) ?? null,
  };
}

async function loadActiveVoiceFlows(tenantId: string): Promise<FlowRow[]> {
  // Two source tables host voice triggers:
  //   1. ChatbotFlow (legacy sub-flows) — keyed by channel="VOICE", one
  //      trigger per row.
  //   2. FlowCanvas (Main Playbook) — single row per tenant containing all
  //      automations. Voice triggers there look like `voice_trigger:call.*`
  //      and there can be MANY in the same canvas. We emit one synthetic
  //      FlowRow per voice_trigger node found so each can be matched +
  //      walked independently.
  const [chatbotRows, canvas] = await Promise.all([
    prisma.chatbotFlow.findMany({
      where: { tenantId, isActive: true, channel: "VOICE" },
      select: { id: true, tenantId: true, name: true, nodes: true, edges: true },
    }),
    prisma.flowCanvas.findUnique({
      where: { tenantId },
      select: { tenantId: true, nodes: true, edges: true },
    }),
  ]);

  const out: FlowRow[] = [];
  for (const r of chatbotRows) {
    const nodes = Array.isArray(r.nodes) ? (r.nodes as unknown as FlowNode[]) : [];
    const edges = Array.isArray(r.edges) ? (r.edges as unknown as FlowEdge[]) : [];
    if (!nodes[0]) continue;
    out.push({
      id: r.id,
      tenantId: r.tenantId,
      name: r.name,
      nodes,
      edges,
      triggerNodeId: nodes[0].id,
      source: "chatbot_flow",
    });
  }
  if (canvas) {
    const nodes = Array.isArray(canvas.nodes) ? (canvas.nodes as unknown as FlowNode[]) : [];
    const edges = Array.isArray(canvas.edges) ? (canvas.edges as unknown as FlowEdge[]) : [];
    for (const n of nodes) {
      if (!n.type || !n.type.startsWith("voice_trigger:")) continue;
      out.push({
        id: `flowCanvas:${tenantId}:${n.id}`,
        tenantId: canvas.tenantId,
        name: `playbook:${n.type}`,
        nodes,
        edges,
        triggerNodeId: n.id,
        source: "flow_canvas",
      });
    }
  }
  return out;
}

function readTriggerKind(node: FlowNode): FlowTriggerKind | null {
  // Two conventions accepted: explicit `data.triggerType`, or `node.type` of
  // the form `voice_trigger:<kind>`. Picking either keeps the canvas editor
  // free to ship without backend coordination.
  const explicit = node.data?.triggerType as string | undefined;
  if (explicit && /^call\./.test(explicit)) return explicit as FlowTriggerKind;
  if (node.type?.startsWith("voice_trigger:")) {
    return node.type.slice("voice_trigger:".length) as FlowTriggerKind;
  }
  return null;
}

function matchesTriggerPayload(
  triggerNode: FlowNode,
  kind: FlowTriggerKind,
  evt: ServiceEvent,
): boolean {
  const d = (evt.data ?? {}) as Record<string, unknown>;
  const data = (triggerNode.data ?? {}) as Record<string, unknown>;

  if (kind === "call.intent_detected") {
    const wanted = String(data.intent ?? data.intentName ?? "").toLowerCase().trim();
    if (!wanted) {
      console.warn(`[voice-flow] intent_detected: trigger has no intent configured (nodeId=${triggerNode.id})`);
      return false;
    }
    const frame = (d.frame ?? {}) as Record<string, unknown>;
    const intent = (frame.intent ?? {}) as Record<string, unknown>;
    const primary = String(intent.primary ?? "").toLowerCase().trim();
    const minConf = Number(data.minConfidence ?? 0);
    const conf = Number(intent.confidence ?? 0);

    // Token-based fuzzy match. Authors don't know which exact label the
    // LLM will emit (refund vs request_refund vs refund_request), so we
    // accept when every author-supplied token appears as a token in the
    // model's intent. Split on `_`, `-`, `/`, and whitespace; tokens are
    // case-insensitive (already lowercased above).
    //
    // Examples:
    //   wanted="refund"          primary="request_refund"   → match
    //   wanted="process refund"  primary="request_refund"   → no match (no "process")
    //   wanted="refund"          primary="refundpreparation" → no match (no token boundary)
    //   wanted="request_refund"  primary="request_refund"   → match (exact path)
    const tokenize = (s: string): string[] => s.split(/[\s_\-/]+/).filter(Boolean);
    const wantedTokens = tokenize(wanted);
    const primaryTokens = tokenize(primary);
    const tokensMatch = primary === wanted
      || (wantedTokens.length > 0 && wantedTokens.every((t) => primaryTokens.includes(t)));

    if (!tokensMatch) {
      console.log(`[voice-flow] intent_detected: name mismatch — trigger="${wanted}" frame="${primary}" (token-check failed) (no match)`);
      return false;
    }
    if (conf < minConf) {
      console.log(`[voice-flow] intent_detected: confidence too low — trigger>=${minConf} frame=${conf} (no match)`);
      return false;
    }
    console.log(`[voice-flow] intent_detected: ACCEPTED trigger="${wanted}" frame="${primary}" conf=${conf} (>=${minConf})`);
    return true;
  }
  if (kind === "call.keyword_spoken") {
    const raw = data.keyword ?? data.keywords;
    const keywords = Array.isArray(raw)
      ? (raw as unknown[]).map((s) => String(s).toLowerCase()).filter(Boolean)
      : typeof raw === "string"
      ? [raw.toLowerCase()]
      : [];
    if (keywords.length === 0) return false;
    const frame = (d.frame ?? {}) as Record<string, unknown>;
    const summary = String((frame.summary as Record<string, unknown> | undefined)?.text ?? "").toLowerCase();
    // Cheap match: any configured keyword present in the rolling summary
    // text. Avoids a separate transcript fetch and keeps the trigger
    // cadence-aligned with frame updates.
    return keywords.some((k) => summary.includes(k));
  }
  // Other triggers don't have payload predicates.
  return true;
}

async function executeFlow(flow: FlowRow, ctx: VoiceContext): Promise<boolean> {
  // BFS from the matched trigger node — the canvas's other triggers (and
  // their subtrees) are ignored here. No branching/conditions in the MVP:
  // a fan-out runs every successor unconditionally.
  //
  // Returns true if AT LEAST ONE action ran to completion (sent/added) so
  // the caller can dedupe re-fires. Returns false when every action was
  // skipped (e.g. `no_recipient`) so the next noisy event can retry.
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const root = byId.get(flow.triggerNodeId);
  if (!root) {
    console.warn(`[voice-flow] missing trigger node=${flow.triggerNodeId} in flow=${flow.id}`);
    return false;
  }
  const queue: string[] = [root.id];
  const seen = new Set<string>();
  let anySuccess = false;
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (id !== root.id) {
      try {
        const ok = await executeActionNode(node, ctx);
        if (ok) anySuccess = true;
      } catch (err) {
        console.warn(
          `[voice-flow] action node=${node.id} (${node.type}) failed:`,
          (err as { message?: string })?.message ?? err,
        );
      }
    }
    for (const e of flow.edges) {
      if (e.source === id) queue.push(e.target);
    }
  }
  return anySuccess;
}

async function executeActionNode(node: FlowNode, ctx: VoiceContext): Promise<boolean> {
  // Returns true when the action ran to completion. Used by executeFlow to
  // decide whether to mark this flow's (session, trigger) as fired — so a
  // pure skip (e.g. `no_recipient`) doesn't burn the dedupe slot.
  const data = (node.data ?? {}) as Record<string, unknown>;
  switch (node.type) {
    case "voice_add_participant": {
      const to = String(data.to ?? "").trim();
      if (!to || !ctx.sessionId) return false;
      await internalFetch(
        `${VOICE_COPILOT_URL()}/api/voice-copilot/sessions/${encodeURIComponent(ctx.sessionId)}/add-participant`,
        { to, label: (data.label as string) || "automation" },
      );
      return true;
    }
    case "send_message_template": {
      // Voice flows are channel-mismatched against WhatsApp by definition
      // (the call's conversation is on VOICE), so we resolve a WhatsApp
      // channelAccount on the fly: prefer the template's bound account,
      // fall back to the tenant's first active WhatsApp account. Recipient
      // is the caller's phone number captured on the voice session.
      return await sendTemplateFromVoice(data, ctx);
    }
    default:
      // Unknown action types are silently ignored — admins can add new
      // node types in the canvas without breaking running flows.
      return false;
  }
}

// ─── send_message_template helpers (voice flows) ─────────────────
//
// Mirrors `flow-executor.service.ts` (incoming-worker) but tailored for
// the voice runner: no `ctx.vars` to interpolate against (only the small
// set of voice-derived placeholders below), and the channel account is
// resolved at runtime rather than carried in `ctx.sendCtx`.

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

function interpolateVoiceVars(text: string, ctx: VoiceContext): string {
  // Tiny variable surface — enough to support common follow-up patterns
  // ("Hi {{customer_phone}}, you missed our call at {{call_started_at}}…").
  // Other `{{...}}` mentions resolve to empty so authors get a visible
  // hole rather than a hard failure.
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key) => {
    switch (key) {
      case "customer_phone":
      case "customer_number":
        return ctx.customerNumber || "";
      case "call_sid":
        return ctx.callSid || "";
      case "session_id":
        return ctx.sessionId || "";
      case "conversation_id":
        return ctx.conversationId || "";
      default:
        return "";
    }
  });
}

// Mirrors the alias surface used by outbound/scheduled and incoming-worker.
// Resolves a `crm:<field>` token against a Contact row. Empty string means
// "fall back to the template's declared sample".
function resolveCrmFieldVoice(
  field: string,
  contact: { displayName?: string | null; email?: string | null; phone?: string | null; source?: string | null; metadata?: unknown } | null,
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

function buildTemplateComponentsForVoice(
  tmpl: { body: string | null; headerType: string | null; headerContent: string | null; variables?: unknown },
  authorValues: Record<string, string> | undefined,
  headerMediaOverride: string | undefined,
  ctx: VoiceContext,
  contact: { displayName?: string | null; email?: string | null; phone?: string | null; source?: string | null; metadata?: unknown } | null,
): any[] {
  const components: any[] = [];
  const declared = Array.isArray(tmpl.variables) ? (tmpl.variables as Array<{ key?: string; sample?: string }>) : [];
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
        const v = resolveCrmFieldVoice(s.slice(4), contact);
        if (v.length > 0) return v;
      } else {
        const resolved = interpolateVoiceVars(s, ctx);
        if (resolved.length > 0) return resolved;
      }
    }
    return sampleByKey.get(key) || "-";
  };
  const buildComponent = (scope: "header" | "body", text: string) => {
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
  };
  if (tmpl.headerType === "TEXT" && tmpl.headerContent) {
    const h = buildComponent("header", tmpl.headerContent);
    if (h) components.push(h);
  } else if (tmpl.headerType === "IMAGE" || tmpl.headerType === "VIDEO" || tmpl.headerType === "DOCUMENT") {
    let overrideUrl = "";
    if (headerMediaOverride) {
      const s = String(headerMediaOverride);
      if (s.startsWith("crm:")) {
        overrideUrl = resolveCrmFieldVoice(s.slice(4), contact);
      } else {
        overrideUrl = interpolateVoiceVars(s, ctx);
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

async function sendTemplateFromVoice(data: Record<string, unknown>, ctx: VoiceContext): Promise<boolean> {
  // Returns true ONLY when Meta accepts the send. Every skip/fail returns
  // false so the dedupe slot stays open — letting the next noisy event
  // (which may carry the missing customerNumber) get a clean retry.
  const tag = "[voice-flow.template]";
  const templateId = String(data.templateId || "").trim();
  if (!templateId) { console.warn(`${tag} skip no_template conv=${ctx.conversationId}`); return false; }

  // `voice.frame.updated` (the event that powers intent_detected /
  // keyword_spoken triggers) only carries { tenantId, conversationId, frame }
  // — no customerNumber. Resolve it from the durable voice session row
  // (preferred — has the E.164 customer number) or fall back to the
  // conversation's customerExternalId (for WhatsApp this IS the phone).
  // Without this fallback, every intent/keyword-driven template send would
  // exit at `skip no_recipient`.
  let recipient = ctx.customerNumber;
  if (!recipient && ctx.sessionId) {
    const sess = await prisma.voiceCallSession.findUnique({
      where: { id: ctx.sessionId },
      select: { customerNumber: true },
    }).catch(() => null);
    if (sess?.customerNumber) recipient = sess.customerNumber;
  }
  if (!recipient) {
    const conv = await prisma.conversation.findUnique({
      where: { id: ctx.conversationId },
      select: { customerExternalId: true },
    }).catch(() => null);
    if (conv?.customerExternalId) recipient = conv.customerExternalId;
  }
  if (!recipient) {
    console.warn(`${tag} skip no_recipient conv=${ctx.conversationId} (resolved from session+conv lookup; both missing)`);
    return false;
  }

  const tmpl = await prisma.messageTemplate.findFirst({
    where: { id: templateId, tenantId: ctx.tenantId },
  });
  if (!tmpl) { console.warn(`${tag} skip template_not_found id=${templateId} tenant=${ctx.tenantId}`); return false; }
  if (tmpl.status !== "APPROVED") {
    console.warn(`${tag} skip template_not_approved id=${templateId} status=${tmpl.status}`);
    return false;
  }

  // Resolve WhatsApp ChannelAccount: prefer the template's binding, else
  // fall back to the tenant's first active WhatsApp account.
  let channelAccount = tmpl.channelAccountId
    ? await prisma.channelAccount.findFirst({
        where: { id: tmpl.channelAccountId, tenantId: ctx.tenantId, channel: "WHATSAPP", isActive: true },
      })
    : null;
  if (!channelAccount) {
    channelAccount = await prisma.channelAccount.findFirst({
      where: { tenantId: ctx.tenantId, channel: "WHATSAPP", isActive: true },
      orderBy: { createdAt: "asc" },
    });
  }
  if (!channelAccount) {
    console.warn(`${tag} skip no_whatsapp_account tenant=${ctx.tenantId}`);
    return false;
  }

  const adapter = getOutboundAdapter("WHATSAPP" as any);
  if (!adapter || !adapter.sendTemplateMessage) {
    console.warn(`${tag} skip adapter_unsupported`);
    return false;
  }

  const rawCreds = (channelAccount as any).credentials;
  const creds = (typeof rawCreds === "string" ? decryptCredentials(rawCreds) : (rawCreds || {})) as ChannelCredentials;

  // Look up the Contact for this caller's number so `crm:<field>` tokens
  // can resolve. Use the recipient we just resolved (may have come from
  // the session/conversation fallback above), then fall back to the
  // voice conversation's customerExternalId.
  let contact: { displayName?: string | null; email?: string | null; phone?: string | null; source?: string | null; metadata?: unknown } | null = null;
  if (recipient) {
    contact = await prisma.contact.findFirst({
      where: { tenantId: ctx.tenantId, phone: recipient },
      select: { displayName: true, email: true, phone: true, source: true, metadata: true },
    });
  }
  if (!contact) {
    const conv = await prisma.conversation.findUnique({
      where: { id: ctx.conversationId },
      select: { customerExternalId: true, customerName: true },
    });
    if (conv?.customerExternalId) {
      contact = await prisma.contact.findFirst({
        where: { tenantId: ctx.tenantId, externalId: conv.customerExternalId },
        select: { displayName: true, email: true, phone: true, source: true, metadata: true },
      });
    }
    if (!contact && conv) {
      contact = { displayName: conv.customerName };
    }
  }

  // Propagate the resolved recipient into the context so `{{customer_phone}}`
  // mentions in the template body resolve even when the triggering event
  // didn't carry customerNumber.
  const sendCtx: VoiceContext = { ...ctx, customerNumber: recipient };
  const components = buildTemplateComponentsForVoice(
    { body: tmpl.body, headerType: tmpl.headerType, headerContent: tmpl.headerContent, variables: tmpl.variables },
    (data.variables as Record<string, string>) || {},
    data.headerMediaUrl ? String(data.headerMediaUrl) : undefined,
    sendCtx,
    contact,
  );

  console.log(`${tag} attempt name=${tmpl.name} lang=${tmpl.language} to=${recipient} via=${channelAccount.id}`);
  let extId: string | null = null;
  try {
    extId = await adapter.sendTemplateMessage(
      creds,
      (channelAccount as any).externalId,
      recipient,
      tmpl.name,
      tmpl.language || "en",
      components,
    );
  } catch (err: unknown) {
    const msg = String((err as { message?: string })?.message ?? err).slice(0, 200);
    console.error(`${tag} fail name=${tmpl.name} err=${msg}`);
    await persistVoiceTemplateMessage(ctx, tmpl, components, null, msg);
    // DO NOT return true. Earlier version did, to suppress retries on the
    // next noisy event — but that hid Meta rejects from the operator and
    // matched the symptom "skip already_fired follows match but customer
    // never received the message". Letting the next event retry gives the
    // author one more chance to spot the failure in the inspector
    // (FAILED message row carries `metadata.error`) and still bounds the
    // damage to one retry per state event (typically 2–3 per call).
    return false;
  }

  console.log(`${tag} sent name=${tmpl.name} extId=${extId} conv=${ctx.conversationId}`);
  await persistVoiceTemplateMessage(ctx, tmpl, components, extId, null);
  return true;
}

async function persistVoiceTemplateMessage(
  ctx: VoiceContext,
  tmpl: { id: string; name: string; language: string; body: string | null },
  components: unknown[],
  externalMessageId: string | null,
  errorMessage: string | null,
): Promise<void> {
  try {
    await prisma.message.create({
      data: {
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        channel: "WHATSAPP" as any,
        direction: "OUTBOUND",
        body: tmpl.body || tmpl.name,
        messageType: "template",
        senderName: "Voice Flow",
        externalMessageId,
        status: externalMessageId ? "SENT" : "FAILED",
        metadata: {
          templateId: tmpl.id,
          templateName: tmpl.name,
          language: tmpl.language,
          components,
          ...(errorMessage ? { error: errorMessage } : {}),
        } as any,
      } as any,
    });
  } catch (err) {
    console.warn(`[voice-flow.template] persist failed: ${(err as { message?: string })?.message ?? err}`);
  }
}

async function internalFetch(url: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Key": INTERNAL_KEY() },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[voice-flow] action POST ${url} → ${res.status} ${t.slice(0, 120)}`);
    }
  } catch (err) {
    console.warn(
      `[voice-flow] action POST ${url} threw:`,
      (err as { message?: string })?.message ?? err,
    );
  }
}
