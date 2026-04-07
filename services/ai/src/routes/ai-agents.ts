import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";
import { generateAndSavePrompts } from "../services/prompt-assembler.service";

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
        where: { aiAgentId: agent.id, isAllowed: true },
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

    // Detect role from answers
    const purposeLower = (answers.purpose || "").toLowerCase();
    const roleLower = (answers.role || answers.department || "").toLowerCase();
    let detectedRole = "custom";
    for (const [key, val] of Object.entries(roleMap)) {
      if (purposeLower.includes(key) || roleLower.includes(key)) { detectedRole = val; break; }
    }

    // Detect tone
    const toneLower = (answers.tone || "").toLowerCase();
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

    // Build the AI Employee name
    const name = answers.purpose
      ? answers.purpose.substring(0, 50)
      : `AI Employee ${new Date().toLocaleDateString()}`;

    // Detect mode from role answer
    const roleAnswerLower = (answers.role || "").toLowerCase();
    let mode = "COPILOT";
    if (roleAnswerLower.includes("agent") || roleAnswerLower.includes("respond") || roleAnswerLower.includes("autonomous") || roleAnswerLower.includes("אוטונומי")) {
      mode = "AUTONOMOUS";
    } else if (roleAnswerLower.includes("hybrid") || roleAnswerLower.includes("היברידי")) {
      mode = "COPILOT"; // Default hybrid to copilot
    }

    const config = {
      name,
      role: detectedRole,
      description: answers.purpose || "",
      tone: detectedTone,
      channels,
      mode,
      persona: {
        gender: detectedGender,
        traits: { warmth: "moderate", humor: "low" },
      },
      escalationHints: answers.escalation || "",
      extraContext: answers.extra || "",
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
      where: { aiAgentId: agent.id, isAllowed: true },
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
      name, role, description, avatarColor, mode, status,
      tone, languages, style, channels, escalationRules,
      interactiveMessages, systemPrompt, model, provider,
      temperature, maxTokens, identity, goals, toneConfig,
      behavioral, persona, maxAutonomousMessages, maxAutonomousMinutes,
      confidenceThreshold, escalationMessage,
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
        mode: mode || "AUTONOMOUS",
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

    const { knowledgeBaseIds, toolIds, ...updateData } = req.body;

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
      await prisma.agentToolPermission.deleteMany({ where: { aiAgentId: agent.id } });
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

    // Generate and save prompt parts (shared + autonomous)
    try {
      await generateAndSavePrompts(req.tenantId! as string, agent.id);
    } catch (promptErr) {
      console.warn("[ai-agents] Prompt generation failed (non-fatal):", promptErr);
    }

    res.json({ data: agent });
  } catch (err) {
    console.error("Update AI agent error:", err);
    res.status(500).json({ error: "Failed to update AI agent" });
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
