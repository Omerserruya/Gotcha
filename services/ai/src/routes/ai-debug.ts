/**
 * AI prompt debug route.
 *
 * Returns the FULL final payload that would be sent to the LLM for a given
 * AI Employee in either /assist (copilot) or /agent (autonomous) mode —
 * system prompt, tool definitions, conversation transcript, and KB context.
 * Use this when "the AI sucks" to see exactly what the model is reading.
 *
 * Auth (either):
 *   1. `X-Debug-Key: <env AI_DEBUG_KEY>` — long-lived backend ops key.
 *   2. `Authorization: Bearer <jit>` — single-use, short-TTL token minted
 *      via `POST /api/ai-debug/jit` (SYSTEM_ADMIN only).
 *
 * The JIT store is in-process memory. The ai service runs as a single
 * process, so this is fine for debug purposes; do not repurpose this for
 * production auth.
 */

import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { prisma, authenticate, requireSystemAdmin, buildAgentToolsForAIAgent } from "@chatcenter/shared";
import { buildConfigFromAIAgent } from "../services/ai-assist.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "../services/knowledge.service";
import { buildAgentPrompt, renderOutputContractInstruction } from "../services/prompt-builder.service";
import { computeBehaviorState, shouldRetrieveKB } from "../services/behavior-engine.service";

const router = Router();

// ─── JIT store (in-memory, single-use) ──────────────────────

interface JitEntry {
  tenantId: string;
  agentId?: string;
  expiresAt: number;
  used: boolean;
}
const jitStore = new Map<string, JitEntry>();

function pruneExpiredJits() {
  const now = Date.now();
  for (const [token, entry] of jitStore.entries()) {
    if (entry.used || entry.expiresAt < now) jitStore.delete(token);
  }
}

// ─── Auth middleware (env key OR JIT) ───────────────────────

interface DebugAuthCtx {
  scope: { tenantId?: string; agentId?: string };
  via: "env_key" | "jit";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      debugAuth?: DebugAuthCtx;
    }
  }
}

function debugAuth(req: Request, res: Response, next: NextFunction): void {
  pruneExpiredJits();

  const envKey = process.env.AI_DEBUG_KEY;
  const headerKey = req.headers["x-debug-key"];
  if (envKey && typeof headerKey === "string" && headerKey === envKey) {
    req.debugAuth = { scope: {}, via: "env_key" };
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    const entry = jitStore.get(token);
    if (entry && !entry.used && entry.expiresAt >= Date.now()) {
      entry.used = true;
      req.debugAuth = {
        scope: { tenantId: entry.tenantId, agentId: entry.agentId },
        via: "jit",
      };
      next();
      return;
    }
  }

  res.status(401).json({ error: "Debug auth required (X-Debug-Key header or single-use Bearer JIT)" });
}

// ─── JIT minting (SYSTEM_ADMIN) ─────────────────────────────
// POST /api/ai-debug/jit  body: { tenantId, agentId?, ttlSeconds? }

router.post("/jit", authenticate, requireSystemAdmin(), (req: Request, res: Response) => {
  const { tenantId, agentId, ttlSeconds } = req.body || {};
  if (!tenantId || typeof tenantId !== "string") {
    res.status(400).json({ error: "tenantId is required" });
    return;
  }
  const ttl = Math.min(Math.max(Number(ttlSeconds) || 300, 30), 3600); // 30s..1h
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + ttl * 1000;
  jitStore.set(token, {
    tenantId,
    agentId: agentId && typeof agentId === "string" ? agentId : undefined,
    expiresAt,
    used: false,
  });
  res.json({
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    ttlSeconds: ttl,
    scope: { tenantId, agentId: agentId || null },
  });
});

// ─── Mode renderers ─────────────────────────────────────────
// Both modes call `buildAgentPrompt` from prompt-builder.service — the
// same builder production uses on `/api/ai-bot/reply` and the copilot
// suggestions / chat paths.

