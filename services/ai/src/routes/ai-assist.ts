import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";
import * as aiService from "../services/ai-assist.service";
import { generateResponse, getDefaultModel } from "../services/ai.service";
import { generateAllAgentConfigs, generateAgentConfig } from "../services/agent-config-generator";
import { analyzeConversation, getConversationIntelligence, getConversationReplay } from "../services/conversation-intelligence.service";
import { getToolsForTenant, executeTool, getToolExecutions } from "../services/tool-execution.service";
import { scoreAgent, getAgentScore } from "../services/agent-scoring.service";
import { generateFollowup } from "../services/followup-generator.service";

const router = Router();

// ─── Config Generation Endpoints (called during onboarding - tenant may not be active yet) ───

router.post("/generate-configs", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    await generateAllAgentConfigs(req.tenantId!);
    const agents = await prisma.aIAgent.findMany({
      where: { tenantId: req.tenantId! },
    });
    res.json({
      data: {
        agentsConfigured: agents.length,
        agents: agents.map(a => ({
          id: a.id,
          name: a.name,
          role: a.role,
          status: a.status,
          systemPrompt: a.systemPrompt.substring(0, 200) + "...",
          hasIdentity: !!a.identity,
          hasGoals: !!a.goals,
          hasTone: !!a.toneConfig,
          hasBehavioral: !!a.behavioral,
        })),
      },
    });
  } catch (err) {
    console.error("Generate all configs error:", err);
    res.status(500).json({ error: "Failed to generate configurations" });
  }
});

router.post("/generate-config/:departmentId", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const departmentId = req.params.departmentId as string;
    const dept = await prisma.department.findFirst({
      where: { id: departmentId, tenantId: req.tenantId! },
    });
    if (!dept) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    await generateAgentConfig(req.tenantId!, departmentId);
    res.json({ data: { departmentId, status: "generated" } });
  } catch (err) {
    console.error("Generate config error:", err);
    res.status(500).json({ error: "Failed to generate configuration" });
  }
});

// ─── Intent Classification (internal, called by incoming-worker) ───

router.post("/intent", (req: Request, res: Response, next) => {
  const key = req.headers["x-internal-key"];
  if (!key || key !== (process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}, async (req: Request, res: Response) => {
  try {
    const { message, intent, tenantId } = req.body;
    if (!message || !intent) {
      res.status(400).json({ error: "message and intent are required" });
      return;
    }

    // Ask AI: does this message relate to this intent?
    // Use generateResponse from ai.service (central LLM access)
    let match = false;
    try {
      const aiResponse = await generateResponse({
        tenantId: tenantId || "system",
        messages: [
          {
            role: "system",
            content: `You determine if a customer message is related to a specific intent. Answer ONLY "true" or "false".\n\nIntent to check: "${intent}"`,
          },
          { role: "user", content: message },
        ],
        temperature: 0,
        maxTokens: 5,
        metadata: { type: "intent" },
      });

      const answer = aiResponse.content?.trim()?.toLowerCase();
      match = answer === "true";
      console.log(`[intent] message="${message.substring(0, 50)}" target="${intent}" answer="${answer}" match=${match}`);
    } catch (err: any) {
      // AI service not initialized — fall back to keyword matching
      const msgLower = message.toLowerCase();
      const intentLower = intent.toLowerCase();
      match = msgLower.includes(intentLower);
      console.log(`[intent] AI unavailable (${err.message}), keyword fallback: message="${message.substring(0, 50)}" target="${intentLower}" match=${match}`);
    }

    res.json({ data: { match } });
  } catch (err) {
    console.error("Intent classification error:", err);
    res.status(500).json({ error: "Failed to classify intent" });
  }
});

// ─── Main AI Routes (require active tenant) ─────────────────

router.use(authenticate, resolveTenant, requireActiveTenant());

// Tools registry - MUST be before /:conversationId routes
router.get("/tools/registry", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const tools = await getToolsForTenant(req.tenantId!);
    res.json({ data: tools });
  } catch (err) { console.error("Tools registry error:", err); res.status(500).json({ error: "Failed to get tools" }); }
});

// Static routes BEFORE parameterized routes
router.get("/config", async (req: Request, res: Response) => {
  try {
    const config = await aiService.getTenantCopilotConfig(req.tenantId!);
    res.json({ data: config });
  } catch (err) { console.error("AI config error:", err); res.status(500).json({ error: "Failed to get config" }); }
});

