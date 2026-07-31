import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requirePermissionOrRole, requireEntitlement, requireCapacity } from "@chatcenter/shared";
import { runSandboxTurn } from "../services/sandbox-conversation.service";
import { computeCalendarCapability } from "../services/calendar-capability.service";
import { generateResponse, getDefaultModel } from "../services/ai.service";
import { computeBehaviorState } from "../services/behavior-engine.service";
import { buildAgentPrompt, GENERATOR_BUILTIN_AGENT } from "../services/prompt-builder.service";
import { isBrandArchetype } from "../services/brand-archetypes";
import { loadToolGrants, deriveAllowedOperations } from "../services/agent-loop/permissions-bridge";
import { ensureCapabilitiesRegistered, describeAllWorlds } from "../services/capability-plane";

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

/**
 * Normalize the Product Qualification Context (agent.salesContext). Trims the
 * two string fields, cleans the four string-array fields, and collapses an
 * all-empty object to NULL so the prompt block is skipped. Unknown keys are
 * dropped. Returns null for non-object input.
 */
function normalizeSalesContext(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const list = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((s) => s.trim())
      : [];

  const out: Record<string, unknown> = {};
  const whatWeSell = str(r.whatWeSell);
  const idealCustomerProfile = str(r.idealCustomerProfile);
  const problemsSolved = list(r.problemsSolved);
  const expectedOutcomes = list(r.expectedOutcomes);
  const qualificationSignals = list(r.qualificationSignals);
  const disqualifiers = list(r.disqualifiers);

  if (whatWeSell) out.whatWeSell = whatWeSell;
  if (idealCustomerProfile) out.idealCustomerProfile = idealCustomerProfile;
  if (problemsSolved.length) out.problemsSolved = problemsSolved;
  if (expectedOutcomes.length) out.expectedOutcomes = expectedOutcomes;
  if (qualificationSignals.length) out.qualificationSignals = qualificationSignals;
  if (disqualifiers.length) out.disqualifiers = disqualifiers;

  return Object.keys(out).length ? out : null;
}

// ─── List AI Agents ──────────────────────────────────────────
router.get("/", authenticate, resolveTenant, requireActiveTenant(), requirePermissionOrRole("ai:employees:read", "ADMIN"), async (req: Request, res: Response) => {
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

    // Departments resolved once rather than per agent.
    const departments = await prisma.department.findMany({
      where: { tenantId: req.tenantId! as string },
      select: { id: true, name: true },
    }).catch(() => [] as Array<{ id: string; name: string }>);
    const deptById = new Map(departments.map((d) => [d.id, d.name]));

    // Enrich with tool count, department name and when it was last tested.
    const enriched = await Promise.all(agents.map(async (agent) => {
      const toolCount = await prisma.agentToolPermission.count({
        where: { tenantId: req.tenantId! as string, aiAgentId: agent.id, isAllowed: true },
      });
      // "Last tested" is read from the sandbox conversation the test chat keeps,
      // so it reflects a real conversation rather than a separate counter that
      // could drift from whether anyone actually tried the employee.
      const sandbox = await prisma.conversation.findFirst({
        where: {
          tenantId: req.tenantId! as string,
          customerExternalId: { startsWith: `sandbox:${agent.id}:` },
        },
        select: { lastMessageAt: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
      }).catch(() => null);
      return {
        ...agent,
        knowledgeSources: agent.knowledgeBases.map((ak: any) => ak.knowledgeBase),
        toolCount,
        departmentName: agent.departmentId ? deptById.get(agent.departmentId) ?? null : null,
        lastTestedAt: sandbox ? (sandbox.lastMessageAt ?? sandbox.updatedAt) : null,
      };
    }));

    res.json({ data: enriched });
  } catch (err) {
    console.error("List AI agents error:", err);
    res.status(500).json({ error: "Failed to list AI agents" });
  }
});