async function renderAgentMode(opts: {
  tenantId: string;
  agentId: string;
  conversationId?: string;
  message?: string;
}): Promise<any> {
  const config = await prisma.aIAgent.findFirst({ where: { id: opts.agentId, tenantId: opts.tenantId } });
  if (!config) throw Object.assign(new Error("AI Agent not found"), { status: 404 });

  // RAG probe + history
  let kbProbe = (opts.message || "").trim();
  let history: Array<{ direction: "INBOUND" | "OUTBOUND"; body: string; messageType: string | null }> = [];
  let customerBlock: string | undefined;
  if (opts.conversationId) {
    const conv = await prisma.conversation.findFirst({
      where: { id: opts.conversationId, tenantId: opts.tenantId },
    });
    if (!conv) throw Object.assign(new Error("Conversation not found"), { status: 404 });

    const msgs = await prisma.message.findMany({
      where: { conversationId: opts.conversationId, tenantId: opts.tenantId },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: { direction: true, body: true, messageType: true },
    });
    history = msgs as any;
    if (!kbProbe) {
      const lastIn = [...msgs].reverse().find((m) => m.direction === "INBOUND" && m.body?.trim());
      kbProbe = (lastIn?.body || "").trim();
    }

    // Render the same Customer block production uses.
    const lines: string[] = ["## Customer & Conversation Info"];
    if ((conv as any).customerName) lines.push(`- Customer Name: ${(conv as any).customerName}`);
    if (conv.customerExternalId) lines.push(`- External ID / Phone: ${conv.customerExternalId}`);
    if (conv.channel) lines.push(`- Channel: ${conv.channel}`);
    if ((conv as any).status) lines.push(`- Conversation Status: ${(conv as any).status}`);
    if (conv.createdAt) lines.push(`- Conversation Started: ${conv.createdAt.toISOString()}`);
    if ((conv as any).lastMessageAt) lines.push(`- Last Message: ${(conv as any).lastMessageAt.toISOString()}`);
    customerBlock = lines.length > 1 ? lines.join("\n") : undefined;
  }

  let kbAppended: any[] = [];
  let kbBlock: string | undefined;
  if (kbProbe) {
    try {
      const chunks = await retrieveRelevantChunks(opts.tenantId, kbProbe, 5);
      kbBlock = buildKnowledgeContext(chunks) || undefined;
      if (kbBlock) kbAppended = chunks as any[];
    } catch (err: any) {
      kbAppended = [{ error: err.message }];
    }
  }

  // Compute BehaviorState the same way production does.
  const behaviorState = computeBehaviorState({
    mode: "agent",
    identity: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 },
    request: {
      lastMessage: kbProbe,
      messageCount: history.length || 1,
      recentDirections: history.slice(-5).map((m) => m.direction),
    },
  });

  // Use the unified prompt builder — same path production uses, with full slots.
  const systemPrompt = buildAgentPrompt({
    behaviorState,
    agent: {
      name: config.name,
      role: config.role,
      description: config.description,
      tone: config.tone,
      style: config.style,
      identity: config.identity,
      goals: config.goals,
      toneConfig: config.toneConfig,
      behavioral: config.behavioral,
      persona: config.persona,
      conversationFlow: config.conversationFlow,
      customGuardrails: config.customGuardrails,
      escalationRules: config.escalationRules,
      behavioralAnchors: (config as any).behavioralAnchors,
    },
    context: { customerBlock },
    knowledge: { block: kbBlock },
  });

  const messages: any[] = [{ role: "system", content: systemPrompt }];
  for (const m of history) {
    if (!m.body?.trim()) continue;
    if (m.messageType === "system") continue;
    messages.push({ role: m.direction === "INBOUND" ? "user" : "assistant", content: m.body });
  }
  if (opts.message && (!opts.conversationId || history.length === 0)) {
    messages.push({ role: "user", content: opts.message });
  }

  const tools = await buildAgentToolsForAIAgent(opts.tenantId, config.id, {
    identityLinking: true,
    escalation: true,
  });

  return {
    mode: "agent",
    agent: {
      id: config.id,
      name: config.name,
      role: config.role,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      status: config.status,
    },
    context: {
      conversationId: opts.conversationId || null,
      historyCount: history.length,
      kbProbe: kbProbe || null,
      kbChunks: kbAppended.length,
    },
    systemPrompt,
    tools,
    messages,
  };
}

