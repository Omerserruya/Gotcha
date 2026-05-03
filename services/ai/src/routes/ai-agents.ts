import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";
import { buildConfigFromAIAgent, chatWithAgent } from "../services/ai-assist.service";
import { generateResponse } from "../services/ai.service";
import { computeBehaviorState } from "../services/behavior-engine.service";
import { buildAgentPrompt, GENERATOR_BUILTIN_AGENT } from "../services/prompt-builder.service";

const router = Router();

// ─── List AI Agents ──────────────────────────────────────────
router.get("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const agents = await prisma.aIAgent.findMany({
      where: { tenantId: req.tenantId! as string },
      include: {
        knowledgeBases: {
          include: { knowledgeBase: { select: { id: true, name: true, isActive: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Enrich with tool count
    const enriched = await Promise.all(agents.map(async (agent) => {
      const toolCount = await prisma.agentToolPermission.count({
        where: { tenantId: req.tenantId! as string, aiAgentId: agent.id, isAllowed: true },
      });
      return {
        ...agent,
        knowledgeSources: agent.knowledgeBases.map((ak: any) => ak.knowledgeBase),
        toolCount,
      };
    }));

    res.json({ data: enriched });
  } catch (err) {
    console.error("List AI agents error:", err);
    res.status(500).json({ error: "Failed to list AI agents" });
  }
});

// ─── Generate AI Employee Config from Wizard Answers ────────
router.post("/generate", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { answers, departmentId } = req.body;
    if (!answers || typeof answers !== "object") {
      res.status(400).json({ error: "answers object is required" });
      return;
    }

    // Map wizard answers to structured AI Employee config
    const roleMap: Record<string, string> = {
      support: "customer_support", sales: "sales", booking: "booking", billing: "billing",
    };
    const toneMap: Record<string, string> = {
      professional: "professional", friendly: "friendly", casual: "casual", formal: "formal",
    };
    const genderMap: Record<string, string> = {
      male: "male", female: "female", neutral: "neutral",
      "זכר": "male", "נקבה": "female", "ניטרלי": "neutral",
    };

    // Map wizard keys → normalize (wizard sends: name, responsibility, channels, communication, escalation, aiDisclosure, extra, conversationFlow, guardrails)
    const responsibility = answers.responsibility || answers.purpose || "";
    const communicationStyle = answers.communication || answers.tone || "";
    const agentName = answers.name || "";

    // Detect role from responsibility
    const responsibilityLower = responsibility.toLowerCase();
    const roleLower = (answers.role || answers.department || "").toLowerCase();
    let detectedRole = "custom";
    for (const [key, val] of Object.entries(roleMap)) {
      if (responsibilityLower.includes(key) || roleLower.includes(key)) { detectedRole = val; break; }
    }

    // Detect tone from communication style
    const toneLower = communicationStyle.toLowerCase();
    let detectedTone = "friendly";
    for (const [key, val] of Object.entries(toneMap)) {
      if (toneLower.includes(key)) { detectedTone = val; break; }
    }

    // Detect gender
    const genderLower = (answers.gender || "").toLowerCase();
    let detectedGender = "neutral";
    for (const [key, val] of Object.entries(genderMap)) {
      if (genderLower.includes(key)) { detectedGender = val; break; }
    }

    // Detect channels
    const channelsRaw = (answers.channels || "").toLowerCase();
    const channels: string[] = [];
    if (channelsRaw.includes("whatsapp") || channelsRaw.includes("ווטסאפ")) channels.push("whatsapp");
    if (channelsRaw.includes("instagram") || channelsRaw.includes("אינסטגרם")) channels.push("instagram");
    if (channelsRaw.includes("web") || channelsRaw.includes("אתר") || channelsRaw.includes("צ'אט")) channels.push("webchat");
    if (channelsRaw.includes("email") || channelsRaw.includes("אימייל") || channelsRaw.includes("מייל")) channels.push("email");

    // Build the AI Employee name
    const name = agentName || (responsibility ? responsibility.substring(0, 50) : `AI Employee ${new Date().toLocaleDateString()}`);

    // Detect mode — default to AUTONOMOUS for AI agents
    const roleAnswerLower = (answers.role || responsibility || "").toLowerCase();
    let mode = "AUTONOMOUS";
    if (roleAnswerLower.includes("copilot") || roleAnswerLower.includes("assist") || roleAnswerLower.includes("suggest")) {
      mode = "COPILOT";
    } else if (roleAnswerLower.includes("hybrid") || roleAnswerLower.includes("היברידי")) {
      mode = "COPILOT";
    }

    // Generate rich description using AI based on all wizard answers
    let description = responsibility;
    try {
      const wizardSummary = Object.entries(answers)
        .filter(([, v]) => typeof v === "string" && v.trim().length > 0)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");

      // Generator path goes through BEL → PB. The system prompt is built by
      // the platform Generator agent; the wizard answers are the user input.
      const generatorState = computeBehaviorState({
        mode: "generator",
        identity: { hasContact: true, contactLifecycle: null, priorConversationCount: 0 },
        request: { lastMessage: wizardSummary, messageCount: 1 },
      });
      const generatorSystemPrompt = buildAgentPrompt({
        behaviorState: generatorState,
        agent: GENERATOR_BUILTIN_AGENT,
      });
      const aiRes = await generateResponse({
        tenantId: req.tenantId! as string,
        messages: [
          { role: "system", content: generatorSystemPrompt },
          {
            role: "user",
            content: `Wizard answers for the new AI agent:\n\n${wizardSummary}\n\nProduce a 2–4 sentence description in the user's language. Do not repeat the agent's name. Output only the description text.`,
          },
        ],
        temperature: 0.7,
        maxTokens: 200,
        metadata: { type: "agent_description", belMode: "generator" },
      });
      if (aiRes.content?.trim()) {
        description = aiRes.content.trim();
      }
    } catch (err) {
      console.warn("[ai-agents] AI description generation failed, using fallback:", (err as Error).message);
      // Fallback to concatenated answers
      const parts = [responsibility];
      if (answers.extra) parts.push(answers.extra);
      description = parts.filter(Boolean).join(". ");
    }

    const config = {
      name,
      role: detectedRole,
      description,
      tone: detectedTone,
      channels,
      mode,
      persona: {
        gender: detectedGender,
        traits: { warmth: "moderate", humor: "low" },
      },
      escalationHints: answers.escalation || "",
      extraContext: answers.extra || "",
      conversationFlow: answers.conversationFlow || "",
      customGuardrails: answers.guardrails || "",
    };

    res.json({ data: config });
  } catch (err) {
    console.error("Generate AI employee config error:", err);
    res.status(500).json({ error: "Failed to generate AI employee config" });
  }
});

// ─── Get AI Agent by ID ──────────────────────────────────────
router.get("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const agent = await prisma.aIAgent.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
      include: {
        knowledgeBases: {
          include: { knowledgeBase: { select: { id: true, name: true, isActive: true } } },
        },
      },
    });

    if (!agent) {
      res.status(404).json({ error: "AI agent not found" });
      return;
    }

    // Get assigned tools
    const toolPermissions = await prisma.agentToolPermission.findMany({
      where: { tenantId: req.tenantId! as string, aiAgentId: agent.id, isAllowed: true },
      include: {
        tenantTool: {
          include: {
            catalogTool: { select: { id: true, name: true, slug: true, riskLevel: true } },
            tenantIntegration: {
              include: { integration: { select: { name: true, slug: true } } },
            },
          },
        },
      },
    });

    const tools = toolPermissions.map(tp => ({
      id: tp.tenantTool.catalogTool.id,
      tenantToolId: tp.tenantToolId,
      name: tp.tenantTool.catalogTool.name,
      slug: tp.tenantTool.catalogTool.slug,
      risk: tp.tenantTool.catalogTool.riskLevel,
      integration: tp.tenantTool.tenantIntegration.integration.name,
      enabled: tp.isAllowed,
      requireApproval: tp.requireApproval,
    }));

    res.json({
      data: {
        ...agent,
        knowledgeSources: agent.knowledgeBases.map((ak: any) => ak.knowledgeBase),
        tools,
      },
    });
  } catch (err) {
    console.error("Get AI agent error:", err);
    res.status(500).json({ error: "Failed to get AI agent" });
  }
});