// ─── Generate AI Employee Config from Wizard Answers ────────
router.post("/generate", authenticate, resolveTenant, requireActiveTenant(), requirePermissionOrRole("ai:employees:update", "ADMIN"), async (req: Request, res: Response) => {
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

    // Detect mode - default to AUTONOMOUS for AI agents
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
router.get("/:id", authenticate, resolveTenant, requireActiveTenant(), requirePermissionOrRole("ai:employees:read", "ADMIN"), async (req: Request, res: Response) => {
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

    // Dedupe by tenantToolId: one tenant-tool is one logical tool. Duplicate
    // permission rows can exist (the unique key includes the NULLABLE
    // departmentId, and Postgres treats NULLs as distinct, so a department-less
    // re-assign inserts a second row). Collapse them so the UI never shows the
    // same action twice. Keep the first (lowest id wins via createdAt order).
    const seenTenantTool = new Set<string>();
    const tools = toolPermissions
      .filter((tp) => {
        if (seenTenantTool.has(tp.tenantToolId)) return false;
        seenTenantTool.add(tp.tenantToolId);
        return true;
      })
      .map(tp => ({
        id: tp.tenantTool.catalogTool.id,
        tenantToolId: tp.tenantToolId,
        name: tp.tenantTool.catalogTool.name,
        slug: tp.tenantTool.catalogTool.slug,
        risk: tp.tenantTool.catalogTool.riskLevel,
        integration: tp.tenantTool.tenantIntegration.integration.name,
        enabled: tp.isAllowed,
        requireApproval: tp.requireApproval,
        // Per-agent semantics (Tier 2). NULL when the operator hasn't
        // customized - composeToolDescription falls back to catalog defaults.
        description: (tp as any).description ?? null,
        usageRule: (tp as any).usageRule ?? null,
      }));

    // Single calendar-capability signal so the builder can warn accurately
    // when calendar tools are enabled but the agent cannot actually book.
    const calendarCapability = await computeCalendarCapability(req.tenantId! as string, agent.id);

    res.json({
      data: {
        ...agent,
        knowledgeSources: agent.knowledgeBases.map((ak: any) => ak.knowledgeBase),
        tools,
        calendarCapability,
      },
    });
  } catch (err) {
    console.error("Get AI agent error:", err);
    res.status(500).json({ error: "Failed to get AI agent" });
  }
});

// Roles for which a funnel is REQUIRED at save time. These are
// outcome-driven roles whose conversations advance through pipeline
// stages - the funnel provides the stage goals + exit criteria.
// Roles NOT in this set (support, billing, custom, research) rely on
// `agent.goal` + `agent.successCriteria` instead and the funnel binding
// is optional.
const FUNNEL_REQUIRED_ROLES = new Set(["sales", "sdr", "recruiting"]);

function requiresFunnel(role: string | undefined | null): boolean {
  return FUNNEL_REQUIRED_ROLES.has(String(role || "").toLowerCase());
}

// ─── Create AI Agent ─────────────────────────────────────────
// Plan gates run BEFORE the handler:
//   requireEntitlement("ai.employee")     - is this capability sold on the plan?
//   requireCapacity("limit:ai_employees") - is there headroom under the limit?
// Both return a structured 402 the frontend can act on. Hiding the "New
// employee" button is not enforcement; this is.
router.post(
  "/",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  requirePermissionOrRole("ai:employees:create", "ADMIN"),
  requireEntitlement("ai.employee"),
  // Every employee counts, including DRAFT and PAUSED: a draft can be activated
  // at any moment, so excluding it would let an organization stage its way past
  // the limit and then flip them all on.
  requireCapacity("limit:ai_employees", (tenantId) => prisma.aIAgent.count({ where: { tenantId } })),
  async (req: Request, res: Response) => {
  try {
    const {
      name, role, description, avatarColor, status,
      tone, languages, style, channels, escalationRules,
      interactiveMessages, systemPrompt, model, provider,
      temperature, maxTokens, identity, goals, toneConfig,
      behavioral, persona, maxAutonomousMessages, maxAutonomousMinutes,
      confidenceThreshold, escalationMessage, conversationFlow, customGuardrails,
      departmentId, funnelId,
      goal, successCriteria, salesContext,
      knowledgeBaseIds, toolIds,
    } = req.body;

    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }

    // Role-driven guardrails: funnel-required roles still need a funnel
    // binding (pipelines depend on stage definitions). For text-driven
    // roles `goal` is preferred but not blocking - if missing we synthesize
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
    // An explicitly-ACTIVE create must satisfy the same readiness rule the
    // wizard enforces: at least one knowledge base. Otherwise any API client
    // can mint a live employee with nothing grounded to answer from.
    if (String(status || "").toUpperCase() === "ACTIVE" && (!Array.isArray(knowledgeBaseIds) || knowledgeBaseIds.length === 0)) {
      res.status(422).json({
        error: "knowledge_required_for_active",
        message: "An ACTIVE AI employee needs at least one knowledge base. Create as DRAFT or attach knowledgeBaseIds.",
      });
      return;
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
        // description column dropped per spec - caller-supplied value is ignored.
        avatarColor: avatarColor || "#7c5cfc",
        status: status || "DRAFT",
        tone: tone || "professional",
        languages: languages || { english: true },
        style: style || {},
        channels: channels || [],
        escalationRules: escalationRules || [],
        interactiveMessages: interactiveMessages || {},
        systemPrompt: systemPrompt || "",
        model: model || getDefaultModel(),
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
        // Cast matches the loosely-typed sibling Json fields (identity/behavioral
        // are `any` from req.body); null → SQL NULL, same as those.
        salesContext: normalizeSalesContext(salesContext) as any,
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
router.patch("/:id", authenticate, resolveTenant, requireActiveTenant(), requirePermissionOrRole("ai:employees:update", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.aIAgent.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });

    if (!existing) {
      res.status(404).json({ error: "AI agent not found" });
      return;
    }

    const { knowledgeBaseIds, toolIds, tools: toolsWithOverrides } = req.body;

    // Explicit column allowlist. NEVER rest-spread req.body into the update:
    // AIAgent has tenantId (cross-tenant move) and server-owned columns
    // (readinessReport, timestamps) that must not be client-settable.
    // `sharedPrompt`, `autonomousPrompt` and `escalationGates` are NOT here.
    //
    // Each existed only in this array. No UI sent them, no runtime read them -
    // their sole appearance anywhere in the codebase was as a string in this
    // list, which made them look supported. An API that accepts a field and
    // then ignores it is worse than one that rejects it: an integrator sets
    // `escalationGates`, gets a 200, and never learns the agent's escalation
    // behaviour did not change.
    //
    // The COLUMNS stay. Dropping them is a separate change after a
    // compatibility period, and `agent-field-reachability.test.ts` records
    // which fields actually reach the runtime so this set cannot quietly grow
    // again.
    const AGENT_EDITABLE_FIELDS = [
      "name", "role", "avatarColor", "status", "tone", "languages", "style",
      "channels", "escalationRules", "interactiveMessages", "systemPrompt",
      "model", "provider", "temperature",
      "maxTokens", "persona", "identity", "goals", "toneConfig", "behavioral",
      "salesContext", "goal", "successCriteria", "maxAutonomousMessages",
      "maxAutonomousMinutes", "confidenceThreshold", "escalationMessage",
      "conversationFlow", "customGuardrails", "capabilities",
      "behavioralAnchors", "departmentId", "funnelId",
    ] as const;
    const bodySrc = (req.body ?? {}) as Record<string, unknown>;
    const updateData: Record<string, any> = {};
    for (const k of AGENT_EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(bodySrc, k)) updateData[k] = bodySrc[k];
    }

    // Empty strings from the dropdowns mean "no binding" - coerce to NULL
    // so the FK constraint accepts it (Postgres won't accept "" as a cuid).
    if (Object.prototype.hasOwnProperty.call(updateData, "departmentId") && !updateData.departmentId) {
      updateData.departmentId = null;
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "funnelId") && !updateData.funnelId) {
      updateData.funnelId = null;
    }

    // Strip an unknown brand_archetype before it reaches the DB. The whole
    // persona object is replaced on update, so the frontend sends the merged
    // persona (gender/traits + brand_archetype) - we only validate the new key.
    if (Object.prototype.hasOwnProperty.call(updateData, "persona")) {
      updateData.persona = sanitizePersona(updateData.persona);
    }

    // Normalize the new goal / successCriteria fields the same way create
    // does - trim and convert empty strings to NULL.
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

    // Product Qualification Context (sales). Clean strings/arrays; an
    // all-empty object collapses to NULL so the prompt block is skipped.
    if (Object.prototype.hasOwnProperty.call(updateData, "salesContext")) {
      updateData.salesContext = normalizeSalesContext(updateData.salesContext);
    }

    // Role-driven guardrails on update - funnel binding is still required
    // for pipeline roles (Sales/SDR/Recruiting) because stages drive
    // behavior. `goal` is preferred but not blocking on PATCH - legacy
    // agents (pre-dating the field) and partial saves must still succeed.
    const merged = { ...existing, ...updateData };
    if (requiresFunnel(merged.role) && !merged.funnelId) {
      res.status(422).json({
        error: "funnel_required_for_role",
        message: `Role \`${merged.role}\` requires a funnel binding.`,
      });
      return;
    }

    // Saving from the editor means the creation wizard is finished - clear the
    // resumable progress pointer so the agent leaves the "resume setup" list
    // and is treated as a fully-configured employee.
    const wasIncompleteWizard = existing.status === "DRAFT" && (existing as any).builderStep != null;
    updateData.builderStep = null;

    // Only mark the employee ACTIVE once the creation wizard actually
    // completes (was an incomplete DRAFT, now being saved). Guarded so a
    // PAUSED agent edited later is never silently reactivated. Promotion
    // (auto OR explicit `status:"ACTIVE"` in the body) additionally requires
    // server-side readiness (real name + goal-or-funnel + >=1 knowledge
    // base) - an unready draft SAVES fine but stays DRAFT.
    const explicitStatus = Object.prototype.hasOwnProperty.call(updateData, "status");
    if (existing.status === "DRAFT" && (wasIncompleteWizard || (explicitStatus && updateData.status === "ACTIVE"))) {
      const promotedName = String(merged.name ?? "").trim();
      const hasIdentity = !!promotedName && promotedName !== "Untitled AI Employee";
      const hasGoalOrFunnel = requiresFunnel(merged.role)
        ? !!merged.funnelId
        : !!String(merged.goal ?? "").trim();
      const kbCount = Array.isArray(knowledgeBaseIds)
        ? knowledgeBaseIds.length
        : await prisma.aIAgentKnowledge.count({ where: { aiAgentId: req.params.id as string } });
      const ready = hasIdentity && hasGoalOrFunnel && kbCount > 0;
      if (explicitStatus && updateData.status === "ACTIVE" && !ready) {
        const missing = [
          ...(hasIdentity ? [] : ["name"]),
          ...(hasGoalOrFunnel ? [] : [requiresFunnel(merged.role) ? "funnel" : "goal"]),
          ...(kbCount > 0 ? [] : ["knowledge"]),
        ];
        res.status(422).json({ error: "draft_not_ready", missing });
        return;
      }
      if (!explicitStatus && wasIncompleteWizard) {
        if (ready) {
          updateData.status = "ACTIVE";
        } else {
          console.warn(`[ai-agents] draft ${req.params.id} saved but NOT promoted (readiness unmet: identity=${hasIdentity} goalOrFunnel=${hasGoalOrFunnel} kb=${kbCount})`);
        }
      }
    }

    const agent = await prisma.aIAgent.update({
      where: { id: req.params.id as string },
      data: updateData,
    });

    // Keep the linked RouterRule label in sync with the employee's name on a
    // rename - onboarding already does this at hire time; the editor must too, or
    // the routing/inbox label keeps showing the OLD name after a rename (part of
    // "the name change doesn't take effect").
    if (Object.prototype.hasOwnProperty.call(updateData, "name") && typeof agent.name === "string" && agent.name.trim() && agent.name !== existing.name) {
      await prisma.routerRule.updateMany({
        where: { tenantId: req.tenantId! as string, aiAgentId: agent.id },
        data: { name: agent.name.trim() },
      }).catch(() => { /* label sync is cosmetic - never fail the save on it */ });
    }

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
    // is kept for backward compat - when both are present, `tools` wins.
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
// `TenantTool` is enabled - both must be true for the bot to see the tool.
//
// Body: { isAllowed: boolean, requireApproval?: boolean }
router.put(
  "/:id/tools/:tenantToolId",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  requirePermissionOrRole("ai:tools:assign", "ADMIN"),
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

// ─── Reachability ────────────────────────────────────────────
// Runtime routing is exclusively the FlowCanvas graph: an ACTIVE employee
// with no agent-node targeting it NEVER receives a conversation. This
// endpoint tells the UI the truth so "go live" can't be a broken promise.
router.get("/:id/reachability", authenticate, resolveTenant, requireActiveTenant(), requirePermissionOrRole("ai:employees:read", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const agent = await prisma.aIAgent.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
      select: { id: true },
    });
    if (!agent) { res.status(404).json({ error: "AI agent not found" }); return; }

    const canvas = await (prisma as any).flowCanvas.findUnique({
      where: { tenantId: req.tenantId! as string },
      select: { nodes: true },
    });
    const nodes: any[] = Array.isArray(canvas?.nodes) ? (canvas!.nodes as any[]) : [];
    // A node routes to this employee when its routeType is (or defaults to)
    // "agent" and targetId matches - mirrors flow-executor's dispatchRoute.
    const reachable = nodes.some((n) => {
      const routeType = n?.data?.routeType ?? "agent";
      return routeType === "agent" && n?.data?.targetId === agent.id;
    });
    res.json({ data: { hasCanvas: !!canvas, reachable } });
  } catch (err) {
    console.error("Reachability check error:", err);
    res.status(500).json({ error: "Failed to check reachability" });
  }
});