async function renderAssistMode(opts: {
  tenantId: string;
  agentId: string;
  conversationId?: string;
  message?: string;
}): Promise<any> {
  const agent = await prisma.aIAgent.findFirst({ where: { id: opts.agentId, tenantId: opts.tenantId } });
  if (!agent) throw Object.assign(new Error("AI Agent not found"), { status: 404 });

  // Build the assist-mode CopilotConfigData using the same code path the
  // live route uses (buildConfigFromAIAgent → buildAgentPrompt).
  const config = buildConfigFromAIAgent(agent as any, "copilot");

  let kbAppended: any[] = [];

  let convoMeta: any = null;
  let history: Array<{ direction: "INBOUND" | "OUTBOUND"; body: string | null; senderName: string | null }> = [];
  let customerName: string | null = null;
  let customerBlock: string | undefined;
  let metaForRender: any = null;
  if (opts.conversationId) {
    const conv = await prisma.conversation.findFirst({
      where: { id: opts.conversationId, tenantId: opts.tenantId },
    });
    if (!conv) throw Object.assign(new Error("Conversation not found"), { status: 404 });
    customerName = conv.customerName;
    convoMeta = { id: conv.id, channel: conv.channel, status: conv.status, departmentId: conv.departmentId };

    // Mirror the live /suggestions handler: resolve department + assigned
    // agent names so the "Customer & Conversation Info" block renders the
    // same way prod sees it.
    let departmentName: string | undefined;
    let assignedAgentName: string | undefined;
    try {
      if ((conv as any).departmentId) {
        const dept = await prisma.department.findUnique({
          where: { id: (conv as any).departmentId },
          select: { name: true },
        });
        departmentName = dept?.name || undefined;
      }
      if ((conv as any).assignedAgentId) {
        const u = await prisma.user.findUnique({
          where: { id: (conv as any).assignedAgentId },
          select: { name: true, email: true },
        });
        if (u) assignedAgentName = u.name?.trim() || u.email || undefined;
      }
    } catch { /* best-effort */ }

    metaForRender = {
      channel: conv.channel,
      status: (conv as any).status,
      departmentName,
      assignedAgentName,
      isHandedOver: (conv as any).isHandedOver,
      createdAt: conv.createdAt?.toISOString(),
      lastMessageAt: (conv as any).lastMessageAt?.toISOString(),
      customerExternalId: conv.customerExternalId,
      aiAgentId: (conv as any).assignedAiAgentId || null,
    };
    const lines: string[] = ["## Customer & Conversation Info"];
    lines.push(`- Customer: ${customerName || "Unknown"}`);
    if (metaForRender.customerExternalId) lines.push(`- External ID / Phone: ${metaForRender.customerExternalId}`);
    if (metaForRender.channel) lines.push(`- Channel: ${metaForRender.channel}`);
    if (metaForRender.status) lines.push(`- Conversation Status: ${metaForRender.status}`);
    if (metaForRender.departmentName) lines.push(`- Department: ${metaForRender.departmentName}`);
    if (metaForRender.assignedAgentName) lines.push(`- Assigned Agent: ${metaForRender.assignedAgentName}`);
    if (metaForRender.createdAt) lines.push(`- Conversation Started: ${metaForRender.createdAt}`);
    if (metaForRender.lastMessageAt) lines.push(`- Last Message: ${metaForRender.lastMessageAt}`);
    if (metaForRender.isHandedOver !== undefined) lines.push(`- Handed Over to Human: ${metaForRender.isHandedOver ? "Yes" : "No"}`);
    customerBlock = lines.join("\n");

    const msgs = await prisma.message.findMany({
      where: { conversationId: opts.conversationId, tenantId: opts.tenantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { direction: true, body: true, senderName: true, createdAt: true },
    });
    history = msgs.reverse() as any;
  }

  // Compute BehaviorState first — KB gate is then BEL-controlled.
  const lastInbound = [...history].reverse().find((m) => m.direction === "INBOUND" && m.body?.trim());
  const kbProbe = (opts.message || lastInbound?.body || "").trim();

  const behaviorState = computeBehaviorState({
    mode: "copilot",
    identity: {
      hasContact: !!metaForRender?.customerExternalId,
      contactLifecycle: null,
      priorConversationCount: 0,
    },
    request: {
      lastMessage: kbProbe,
      messageCount: history.length || 1,
      recentDirections: history.slice(-5).map((m) => m.direction),
    },
    copilotPreferredMode: config.copilotMode,
  });

  let kbBlock: string | undefined;
  if (kbProbe && shouldRetrieveKB(behaviorState, kbProbe)) {
    try {
      const chunks = await retrieveRelevantChunks(opts.tenantId, kbProbe, 5);
      kbBlock = buildKnowledgeContext(chunks) || undefined;
      if (kbBlock) kbAppended = chunks as any[];
    } catch (err: any) {
      kbAppended = [{ error: err.message }];
    }
  }

  // Mirror OpenAIProvider.suggestResponse: build the system prompt via the
  // unified prompt-builder, with customer info + KB inside the prompt's slots.
  const systemPrompt = buildAgentPrompt({
    behaviorState,
    agent: config.agent,
    context: { customerBlock },
    knowledge: { block: kbBlock },
  });

  const messages: any[] = [{ role: "system", content: systemPrompt }];
  const transcript = history
    .filter((m) => m.body?.trim())
    .map((m) => {
      if (m.direction === "INBOUND") return `[Customer${customerName ? ` - ${customerName}` : ""}]: ${m.body}`;
      return `[Agent${m.senderName ? ` - ${m.senderName}` : ""}]: ${m.body}`;
    })
    .join("\n");
  if (transcript) messages.push({ role: "user", content: `## Conversation Transcript\n${transcript}` });

  // Output instruction sourced from BEL (NOT agent.copilotMode at debug time).
  messages.push({ role: "user", content: renderOutputContractInstruction(behaviorState.outputContract) });

  // Tool surface — same construction the provider's suggestResponse uses
  // (submit_suggestions terminator + ASSIST-filtered integration tools +
  // identity-link if a contact resolves).
  const SUBMIT_SUGGESTIONS_TOOL = {
    type: "function",
    function: {
      name: "submit_suggestions",
      description:
        "Call this to FINISH and return your final suggestions to the human agent. Call it exactly once after using any read-only tools.",
      parameters: {
        type: "object",
        properties: {
          suggestions: { type: "array", items: { type: "object" } },
        },
        required: ["suggestions"],
      },
    },
  };

  let identityLinking = false;
  if (metaForRender?.customerExternalId && metaForRender?.channel) {
    const contact = await prisma.contact.findFirst({
      where: {
        tenantId: opts.tenantId,
        channel: metaForRender.channel as any,
        externalId: metaForRender.customerExternalId,
      },
      select: { id: true },
    });
    identityLinking = !!contact?.id;
  }
  const { buildAgentToolsForAIAgent: buildTools } = await import("@chatcenter/shared");
  const integrationTools = await buildTools(opts.tenantId, agent.id, {
    identityLinking,
    escalation: false,
    allowedMode: "ASSIST",
  });
  const tools = [SUBMIT_SUGGESTIONS_TOOL, ...integrationTools];

  return {
    mode: "assist",
    agent: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      status: agent.status,
      copilotMode: config.copilotMode,
    },
    context: {
      conversationId: opts.conversationId || null,
      conversation: convoMeta,
      conversationMeta: metaForRender,
      historyCount: history.length,
      kbProbe: kbProbe || null,
      kbChunks: kbAppended.length,
    },
    systemPrompt,
    tools,
    messages,
  };
}

