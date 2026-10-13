import { Router, Request, Response } from "express";
import { prisma, authenticate, resolveTenant, requireActiveTenant, requirePermissionOrRole, requireEntitlement, requireCapacity, defaultIntegrationAccess, validateIntegrationAccess, integrationAccessChoices, readAgentToolLevels, writeAgentToolLevel, stricterLevel, allowedEmployeeLevels, writeAudit, AuditAction, type ToolLevel } from "@chatcenter/shared";
import { listWorkspaceTools } from "./tool-permissions";
import { catalogTool } from "../lib/catalog-tools-he";
import { readerLocale } from "../lib/reader-locale";
import { whereEmployeeAnswers } from "../services/employee-reach.service";

/**
 * Columns that still exist but are no longer part of the API. `channels`
 * ("Answers on") was display-only: who answers where is the playbook, which
 * GET /:id/reachability reports per channel. The column is dropped separately.
 */
function withoutInertFields<T extends Record<string, any>>(agent: T): Omit<T, "channels"> {
  const { channels: _channels, ...rest } = agent;
  return rest;
}
import { runSandboxTurn } from "../services/sandbox-conversation.service";
import { computeCalendarCapability } from "../services/calendar-capability.service";
import { generateResponse, getDefaultModel } from "../services/ai.service";
import { computeBehaviorState } from "../services/behavior-engine.service";
import { buildAgentPrompt, GENERATOR_BUILTIN_AGENT } from "../services/prompt-builder.service";
import { isBrandArchetype } from "../services/brand-archetypes";
import { loadToolGrants, deriveAllowedOperations } from "../services/agent-loop/permissions-bridge";
import { ensureCapabilitiesRegistered, describeAllWorlds } from "../services/capability-plane";
import { withoutWideDashes } from "../lib/wide-dash";
import { readReadinessStatus } from "../services/readiness-status";

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

    // ── Per-employee conversation counts ───────────────────────────────────
    //
    // WHAT COUNTS AS THIS EMPLOYEE'S WORK. Defined ONCE and spread into every
    // query below, because the last time a filter like this was added to one
    // query and not its sibling, a total disagreed with the list it totalled
    // and nothing looked wrong. Two exclusions here, each a different kind of
    // not-a-customer, and a third the platform already applies:
    //
    //   sandbox:   the owner's own test chat. `ensureSandboxConversation`
    //              writes assignedAiAgentId and status OPEN, and NOTHING ever
    //              closes those rows - `resetSandboxConversation` wipes the
    //              messages and leaves the conversation open - so each one is
    //              a permanent phantom, one per person who ever clicked Test.
    //              The prefix is the product's own definition of a sandbox
    //              conversation (sandbox-conversation.service.ts), and this
    //              file already queries it 25 lines below for `lastTestedAt`.
    //   isTest:    the rehearsal the team ran during setup, from their own
    //              numbers, before going live.
    //
    // `isTest` does NOT mean sandbox - they are separate flags and a sandbox
    // row has isTest=false - which is exactly why the old count missed it.
    //
    // IMPORTED HISTORY IS EXCLUDED, AND NOT HERE. `applyLiveByDefault` in
    // packages/shared/src/lib/prisma.ts injects `origin: "LIVE"` into every
    // bulk where-operation on Conversation, groupBy included. Writing it out
    // again would be worse than redundant: `mentionsOrigin()` treats any
    // mention of origin as "the caller has an explicit intent" and SUPPRESSES
    // the injection, so restating the platform's own default replaces a
    // guarantee with a hand-written copy of it that the next edit can break.
    // The guard's whole argument is that call sites should not have to
    // remember. So this one does not.
    const workloadScope = {
      tenantId: req.tenantId! as string,
      assignedAiAgentId: { not: null },
      customerExternalId: { not: { startsWith: "sandbox:" } },
      isTest: false,
    };

    // Three counts, one round trip each, all served by
    // @@index([tenantId, assignedAiAgentId]). Grouped rather than counted per
    // agent: `assignedAiAgentId` is a plain column with no Prisma relation, so
    // there is no `_count` to piggyback on and per-agent counts would add
    // 3 x N queries to a loop that already runs two per agent.
    const tally = async (extra: Record<string, unknown>) =>
      prisma.conversation
        .groupBy({ by: ["assignedAiAgentId"], where: { ...workloadScope, ...extra } as never, _count: { _all: true } })
        .catch(() => [] as Array<{ assignedAiAgentId: string | null; _count: { _all: number } }>);

    const [openGrouped, handledGrouped, aloneGrouped] = await Promise.all([
      // OPEN + WAITING. Not "being handled right now" - WAITING is usually
      // waiting on the customer - so it must not be captioned as live activity.
      tally({ status: { not: "CLOSED" } }),
      // Everything ever routed here, open or finished. The denominator.
      tally({}),
      // Finished, and finished without a person taking over.
      //
      // `isHandedOver` is the right field for THIS question and the wrong one
      // for "escalated", which is why no escalation column exists here. It has
      // six-plus writers - escalation, a human claiming the thread, the idle
      // sweeper, a human replying from their own phone - and they share only
      // one meaning: a person ended up driving. That is precisely the negation
      // of "alone", so it answers this and nothing else. The CAUSE would need
      // ConversationHandover.reason, which holds zero rows while five
      // conversations carry the flag, so a cause column would be a confident
      // zero for every employee.
      tally({ status: "CLOSED", isHandedOver: false }),
    ]);

    const byAgent = (rows: Array<{ assignedAiAgentId: string | null; _count: { _all: number } }>) => {
      const m = new Map<string, number>();
      for (const row of rows) if (row.assignedAiAgentId) m.set(row.assignedAiAgentId, row._count._all);
      return m;
    };
    const openByAgent = byAgent(openGrouped);
    const handledByAgent = byAgent(handledGrouped);
    const aloneByAgent = byAgent(aloneGrouped);

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
        ...withoutInertFields(agent),
        knowledgeSources: agent.knowledgeBases.map((ak: any) => ak.knowledgeBase),
        toolCount,
        departmentName: agent.departmentId ? deptById.get(agent.departmentId) ?? null : null,
        lastTestedAt: sandbox ? (sandbox.lastMessageAt ?? sandbox.updatedAt) : null,
        // Absent from the group-by means zero, not unknown: the queries cover
        // every non-null assignment in the tenant.
        //
        // NO LONGER THE SAME PREDICATE as the human count on
        // /api/permissions/users, and both files used to say it was. That one
        // filters on `status != CLOSED` alone. Sandbox rows cannot reach it -
        // the test chat sets assignedAiAgentId, never assignedAgentId - but
        // `isTest` and imported history DO count toward a person's total and
        // no longer count toward an employee's. If the two are rendered in one
        // column, that column is now comparing two slightly different things,
        // and the human side is the one that is wrong.
        openConversations: openByAgent.get(agent.id) ?? 0,
        // Lifetime, not windowed. "How much has this employee done" rather
        // than "this week", which is the question the roster asks; a windowed
        // version is a different field and should be named for its window
        // rather than quietly changing what this one means.
        handledConversations: handledByAgent.get(agent.id) ?? 0,
        // Closed with no human ever taking over. A ratio against
        // `handledConversations` is the honest denominator - both are drawn
        // from the same scope, so the division means something.
        resolvedAlone: aloneByAgent.get(agent.id) ?? 0,
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

    // Channels are not part of an employee: the playbook decides who answers
    // where (GET /:id/reachability says it per channel).

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
            content: `Wizard answers for the new AI agent:\n\n${wizardSummary}\n\nProduce a 2-4 sentence description in the user's language. Do not repeat the agent's name. Output only the description text.`,
          },
        ],
        temperature: 0.7,
        maxTokens: 200,
        metadata: { type: "agent_description", belMode: "generator" },
      });
      if (aiRes.content?.trim()) {
        description = withoutWideDashes(aiRes.content.trim());
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
    // Is the readiness report being made now? Read, never guessed (H7).
    const readiness = await readReadinessStatus(req.tenantId! as string, agent.id).catch(() => null);

    res.json({
      data: {
        ...withoutInertFields(agent),
        knowledgeSources: agent.knowledgeBases.map((ak: any) => ak.knowledgeBase),
        tools,
        calendarCapability,
        readinessStatus: readiness?.status ?? null,
        readinessStartedAt: readiness?.startedAt ?? null,
        readinessFinishedAt: readiness?.finishedAt ?? null,
        readinessError: readiness?.error ?? null,
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
      tone, languages, style, escalationRules,
      interactiveMessages, systemPrompt, model, provider,
      temperature, maxTokens, identity, goals, toneConfig,
      behavioral, persona, maxAutonomousMessages, maxAutonomousMinutes,
      confidenceThreshold, escalationMessage, conversationFlow, customGuardrails,
      departmentId, funnelId,
      goal, successCriteria, salesContext,
      knowledgeBaseIds, toolIds, integrationAccess,
    } = req.body;

    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }

    // The systems this employee may use: the creator's choice, checked, or
    // every system the workspace has today (one connected later stays off).
    let access: string[];
    if (integrationAccess !== undefined) {
      const v = await validateIntegrationAccess(req.tenantId! as string, integrationAccess);
      if (!v.ok) {
        res.status(422).json({ error: "Unknown system in integrationAccess", field: "integrationAccess", code: "INVALID_INTEGRATION_ACCESS", invalid: v.invalid });
        return;
      }
      access = v.keys;
    } else {
      access = await defaultIntegrationAccess(req.tenantId! as string);
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
        integrationAccess: access,
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
        maxAutonomousMessages: maxAutonomousMessages ?? 30,
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

    res.status(201).json({ data: withoutInertFields(agent) });
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
      "escalationRules", "interactiveMessages", "systemPrompt",
      "model", "provider", "temperature",
      "maxTokens", "persona", "identity", "goals", "toneConfig", "behavioral",
      "salesContext", "goal", "successCriteria", "maxAutonomousMessages",
      "maxAutonomousMinutes", "confidenceThreshold", "escalationMessage",
      "conversationFlow", "customGuardrails", "capabilities",
      "behavioralAnchors", "departmentId", "funnelId", "noSkillPolicy",
    ] as const;
    const bodySrc = (req.body ?? {}) as Record<string, unknown>;
    const updateData: Record<string, any> = {};
    for (const k of AGENT_EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(bodySrc, k)) updateData[k] = bodySrc[k];
    }

    // "Says it's AI when asked" (A3b): a boolean kept inside persona, merged so
    // a persona edit that does not mention it keeps it.
    if (Object.prototype.hasOwnProperty.call(bodySrc, "disclosesAi")) {
      if (typeof bodySrc.disclosesAi !== "boolean") {
        res.status(400).json({ error: "disclosesAi must be true or false", field: "disclosesAi", code: "INVALID_DISCLOSES_AI" });
        return;
      }
      const current = updateData.persona === undefined
        ? (await prisma.aIAgent.findFirst({ where: { id: req.params.id as string, tenantId: req.tenantId! as string }, select: { persona: true } }))?.persona
        : updateData.persona;
      const base = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
      updateData.persona = { ...base, disclosesAi: bodySrc.disclosesAi };
    } else if (updateData.persona && typeof updateData.persona === "object" && !Array.isArray(updateData.persona) && !("disclosesAi" in updateData.persona)) {
      const prev = (await prisma.aIAgent.findFirst({ where: { id: req.params.id as string, tenantId: req.tenantId! as string }, select: { persona: true } }))?.persona as any;
      if (prev && typeof prev.disclosesAi === "boolean") updateData.persona = { ...updateData.persona, disclosesAi: prev.disclosesAi };
    }

    // Handover rules (A2): the array is replaced whole, so its shape is checked
    // here; a malformed rule reached the prompt as "undefined".
    if (Object.prototype.hasOwnProperty.call(bodySrc, "escalationRules")) {
      const rules = bodySrc.escalationRules;
      const ok = Array.isArray(rules) && rules.length <= 50 && rules.every((r: any) =>
        r && typeof r === "object" && !Array.isArray(r)
        && typeof r.label === "string" && r.label.trim().length > 0 && r.label.length <= 300
        && (r.type === undefined || typeof r.type === "string")
        && (r.value === undefined || r.value === null || typeof r.value === "string" || typeof r.value === "number")
        && (r.enabled === undefined || typeof r.enabled === "boolean"));
      if (!ok) {
        res.status(400).json({ error: "escalationRules must be a list of {label, type?, value?, enabled?} (at most 50, label 1-300 characters)", field: "escalationRules", code: "INVALID_ESCALATION_RULES" });
        return;
      }
      updateData.escalationRules = (rules as any[]).map((r) => ({ ...r, label: String(r.label).trim() }));
    }

    // The systems this employee may use: a checked list of catalog slugs and
    // "custom:<id>" keys. An unknown key is refused (stored, it would gate nothing).
    if (Object.prototype.hasOwnProperty.call(bodySrc, "integrationAccess")) {
      const v = await validateIntegrationAccess(req.tenantId! as string, bodySrc.integrationAccess);
      if (!v.ok) {
        res.status(422).json({ error: "Unknown system in integrationAccess", field: "integrationAccess", code: "INVALID_INTEGRATION_ACCESS", invalid: v.invalid });
        return;
      }
      updateData.integrationAccess = v.keys;
    }

    // What the employee does when no business skill fits. A closed list: an
    // unknown value is refused, not stored (it would change nothing at runtime).
    if (Object.prototype.hasOwnProperty.call(updateData, "noSkillPolicy") &&
        !["answer_from_knowledge", "always_handover", "knowledge_only"].includes(updateData.noSkillPolicy)) {
      res.status(422).json({ error: "noSkillPolicy must be answer_from_knowledge, always_handover or knowledge_only", field: "noSkillPolicy" });
      return;
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

    res.json({ data: withoutInertFields(agent) });
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
// ─── The employee's own tool levels (A1, Omer 2026-10-13) ──────────────────
//
// Equal to or stricter than the workspace (Integrations), never looser.
// Enforced at dispatch in the shared gate (evaluatePolicies, Layer 4); these
// two routes read and set it.

function workspaceLevelOf(row: { enabled: boolean; requiresApproval: boolean }): ToolLevel {
  if (!row.enabled) return "never";
  return row.requiresApproval ? "ask" : "execute";
}

router.get("/:id/tools", authenticate, resolveTenant, requireActiveTenant(), requirePermissionOrRole("ai:employees:read", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const agent = await prisma.aIAgent.findFirst({ where: { id: req.params.id as string, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "AI employee not found" }); return; }
    const [rows, levels, locale] = await Promise.all([
      listWorkspaceTools(tenantId),
      readAgentToolLevels(tenantId, agent.id),
      readerLocale(req),
    ]);
    // Only what can run: built-ins, and the tools of integrations that are
    // CONNECTED. A disconnected (or failing) store's tools cannot run, so
    // listing ~80 of them only confuses. An own level already stored for one
    // stays stored and applies again once the store reconnects.
    const tools = rows.filter((r) => !r.integration || r.integrationConnected === true).map((r) => {
      const workspaceLevel = workspaceLevelOf(r);
      const own = levels[r.toolName] ?? null;
      const employeeLevel: ToolLevel = own ?? workspaceLevel;
      const slug = r.toolName.includes(".") ? r.toolName.slice(r.toolName.indexOf(".") + 1) : r.toolName;
      const label = r.integration ? catalogTool(r.integration, { slug, name: slug, description: r.description }, locale) : null;
      return {
        toolName: r.toolName,
        label: label?.name ?? r.toolName,
        description: label?.description ?? r.description,
        integration: r.integration,
        riskGroup: r.riskGroup,
        workspaceLevel,
        // What this employee has chosen, or null for "the same as the workspace".
        ownLevel: own,
        // What actually applies: the stricter of the two, so a workspace that
        // tightened after the employee was set still wins.
        employeeLevel: stricterLevel(workspaceLevel, employeeLevel),
        allowedLevels: allowedEmployeeLevels(workspaceLevel),
      };
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ data: { tools } });
  } catch (err) {
    console.error("Employee tools error:", err);
    res.status(500).json({ error: "Failed to list the employee's tools" });
  }
});

router.put("/:id/tool-levels/:toolName", authenticate, resolveTenant, requireActiveTenant(), requirePermissionOrRole("ai:employees:update", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const toolName = String(req.params.toolName);
    const level = req.body?.level as ToolLevel | null;
    if (level !== null && level !== "execute" && level !== "ask" && level !== "never") {
      res.status(400).json({ error: "level must be execute, ask, never or null", code: "BAD_LEVEL" }); return;
    }
    const agent = await prisma.aIAgent.findFirst({ where: { id: req.params.id as string, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "AI employee not found" }); return; }
    const row = (await listWorkspaceTools(tenantId)).find((r) => r.toolName === toolName);
    if (!row) { res.status(404).json({ error: `unknown tool "${toolName}"`, code: "UNKNOWN_TOOL" }); return; }
    const workspaceLevel = workspaceLevelOf(row);
    const wanted: ToolLevel = level ?? workspaceLevel;
    if (!allowedEmployeeLevels(workspaceLevel).includes(wanted)) {
      res.status(422).json({
        error: `The workspace sets "${toolName}" to ${workspaceLevel}; an AI employee may only be the same or stricter.`,
        code: "LOOSER_THAN_WORKSPACE",
        workspaceLevel,
        allowedLevels: allowedEmployeeLevels(workspaceLevel),
      });
      return;
    }
    // Equal to the workspace is stored as "no own level", so the employee
    // follows the workspace if it later loosens back.
    const stored = wanted === workspaceLevel ? null : wanted;
    const levels = await writeAgentToolLevel(tenantId, agent.id, toolName, stored, (req as any).user?.userId);
    void writeAudit({
      tenantId,
      actorType: "user",
      actorId: (req as any).user?.userId ?? null,
      action: AuditAction.PERMISSION_CHANGED,
      targetType: "ai_agent",
      targetId: agent.id,
      metadata: { change: "employee_tool_level", tool: toolName, workspaceLevel, level: wanted },
    });
    res.json({ data: { toolName, workspaceLevel, ownLevel: levels[toolName] ?? null, employeeLevel: wanted } });
  } catch (err) {
    console.error("Set employee tool level error:", err);
    res.status(500).json({ error: "Failed to set the tool level" });
  }
});

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
    // Where it answers, per channel the workspace has (the playbook decides;
    // AIAgent.channels is display-only and does not).
    const channels = await whereEmployeeAnswers(req.tenantId! as string, agent.id);
    res.json({ data: { hasCanvas: !!canvas, reachable, channels } });
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
/**
 * GET /api/ai-agents/:id/integration-access - the systems this employee may
 * use (`allowed`) and every system and custom tool of the workspace it could
 * be given (`choices`). Write it with PATCH /:id { integrationAccess }.
 */