// ─── Effective permissions (P1-8) ────────────────────────────
// The SINGLE source of truth for "what can this employee actually do right
// now": the runtime AND-rule - an operation is EFFECTIVE only when its
// capability is live (CONNECTED / bookable / KB attached) AND (for tool-governed
// domains) an AgentToolPermission grants it. Reuses the exact permissions bridge
// + capability world the kernel uses, so the UI never disagrees with the runtime.
router.get("/:id/effective-permissions", authenticate, resolveTenant, requireActiveTenant(), requirePermissionOrRole("ai:employees:read", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agentId = req.params.id as string;
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "AI agent not found" }); return; }

    ensureCapabilitiesRegistered();
    const [grants, world] = await Promise.all([
      loadToolGrants(tenantId, agentId),
      describeAllWorlds({ tenantId, aiAgentId: agentId, conversationId: "effective-permissions-probe" }),
    ]);
    const exposedOps = world.flatMap((w) => w.operations.map((o) => o.name));
    const allowed = deriveAllowedOperations(grants, exposedOps);
    const unrestricted = allowed.length === 0; // kernel convention: [] = all exposed ops
    const allowedSet = new Set(allowed);

    // Per-capability breakdown so the UI shows WHY an op is on/off.
    const capabilities = world.map((w) => ({
      capability: w.capability,
      summary: w.summary,
      live: w.operations.length > 0,
      operations: w.operations.map((o) => ({
        name: o.name,
        effective: unrestricted || allowedSet.has(o.name),
      })),
    }));

    res.json({
      data: {
        governed: grants.governed,
        allowedToolSlugs: [...grants.allowedToolSlugs],
        effectiveOperations: unrestricted ? exposedOps : allowed.filter((op) => op !== "__no_operations_granted__"),
        capabilities,
      },
    });
  } catch (err: any) {
    console.error("Effective-permissions error:", err?.message);
    res.status(500).json({ error: "Failed to compute effective permissions" });
  }
});