// ─── Create AI Agent ─────────────────────────────────────────
router.post("/", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const {
      name, role, description, avatarColor, status,
      tone, languages, style, channels, escalationRules,
      interactiveMessages, systemPrompt, model, provider,
      temperature, maxTokens, identity, goals, toneConfig,
      behavioral, persona, maxAutonomousMessages, maxAutonomousMinutes,
      confidenceThreshold, escalationMessage, conversationFlow, customGuardrails,
      knowledgeBaseIds, toolIds,
    } = req.body;

    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }

    const agent = await prisma.aIAgent.create({
      data: {
        tenantId: req.tenantId! as string,
        name,
        role: role || "customer_support",
        description: description || null,
        avatarColor: avatarColor || "#7c5cfc",
        status: status || "DRAFT",
        tone: tone || "professional",
        languages: languages || { english: true },
        style: style || {},
        channels: channels || [],
        escalationRules: escalationRules || [],
        interactiveMessages: interactiveMessages || {},
        systemPrompt: systemPrompt || "",
        model: model || "gpt-4o-mini",
        provider: provider || "openai",
        temperature: temperature ?? 0.7,
        maxTokens: maxTokens ?? 1024,
        identity: identity || null,
        goals: goals || null,
        toneConfig: toneConfig || null,
        behavioral: behavioral || null,
        persona: persona || null,
        maxAutonomousMessages: maxAutonomousMessages ?? 10,
        maxAutonomousMinutes: maxAutonomousMinutes ?? 15,
        confidenceThreshold: confidenceThreshold ?? 0.6,
        escalationMessage: escalationMessage || "Let me connect you with a team member who can help further.",
        conversationFlow: conversationFlow || null,
        customGuardrails: customGuardrails || null,
      },
    });

    // Assign knowledge bases
    if (knowledgeBaseIds && Array.isArray(knowledgeBaseIds)) {
      await prisma.aIAgentKnowledge.createMany({
        data: knowledgeBaseIds.map((kbId: string) => ({
          aiAgentId: agent.id,
          knowledgeBaseId: kbId,
        })),
        skipDuplicates: true,
      });
    }

    // Assign tools
    if (toolIds && Array.isArray(toolIds)) {
      // toolIds are TenantTool IDs
      await prisma.agentToolPermission.createMany({
        data: toolIds.map((toolId: string) => ({
          tenantId: req.tenantId! as string,
          aiAgentId: agent.id,
          tenantToolId: toolId,
          isAllowed: true,
        })),
        skipDuplicates: true,
      });
    }

    res.status(201).json({ data: agent });
  } catch (err) {
    console.error("Create AI agent error:", err);
    res.status(500).json({ error: "Failed to create AI agent" });
  }
});

