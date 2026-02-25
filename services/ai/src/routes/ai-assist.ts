import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";
import * as aiService from "../services/ai-assist.service";
import { generateAllAgentConfigs, generateAgentConfig } from "../services/agent-config-generator";

const router = Router();

// ─── Config Generation Endpoints (called during onboarding - tenant may not be active yet) ───

router.post("/generate-configs", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    await generateAllAgentConfigs(req.tenantId!);
    const configs = await prisma.departmentCopilotConfig.findMany({
      where: { department: { tenantId: req.tenantId! } },
      include: { department: { select: { name: true } } },
    });
    res.json({
      data: {
        departmentsConfigured: configs.length,
        configs: configs.map(c => ({
          departmentId: c.departmentId,
          departmentName: c.department.name,
          systemPrompt: c.systemPrompt.substring(0, 200) + "...",
          hasIdentity: !!c.identity,
          hasGoals: !!c.goals,
          hasTone: !!c.tone,
          hasBehavioral: !!c.behavioral,
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
    const { departmentId } = req.params;
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

// ─── Main AI Routes (require active tenant) ─────────────────

router.use(authenticate, resolveTenant, requireActiveTenant());

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

    const context: aiService.ConversationContext = {
      tenantId: req.tenantId!, conversationId: conversation.id,
      customerName: conversation.customerName || undefined,
      messages: messages.reverse().map((m: any) => ({
        direction: m.direction, body: m.body, senderName: m.senderName || undefined, createdAt: m.createdAt.toISOString(),
      })),
      copilotConfig,
    };
    const suggestions = await aiService.getSuggestions(context);
    res.json({ data: suggestions, copilotMode: copilotConfig?.copilotMode || "READY_MESSAGE" });
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

    const context: aiService.ConversationContext = {
      tenantId: req.tenantId!, conversationId: conversation.id,
      customerName: conversation.customerName || undefined,
      messages: messages.map((m: any) => ({
        direction: m.direction, body: m.body, senderName: m.senderName || undefined, createdAt: m.createdAt.toISOString(),
      })),
      copilotConfig,
    };
    const summary = await aiService.summarizeConversation(context);
    res.json({ data: { summary }, copilotMode: copilotConfig?.copilotMode || "READY_MESSAGE" });
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

export default router;