// ─── Test Chat ───────────────────────────────────────────────
router.post("/:id/test-chat", authenticate, resolveTenant, requireActiveTenant(), requirePermissionOrRole("ai:employees:read", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const agent = await prisma.aIAgent.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });

    if (!agent) {
      res.status(404).json({ error: "AI agent not found" });
      return;
    }

    const { message, writes, reset } = req.body as {
      message: string;
      writes?: "safe" | "real";
      reset?: boolean;
    };
    if (typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    // Runs the PRODUCTION employee (generateAIBotReply) against a real sandbox
    // conversation, so the test uses the same prompt, playbook, knowledge,
    // tone, tools, routing, policy and memory model as live traffic. The
    // previous implementation was a separate, thinner lookalike that could not
    // have matched production even in principle - see
    // sandbox-conversation.service for the full list of what it was missing.
    //
    // `history` is no longer accepted from the client: memory now comes from
    // the conversation itself, which is what production does. Trusting a
    // client-supplied transcript also meant the tester could not actually
    // verify that the employee remembers anything.
    const turn = await runSandboxTurn({
      tenantId: req.tenantId! as string,
      agentId: agent.id,
      userId: String((req as any).user?.userId || "admin"),
      message,
      writes: writes === "real" ? "real" : "safe",
      reset: reset === true,
    });

    if (!turn) {
      res.status(404).json({ error: "AI agent not found" });
      return;
    }

    // `diagnostics` answers "why did it answer this way?". It is derived from
    // what the turn actually did and contains no prompt text and no chain of
    // thought - only the employee, the sources, the tools and the decisions.
    res.json({ data: { reply: turn.reply, diagnostics: turn.diagnostics } });
  } catch (err) {
    console.error("Test chat error:", err);
    res.status(500).json({ error: "Failed to generate response" });
  }
});

