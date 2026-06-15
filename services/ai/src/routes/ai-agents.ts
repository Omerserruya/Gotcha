import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requireRole } from "@chatcenter/shared";
import { buildConfigFromAIAgent, chatWithAgent } from "../services/ai-assist.service";
import { generateResponse } from "../services/ai.service";
import { computeBehaviorState } from "../services/behavior-engine.service";
import { buildAgentPrompt, GENERATOR_BUILTIN_AGENT } from "../services/prompt-builder.service";
import { isBrandArchetype } from "../services/brand-archetypes";

const router = Router();

// Strip an invalid `brand_archetype` out of an incoming persona object so we
// never persist a key the renderer can't resolve (it would silently fall back
// to "neutral"). Leaves the rest of persona (gender, traits, …) untouched and
// returns the value unchanged when it isn't a persona object.
function sanitizePersona<T>(persona: T): T {
  if (!persona || typeof persona !== "object") return persona;
  const p = persona as Record<string, unknown>;
  if ("brand_archetype" in p && !isBrandArchetype(p.brand_archetype)) {
    const { brand_archetype: _drop, ...rest } = p;
    return rest as T;
  }
  return persona;
}

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
      // Per-agent semantics (Tier 2). NULL when the operator hasn't
      // customized — composeToolDescription falls back to catalog defaults.
      description: (tp as any).description ?? null,
      usageRule: (tp as any).usageRule ?? null,
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

// Roles for which a funnel is REQUIRED at save time. These are
// outcome-driven roles whose conversations advance through pipeline
// stages — the funnel provides the stage goals + exit criteria.
// Roles NOT in this set (support, billing, custom, research) rely on
// `agent.goal` + `agent.successCriteria` instead and the funnel binding
// is optional.
const FUNNEL_REQUIRED_ROLES = new Set(["sales", "sdr", "recruiting"]);

function requiresFunnel(role: string | undefined | null): boolean {
  return FUNNEL_REQUIRED_ROLES.has(String(role || "").toLowerCase());
}

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
      departmentId, funnelId,
      goal, successCriteria,
      knowledgeBaseIds, toolIds,
    } = req.body;

    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }

    // Role-driven guardrails: funnel-required roles still need a funnel
    // binding (pipelines depend on stage definitions). For text-driven
    // roles `goal` is preferred but not blocking — if missing we synthesize
    // a sensible default from name/description/role so the wizard and
    // legacy agents (created before `goal` existed) keep working.
    const effectiveRole = String(role || "customer_support").toLowerCase();
    if (requiresFunnel(effectiveRole)) {
      if (!funnelId) {
        res.status(422).json({
          error: "funnel_required_for_role",
          message: `Role \`${effectiveRole}\` requires a funnel binding. Create a funnel under Settings → Funnels first, or pick a non-pipeline role.`,
        });
        return;
      }
    }
    const normalizedGoal: string | null = (() => {
      if (typeof goal === "string" && goal.trim()) return goal.trim();
      if (requiresFunnel(effectiveRole)) return null;
      const desc = typeof description === "string" ? description.trim() : "";
      if (desc) return desc.length > 240 ? desc.slice(0, 237) + "…" : desc;
      const safeName = typeof name === "string" && name.trim() ? name.trim() : "this agent";
      return `Help every customer reach the outcome ${safeName} is built for.`;
    })();

    const agent = await prisma.aIAgent.create({
      data: {
        tenantId: req.tenantId! as string,
        name,
        role: role || "customer_support",
        // description column dropped per spec — caller-supplied value is ignored.
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
        persona: sanitizePersona(persona) || null,
        maxAutonomousMessages: maxAutonomousMessages ?? 10,
        maxAutonomousMinutes: maxAutonomousMinutes ?? 15,
        confidenceThreshold: confidenceThreshold ?? 0.6,
        escalationMessage: escalationMessage || "Let me connect you with a team member who can help further.",
        conversationFlow: conversationFlow || null,
        customGuardrails: customGuardrails || null,
        departmentId: departmentId || null,
        funnelId: funnelId || null,
        goal: normalizedGoal,
        successCriteria: typeof successCriteria === "string" ? successCriteria.trim() || null : null,
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

    const { knowledgeBaseIds, toolIds, tools: toolsWithOverrides, mode: _dropMode, ...updateData } = req.body;

    // Empty strings from the dropdowns mean "no binding" — coerce to NULL
    // so the FK constraint accepts it (Postgres won't accept "" as a cuid).
    if (Object.prototype.hasOwnProperty.call(updateData, "departmentId") && !updateData.departmentId) {
      updateData.departmentId = null;
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "funnelId") && !updateData.funnelId) {
      updateData.funnelId = null;
    }

    // Strip an unknown brand_archetype before it reaches the DB. The whole
    // persona object is replaced on update, so the frontend sends the merged
    // persona (gender/traits + brand_archetype) — we only validate the new key.
    if (Object.prototype.hasOwnProperty.call(updateData, "persona")) {
      updateData.persona = sanitizePersona(updateData.persona);
    }

    // Normalize the new goal / successCriteria fields the same way create
    // does — trim and convert empty strings to NULL.
    if (Object.prototype.hasOwnProperty.call(updateData, "goal")) {
      updateData.goal = typeof updateData.goal === "string"
        ? updateData.goal.trim() || null
        : null;
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "successCriteria")) {
      updateData.successCriteria = typeof updateData.successCriteria === "string"
        ? updateData.successCriteria.trim() || null
        : null;
    }

    // Role-driven guardrails on update — funnel binding is still required
    // for pipeline roles (Sales/SDR/Recruiting) because stages drive
    // behavior. `goal` is preferred but not blocking on PATCH — legacy
    // agents (pre-dating the field) and partial saves must still succeed.
    const merged = { ...existing, ...updateData };
    if (requiresFunnel(merged.role) && !merged.funnelId) {
      res.status(422).json({
        error: "funnel_required_for_role",
        message: `Role \`${merged.role}\` requires a funnel binding.`,
      });
      return;
    }

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

    // Update tool assignments if provided.
    // Preferred shape: `tools: [{ tenantToolId, description?, usageRule? }]`
    // which carries per-agent semantics. Legacy shape `toolIds: string[]`
    // is kept for backward compat — when both are present, `tools` wins.
    const useToolsShape = Array.isArray(toolsWithOverrides);
    if (useToolsShape || (toolIds && Array.isArray(toolIds))) {
      await prisma.agentToolPermission.deleteMany({ where: { tenantId: req.tenantId! as string, aiAgentId: agent.id } });
      if (useToolsShape && toolsWithOverrides.length > 0) {
        await prisma.agentToolPermission.createMany({
          data: toolsWithOverrides
            .filter((t: any) => t && typeof t.tenantToolId === "string" && t.tenantToolId.length > 0)
            .map((t: any) => ({
              tenantId: req.tenantId! as string,
              aiAgentId: agent.id,
              tenantToolId: t.tenantToolId,
              isAllowed: true,
              description:
                typeof t.description === "string" && t.description.trim() ? t.description.trim() : null,
              usageRule:
                typeof t.usageRule === "string" && t.usageRule.trim() ? t.usageRule.trim() : null,
            })),
          skipDuplicates: true,
        });
      } else if (!useToolsShape && toolIds.length > 0) {
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

    // Check if any router rules reference this agent. Must be tenant-scoped —
    // the shared TenantGuard rejects any query whose where clause is missing
    // tenantId (a count without it 500s instead of returning a number).
    const ruleCount = await prisma.routerRule.count({
      where: { tenantId: req.tenantId! as string, aiAgentId: req.params.id as string, enabled: true },
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