router.get("/:conversationId/suggestions", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const conversation = await prisma.conversation.findFirst({ where: { id: convId, tenantId: req.tenantId! } });
    if (!conversation) { res.status(404).json({ error: "Conversation not found" }); return; }

    const messages = await prisma.message.findMany({
      where: { conversationId: convId, tenantId: req.tenantId! },
      orderBy: { createdAt: "desc" }, take: 20,
      select: { direction: true, body: true, senderName: true, createdAt: true },
    });

    const copilotConfig = await aiService.getEffectiveCopilotConfig(req.tenantId!, (conversation as any).departmentId);

    // No AI Employee configured — return stub so frontend shows "not configured"
    if (!copilotConfig) {
      res.json({ data: [{ id: "no-config", text: "No AI Employee configured.", confidence: 0, type: "info" }], copilotMode: "READY_MESSAGE" });
      return;
    }

    const context: aiService.ConversationContext = {
      tenantId: req.tenantId!, conversationId: conversation.id,
      customerName: conversation.customerName || undefined,
      messages: messages.reverse().map((m: any) => ({
        direction: m.direction, body: m.body, senderName: m.senderName || undefined, createdAt: m.createdAt.toISOString(),
      })),
      copilotConfig,
    };
    const suggestions = await aiService.getSuggestions(context);
    res.json({ data: suggestions, copilotMode: copilotConfig.copilotMode || "READY_MESSAGE" });
  } catch (err) { console.error("AI suggestions error:", err); res.status(500).json({ error: "Failed to get suggestions" }); }
});

router.get("/:conversationId/summary", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const conversation = await prisma.conversation.findFirst({ where: { id: convId, tenantId: req.tenantId! } });
    if (!conversation) { res.status(404).json({ error: "Conversation not found" }); return; }

    const messages = await prisma.message.findMany({
      where: { conversationId: convId, tenantId: req.tenantId! },
      orderBy: { createdAt: "asc" },
      select: { direction: true, body: true, senderName: true, createdAt: true },
    });

    const copilotConfig = await aiService.getEffectiveCopilotConfig(req.tenantId!, (conversation as any).departmentId);

    if (!copilotConfig) {
      res.json({ data: { summary: "AI summarization not configured." }, copilotMode: "READY_MESSAGE" });
      return;
    }

    const context: aiService.ConversationContext = {
      tenantId: req.tenantId!, conversationId: conversation.id,
      customerName: conversation.customerName || undefined,
      messages: messages.map((m: any) => ({
        direction: m.direction, body: m.body, senderName: m.senderName || undefined, createdAt: m.createdAt.toISOString(),
      })),
      copilotConfig,
    };
    const summary = await aiService.summarizeConversation(context);
    res.json({ data: { summary }, copilotMode: copilotConfig.copilotMode || "READY_MESSAGE" });
  } catch (err) { console.error("AI summary error:", err); res.status(500).json({ error: "Failed to get summary" }); }
});

// ─── Agent Chat with AI (CHAT mode) ──────────────────────────
router.post("/:conversationId/chat", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const { message, history } = req.body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: convId, tenantId: req.tenantId! },
      include: {
        department: { select: { id: true, name: true } },
        assignedAgent: { select: { name: true } },
      },
    });
    if (!conversation) { res.status(404).json({ error: "Conversation not found" }); return; }

    const messages = await prisma.message.findMany({
      where: { conversationId: convId, tenantId: req.tenantId! },
      orderBy: { createdAt: "asc" },
      select: { direction: true, body: true, senderName: true, createdAt: true },
    });

    const copilotConfig = await aiService.getEffectiveCopilotConfig(req.tenantId!, (conversation as any).departmentId);

    if (!copilotConfig) {
      res.status(400).json({ error: "No AI Employee configured. Set up an AI Employee in AI Studio." });
      return;
    }

    const reply = await aiService.chatWithAgent({
      tenantId: req.tenantId!,
      conversationId: conversation.id,
      customerName: conversation.customerName || undefined,
      messages: messages.map((m: any) => ({
        direction: m.direction, body: m.body, senderName: m.senderName || undefined, createdAt: m.createdAt.toISOString(),
      })),
      copilotConfig,
      agentMessage: message,
      chatHistory: Array.isArray(history) ? history : [],
      customerData: {
        externalId: conversation.customerExternalId,
        name: conversation.customerName || undefined,
        channel: conversation.channel,
        status: conversation.status,
        department: (conversation as any).department?.name || undefined,
        assignedAgent: (conversation as any).assignedAgent?.name || undefined,
        createdAt: conversation.createdAt.toISOString(),
        lastMessageAt: conversation.lastMessageAt?.toISOString() || undefined,
        isHandedOver: conversation.isHandedOver,
      },
    });

    res.json({ data: { reply } });
  } catch (err) {
    console.error("AI chat error:", err);
    res.status(500).json({ error: "Failed to get AI response" });
  }
});