router.get("/:id/integration-access", authenticate, resolveTenant, requireActiveTenant(), requirePermissionOrRole("ai:employees:read", "ADMIN"), async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agent = await prisma.aIAgent.findFirst({ where: { id: String(req.params.id), tenantId }, select: { integrationAccess: true } });
    if (!agent) {
      res.status(404).json({ error: "AI agent not found" });
      return;
    }
    const choices = await integrationAccessChoices(tenantId);
    res.json({ data: { allowed: agent.integrationAccess ?? [], choices } });
  } catch (err) {
    console.error("[ai-agents] integration-access failed:", (err as Error)?.message);
    res.status(500).json({ error: "Could not load the employee's systems" });
  }
});

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

      // ── The routing canvas ──────────────────────────────────────────────
      //
      // THE THIRD HIDING PLACE, and the only one that keeps causing damage
      // after the delete rather than leaving a fixed amount behind.
      // `FlowCanvas.nodes` holds `{ targetId, routeType: "agent" }`, and
      // flow-executor.service.ts writes that targetId straight onto
      // `Conversation.assignedAiAgentId` for every inbound that reaches the
      // node. Leave it pointing at a deleted employee and the canvas keeps
      // stamping a dead id onto NEW conversations for as long as nobody looks.
      //
      // It hid the way the voice mirror did, one level further down. The
      // schema comment at FlowCanvas.nodes enumerates the types as
      // "channel"|"rule"|"flow"|"agent"|"department". The types that actually
      // exist are `start` and `route_target`, so searching for an "agent" node
      // - which is what that comment instructs - finds nothing and reads as
      // proof the canvas is clean. Matched on routeType, not on node type.
      //
      // The node is neutralised rather than removed: deleting it would break
      // the edges that point at it and silently reshape the tenant's routing
      // graph, which is a bigger decision than deleting one employee.
      await tx.$executeRaw`
        UPDATE flow_canvas
        SET nodes = (
          SELECT jsonb_agg(
            CASE
              WHEN n->'data'->>'targetId' = ${agentId}
               AND n->'data'->>'routeType' = 'agent'
              THEN jsonb_set(n, '{data,targetId}', 'null'::jsonb)
              ELSE n
            END
          )
          FROM jsonb_array_elements(nodes::jsonb) n
        )
        WHERE tenant_id = ${tenantId}
          AND nodes::jsonb @> ${`[{"data":{"targetId":"${agentId}","routeType":"agent"}}]`}::jsonb
      `;

      // ── Per-agent tool grants ───────────────────────────────────────────
      //
      // Deleted with the employee. A grant saying "this agent may call
      // shopify.process_refund" describes an agent that no longer exists; it
      // is configuration, not history, and `AIAgentKnowledge` already cascades
      // for exactly this reason. No FK here, so it is done by hand.
      const { count: removedToolGrants } = await tx.agentToolPermission.deleteMany({
        where: { tenantId, aiAgentId: agentId },
      });

      // ── Usage history: the ids STAY DANGLING, deliberately ──────────────
      //
      // `UsageLog.aiAgentId` and `ConversationUsageAggregate.aiAgentId` are NOT
      // cleared. Deleting an employee does not mean it never ran or never cost
      // anything, and nulling those columns would erase which employee incurred
      // which spend - the profitability ledger and the per-employee cost
      // rollups both key on it.
      //
      // This codebase has already paid for that lesson once, on ToolExecution:
      // disconnecting an integration cascaded away the audit log of everything
      // the AI had done through it. The fix was SetNull plus a denormalised
      // name, under the note that an audit trail a normal UI action can delete
      // is not an audit trail. Same shape, same answer.
      //
      // NOT EVERY DANGLING ID IS A BUG. Some are the only remaining evidence
      // that something happened.
      //
      // What those rows cannot do once the employee is gone is NAME it. The
      // right fix is a denormalised `aiAgentName` column written at insert
      // time, as ToolExecution has - that needs a migration, so the name is
      // captured here instead, in the transaction that would otherwise lose it.
      // Delete-time capture is strictly weaker than write-time: it is atomic
      // with the delete, but nothing recovers rows if this statement is ever
      // removed. Replace it with a real column when a migration is next open.
      await tx.$executeRaw`
        UPDATE usage_logs
        SET metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ aiAgentName: existing.name, aiAgentDeletedAt: new Date().toISOString() })}::jsonb
        WHERE tenant_id = ${tenantId} AND ai_agent_id = ${agentId}
      `;

      // ── Live conversations: released, not closed and not reassigned ─────
      //
      // Omer's ruling, and the screen says it in these words: "14 people are
      // mid-conversation with it. They will stop getting replies and will wait
      // unassigned until someone claims them." That sentence is the spec, so
      // the end state has to be one a human actually meets in the inbox.
      //
      // `handledBy` IS CLEARED, and nulling `assignedAiAgentId` alone would
      // have made the sentence false. `isAiManaged()` in the frontend and
      // `automatedOnly` in conversation.service both read
      // (handledBy in [ai_agent, flow]) AND !isHandedOver AND !assignedAgentId
      // - a released conversation still saying "ai_agent" satisfies all three,
      // so it would file itself under "the AI is handling this" and sit there
      // while nobody replied. Null puts it back in the unrouted state the
      // worker already documents as "stays in inbox for manual pickup".
      //
      // `isHandedOver` is deliberately NOT set. No human has taken it - that
      // latch is what `claim` flips, and setting it here would make the
      // conversation look owned by someone who has not arrived.
      //
      // LIVE ONES ONLY. A CLOSED conversation keeps its `assignedAiAgentId`,
      // because on a finished thread that id is the record of WHICH employee
      // handled it - evidence, by the same rule that keeps the usage rows. It
      // is also what the per-employee handled/resolved counts read. Releasing
      // all 82 rather than the 14 that are live would erase the history to tidy
      // the hazard. The origin filter is injected by applyLiveByDefault, so
      // imported threads are excluded without being mentioned.
      const { count: releasedConversations } = await tx.conversation.updateMany({
        where: { tenantId, assignedAiAgentId: agentId, status: { not: "CLOSED" } },
        data: { assignedAiAgentId: null, handledBy: null },
      });

      // ── Dead instructions elsewhere ─────────────────────────────────────
      //
      // Both are READ to make a live decision, which is what separates them
      // from the history above: a dead instruction keeps acting.
      //   Tenant.defaultAgentId   router-rules.ts uses it as the tenant-wide
      //                           routing fallback - the canvas problem at
      //                           tenant scope.
      //   KnowledgeBase.scopeAgentId  knowledge.service.ts compares it to the
      //                           asking agent to decide who may read a base;
      //                           left dangling it makes a base invisible to
      //                           everyone, permanently.
      // Neither has an FK. Both are empty on this estate today, which is the
      // condition under which every other item in this file was wrong for
      // months - empty is untested, not safe.
      await tx.tenant.updateMany({ where: { id: tenantId, defaultAgentId: agentId }, data: { defaultAgentId: null } });
      await tx.knowledgeBase.updateMany({ where: { tenantId, scopeAgentId: agentId }, data: { scopeAgentId: null } });

      // ── A connected calendar the employee owned ─────────────────────────
      //
      // The link is cleared; the Google account stays connected to the tenant,
      // owned by nobody, for a human to re-attach. Same choice as the
      // conversations: leave the external thing intact and unowned rather than
      // destroy it. Deleting the row would sever a live third-party grant to
      // tidy a foreign key, and reassigning it would invent an owner nobody
      // picked.
      //
      // This needed migration 20260923120000 - the column was NOT NULL, so
      // until then there was no null to write and the id was left dangling.
      // Dangling was worse than it sounds: the only admin listing takes
      // `aiAgentId` as a required parameter, so an orphaned row was not merely
      // unowned but UNREACHABLE - the merchant kept a live Google grant with no
      // route to see or disconnect it. `scheduler-admin.ts` now accepts the
      // parameter as optional so an unowned account can be found.
      await tx.calendarAccount.updateMany({
        where: { tenantId, aiAgentId: agentId },
        data: { aiAgentId: null },
      });

      await tx.aIAgent.delete({ where: { id: agentId } });
      return { removedRules: count, removedToolGrants, releasedConversations };
    });

    res.json({
      success: true,
      removedRoutingRules: removedRules.removedRules,
      removedToolGrants: removedRules.removedToolGrants,
      // The number the confirmation dialog says out loud. Returned so the
      // screen reports what actually happened rather than the count it
      // predicted before the delete ran.
      releasedConversations: removedRules.releasedConversations,
    });
  } catch (err) {
    console.error("Delete AI agent error:", err);
    res.status(500).json({ error: "Failed to delete AI agent" });
  }
});

export default router;