function stringify(messages: any[]): string {
  return messages
    .map((m) => {
      const role = String(m.role || "?").toUpperCase();
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const tcalls = m.tool_calls ? `\n[tool_calls=${JSON.stringify(m.tool_calls)}]` : "";
      return `=== ${role} ===\n${content}${tcalls}`;
    })
    .join("\n\n");
}

// ─── GET /api/ai-debug/prompt ───────────────────────────────

router.get("/prompt", debugAuth, async (req: Request, res: Response) => {
  try {
    const tenantIdParam = String(req.query.tenantId || "");
    const agentIdParam = String(req.query.agentId || "");
    const mode = (String(req.query.mode || "agent").toLowerCase() === "assist" ? "assist" : "agent") as
      | "assist"
      | "agent";
    const conversationId = req.query.conversationId ? String(req.query.conversationId) : undefined;
    const message = req.query.message ? String(req.query.message) : undefined;

    // JIT scope (when used) takes precedence — caller cannot leak across tenants.
    const tenantId = req.debugAuth?.scope.tenantId || tenantIdParam;
    const agentId = req.debugAuth?.scope.agentId || agentIdParam;
    if (!tenantId) {
      res.status(400).json({ error: "tenantId is required (query or JIT scope)" });
      return;
    }
    if (!agentId) {
      res.status(400).json({ error: "agentId is required (query or JIT scope)" });
      return;
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, status: true },
    });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const rendered = mode === "assist"
      ? await renderAssistMode({ tenantId, agentId, conversationId, message })
      : await renderAgentMode({ tenantId, agentId, conversationId, message });

    res.json({
      tenant,
      authVia: req.debugAuth?.via,
      ...rendered,
      stringified: stringify(rendered.messages),
    });
  } catch (err: any) {
    const status = err?.status || 500;
    console.error("[ai-debug] error:", err.message);
    res.status(status).json({ error: err.message || "Failed to render prompt" });
  }
});

export default router;