// ─── Update AI Agent ─────────────────────────────────────────
router.patch("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.aIAgent.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });

    if (!existing) {
      res.status(404).json({ error: "AI agent not found" });
      return;
    }

    const { knowledgeBaseIds, toolIds, mode: _dropMode, ...updateData } = req.body;

    const agent = await prisma.aIAgent.update({
      where: { id: req.params.id as string },
      data: updateData,
    });

    // Update knowledge base assignments if provided
    if (knowledgeBaseIds && Array.isArray(knowledgeBaseIds)) {
      await prisma.aIAgentKnowledge.deleteMany({ where: { aiAgentId: agent.id } });
      if (knowledgeBaseIds.length > 0) {
        await prisma.aIAgentKnowledge.createMany({
          data: knowledgeBaseIds.map((kbId: string) => ({
            aiAgentId: agent.id,
            knowledgeBaseId: kbId,
          })),
          skipDuplicates: true,
        });
      }
    }

    // Update tool assignments if provided
    if (toolIds && Array.isArray(toolIds)) {
      await prisma.agentToolPermission.deleteMany({ where: { tenantId: req.tenantId! as string, aiAgentId: agent.id } });
      if (toolIds.length > 0) {
        await prisma.agentToolPermission.createMany({
          data: toolIds.map((toolId: string) => ({
            tenantId: req.tenantId! as string,
            aiAgentId: agent.id,
            tenantToolId: toolId,
            isAllowed: true,
          })),
          skipDuplicates: true,
        });
      }
    }

    // Single-tool toggle path (used by the IntegrationDrawer when opened
    // from the agent page so flipping a switch persists per-agent without
    // having to send the whole toolIds array).
    // Body: { tenantToolId, isAllowed, requireApproval? }
    // Handled via the dedicated route below.

    res.json({ data: agent });
  } catch (err) {
    console.error("Update AI agent error:", err);
    res.status(500).json({ error: "Failed to update AI agent" });
  }
});