// Get effective copilot config for a department (SYSTEM_ADMIN only)
router.get("/prompt/:departmentId", requireRole("SYSTEM_ADMIN"), async (req: Request, res: Response) => {
  try {
    const config = await aiService.getEffectiveCopilotConfig(
      req.tenantId!,
      req.params.departmentId as string,
    );
    if (!config) {
      res.status(404).json({ error: "No copilot configuration found for this department" });
      return;
    }
    res.json({
      data: {
        systemPrompt: config.systemPrompt,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        copilotMode: config.copilotMode,
      },
    });
  } catch (err) {
    console.error("Get assembled prompt error:", err);
    res.status(500).json({ error: "Failed to get copilot config" });
  }
});

// ─── Conversation Intelligence & Replay ─────────────────────

router.get("/:conversationId/intelligence", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const intelligence = await getConversationIntelligence(req.tenantId!, convId);
    res.json({ data: intelligence });
  } catch (err) { console.error("Intelligence error:", err); res.status(500).json({ error: "Failed to get conversation intelligence" }); }
});

router.post("/:conversationId/analyze", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const intelligence = await analyzeConversation(req.tenantId!, convId);
    res.json({ data: intelligence });
  } catch (err) { console.error("Analyze error:", err); res.status(500).json({ error: "Failed to analyze conversation" }); }
});

router.get("/:conversationId/replay", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const replay = await getConversationReplay(req.tenantId!, convId);
    res.json({ data: replay });
  } catch (err) { console.error("Replay error:", err); res.status(500).json({ error: "Failed to get conversation replay" }); }
});

// ─── Tool Execution ──────────────────────────────────────────

router.get("/:conversationId/tools", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const executions = await getToolExecutions(req.tenantId!, convId);
    res.json({ data: executions });
  } catch (err) { console.error("Tool executions error:", err); res.status(500).json({ error: "Failed to get tool executions" }); }
});

router.post("/:conversationId/tools/execute", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const { tenantToolId, input } = req.body;
    if (!tenantToolId) { res.status(400).json({ error: "tenantToolId is required" }); return; }
    const execution = await executeTool({
      tenantId: req.tenantId!,
      conversationId: convId,
      tenantToolId,
      input: input || {},
      triggeredBy: (req as any).user?.id || "agent",
    });
    res.json({ data: execution });
  } catch (err: any) {
    console.error("Tool execute error:", err);
    if (err.message === "Tool not found") { res.status(404).json({ error: err.message }); return; }
    res.status(500).json({ error: "Failed to execute tool" });
  }
});

// ─── Agent Scoring ───────────────────────────────────────────

router.get("/:conversationId/score", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const score = await getAgentScore(req.tenantId!, convId);
    if (!score) {
      res.status(404).json({ error: "No agent assigned to this conversation" });
      return;
    }
    res.json({ data: score });
  } catch (err) {
    console.error("Get agent score error:", err);
    res.status(500).json({ error: "Failed to get agent score" });
  }
});

router.post("/:conversationId/score", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const score = await scoreAgent(req.tenantId!, convId);
    if (!score) {
      res.status(404).json({ error: "No agent assigned to this conversation" });
      return;
    }
    res.json({ data: score });
  } catch (err) {
    console.error("Score agent error:", err);
    res.status(500).json({ error: "Failed to score agent" });
  }
});

// F6.3 — generate a contextual follow-up for a stale conversation
router.post(
  "/:conversationId/followup",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  async (req: Request, res: Response) => {
    try {
      const result = await generateFollowup(req.tenantId!, String(req.params.conversationId));
      if (!result) return res.json({ data: null, reason: "nothing useful to send" });
      return res.json({ data: result });
    } catch (err: any) {
      console.error("followup generator error:", err);
      return res.status(500).json({ error: "Failed to generate follow-up" });
    }
  },
);

export default router;