// ─── Delete AI Agent ─────────────────────────────────────────
router.delete("/:id", authenticate, resolveTenant, requireActiveTenant(), requirePermissionOrRole("ai:employees:delete", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.aIAgent.findFirst({
      where: { id: req.params.id as string, tenantId: req.tenantId! as string },
    });

    if (!existing) {
      res.status(404).json({ error: "AI agent not found" });
      return;
    }

    // Router rules that point at this agent are deleted WITH it, in one
    // transaction. Blocking the delete instead (the old 409) made every
    // onboarding-created employee permanently undeletable, because onboarding
    // always seeds a RouterRule for the employee it creates.
    //
    // The rules cannot simply be left behind: the schema relation is
    // onDelete:SetNull, so an AI_AGENT rule would survive with aiAgentId=null
    // and route to nothing. `routeTarget` holds the same id for AI_AGENT rules
    // and has no FK at all, so it is matched explicitly.
    //
    // Queries stay tenant-scoped - the shared TenantGuard rejects any where
    // clause missing tenantId (it 500s rather than returning a result).
    const agentId = req.params.id as string;
    const tenantId = req.tenantId! as string;

    const removedRules = await prisma.$transaction(async (tx) => {
      const { count } = await tx.routerRule.deleteMany({
        where: {
          tenantId,
          OR: [{ aiAgentId: agentId }, { routeType: "AI_AGENT", routeTarget: agentId }],
        },
      });

      // Voice channels hold this agent id TWICE: as `ai_agent_id`, which the
      // schema nulls for us (onDelete: SetNull), and as a mirror inside the
      // `copilot_config` JSONB that the channel update route rewrites on every
      // save. Nulling the column alone left the mirror pointing at an agent
      // that no longer exists, and the copilot config loader read the blob - so
      // the binding looked live long after the employee was gone.
      //
      // Raw SQL because Prisma cannot remove a key from a JSONB column. Scoped
      // by tenant AND by the id being removed, so it cannot touch a channel
      // bound to a different agent.
      await tx.$executeRaw`
        UPDATE voice_channels vc
        SET copilot_config = vc.copilot_config - 'aiAgentId'
        FROM communication_channels cc
        WHERE cc.id = vc.communication_channel_id
          AND cc.tenant_id = ${tenantId}
          AND vc.copilot_config->>'aiAgentId' = ${agentId}
      `;

      await tx.aIAgent.delete({ where: { id: agentId } });
      return count;
    });

    res.json({ success: true, removedRoutingRules: removedRules });
  } catch (err) {
    console.error("Delete AI agent error:", err);
    res.status(500).json({ error: "Failed to delete AI agent" });
  }
});

export default router;