// ─── Single-tool toggle (per-agent permission) ──────────────
//
// Used by the IntegrationDrawer when opened from the agent page so that
// flipping one tool switch persists immediately (creates/updates a single
// `AgentToolPermission` row) instead of requiring the caller to send the
// full toolIds array via the PATCH path. The drawer also continues to
// hit `PUT /api/integrations/:slug/tools/:slug` to ensure the underlying
// `TenantTool` is enabled — both must be true for the bot to see the tool.
//
// Body: { isAllowed: boolean, requireApproval?: boolean }
router.put(
  "/:id/tools/:tenantToolId",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  requireRole("ADMIN"),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantId! as string;
      const aiAgentId = req.params.id as string;
      const tenantToolId = req.params.tenantToolId as string;
      const { isAllowed, requireApproval } = req.body || {};

      if (typeof isAllowed !== "boolean") {
        res.status(400).json({ error: "isAllowed (boolean) is required" });
        return;
      }

      // Tenant-scope guard: agent + tool must belong to this tenant.
      const agent = await prisma.aIAgent.findFirst({
        where: { id: aiAgentId, tenantId },
        select: { id: true },
      });
      if (!agent) {
        res.status(404).json({ error: "AI agent not found" });
        return;
      }
      const tenantTool = await prisma.tenantTool.findFirst({
        where: { id: tenantToolId, tenantId },
        select: { id: true },
      });
      if (!tenantTool) {
        res.status(404).json({ error: "TenantTool not found for this tenant" });
        return;
      }

      // findFirst + branch (the compound unique
      // tenantToolId_departmentId_agentId omits tenantId, so the guard
      // would block a direct upsert).
      const existing = await prisma.agentToolPermission.findFirst({
        where: { tenantId, aiAgentId, tenantToolId },
        select: { id: true },
      });
      const row = existing
        ? await prisma.agentToolPermission.update({
            where: { id: existing.id },
            data: {
              isAllowed,
              ...(typeof requireApproval === "boolean" ? { requireApproval } : {}),
            },
          })
        : await prisma.agentToolPermission.create({
            data: {
              tenantId,
              aiAgentId,
              tenantToolId,
              isAllowed,
              requireApproval: typeof requireApproval === "boolean" ? requireApproval : false,
            },
          });

      res.json({ data: row });
    } catch (err: any) {
      console.error("Toggle agent tool error:", err);
      res.status(500).json({ error: "Failed to toggle agent tool" });
    }
  },
);

// ─── Test Chat ───────────────────────────────────────────────
router.post("/:id/test-chat", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const agent = await prisma.aIAgent.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });

    if (!agent) {
      res.status(404).json({ error: "AI agent not found" });
      return;
    }

    const { message, history = [] } = req.body as {
      message: string;
      history: Array<{ role: "user" | "assistant"; content: string }>;
    };

    const config = buildConfigFromAIAgent(agent as any, "agent");
    const reply = await chatWithAgent({
      tenantId: req.tenantId! as string,
      conversationId: `test-${agent.id}`,
      messages: [],
      copilotConfig: config,
      agentMessage: message,
      chatHistory: history,
    });

    res.json({ data: { reply } });
  } catch (err) {
    console.error("Test chat error:", err);
    res.status(500).json({ error: "Failed to generate response" });
  }
});

// ─── Delete AI Agent ─────────────────────────────────────────
router.delete("/:id", authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.aIAgent.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });

    if (!existing) {
      res.status(404).json({ error: "AI agent not found" });
      return;
    }

    // Check if any router rules reference this agent
    const ruleCount = await prisma.routerRule.count({
      where: { aiAgentId: req.params.id as string, enabled: true },
    });

    if (ruleCount > 0) {
      res.status(409).json({
        error: "Cannot delete AI agent that is referenced by active routing rules",
        activeRules: ruleCount,
      });
      return;
    }

    await prisma.aIAgent.delete({ where: { id: req.params.id as string } });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete AI agent error:", err);
    res.status(500).json({ error: "Failed to delete AI agent" });
  }
});

export default router;
