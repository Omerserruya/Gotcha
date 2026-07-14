import { Router, Request, Response } from "express";
import { z } from "zod";
import * as crypto from "crypto";
import { promises as dns } from "dns";
import * as bcrypt from "bcryptjs";
import { prisma, authenticate, resolveTenant, requireRole, validate, trackAIUsage, meterAiUnits } from "@chatcenter/shared";
import { sendActivationConfirmation, createMagicLink, sendOnboardingInvite, sendTeammateInvite, sendIntegrationRequestEmail } from "../services/notification.service";
import { scheduleOnboardingNudge } from "../services/nudge-engine.service";
import { syncDiscoveryRecommendations, listRecommendations, setRecommendationStatus, addStoreInspectionRecs, reconcileConnectSystemRecs } from "../services/recommendations.service";
import OpenAI from "openai";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";
const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "http://billing:4009";

/**
 * fetch() with a hard timeout (T-3). A hung AI or billing hop must never hang
 * an onboarding request - we abort after `ms` and surface it as an ordinary
 * network failure the callers already handle (null / thrown Error).
 */
async function fetchWithTimeout(url: string, init: RequestInit, ms = 20000): Promise<globalThis.Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Provision the billing BillableEntity for a freshly-activated tenant. The
 * trial itself starts later, when the admin adds a card on file (card-before-
 * trial: billing's payment-methods route auto-starts the trial on first card).
 * Best-effort - billing is a soft dependency, so a failure here is logged but
 * never blocks tenant activation. Idempotent (ensure-entity is a no-op if the
 * entity already exists).
 */
async function provisionBilling(tenantId: string): Promise<void> {
  const res = await fetchWithTimeout(`${BILLING_SERVICE_URL}/api/internal/billing/ensure-entity`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-key": process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026",
    },
    body: JSON.stringify({ tenantId }),
  }, 10000);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`billing ensure-entity failed (${res.status}): ${body}`);
  }
}

async function callAIGenerateConfigs(tenantId: string, authHeader: string): Promise<void> {
  const res = await fetchWithTimeout(`${AI_SERVICE_URL}/api/ai-assist/generate-configs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": authHeader },
  }, 30000);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AI service generate-configs failed (${res.status}): ${body}`);
  }
}

// The recommended employee (Movement 4 / Movement 7) → the department name that
// makes the config generator produce a role-appropriate identity, and the
// canonical AIAgent.role. Keeps the employee the owner "hired" consistent with
// the one that actually gets created.
const RECOMMENDATION_DEPT_NAME: Record<string, string> = {
  customer_support: "Customer Support",
  sales: "Sales",
  reception: "Customer Support",
  conversation_intelligence: "Customer Support",
};
const RECOMMENDATION_ROLE: Record<string, string> = {
  customer_support: "customer_support",
  sales: "sales",
  reception: "customer_support",
  conversation_intelligence: "customer_support",
};

/**
 * "Bring them on board" - create the actual AIAgent for the recommended
 * employee by REUSING the existing config generator, then rename it so the
 * employee that joins is the exact one the owner just met in Movement 7.
 *
 * Generation is deterministic (no LLM - pure static mapping over the confirmed
 * BusinessProfile), so this is cheap enough to run synchronously on activation:
 * the employee genuinely EXISTS the moment the owner lands, which is the whole
 * point ("it already joined the company", not "now configure one").
 *
 * Best-effort rename: only relabels when this is a fresh single-employee tenant
 * (the onboarding case), so it never touches a tenant that already had agents.
 */
async function hireRecommendedEmployee(tenantId: string, authHeader: string, rec: any): Promise<void> {
  await callAIGenerateConfigs(tenantId, authHeader);

  const agents = await prisma.aIAgent.findMany({ where: { tenantId }, select: { id: true, role: true, persona: true, customGuardrails: true }, orderBy: { createdAt: "desc" } });
  if (agents.length === 0) return;

  const displayName = typeof rec?.employeeName === "string" && rec.employeeName.trim()
    ? rec.employeeName.trim().slice(0, 120)
    : null;
  const role = rec?.employeeRole && RECOMMENDATION_ROLE[rec.employeeRole] ? RECOMMENDATION_ROLE[rec.employeeRole] : null;

  // Target the employee the owner just hired. With a single fresh employee that's
  // it; on a multi-department generate we rename the one whose role matches the
  // recommendation, else the most recently created - so the owner's chosen name
  // is ALWAYS applied (the old `agents.length !== 1 → return` silently dropped it
  // and left the generator's "<Dept> AI Employee" default - the name-bug).
  const target = (role ? agents.find((a) => a.role === role) : null) || agents[0]!;
  const agentId = target.id;

  const data: Record<string, unknown> = {};
  if (displayName) data.name = displayName;
  if (role) data.role = role;

  // Movement 8 - apply the persona the owner tuned by CHATTING with the employee
  // before deploy as STRUCTURED fields (persona.customAttributes + guardrails),
  // not a systemPrompt text append, so the prompt-builder renders it the same
  // way it renders the transplanted brand - and the two compose cleanly.
  const tuned = rec?.tunedPersona as { tone?: string; personality?: string; focus?: string; goal?: string; successCriteria?: string[]; instructions?: string[] } | undefined;
  if (tuned) {
    const VALID_TONES = new Set(["professional", "friendly", "casual", "formal"]);
    if (tuned.tone && VALID_TONES.has(tuned.tone)) data.tone = tuned.tone;

    // The owner CONFIRMED the goal + success criteria in the conversational build
    // - these are first-class prompt fields, so they win over the generated ones.
    if (typeof tuned.goal === "string" && tuned.goal.trim()) data.goal = tuned.goal.trim().slice(0, 2000);
    if (Array.isArray(tuned.successCriteria) && tuned.successCriteria.length) {
      data.successCriteria = tuned.successCriteria
        .filter((s): s is string => typeof s === "string" && !!s.trim())
        .map((s) => `• ${s.trim()}`)
        .join("\n");
    }

    const currentPersona = (target.persona as any) || {};
    const attrs: Record<string, string> = { ...(currentPersona.customAttributes || {}) };
    if (tuned.focus && tuned.focus.trim()) attrs["Primary focus"] = tuned.focus.trim();
    if (tuned.personality && tuned.personality.trim()) attrs["Personality (owner-tuned)"] = tuned.personality.trim();
    if (Object.keys(attrs).length) data.persona = { ...currentPersona, customAttributes: attrs };

    const instr = Array.isArray(tuned.instructions)
      ? tuned.instructions.filter((i): i is string => typeof i === "string" && !!i.trim()).map((s) => s.trim())
      : [];
    if (instr.length) {
      const existingGuards = Array.isArray(target.customGuardrails)
        ? (target.customGuardrails as unknown[]).filter((g): g is string => typeof g === "string")
        : [];
      data.customGuardrails = [...existingGuards, ...instr.map((i) => `Owner instruction: ${i}`)];
    }
  }

  if (Object.keys(data).length) {
    await prisma.aIAgent.update({ where: { id: agentId }, data });
  }
  if (displayName) {
    await prisma.routerRule.updateMany({
      where: { tenantId, aiAgentId: agentId },
      data: { name: displayName },
    }).catch(() => { /* label sync is cosmetic */ });
  }
}

const router = Router();
router.use(authenticate, resolveTenant);

// ─── Onboarding AI Chat via LLM ────────────────────────────

const LOCALE_NAMES: Record<string, string> = {
  en: "English",
  he: "Hebrew",
};

function buildOnboardingSystemPrompt(locale: string): string {
  const lang = LOCALE_NAMES[locale] || "English";
  return `You are the onboarding assistant for ChatCenter. You are configuring the AI copilot for a business.

IMPORTANT RULES - follow these exactly:
1. You MUST respond ONLY with a valid JSON object. No text outside the JSON.
2. Format: {"reply": "your message here", "readyToGenerate": false}
3. You MUST write your reply in **${lang}**. All text in the "reply" field must be in ${lang}.
4. On the VERY FIRST message, introduce yourself briefly, mention the business name and their departments from the context below, then ask your first question about communication tone.
5. Ask ONE question at a time. Keep it short (2-4 sentences max).
6. You need to understand these 4 things:
   a) Communication tone - formal vs casual vs friendly
   b) Agent workflow - when should conversations be transferred to a specialist or supervisor
   c) Common customer topics - what do customers usually ask about
   d) Restrictions - topics agents should never handle without supervisor approval
7. After collecting answers on at least 3 of these areas, set "readyToGenerate": true and tell the user you're generating their configs.
8. If the user says "skip", "just do it", "go ahead", "I don't care", or anything impatient - immediately set "readyToGenerate": true.
9. Do NOT use emojis. Do NOT give generic greetings. Do NOT ask "how can I help you". You already know what to do - configure their AI.
10. Do NOT mention buttons or UI elements.
11. Use **bold** for emphasis in your replies.`;
}

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
  if (openaiClient) return openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseURL = process.env.OPENAI_BASE_URL || undefined;
  openaiClient = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return openaiClient;
}

interface ChatReplyResult {
  reply: string;
  readyToGenerate: boolean;
}

interface BusinessContext {
  organizationName: string;
  industry: string;
  businessDescription: string;
  businessPriority: string;
  estimatedDailyConversations?: number;
  numberOfAgents?: number;
  departments: {
    name: string;
    description?: string | null;
    slaTarget?: number | null;
    escalateOnSlaBreach?: boolean;
    autoRepliesEnabled?: boolean;
    queueMode?: string;
  }[];
}

async function getOnboardingChatReply(
  tenantId: string,
  message: string,
  businessContext: BusinessContext,
  chatHistory: Array<{ role: string; content: string }>,
  locale: string = "en",
): Promise<ChatReplyResult> {
  const client = getOpenAIClient();
  if (!client) {
    return fallbackReply(message, businessContext, chatHistory, locale);
  }

  const deptDetails = businessContext.departments.map(d => {
    const parts = [`  - **${d.name}**`];
    if (d.description) parts.push(`description="${d.description}"`);
    if (d.slaTarget) parts.push(`SLA=${d.slaTarget}min`);
    if (d.escalateOnSlaBreach) parts.push(`escalates on SLA breach`);
    if (d.autoRepliesEnabled) parts.push(`auto-replies ON`);
    if (d.queueMode) parts.push(`queue=${d.queueMode}`);
    return parts.join(", ");
  }).join("\n");

  const contextBlock = `## Business Profile
- Organization: ${businessContext.organizationName}
- Industry: ${businessContext.industry}
- What they do: ${businessContext.businessDescription}
- Business Priority: ${businessContext.businessPriority}
- Estimated daily conversations: ${businessContext.estimatedDailyConversations || "unknown"}
- Number of human agents: ${businessContext.numberOfAgents || "unknown"}

## Departments
${deptDetails}`;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: buildOnboardingSystemPrompt(locale) + "\n\n" + contextBlock },
  ];

  // Add chat history
  for (const msg of chatHistory) {
    messages.push({
      role: msg.role === "user" ? "user" : "assistant",
      content: msg.role === "assistant"
        ? JSON.stringify({ reply: msg.content, readyToGenerate: false })
        : msg.content,
    });
  }

  // Add current message
  messages.push({ role: "user", content: message });

  try {
    const model = process.env.ONBOARDING_CHAT_MODEL || "gpt-4o-mini";
    const response = await client.chat.completions.create({
      model,
      temperature: 0.7,
      max_tokens: 512,
      response_format: { type: "json_object" },
      messages,
    });

    // Track usage via shared helper (fire-and-forget, never block onboarding)
    if (response.usage) {
      trackAIUsage({
        tenantId,
        feature: "onboarding",
        model,
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      }).catch((err: any) => console.error("[Onboarding] Usage tracking failed:", err.message));

      // Meter AI Units - onboarding chat is no longer an enforcement exception.
      meterAiUnits({
        tenantId,
        model,
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      }).catch((err: any) => console.error("[Onboarding] Unit metering failed:", err.message));

      // Audit row (T-6, CLAUDE.md §5): the grandfathered auth-side LLM calls now
      // leave an audit trail with the bounded prompt + context, not just usage.
      prisma.auditLog.create({
        data: {
          tenantId,
          actorType: "ai",
          action: "ai.responded",
          targetType: "onboarding",
          metadata: {
            feature: "onboarding_chat",
            model,
            tokens: { prompt: response.usage.prompt_tokens, completion: response.usage.completion_tokens, total: response.usage.total_tokens },
            inputPreview: message.slice(0, 500),
            context: { organization: businessContext.organizationName, industry: businessContext.industry, departments: businessContext.departments.map((d) => d.name) },
          },
        },
      }).catch((err: any) => console.error("[Onboarding] Audit logging failed:", err.message));
    }

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return fallbackReply(message, businessContext, chatHistory, locale);
    }

    const parsed = JSON.parse(content);
    return {
      reply: parsed.reply || "I'm having trouble processing that. Could you try again?",
      readyToGenerate: !!parsed.readyToGenerate,
    };
  } catch (err: any) {
    console.error("Onboarding chat LLM error:", err.message);
    return fallbackReply(message, businessContext, chatHistory, locale);
  }
}

// Simple fallback when no OpenAI key is configured
function fallbackReply(
  _message: string,
  ctx: BusinessContext,
  chatHistory: Array<{ role: string; content: string }>,
  locale: string = "en",
): ChatReplyResult {
  const deptNames = ctx.departments.map(d => d.name).join(", ");
  const exchanges = chatHistory.filter(m => m.role === "user").length;

  if (locale === "he") {
    return fallbackReplyHebrew(ctx, deptNames, exchanges);
  }

  if (exchanges === 0) {
    return {
      reply: `Hi! I'll help set up your AI copilot for **${ctx.organizationName}**.\n\nYou're in **${ctx.industry}** with ${ctx.departments.length} department(s): ${deptNames}.\n\nQuick question - **what communication style do your customers expect?** Formal, casual, or somewhere in between?`,
      readyToGenerate: false,
    };
  }
  if (exchanges === 1) {
    return {
      reply: `Got it!\n\n**When should conversations be transferred to a specialist or supervisor?** For example - after a certain time, for specific topics, or when the customer requests it?`,
      readyToGenerate: false,
    };
  }
  if (exchanges === 2) {
    return {
      reply: `Noted!\n\n**What are the most common topics your customers ask about?** (e.g. pricing, orders, technical issues, account help)`,
      readyToGenerate: false,
    };
  }
  if (exchanges === 3) {
    return {
      reply: `Thanks! Last one - **are there any topics that should always require supervisor approval?** (e.g. refunds, legal, complaints)\n\nIf nothing specific, just say "none".`,
      readyToGenerate: false,
    };
  }

  // 4+ exchanges - ready to generate
  return {
    reply: `I have a great picture of your needs now! Generating optimized AI configurations for **${deptNames}**...`,
    readyToGenerate: true,
  };
}

function fallbackReplyHebrew(
  ctx: BusinessContext,
  deptNames: string,
  exchanges: number,
): ChatReplyResult {
  if (exchanges === 0) {
    return {
      reply: `שלום! אעזור לכם להגדיר את עוזר ה-AI עבור **${ctx.organizationName}**.\n\nאתם בתחום **${ctx.industry}** עם ${ctx.departments.length} מחלקות: ${deptNames}.\n\nשאלה ראשונה - **איזה סגנון תקשורת הלקוחות שלכם מצפים?** רשמי, ידידותי, או משהו באמצע?`,
      readyToGenerate: false,
    };
  }
  if (exchanges === 1) {
    return {
      reply: `הבנתי!\n\n**מתי צריך להעביר שיחות למומחה או למנהל?** למשל - אחרי זמן מסוים, לנושאים ספציפיים, או כשהלקוח מבקש?`,
      readyToGenerate: false,
    };
  }
  if (exchanges === 2) {
    return {
      reply: `נרשם!\n\n**מהם הנושאים הנפוצים ביותר שהלקוחות שלכם שואלים עליהם?** (למשל: מחירים, הזמנות, בעיות טכניות, עזרה בחשבון)`,
      readyToGenerate: false,
    };
  }
  if (exchanges === 3) {
    return {
      reply: `תודה! שאלה אחרונה - **האם יש נושאים שתמיד דורשים אישור מנהל?** (למשל: החזרים, משפטי, תלונות)\n\nאם אין משהו ספציפי, פשוט אמרו "אין".`,
      readyToGenerate: false,
    };
  }

  return {
    reply: `יש לי תמונה מצוינת של הצרכים שלכם! מייצר הגדרות AI מותאמות עבור **${deptNames}**...`,
    readyToGenerate: true,
  };
}

// ─── Get Onboarding Status ──────────────────────────────────

router.get("/status", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId! },
      select: { id: true, name: true, slug: true, status: true, defaultLocale: true },
    });

    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const onboarding = await prisma.tenantOnboarding.findUnique({
      where: { tenantId: req.tenantId! },
    });

    const businessProfile = await prisma.businessProfile.findUnique({
      where: { tenantId: req.tenantId! },
    });

    const departments = await prisma.department.findMany({
      where: { tenantId: req.tenantId! },
    });

    const aiAgentCount = await prisma.aIAgent.count({
      where: { tenantId: req.tenantId! },
    });

    const coreSystemConnected = await connectedCoreSystem(req.tenantId!);

    res.json({
      data: {
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, defaultLocale: (tenant as any).defaultLocale },
        onboarding: onboarding || { currentStep: "BUSINESS_PROFILE", completedAt: null },
        businessProfileCompleted: !!businessProfile,
        // Structured understanding so Gate 1 can re-hydrate on refresh.
        businessProfile: businessProfile
          ? {
              organizationName: businessProfile.organizationName,
              businessDescription: businessProfile.businessDescription,
              industry: businessProfile.industry,
              country: (businessProfile as any).country ?? null,
              primaryLanguage: (businessProfile as any).primaryLanguage ?? null,
              primarySystem: (businessProfile as any).primarySystem ?? null,
              websiteDomain: businessProfile.websiteDomain ?? null,
            }
          : null,
        coreSystemConnected,
        departmentsConfigured: departments.length,
        aiAgentsConfigured: aiAgentCount,
      },
    });
  } catch (err) {
    console.error("Get onboarding status error:", err);
    res.status(500).json({ error: "Failed to get onboarding status" });
  }
});

// ─── Step A: Save Business Profile ──────────────────────────
// Minimal schema - only the two fields actually surfaced in Screen 1.
// Legacy fields (industry, businessPriority, daily conversations, agents)
// are kept on the model but defaulted server-side so a future settings
// page can still surface them without forcing them through onboarding.

const businessProfileSchema = z.object({
  organizationName: z.string().min(1).max(200),
  businessDescription: z.string().min(1).max(2000),
  locale: z.string().min(2).max(10).optional(),
  // Onboarding v2 - multi-select goals and the original domain the user
  // typed (so we can re-analyze later from settings without making them
  // retype it). Both optional so the legacy single-screen flow still
  // works against this endpoint.
  businessGoals: z.array(z.string().min(1).max(64)).max(6).optional(),
  websiteDomain: z.string().max(255).optional(),
  // Onboarding refactor - structured business understanding confirmed by
  // the user on the single "We understood your business" card.
  industry: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  primaryLanguage: z.string().max(10).optional(),
});

router.post("/business-profile", requireRole("ADMIN"), validate(businessProfileSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId! },
      select: { status: true },
    });

    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (tenant.status === "ACTIVE") {
      res.status(400).json({ error: "Tenant is already active. Use settings to update business profile." });
      return;
    }

    const { organizationName, businessDescription, locale, businessGoals, websiteDomain, industry, country, primaryLanguage } = req.body as {
      organizationName: string;
      businessDescription: string;
      locale?: string;
      businessGoals?: string[];
      websiteDomain?: string;
      industry?: string;
      country?: string;
      primaryLanguage?: string;
    };

    const existing = await prisma.businessProfile.findUnique({
      where: { tenantId: req.tenantId! },
      select: { industry: true, businessPriority: true, estimatedDailyConversations: true, numberOfAgents: true },
    });

    // Structured-understanding fields only overwrite when a non-empty value
    // is supplied, so a later partial save never wipes a confirmed value.
    const understandingPatch = {
      ...(industry && industry.trim() ? { industry: industry.trim() } : {}),
      ...(country && country.trim() ? { country: country.trim() } : {}),
      ...(primaryLanguage && primaryLanguage.trim() ? { primaryLanguage: primaryLanguage.trim() } : {}),
    };

    const profile = await prisma.businessProfile.upsert({
      where: { tenantId: req.tenantId! },
      update: {
        organizationName,
        businessDescription,
        ...understandingPatch,
        ...(businessGoals !== undefined ? { businessGoals } : {}),
        ...(websiteDomain !== undefined ? { websiteDomain } : {}),
      },
      create: {
        tenantId: req.tenantId!,
        organizationName,
        businessDescription,
        industry: (industry && industry.trim()) || existing?.industry || "Other",
        businessPriority: existing?.businessPriority ?? "FAST_RESPONSE",
        estimatedDailyConversations: existing?.estimatedDailyConversations ?? 100,
        numberOfAgents: existing?.numberOfAgents ?? 5,
        ...(country && country.trim() ? { country: country.trim() } : {}),
        ...(primaryLanguage && primaryLanguage.trim() ? { primaryLanguage: primaryLanguage.trim() } : {}),
        ...(businessGoals !== undefined ? { businessGoals } : {}),
        ...(websiteDomain !== undefined ? { websiteDomain } : {}),
      },
    });

    // Mirror name + locale onto Tenant so the dashboard, AI content, and
    // routing read the same values without joining BusinessProfile.
    await prisma.tenant.update({
      where: { id: req.tenantId! },
      data: {
        name: organizationName,
        ...(locale ? { defaultLocale: locale } : {}),
        ...(tenant.status === "PENDING_ADMIN_SETUP" ? { status: "PENDING_ONBOARDING" as const } : {}),
      },
    });

    await prisma.tenantOnboarding.upsert({
      where: { tenantId: req.tenantId! },
      update: {},
      create: { tenantId: req.tenantId!, currentStep: "BUSINESS_PROFILE" },
    });

    res.json({ data: profile });
  } catch (err) {
    console.error("Save business profile error:", err);
    res.status(500).json({ error: "Failed to save business profile" });
  }
});

// ─── Step B: Configure Departments ──────────────────────────

const departmentConfigSchema = z.object({
  departments: z.array(z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    queueMode: z.enum(["CLAIM", "ROUND_ROBIN"]).optional().default("CLAIM"),
    workingHours: z.object({
      timezone: z.string().min(1),
      schedule: z.record(z.object({
        enabled: z.boolean(),
        open: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        close: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      })),
    }).optional(),
    slaTarget: z.number().int().min(1).max(1440),
    escalationPolicy: z.object({
      escalateOnBreach: z.boolean().optional().default(false),
      escalateTo: z.string().optional(),
      maxWaitMinutes: z.number().int().min(1).optional(),
    }).optional(),
    autoGreetingEnabled: z.boolean().optional().default(false),
    autoGreetingMessage: z.string().max(1000).optional(),
    autoCloseMinutes: z.number().int().min(1).max(10080).optional(),
    escalateOnSlaBreach: z.boolean().optional().default(false),
    aiSuggestionsEnabled: z.boolean().optional().default(true),
    autoRepliesEnabled: z.boolean().optional().default(false),
  })).min(1, "At least one department is required"),
});

router.post("/departments", requireRole("ADMIN"), validate(departmentConfigSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId! },
      select: { status: true },
    });

    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (tenant.status === "ACTIVE") {
      res.status(400).json({ error: "Tenant is already active. Use department settings to update." });
      return;
    }

    // Verify business profile exists
    const profile = await prisma.businessProfile.findUnique({
      where: { tenantId: req.tenantId! },
    });
    if (!profile) {
      res.status(400).json({ error: "Business profile must be completed before configuring departments" });
      return;
    }

    const { departments: deptConfigs } = req.body;

    // Create departments in a transaction
    const departments = await prisma.$transaction(async (tx) => {
      // Remove previously created onboarding departments (if re-submitting)
      await tx.department.deleteMany({
        where: { tenantId: req.tenantId! },
      });

      const created = [];
      for (const config of deptConfigs) {
        const dept = await tx.department.create({
          data: {
            tenantId: req.tenantId!,
            name: config.name,
            description: config.description,
            queueMode: config.queueMode || "CLAIM",
            workingHours: config.workingHours || null,
            slaTarget: config.slaTarget,
            escalationPolicy: config.escalationPolicy || null,
            autoGreetingEnabled: config.autoGreetingEnabled || false,
            autoGreetingMessage: config.autoGreetingMessage || null,
            autoCloseMinutes: config.autoCloseMinutes || null,
            escalateOnSlaBreach: config.escalateOnSlaBreach || false,
            aiSuggestionsEnabled: config.aiSuggestionsEnabled !== false,
            autoRepliesEnabled: config.autoRepliesEnabled || false,
          },
        });
        created.push(dept);
      }
      return created;
    });

    // Update onboarding step
    await prisma.tenantOnboarding.upsert({
      where: { tenantId: req.tenantId! },
      update: { currentStep: "COMPLETED" },
      create: { tenantId: req.tenantId!, currentStep: "COMPLETED" },
    });

    res.json({ data: departments });
  } catch (err) {
    console.error("Configure departments error:", err);
    res.status(500).json({ error: "Failed to configure departments" });
  }
});

// ─── Onboarding AI Chat ──────────────────────────────────────

router.post("/ai-chat", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const { message, context: clientContext } = req.body;
    const chatHistory = clientContext?.chatHistory || req.body.chatHistory || [];
    const locale = clientContext?.locale || "en";

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    // Load context: business profile + departments with full details
    const [profile, departments] = await Promise.all([
      prisma.businessProfile.findUnique({ where: { tenantId: req.tenantId! } }),
      prisma.department.findMany({
        where: { tenantId: req.tenantId! },
        select: {
          name: true, description: true,
          slaTarget: true, escalateOnSlaBreach: true,
          autoGreetingEnabled: true, autoRepliesEnabled: true,
          aiSuggestionsEnabled: true, autoCloseMinutes: true,
          queueMode: true,
        },
      }),
    ]);

    if (!profile) {
      res.status(400).json({ error: "Business profile must be completed first" });
      return;
    }

    // Build rich context for the AI
    const context = {
      organizationName: profile.organizationName,
      industry: profile.industry,
      businessDescription: profile.businessDescription,
      businessPriority: profile.businessPriority,
      estimatedDailyConversations: profile.estimatedDailyConversations,
      numberOfAgents: profile.numberOfAgents,
      departments: departments.map(d => ({
        name: d.name,
        description: d.description,
        slaTarget: d.slaTarget,
        escalateOnSlaBreach: d.escalateOnSlaBreach,
        autoRepliesEnabled: d.autoRepliesEnabled,
        queueMode: d.queueMode,
      })),
    };

    const result = await getOnboardingChatReply(req.tenantId!, message, context, chatHistory, locale);

    res.json({ data: { reply: result.reply, readyToGenerate: result.readyToGenerate } });
  } catch (err) {
    console.error("Onboarding AI chat error:", err);
    res.status(500).json({ error: "Failed to process chat message" });
  }
});

// ─── Generate Copilot Configs ────────────────────────────────

router.post("/generate-configs", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const profile = await prisma.businessProfile.findUnique({ where: { tenantId: req.tenantId! } });
    if (!profile) {
      res.status(400).json({ error: "Business profile must be completed first" });
      return;
    }

    const departments = await prisma.department.findMany({
      where: { tenantId: req.tenantId!, isActive: true },
      select: { id: true, name: true },
    });

    if (departments.length === 0) {
      res.status(400).json({ error: "At least one department is required" });
      return;
    }

    // Generate agent configs via AI service (populates AIAgent records)
    await callAIGenerateConfigs(req.tenantId!, req.headers.authorization!);

    // Fetch the generated AI agents to return
    const agents = await prisma.aIAgent.findMany({
      where: { tenantId: req.tenantId! },
    });

    // Update onboarding step
    await prisma.tenantOnboarding.upsert({
      where: { tenantId: req.tenantId! },
      update: { currentStep: "AI_CONFIG" },
      create: { tenantId: req.tenantId!, currentStep: "AI_CONFIG" },
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
    console.error("Generate configs error:", err);
    res.status(500).json({ error: "Failed to generate configurations" });
  }
});

// ─── Complete Onboarding (Activation + async AI generation) ──
// The new 2-screen flow makes this the synchronous critical path:
//   1. Verify profile exists
//   2. Auto-create a default "General" department if none exists
//   3. Flip tenant.status = ACTIVE (so AppLayout stops redirecting to /setup)
//   4. Fire-and-forget the AI config generation - the user enters the app
//      immediately; agents materialize within a few seconds in the background.

router.post("/complete", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId! },
      select: { id: true, status: true, name: true },
    });

    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (tenant.status === "ACTIVE") {
      res.json({ data: { status: "ACTIVE", message: "Already active" } });
      return;
    }

    const profile = await prisma.businessProfile.findUnique({
      where: { tenantId: req.tenantId! },
      select: { id: true },
    });
    if (!profile) {
      res.status(400).json({ error: "Business profile is required before activation" });
      return;
    }

    const admin = await prisma.user.findFirst({
      where: { tenantId: req.tenantId!, role: "ADMIN", isActive: true },
      select: { id: true },
    });
    if (!admin) {
      res.status(400).json({ error: "An active admin account is required before activation" });
      return;
    }

    // Onboarding refactor - the activation gate. Normally exactly ONE "system
    // of truth" (CRM or Shopify) is connected to finish onboarding. The user
    // may also explicitly skip ("not now") - they can connect it later from
    // the Setup Hub. Anything else stays non-linear in the Setup Hub.
    const skipCoreSystem = req.body?.skipCoreSystem === true;
    const coreSystem = await connectedCoreSystem(req.tenantId!);
    if (!coreSystem && !skipCoreSystem) {
      res.status(400).json({
        error: "core_system_required",
        message: "Connect your main business system (HubSpot, Salesforce, Zoho, Fireberry, Airtable, or Shopify) to finish onboarding.",
      });
      return;
    }

    // The employee the owner just met in Movement 7 - drives the department
    // name (so the generator produces a role-appropriate identity) and the
    // final employee name/role.
    const discovery = await prisma.businessDiscovery
      .findUnique({ where: { tenantId: req.tenantId! }, select: { recommendation: true } })
      .catch(() => null);
    const recommendation = (discovery?.recommendation as any) || null;
    const recDeptName =
      (recommendation?.employeeRole && RECOMMENDATION_DEPT_NAME[recommendation.employeeRole]) || "General";

    // Auto-create a single department if the tenant has none, named after the
    // recommended employee so the generated identity fits the role.
    let departments = await prisma.department.findMany({
      where: { tenantId: req.tenantId!, isActive: true },
      select: { id: true, name: true },
    });
    if (departments.length === 0) {
      const dept = await prisma.department.create({
        data: {
          tenantId: req.tenantId!,
          name: recDeptName,
          queueMode: "CLAIM",
          slaTarget: 30,
          aiSuggestionsEnabled: true,
        },
        select: { id: true, name: true },
      });
      departments = [dept];
    }

    // Activate first, generate AI configs after. The activation flip is
    // the only thing the user blocks on; the LLM call can take seconds.
    await prisma.$transaction([
      prisma.tenant.update({
        where: { id: req.tenantId! },
        data: { status: "ACTIVE" },
      }),
      prisma.tenantOnboarding.upsert({
        where: { tenantId: req.tenantId! },
        create: { tenantId: req.tenantId!, currentStep: "COMPLETED", completedAt: new Date() },
        update: { currentStep: "COMPLETED", completedAt: new Date() },
      }),
    ]);

    // Create the recommended employee NOW (awaited) - reusing the existing
    // generator - so it genuinely exists the moment the owner lands. Generation
    // is LLM-free and fast; the "Getting your employee ready…" screen covers it.
    // Falls back to fire-and-forget so an agent still materializes on error.
    // The owner can SKIP this from the "Meet your employee" screen ("I'll create
    // one later") - then we activate the workspace with no employee and the
    // journey checklist surfaces "create your AI employee" as the next step.
    const skipEmployee = (req.body as { skipEmployee?: boolean } | undefined)?.skipEmployee === true;
    const authHeader = req.headers.authorization;
    if (authHeader && !skipEmployee) {
      try {
        await hireRecommendedEmployee(req.tenantId!, authHeader, recommendation);
      } catch (err: any) {
        console.error(`[Onboarding] Synchronous hire failed for tenant ${req.tenantId}:`, err?.message);
        callAIGenerateConfigs(req.tenantId!, authHeader).catch((e) => {
          console.error(`[Onboarding] Async generate-configs fallback failed for tenant ${req.tenantId}:`, e.message);
        });
      }
    } else if (skipEmployee) {
      console.log(`[Onboarding] Tenant ${req.tenantId} skipped employee creation - activating without an AI employee.`);
    }

    sendActivationConfirmation(req.tenantId!).catch((err) => {
      console.error("Failed to send activation confirmation:", err);
    });

    // Re-arm the nudge one last time: if they activated without a live channel,
    // the sweep sends "your AI employee is waiting to start working"; if they're
    // fully live it computes nothing and is SKIPPED. (No manual cancel needed.)
    scheduleOnboardingNudge(req.tenantId!, "1d").catch(() => {});

    // Provision billing (entity + trial + included AI Units) for the new tenant.
    // Best-effort: never block activation on billing availability.
    provisionBilling(req.tenantId!).catch((err) => {
      console.error(`[Onboarding] Billing provisioning failed for tenant ${req.tenantId}:`, err.message);
    });

    res.json({
      data: {
        status: "ACTIVE",
        message: "Tenant activated. AI configurations generating in background.",
        departmentsActivated: departments.length,
      },
    });
  } catch (err) {
    console.error("Complete onboarding error:", err);
    res.status(500).json({ error: "Failed to complete onboarding" });
  }
});

// ─── Get Business Profile ───────────────────────────────────

router.get("/business-profile", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const profile = await prisma.businessProfile.findUnique({
      where: { tenantId: req.tenantId! },
    });
    res.json({ data: profile });
  } catch (err) {
    console.error("Get business profile error:", err);
    res.status(500).json({ error: "Failed to get business profile" });
  }
});

// ─── Get Departments Config ─────────────────────────────────

router.get("/departments", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const departments = await prisma.department.findMany({
      where: { tenantId: req.tenantId! },
      orderBy: { createdAt: "asc" },
    });
    res.json({ data: departments });
  } catch (err) {
    console.error("Get departments config error:", err);
    res.status(500).json({ error: "Failed to get departments config" });
  }
});

// ─── Get Copilot Config for Department ──────────────────────

router.get("/agent-config/:departmentId", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const departmentId = req.params.departmentId as string;
    const dept = await prisma.department.findFirst({
      where: { id: departmentId, tenantId: req.tenantId! },
    });
    if (!dept) {
      res.status(404).json({ error: "Department not found" });
      return;
    }

    // Find AI agent assigned to this department via router rules
    const rule = await prisma.routerRule.findFirst({
      where: { tenantId: req.tenantId!, routeType: "AI_AGENT", aiAgentId: { not: null }, enabled: true, routeTarget: departmentId },
      orderBy: { position: "asc" },
    });
    if (!rule?.aiAgentId) {
      res.status(404).json({ error: "No AI Employee assigned to this department" });
      return;
    }
    const agent = await prisma.aIAgent.findUnique({ where: { id: rule.aiAgentId } });
    if (!agent) {
      res.status(404).json({ error: "AI Employee not found" });
      return;
    }

    res.json({ data: agent });
  } catch (err) {
    console.error("Get copilot config error:", err);
    res.status(500).json({ error: "Failed to get copilot config" });
  }
});

// ─── Onboarding Missions ────────────────────────────────────
// The post-onboarding journey missions - status derived from live state and
// the Recommendation ledger, never a stored checkbox.
// `done` if completed, `active` for the first incomplete one, `pending` for the rest.
// `deepLink` is consumed by the sidebar MissionPanel so route changes stay server-side.

type MissionId =
  | "connect_source_of_truth"
  | "connect_channel"
  | "add_webchat"
  | "teach_knowledge";

interface MissionResult {
  id: MissionId;
  done: boolean;
  deepLink: string;
  /** Optional live detail, e.g. detected channel identifiers or an open-gaps count. */
  hint?: string;
}

router.get("/missions", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.tenantId!;

    // The post-onboarding journey, derived from the SAME sources of truth the
    // onboarding used: the connected-systems state, the discovery's detected
    // channels (with real identifiers), and the living Recommendation ledger -
    // never a stored checkbox. Order = highest-leverage first.
    const [coreSlug, connectedChannel, discovery, openRecs] = await Promise.all([
      connectedCoreSystem(tenantId).catch(() => null),
      prisma.channelAccount.findFirst({
        where: { tenantId, connectionStatus: "CONNECTED" },
        select: { id: true },
      }).catch(() => null),
      prisma.businessDiscovery.findUnique({
        where: { tenantId },
        select: { communication: true },
      }).catch(() => null),
      prisma.recommendation.findMany({
        where: { tenantId, status: "OPEN" },
        select: { kind: true, dedupeKey: true },
      }).catch(() => [] as Array<{ kind: string; dedupeKey: string }>),
    ]);

    const PRIMARY_CH = new Set(["whatsapp", "instagram", "facebook", "messenger", "telegram"]);
    const detectedChannels = (((discovery?.communication as any)?.channels || []) as Array<{ type?: string; identifier?: string }>)
      .filter((c) => c?.type && PRIMARY_CH.has(String(c.type).toLowerCase()));
    const channelHint = detectedChannels.slice(0, 3)
      .map((c) => `${String(c.type)}${c.identifier ? ` · ${c.identifier}` : ""}`)
      .join("  ·  ");

    const webchatOpen = openRecs.some((r) => r.dedupeKey === "channel:webchat");
    const teachOpen = openRecs.filter((r) => r.kind === "import_knowledge").length;

    const missions: MissionResult[] = [
      {
        id: "connect_source_of_truth",
        done: !!coreSlug,
        deepLink: "/settings/integrations",
      },
      {
        id: "connect_channel",
        done: !!connectedChannel,
        deepLink: "/channels",
        hint: channelHint || undefined,
      },
      {
        id: "add_webchat",
        done: !webchatOpen,
        deepLink: "/channels",
      },
      {
        id: "teach_knowledge",
        done: teachOpen === 0,
        deepLink: "/settings/business",
        hint: teachOpen > 0 ? String(teachOpen) : undefined,
      },
    ];

    let activeAssigned = false;
    const out = missions.map((m) => {
      let status: "done" | "active" | "pending";
      if (m.done) {
        status = "done";
      } else if (!activeAssigned) {
        status = "active";
        activeAssigned = true;
      } else {
        status = "pending";
      }
      return { id: m.id, status, deepLink: m.deepLink, hint: m.hint };
    });

    res.json({ data: { missions: out } });
  } catch (err) {
    console.error("Get missions error:", err);
    res.status(500).json({ error: "Failed to get missions" });
  }
});

// GET /journey - the post-onboarding "first steps" arc for the Getting Started
// page. Like /missions, every milestone is DERIVED from real product state -
// the one exception is `first_chat` (the owner's first test conversation with
// their employee), which is stateless by design (test-chat persists nothing),
// so it's marked via the existing /guides mechanism (feature "first_chat").
router.get("/journey", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.tenantId!;
    const [agent, coreSlug, connectedChannel, discovery, openRecs, firstChatUsers, inboundCount, kbCount, profile] = await Promise.all([
      prisma.aIAgent.findFirst({
        where: { tenantId, status: { in: ["ACTIVE", "PAUSED"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, role: true, status: true },
      }).catch(() => null),
      connectedCoreSystem(tenantId).catch(() => null),
      prisma.channelAccount.findFirst({
        where: { tenantId, connectionStatus: "CONNECTED" },
        select: { id: true, channel: true },
      }).catch(() => null),
      prisma.businessDiscovery.findUnique({
        where: { tenantId },
        select: { communication: true, business: true },
      }).catch(() => null),
      prisma.recommendation.findMany({
        where: { tenantId, status: "OPEN" },
        select: { kind: true, dedupeKey: true },
      }).catch(() => [] as Array<{ kind: string; dedupeKey: string }>),
      prisma.user.count({
        where: { tenantId, onboardingGuides: { path: ["first_chat"], equals: "done" } },
      }).catch(() => 0),
      prisma.message.count({ where: { tenantId, direction: "INBOUND" } }).catch(() => 0),
      prisma.knowledgeBase.count({ where: { tenantId } }).catch(() => 0),
      prisma.businessProfile.findUnique({
        where: { tenantId },
        select: { organizationName: true, industry: true },
      }).catch(() => null),
    ]);

    const PRIMARY_CH = new Set(["whatsapp", "instagram", "facebook", "messenger", "telegram"]);
    const detectedChannels = (((discovery?.communication as any)?.channels || []) as Array<{ type?: string; identifier?: string }>)
      .filter((c) => c?.type && PRIMARY_CH.has(String(c.type).toLowerCase()));
    const channelHint = detectedChannels.slice(0, 3)
      .map((c) => `${String(c.type)}${c.identifier ? ` · ${c.identifier}` : ""}`)
      .join("  ·  ");
    const teachOpen = openRecs.filter((r) => r.kind === "import_knowledge").length;

    type Milestone = { id: string; done: boolean; deepLink: string; hint?: string };
    const milestones: Milestone[] = [
      { id: "meet_employee", done: !!agent, deepLink: agent ? `/ai-studio/agents/${agent.id}` : "/ai-studio" },
      { id: "first_chat", done: firstChatUsers > 0, deepLink: "/getting-started#chat" },
      { id: "go_live_channel", done: !!connectedChannel, deepLink: "/channels", hint: channelHint || undefined },
      { id: "first_customer", done: inboundCount > 0, deepLink: "/conversations" },
      { id: "teach_knowledge", done: teachOpen === 0, deepLink: "/settings/business", hint: teachOpen > 0 ? String(teachOpen) : undefined },
    ];

    let activeAssigned = false;
    const out = milestones.map((m) => {
      let status: "done" | "active" | "pending";
      if (m.done) { status = "done"; }
      else if (!activeAssigned) { status = "active"; activeAssigned = true; }
      else { status = "pending"; }
      return { id: m.id, status, deepLink: m.deepLink, hint: m.hint };
    });

    const biz = (discovery?.business || {}) as any;
    res.json({
      data: {
        complete: milestones.every((m) => m.done),
        employee: agent,
        business: {
          name: profile?.organizationName || biz.name || null,
          industry: profile?.industry || biz.industry || null,
        },
        context: {
          coreSystem: coreSlug,
          kbCount,
          channelHint: channelHint || null,
          detectedChannelCount: detectedChannels.length,
        },
        milestones: out,
      },
    });
  } catch (err) {
    console.error("Get journey error:", err);
    res.status(500).json({ error: "Failed to get journey" });
  }
});

// ─── Core System (source of truth) + Setup Hub map + guides ──
//
// The onboarding refactor makes ONE "system of truth" the activation event.
// These slugs match the IntegrationCatalog rows + OAuth routes in the AI
// service (note Zoho's catalog slug is `zoho_crm`).

const CORE_SYSTEM_SLUGS = ["hubspot", "salesforce", "zoho_crm", "shopify", "fireberry", "airtable"] as const;

/** Returns the slug of the first CONNECTED + usable core system, or null.
 *  Airtable is only "usable" once its column mapping is saved (a CONNECTED
 *  Airtable with no fieldMap is mid-setup, not a working source of truth). */
async function connectedCoreSystem(tenantId: string): Promise<string | null> {
  const rows = await prisma.tenantIntegration.findMany({
    where: { tenantId, status: "CONNECTED", integration: { slug: { in: CORE_SYSTEM_SLUGS as unknown as string[] } } },
    include: { integration: true },
    orderBy: { createdAt: "asc" },
  });
  for (const ti of rows) {
    const slug = ti?.integration?.slug as string | undefined;
    if (!slug) continue;
    if (slug === "airtable") {
      const cfg = (ti.config && typeof ti.config === "object" ? ti.config : {}) as any;
      const fm = cfg.fieldMap;
      if (!fm || !(fm.email || fm.phone) || !fm.display_name) continue; // unmapped → not usable yet
    }
    return slug;
  }
  return null;
}

// POST /core-system - record the chosen system of truth. For Shopify we flip
// `config.useAsCrm` so the CRM resolver treats it as the source of truth
// (mirrors the AI service's /integrations/shopify/crm-source toggle).
const coreSystemSchema = z.object({
  slug: z.enum(CORE_SYSTEM_SLUGS),
});
router.post("/core-system", requireRole("ADMIN"), validate(coreSystemSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { slug } = req.body as { slug: string };
    await prisma.businessProfile.updateMany({
      where: { tenantId: req.tenantId! },
      data: { primarySystem: slug },
    });
    if (slug === "shopify") {
      const ti = await prisma.tenantIntegration.findFirst({
        where: { tenantId: req.tenantId!, integration: { slug: "shopify" } },
        select: { id: true, config: true },
      });
      if (ti) {
        const cfg = (ti.config && typeof ti.config === "object" ? ti.config : {}) as Record<string, unknown>;
        cfg.useAsCrm = true;
        await prisma.tenantIntegration.update({ where: { id: ti.id }, data: { config: cfg } });
      }
    }
    const connected = await connectedCoreSystem(req.tenantId!);
    // A connected system is no longer a recommendation - complete it so it never
    // nags post-onboarding (the recommendation is fulfilled, not lost).
    if (connected) {
      await prisma.recommendation.updateMany({
        where: { tenantId: req.tenantId!, dedupeKey: `connect:${connected}`, status: "OPEN" },
        data: { status: "COMPLETED", completedAt: new Date() },
      }).catch(() => {});
      // Second-wave: connecting the source of truth unlocks a new class of
      // concrete next steps - write them to the living backlog (surfaces on /business).
      addStoreInspectionRecs(req.tenantId!, connected).catch(() => {});
    }
    res.json({ data: { primarySystem: slug, connectedSlug: connected, connected: connected === slug } });
  } catch (err) {
    console.error("Set core system error:", err);
    res.status(500).json({ error: "Failed to set core system" });
  }
});

// GET /setup-map - the non-linear Setup Hub tiles + done flags, derived from
// real product signals (no manual check-offs). Tiles tagged stage:"later"
// (Channels, extra Integrations) are shown but excluded from the headline
// progress count.
router.get("/setup-map", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.tenantId!;
    const [coreSlug, kbCount, aiAgent, flowCount, userCount, channel, connectedIntegrations, profile] = await Promise.all([
      connectedCoreSystem(tenantId),
      prisma.knowledgeBase.count({ where: { tenantId } }).catch(() => 0),
      prisma.aIAgent.findFirst({ where: { tenantId }, select: { id: true, status: true } }).catch(() => null),
      prisma.chatbotFlow.count({ where: { tenantId } }).catch(() => 0),
      prisma.user.count({ where: { tenantId, isActive: true } }),
      prisma.channelAccount.findFirst({ where: { tenantId, connectionStatus: "CONNECTED" }, select: { id: true } }).catch(() => null),
      prisma.tenantIntegration.count({ where: { tenantId, status: "CONNECTED" } }).catch(() => 0),
      prisma.businessProfile.findUnique({ where: { tenantId }, select: { primarySystem: true } }).catch(() => null),
    ]);

    // Tiles match the Setup Hub spec: Knowledge Base, AI Employees,
    // Workflows, Settings (core, counted) + Integrations, Channels (later,
    // shown but not counted). The chosen source-of-truth is surfaced
    // separately as `sourceSystem` + reflected in the Integrations tile.
    const tiles = [
      { id: "knowledge_base", done: (kbCount || 0) > 0, deepLink: "/ai-studio/knowledge", stage: "core" as const },
      { id: "ai_employees", done: !!aiAgent, deepLink: "/ai-studio", stage: "core" as const },
      { id: "workflows", done: (flowCount || 0) > 0, deepLink: "/ai-studio", stage: "core" as const },
      { id: "settings", done: userCount > 1, deepLink: "/settings", stage: "core" as const },
      { id: "integrations", done: !!coreSlug, deepLink: "/integrations", stage: "later" as const, meta: { slug: coreSlug || profile?.primarySystem || null } },
      { id: "channels", done: !!channel, deepLink: "/channels", stage: "later" as const },
    ];
    const core = tiles.filter((t) => t.stage === "core");
    res.json({
      data: {
        tiles,
        sourceSystem: coreSlug || profile?.primarySystem || null,
        sourceConnected: !!coreSlug,
        completedCount: core.filter((t) => t.done).length,
        totalCount: core.length,
      },
    });
  } catch (err) {
    console.error("Get setup-map error:", err);
    res.status(500).json({ error: "Failed to get setup map" });
  }
});

// GET/PATCH /guides - per-user first-time guidance state for the persistent
// onboarding layer. Available to ALL roles (agents get guidance too), so no
// requireRole gate. State machine per feature: unseen -> snoozed | done.
router.get("/guides", async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.userId as string | undefined;
    if (!userId) { res.status(401).json({ error: "no user" }); return; }
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { onboardingGuides: true } });
    res.json({ data: { guides: (u?.onboardingGuides as Record<string, string>) || {} } });
  } catch (err) {
    console.error("Get guides error:", err);
    res.status(500).json({ error: "Failed to get guides" });
  }
});

const guidePatchSchema = z.object({
  feature: z.string().min(1).max(64),
  state: z.enum(["unseen", "snoozed", "done"]),
});
router.patch("/guides", validate(guidePatchSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?.userId as string | undefined;
    if (!userId) { res.status(401).json({ error: "no user" }); return; }
    const { feature, state } = req.body as { feature: string; state: string };
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { onboardingGuides: true } });
    const guides = { ...((u?.onboardingGuides as Record<string, string>) || {}), [feature]: state };
    await prisma.user.update({ where: { id: userId }, data: { onboardingGuides: guides } });
    res.json({ data: { guides } });
  } catch (err) {
    console.error("Patch guide error:", err);
    res.status(500).json({ error: "Failed to update guide" });
  }
});

// ─── Domain Analysis (Onboarding v2 - AI-suggested description) ──
//
// Fetches the user's homepage and asks the LLM to produce a one-sentence
// "what this business does" suggestion the user can confirm or edit.
// Falls through to a structured failure response if either step fails -
// the UI then shows the manual one-line input as fallback.

const analyzeDomainSchema = z.object({
  domain: z.string().min(3).max(255),
  locale: z.string().min(2).max(10).optional().default("en"),
});

function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  let withProto = trimmed;
  if (!/^https?:\/\//.test(withProto)) withProto = `https://${withProto}`;
  try {
    const u = new URL(withProto);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function fetchHomepageText(origin: string, timeoutMs = 8000): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(origin, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GotchaOnboarding/1.0; +https://gotcha.co.il)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: ctl.signal,
      redirect: "follow",
    });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("xhtml")) return null;
    const html = await r.text();
    // Cheap extraction - strip scripts/styles/tags, collapse whitespace,
    // cap to ~6KB so we don't blow the LLM context on huge pages.
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
    return stripped.slice(0, 6000) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

router.post("/analyze-domain", requireRole("ADMIN"), validate(analyzeDomainSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { domain, locale } = req.body as { domain: string; locale: string };
    const origin = normalizeDomain(domain);
    if (!origin) {
      res.json({ data: { ok: false, reason: "invalid_domain" } });
      return;
    }

    const pageText = await fetchHomepageText(origin);
    if (!pageText) {
      res.json({ data: { ok: false, reason: "fetch_failed", domain: origin } });
      return;
    }

    const client = getOpenAIClient();
    if (!client) {
      res.json({ data: { ok: false, reason: "ai_unavailable", domain: origin } });
      return;
    }

    const lang = LOCALE_NAMES[locale] || "English";
    const model = process.env.ONBOARDING_CHAT_MODEL || "gpt-4o-mini";
    // Industry Intelligence Pack slugs the classifier may match (Customer
    // Intelligence V2). Must stay in sync with the system packs seeded in
    // packages/shared/prisma/seed.ts.
    const PACK_SLUGS = ["event_hall", "real_estate", "recruiting", "ecommerce"];
    let understanding: {
      name: string; industry: string; country: string; language: string; description: string; packSlug: string;
    } | null = null;
    try {
      const response = await client.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 320,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You analyze a business homepage and extract a structured profile of the business. Respond ONLY with JSON of this exact shape:
{"name":"","industry":"","country":"","language":"","description":"","packSlug":""}
Rules:
- "name": the business / brand name. Plain text.
- "industry": a short industry label (e.g. "E-commerce / Fashion", "SaaS", "Law firm"). 1-4 words.
- "country": the country the business primarily operates in, in English (e.g. "Israel", "United States"). Best guess from language, TLD, addresses, currency. Empty string if unknown.
- "language": the primary language of the site as an ISO-639-1 code ("en", "he", "ar", ...).
- "description": 1-2 sentences in ${lang} describing WHAT THE BUSINESS DOES. No emojis, no marketing fluff, no mention of the homepage or this analysis.
- "packSlug": the best-matching customer-intelligence pack for this business, EXACTLY one of: "event_hall" (wedding/event venues & halls), "real_estate" (property sales/rental/brokerage), "recruiting" (staffing/HR/job placement), "ecommerce" (online retail / order fulfillment). Use "" if none clearly fits - do not force a match.
Set any field you cannot determine to an empty string. Do not invent specifics.`,
          },
          {
            role: "user",
            content: `Homepage URL: ${origin}\n\nHomepage text (truncated):\n${pageText}`,
          },
        ],
      });

      if (response.usage) {
        trackAIUsage({
          tenantId: req.tenantId!,
          feature: "onboarding_domain_analysis",
          model,
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }).catch(() => { /* fire-and-forget */ });

        // Meter AI Units - no enforcement exceptions for any AI surface.
        meterAiUnits({
          tenantId: req.tenantId!,
          model,
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
        }).catch(() => { /* fire-and-forget */ });

        // Audit row (T-6, CLAUDE.md §5): grandfathered domain-analysis LLM call.
        prisma.auditLog.create({
          data: {
            tenantId: req.tenantId!,
            actorType: "ai",
            action: "ai.responded",
            targetType: "onboarding",
            metadata: {
              feature: "onboarding_domain_analysis",
              model,
              tokens: { prompt: response.usage.prompt_tokens, completion: response.usage.completion_tokens, total: response.usage.total_tokens },
              inputPreview: origin,
            },
          },
        }).catch(() => { /* fire-and-forget */ });
      }

      const content = response.choices[0]?.message?.content;
      if (content) {
        const p = JSON.parse(content);
        const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
        const desc = str(p.description);
        if (desc.length >= 10) {
          const rawSlug = str(p.packSlug);
          understanding = {
            name: str(p.name),
            industry: str(p.industry),
            country: str(p.country),
            language: str(p.language) || locale,
            description: desc,
            packSlug: PACK_SLUGS.includes(rawSlug) ? rawSlug : "",
          };
        }
      }
    } catch (err: any) {
      console.warn("[Onboarding] Domain analysis LLM failed:", err?.message);
    }

    if (!understanding) {
      res.json({ data: { ok: false, reason: "no_summary", domain: origin } });
      return;
    }

    // `description` kept at top level for backward compatibility with older
    // callers; the structured fields are the new surface.
    res.json({ data: { ok: true, domain: origin, description: understanding.description, understanding } });
  } catch (err) {
    console.error("Analyze domain error:", err);
    res.status(500).json({ error: "Failed to analyze domain" });
  }
});

// ─── Business Discovery (Onboarding Intelligence Engine) ─────
//
// Movements 1-4 of the Onboarding Bible. This route does the deterministic
// half of the moat - a light same-origin crawl of the public pages and a
// regex pass that detects the tech stack + communication channels - with NO
// LLM. It then hands the raw text + signals to the AI service's
// /discover-business endpoint (the one allowed new LLM call), persists the
// resulting Business Intelligence Report to BusinessDiscovery, and returns it.
//
// The customer WATCHES this happen (Movement 1). Everything the engine learns
// is reflected back (Movement 2), its self-assessed readiness is derived from
// it (Business Health, Movement 3), and its first recommendation is read
// straight off the report (Movement 4).

/** Fetch a page returning BOTH raw HTML (for signal regexes) and stripped text
 *  (for the LLM). Best-effort - returns null on any failure. */
async function fetchPageRaw(url: string, timeoutMs = 8000): Promise<{ html: string; text: string } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // Present as a real browser. Many stores sit behind bot filters that 403 a
    // generic crawler UA - a partial/blocked fetch is a root cause of false
    // negatives, so we look like Chrome and send the browser header set.
    const r = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "he,en-US;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
      signal: ctl.signal,
      redirect: "follow",
    });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("xhtml")) return null;
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
    return { html: html.slice(0, 400000), text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Same-origin internal links worth reading - the pages that carry a business's
// knowledge and policies. We only ever follow a handful.
// Link text / path keywords worth following - the pages where policies, contact
// details, and knowledge actually live. Bilingual (EN + HE) because Hebrew
// stores label these in Hebrew even when the slug is English.
const LINK_KEYWORDS =
  /(about|faq|help|support|contact|shipping|deliver|return|refund|exchange|warranty|policy|policies|terms|privacy|legal|pricing|plans|q-?a|אודות|צור.?קשר|יצירת.?קשר|שאלות|עזרה|תמיכה|משלוח|החזר|החזרה|החזרות|ביטול|תקנון|מדיניות|פרטיות|אחריות|תנאי)/i;

// Well-known convention paths we always TRY even if not linked from the home
// page - most false negatives on Shopify/WordPress stores are policies that
// exist at a predictable URL but aren't in the top nav. fetchPageRaw returns
// null fast on a 404, so probing these is cheap.
const CANDIDATE_PATHS = [
  "/policies/refund-policy", "/policies/shipping-policy", "/policies/terms-of-service",
  "/policies/privacy-policy", "/policies/legal-notice", "/policies/contact-information",
  "/pages/contact", "/pages/contact-us", "/pages/faq", "/pages/about", "/pages/about-us",
  "/pages/shipping", "/pages/returns", "/pages/warranty", "/pages/terms", "/pages/accessibility",
  "/contact", "/contact-us", "/faq", "/about", "/terms", "/privacy",
  "/shipping", "/returns", "/refund-policy", "/policies", "/help", "/support",
];

function extractInternalLinks(html: string, origin: string, cap = 10): string[] {
  const originHost = (() => { try { return new URL(origin).hostname; } catch { return ""; } })();
  const out = new Set<string>();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.size < cap * 4) {
    const href = m[1];
    const label = (m[2] || "").replace(/<[^>]+>/g, " ");
    if (!href) continue;
    let abs: URL;
    try { abs = new URL(href, origin); } catch { continue; }
    if (abs.hostname !== originHost) continue;
    if (!/^https?:$/.test(abs.protocol)) continue;
    if (LINK_KEYWORDS.test(decodeURIComponent(abs.pathname)) || LINK_KEYWORDS.test(label)) {
      abs.hash = "";
      out.add(abs.toString());
    }
  }
  return Array.from(out).slice(0, cap);
}

// ─── Structured signal extraction (deterministic, LLM-free) ──
//
// Platform detection is STRENGTH-SCORED so we can tell an ACTIVE platform
// (many strong signals - e.g. Shopify's CDN + theme + section markup) from a
// LEGACY ARTIFACT (a single stray "magento" string). The AI is handed the
// scores and told to trust the strongest, so an old tag never gets recommended
// as an equal.

interface PlatformDef { slug: string; name: string; patterns: RegExp[] }
const PLATFORM_DEFS: PlatformDef[] = [
  { slug: "shopify", name: "Shopify", patterns: [/cdn\.shopify\.com/i, /\/cdn\/shop\//i, /Shopify\.theme/i, /myshopify\.com/i, /x-shopify/i, /shopify-section/i, /window\.Shopify/i] },
  { slug: "woocommerce", name: "WooCommerce", patterns: [/wp-content\/plugins\/woocommerce/i, /woocommerce/i, /wc-block/i, /wc_add_to_cart/i] },
  { slug: "wix", name: "Wix", patterns: [/wixstatic\.com/i, /wix\.com/i, /X-Wix/i, /_wixCssStates/i, /wixapps/i] },
  { slug: "magento", name: "Magento", patterns: [/mage\/cookies/i, /Magento_/i, /\/static\/version\d+\/frontend/i, /mage-cache/i, /magento/i] },
  { slug: "bigcommerce", name: "BigCommerce", patterns: [/bigcommerce\.com/i, /stencil-utils/i] },
  { slug: "squarespace", name: "Squarespace", patterns: [/squarespace\.com/i, /static1\.squarespace/i, /SQUARESPACE_CONTEXT/i] },
  { slug: "webflow", name: "Webflow", patterns: [/webflow\.com/i, /w-webflow/i, /data-wf-/i] },
];
const TRACKING_DEFS: Array<{ slug: string; name: string; re: RegExp }> = [
  { slug: "google_analytics", name: "Google Analytics", re: /google-analytics\.com|googletagmanager\.com|gtag\(|_gaq/i },
  { slug: "meta_pixel", name: "Meta Pixel", re: /connect\.facebook\.net|fbq\(/i },
  { slug: "tiktok_pixel", name: "TikTok Pixel", re: /analytics\.tiktok\.com|ttq\./i },
  { slug: "hotjar", name: "Hotjar", re: /hotjar\.com|hjSiteSettings/i },
];
// Third-party tools / apps (incl. the Shopify ecosystem the recommender uses).
const TOOL_DEFS: Array<{ slug: string; name: string; re: RegExp; chat?: boolean }> = [
  { slug: "hubspot", name: "HubSpot", re: /hs-scripts\.com|js\.hs-|hubspot\.com|hsforms/i },
  { slug: "salesforce", name: "Salesforce", re: /salesforce\.com|force\.com|pardot/i },
  { slug: "zendesk", name: "Zendesk", re: /zendesk\.com|zdassets\.com/i, chat: true },
  { slug: "intercom", name: "Intercom", re: /intercom\.io|widget\.intercom/i, chat: true },
  { slug: "crisp", name: "Crisp", re: /crisp\.chat/i, chat: true },
  { slug: "tawk", name: "Tawk.to", re: /tawk\.to/i, chat: true },
  { slug: "gorgias", name: "Gorgias", re: /gorgias\.(com|chat)/i, chat: true },
  { slug: "tidio", name: "Tidio", re: /tidio\.co/i, chat: true },
  { slug: "drift", name: "Drift", re: /drift\.com/i, chat: true },
  { slug: "zopim", name: "Zopim", re: /zopim/i, chat: true },
  { slug: "stripe", name: "Stripe", re: /js\.stripe\.com|stripe\.com\/v3/i },
  { slug: "paypal", name: "PayPal", re: /paypal\.com\/sdk|paypalobjects/i },
  { slug: "calendly", name: "Calendly", re: /calendly\.com/i },
  { slug: "klaviyo", name: "Klaviyo", re: /klaviyo\.com|static\.klaviyo/i },
  { slug: "yotpo", name: "Yotpo", re: /yotpo\.com|staticw2\.yotpo/i },
  { slug: "judgeme", name: "Judge.me", re: /judge\.me|judgeme/i },
  { slug: "loox", name: "Loox", re: /loox\.io/i },
  { slug: "returngo", name: "ReturnGO", re: /returngo\.ai|returngo/i },
];

function collectMatches(re: RegExp, hay: string, group = 1, cap = 12): string[] {
  const out = new Set<string>();
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(hay)) && out.size < cap) { if (m[group]) out.add(m[group].trim()); }
  return Array.from(out);
}

const EMAIL_JUNK = /(sentry|wix(press)?|example\.com|\.png|\.jpg|\.gif|@2x|@3x|godaddy|schema\.org|sentry\.io|w3\.org|core\.js)/i;

export interface DiscoverySignals {
  emails: string[];
  phones: string[];
  whatsapp: string[];
  instagram: string[];
  facebook: string[];
  messenger: string[];
  telegram: string[];
  tiktok: string[];
  contactForm: boolean;
  liveChat: string | null;
  platform: { slug: string; name: string; strength: number } | null;
  otherPlatforms: Array<{ slug: string; name: string; strength: number }>;
  tracking: string[];
  tools: string[];
  social: string[];
  coverage: string[]; // URLs actually read
  /** email → "gmail" | "outlook" from an MX lookup of the email's domain. */
  emailProviders?: Record<string, string>;
}

/**
 * Which mail platform serves the found addresses - a deterministic MX lookup
 * per unique domain (google → Gmail/Workspace, outlook/microsoft → Microsoft
 * 365). Lets the briefing show the real provider logo and offer the matching
 * one-click connect. Best-effort: DNS failures simply yield no provider.
 */
async function detectEmailProviders(emails: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const domains = Array.from(new Set(emails.map((e) => e.split("@")[1]).filter((d): d is string => !!d))).slice(0, 4);
  await Promise.all(domains.map(async (domain) => {
    try {
      const mx = await dns.resolveMx(domain);
      const hosts = mx.map((m) => m.exchange.toLowerCase()).join(" ");
      const provider = /google|gmail/.test(hosts) ? "gmail" : /outlook|microsoft|office365/.test(hosts) ? "outlook" : null;
      if (provider) for (const e of emails) if (e.toLowerCase().endsWith("@" + domain)) out[e] = provider;
    } catch { /* unresolvable domain - no provider claim */ }
  }));
  return out;
}

/** Parse JSON-LD blocks for org contact info + social profiles (sameAs). */
function parseJsonLd(html: string): { emails: string[]; phones: string[]; social: string[] } {
  const emails = new Set<string>(), phones = new Set<string>(), social = new Set<string>();
  for (const block of collectMatches(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi, html, 1, 8)) {
    let data: any;
    try { data = JSON.parse(block); } catch { continue; }
    const nodes: any[] = Array.isArray(data) ? data : data["@graph"] && Array.isArray(data["@graph"]) ? data["@graph"] : [data];
    for (const n of nodes) {
      if (!n || typeof n !== "object") continue;
      if (typeof n.email === "string") emails.add(n.email.replace(/^mailto:/i, "").trim());
      if (typeof n.telephone === "string") phones.add(n.telephone.trim());
      const sa = n.sameAs;
      if (Array.isArray(sa)) sa.forEach((u: any) => typeof u === "string" && social.add(u));
      else if (typeof sa === "string") social.add(sa);
      const cp = n.contactPoint;
      const cps = Array.isArray(cp) ? cp : cp ? [cp] : [];
      for (const c of cps) { if (c?.telephone) phones.add(String(c.telephone).trim()); if (c?.email) emails.add(String(c.email).replace(/^mailto:/i, "").trim()); }
    }
  }
  return { emails: [...emails], phones: [...phones], social: [...social] };
}

function extractSignals(pages: Array<{ url: string; html: string }>): DiscoverySignals {
  const html = pages.map((p) => p.html).join("\n");

  const emails = new Set<string>();
  collectMatches(/mailto:([^"'>?\s]+)/gi, html).forEach((e) => emails.add(decodeURIComponent(e).toLowerCase()));
  collectMatches(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, html, 0, 20).forEach((e) => emails.add(e.toLowerCase()));

  const phones = new Set<string>();
  collectMatches(/tel:(\+?[\d][\d\-\s().]{5,})/gi, html).forEach((p) => phones.add(p.replace(/[\s().]/g, "")));

  const whatsapp = new Set<string>();
  // Broadened so WhatsApp isn't silently dropped: classic wa.me / api links,
  // the whatsapp:// app scheme, and wa.link short links all count.
  [
    /wa\.me\/(\+?\d{6,15})/gi,
    /api\.whatsapp\.com\/send\?phone=(\d{6,15})/gi,
    /whatsapp[^"']*?phone=(\d{6,15})/gi,
    /whatsapp:\/\/send\?phone=(\+?\d{6,15})/gi,
    /wa\.link\/(\+?\d{6,15})/gi,
  ].forEach((re) => collectMatches(re, html).forEach((n) => whatsapp.add(n.replace(/^\+/, ""))));

  const handle = (re: RegExp, exclude: RegExp) =>
    collectMatches(re, html).filter((h) => !exclude.test(h));
  const instagram = handle(/instagram\.com\/([A-Za-z0-9_.]{2,40})/gi, /^(p|reel|reels|explore|accounts|stories|tv|about)$/i);
  const facebook = handle(/facebook\.com\/([A-Za-z0-9_.]{2,60})/gi, /^(sharer|tr|plugins|dialog|events|groups|profile\.php|permalink\.php|photo|login|help|policies|policy|terms|privacy|legal|about|business|ads|settings|watch|marketplace|gaming)$/i);
  const messenger = collectMatches(/m\.me\/([A-Za-z0-9_.]+)/gi, html);
  const telegram = handle(/t\.me\/([A-Za-z0-9_]{3,32})/gi, /^(share|joinchat)$/i);
  const tiktok = handle(/tiktok\.com\/@([A-Za-z0-9_.]{2,30})/gi, /^$/);

  const jsonld = parseJsonLd(html);
  jsonld.emails.forEach((e) => e && emails.add(e.toLowerCase()));
  jsonld.phones.forEach((p) => p && phones.add(p.replace(/[\s().]/g, "")));

  // Platform strength scoring.
  const scored = PLATFORM_DEFS
    .map((d) => ({ slug: d.slug, name: d.name, strength: d.patterns.reduce((s, re) => s + (re.test(html) ? 1 : 0), 0) }))
    .filter((p) => p.strength > 0)
    .sort((a, b) => b.strength - a.strength);
  const platform = scored[0] || null;
  const otherPlatforms = scored.slice(1);

  const tracking = TRACKING_DEFS.filter((t) => t.re.test(html)).map((t) => t.slug);
  const matchedTools = TOOL_DEFS.filter((t) => t.re.test(html));
  const tools = matchedTools.map((t) => t.slug);
  const liveChat = matchedTools.find((t) => t.chat)?.name || null;

  const contactForm = /<form[\s\S]{0,6000}(contact|message|inquir|נשמח|צור.?קשר|שליחה|get in touch)/i.test(html);

  const social = new Set<string>(jsonld.social);
  instagram.forEach((h) => social.add(`https://instagram.com/${h}`));
  facebook.forEach((h) => social.add(`https://facebook.com/${h}`));

  const clean = (arr: string[]) => arr.filter((e) => !EMAIL_JUNK.test(e));
  return {
    emails: clean([...emails]).slice(0, 8),
    phones: [...phones].slice(0, 6),
    whatsapp: [...whatsapp].slice(0, 4),
    instagram: instagram.slice(0, 4),
    facebook: facebook.slice(0, 4),
    messenger: messenger.slice(0, 3),
    telegram: telegram.slice(0, 3),
    tiktok: tiktok.slice(0, 3),
    contactForm,
    liveChat,
    platform,
    otherPlatforms,
    tracking,
    tools,
    social: [...social].slice(0, 10),
    coverage: pages.map((p) => p.url),
  };
}

/** Call the AI service to run the deep 5-domain LLM scan. Forwards the admin
 *  JWT exactly like callAIGenerateConfigs. Returns the report or null. */
async function callAIDiscoverBusiness(
  authHeader: string,
  body: { domain: string; locale: string; pages: Array<{ url: string; text: string }>; signals: DiscoverySignals; businessType?: string },
): Promise<any | null> {
  try {
    const res = await fetchWithTimeout(`${AI_SERVICE_URL}/api/ai-assist/discover-business`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify(body),
    }, 60000);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { ok?: boolean; report?: any } };
    if (!json?.data?.ok || !json.data.report) return null;
    return json.data.report;
  } catch (err: any) {
    console.warn("[Onboarding] AI discover-business failed:", err?.message);
    return null;
  }
}

// Business types for which shipping/returns/refund policies are a genuine,
// expected gap. Everyone else (SaaS, legal, health, real-estate, generic B2B)
// is never asked for a "shipping policy" - that was the invented-gap bug.
const BUSINESS_TYPE_EXPECTS_FULFILMENT = new Set<string>(["ecommerce", "restaurant"]);

// A gap that only makes sense for a business that ships physical goods. Matched
// on the gap's label/id/key so it survives the LLM phrasing the gap freely.
function isFulfilmentPolicyGap(gap: any): boolean {
  const hay = `${gap?.id || ""} ${gap?.key || ""} ${gap?.label || ""} ${gap?.domain || ""}`.toLowerCase();
  return /shipping|return|refund|delivery|משלוח|החזר|החזרים|ביטול עסקה/.test(hay);
}

// Derive the Business Health check (Movement 3) - a colleague's self-assessment
// of "can I help you yet?", grouped Knowledge / Communication / Tools. ✓ for
// what was found/detected, ⚠ for the genuine gaps. NOT a management score.
function deriveHealth(report: any, live: { coreSystemSlug: string | null; connectedChannel: boolean }, businessType?: string): any {
  const kn = report?.knowledge || {};
  const pol = kn.policies || {};
  // A policy is a confidence-levelled finding {found, confidence}. Only a
  // genuine `found === true` counts as ✓; found:false or null (unsure) is ⚠.
  const has = (p: any): boolean => (p && typeof p === "object" ? p.found === true : !!p);
  // Business-type–aware knowledge checklist. Shipping/Returns/Refunds are ONLY a
  // meaningful gap for retail/ecommerce - asking a B2B SaaS or a law firm for a
  // "shipping policy" is the invented-gap bug. Every business gets FAQ + Help
  // Center; retail adds fulfilment policies, everyone else gets the universal
  // legal pages (Privacy/Terms) instead.
  const knowledge: Array<{ label: string; ok: boolean }> = [
    { label: "FAQ", ok: !!kn.hasFaq },
    { label: "Help Center", ok: !!kn.hasHelpCenter },
  ];
  if (BUSINESS_TYPE_EXPECTS_FULFILMENT.has(businessType || "")) {
    knowledge.push(
      { label: "Refund policy", ok: has(pol.refunds) },
      { label: "Shipping policy", ok: has(pol.shipping) },
      { label: "Returns policy", ok: has(pol.returns) },
    );
  } else {
    // Universal pages that apply to any business - surfaced only when actually
    // found, so they never read as an invented gap on a services/SaaS site.
    if (has(pol.privacy)) knowledge.push({ label: "Privacy policy", ok: true });
    if (has(pol.terms)) knowledge.push({ label: "Terms of service", ok: true });
  }
  const channels: Array<{ type: string }> = Array.isArray(report?.communication?.channels) ? report.communication.channels : [];
  const seen = new Set<string>();
  const communication: Array<{ label: string; ok: boolean }> = [];
  for (const c of channels) {
    if (!c || typeof c.type !== "string" || seen.has(c.type)) continue;
    seen.add(c.type);
    communication.push({ label: `${c.type} detected`, ok: true });
  }
  if (communication.length === 0) communication.push({ label: "No channels detected yet", ok: false });

  const tech = report?.technology || {};
  const tools: Array<{ label: string; ok: boolean }> = [];
  if (tech.platform?.name) tools.push({ label: `${tech.platform.name} detected`, ok: true });
  (Array.isArray(tech.tools) ? tech.tools : []).slice(0, 4).forEach((t: any) => tools.push({ label: `${t.name || t.slug} detected`, ok: true }));
  tools.push({ label: live.coreSystemSlug ? "Customer system connected" : "CRM not connected", ok: !!live.coreSystemSlug });

  return { knowledge, communication, tools };
}

const discoverSchema = z.object({
  domain: z.string().min(3).max(255),
  locale: z.string().min(2).max(10).optional().default("en"),
});

router.post("/discover", requireRole("ADMIN"), validate(discoverSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { domain, locale } = req.body as { domain: string; locale: string };
    const origin = normalizeDomain(domain);
    if (!origin) {
      res.json({ data: { ok: false, reason: "invalid_domain" } });
      return;
    }

    // Re-scan concurrency guard (T-2): refuse a second scan while one is
    // genuinely in flight. A SCANNING row untouched for >3 min is treated as a
    // crashed request and allowed to restart, so a stale flag never traps a
    // tenant. Prevents two racing scans last-writer-wins.
    const prior = await prisma.businessDiscovery.findUnique({
      where: { tenantId: req.tenantId! },
      select: { status: true, updatedAt: true },
    });
    if (prior?.status === "SCANNING" && Date.now() - new Date(prior.updatedAt).getTime() < 3 * 60_000) {
      res.status(409).json({ error: "scan_in_progress", data: { ok: false, reason: "scan_in_progress", domain: origin } });
      return;
    }

    // Mark the scan as running WITHOUT clearing the prior report (T-2): a failed
    // or slow re-scan leaves the last good report readable. The full-screen
    // ceremony covers the scan, so stale data is never shown mid-scan; new
    // results overwrite atomically on success below.
    await prisma.businessDiscovery.upsert({
      where: { tenantId: req.tenantId! },
      update: { status: "SCANNING", websiteDomain: origin, scanPhase: "homepage" },
      create: { tenantId: req.tenantId!, status: "SCANNING", websiteDomain: origin, scanPhase: "homepage" },
    });

    const home = await fetchPageRaw(origin);
    if (!home) {
      await prisma.businessDiscovery.update({
        where: { tenantId: req.tenantId! },
        data: { status: "FAILED" },
      }).catch(() => {});
      res.json({ data: { ok: false, reason: "fetch_failed", domain: origin } });
      return;
    }

    // Ceremony phase: homepage read - now exploring the site's own pages. The
    // frontend polls GET /discovery during the scan, so each write here lands a
    // REAL checkmark (no timers).
    await prisma.businessDiscovery.update({ where: { tenantId: req.tenantId! }, data: { scanPhase: "pages" } }).catch(() => {});

    // Deep same-origin crawl: discovered policy/contact links + well-known
    // convention paths (deduped). This is the accuracy fix - most "missing"
    // policies/contact details live in the footer or at a predictable URL, not
    // on the home page. fetchPageRaw returns null fast on a 404, so probing is
    // cheap; we cap total fetches to stay polite.
    const discovered = extractInternalLinks(home.html, origin, 10);
    const candidates = CANDIDATE_PATHS.map((p) => { try { return new URL(p, origin).toString(); } catch { return null; } }).filter((u): u is string => !!u);
    const toFetch = Array.from(new Set([...discovered, ...candidates])).filter((u) => u !== origin && u !== origin + "/").slice(0, 16);
    const fetched = (await Promise.all(toFetch.map((u) => fetchPageRaw(u, 6000)))).map((page, i) => ({ url: toFetch[i]!, page }));
    const okPages = fetched.filter((e) => e.page).map((e) => ({ url: e.url, html: e.page!.html, text: e.page!.text }));

    // Cap the text we ship to the AI so the JSON body stays under its
    // body-parser limit. The AI trims further when building the LLM corpus.
    const pages = [
      { url: origin, text: home.text.slice(0, 9000) },
      ...okPages.map((e) => ({ url: e.url, text: e.text.slice(0, 2800) })),
    ];

    const signals = extractSignals([{ url: origin, html: home.html }, ...okPages]);
    signals.emailProviders = await detectEmailProviders(signals.emails);

    // Usecase-aware analysis starts HERE: classify the business deterministically
    // from its own pages (event venue ≠ Shopify store ≠ B2B SaaS) and thread it
    // through the whole scan so the LLM, health, and gaps all reason about the
    // RIGHT business - no more inventing a "return policy" for a SaaS.
    const businessType = classifyBusinessType([home.text, ...okPages.map((p) => p.text)].join(" "), signals);

    // Deterministic findings, persisted at the synthesis boundary. This is what
    // the ceremony renders as LIVE facts while the LLM thinks ("Found WhatsApp,
    // Shopify…"), and it doubles as the honest fallback the review shows if the
    // LLM step fails. Overwritten atomically by the normalized report on success.
    const deterministicChannels = [
      ...signals.whatsapp.map((id) => ({ type: "whatsapp", identifier: id, confidence: "confirmed" })),
      ...signals.instagram.map((h) => ({ type: "instagram", identifier: `@${h}`, confidence: "confirmed" })),
      ...signals.emails.map((e) => ({ type: "email", identifier: e, confidence: "confirmed", provider: signals.emailProviders?.[e] })),
      ...signals.phones.map((p) => ({ type: "phone", identifier: p, confidence: "confirmed" })),
    ];
    // Ceremony phase: the deep 5-domain LLM synthesis (the longest beat).
    await prisma.businessDiscovery.update({
      where: { tenantId: req.tenantId! },
      data: {
        scanPhase: "synthesis",
        communication: { channels: deterministicChannels },
        technology: { platform: signals.platform, tools: signals.tools.map((s) => ({ slug: s, name: s })) },
      },
    }).catch(() => {});

    const report = await callAIDiscoverBusiness(req.headers.authorization!, { domain: origin, locale, pages, signals, businessType });
    if (!report) {
      // The deterministic signals were already persisted at the synthesis
      // boundary above - the review still shows the channels/tech we KNOW we
      // detected; only the status settles here.
      await prisma.businessDiscovery.update({
        where: { tenantId: req.tenantId! },
        data: { status: "FAILED", scanPhase: "failed" },
      }).catch(() => {});
      res.json({ data: { ok: false, reason: "scan_failed", domain: origin, signals } });
      return;
    }

    const coreSystemSlug = await connectedCoreSystem(req.tenantId!);
    const connectedChannel = !!(await prisma.channelAccount.findFirst({
      where: { tenantId: req.tenantId!, connectionStatus: "CONNECTED" },
      select: { id: true },
    }).catch(() => null));

    // Persist the business type onto the report so the frontend + recommendations
    // can read it too, then strip retail-fulfilment gaps for non-retail.
    if (report.business && typeof report.business === "object") {
      (report.business as any).businessType = businessType;
    } else {
      report.business = { businessType } as any;
    }
    // Drop retail-fulfilment gaps (shipping/returns/refunds) for any business
    // that doesn't sell physical goods - they're invented gaps otherwise.
    if (!BUSINESS_TYPE_EXPECTS_FULFILMENT.has(businessType) && Array.isArray(report.gaps)) {
      report.gaps = report.gaps.filter((g: any) => !isFulfilmentPolicyGap(g));
    }

    const health = deriveHealth(report, { coreSystemSlug, connectedChannel }, businessType);

    const saved = await prisma.businessDiscovery.upsert({
      where: { tenantId: req.tenantId! },
      update: {
        status: "COMPLETE",
        scanPhase: "done",
        websiteDomain: origin,
        brand: report.brand ?? undefined,
        business: report.business ?? undefined,
        knowledge: report.knowledge ?? undefined,
        communication: report.communication ?? undefined,
        technology: report.technology ?? undefined,
        gaps: report.gaps ?? undefined,
        recommendation: report.recommendation ?? undefined,
        confidence: report.confidence ?? undefined,
        health,
        report: report.report ?? undefined,
        scannedAt: new Date(),
      },
      create: {
        tenantId: req.tenantId!,
        status: "COMPLETE",
        websiteDomain: origin,
        brand: report.brand ?? undefined,
        business: report.business ?? undefined,
        knowledge: report.knowledge ?? undefined,
        communication: report.communication ?? undefined,
        technology: report.technology ?? undefined,
        gaps: report.gaps ?? undefined,
        recommendation: report.recommendation ?? undefined,
        confidence: report.confidence ?? undefined,
        health,
        report: report.report ?? undefined,
        scannedAt: new Date(),
      },
    });

    // Persist the discovery's recommendations as a living backlog (nothing is
    // ephemeral; "I'll do it later" loses nothing). Best-effort.
    syncDiscoveryRecommendations(req.tenantId!, report).catch(() => {});

    // Re-arm the onboarding nudge: if they go quiet after discovery, the sweep
    // will send "I noticed you stopped after Business Discovery" ~a day later.
    scheduleOnboardingNudge(req.tenantId!, "1d").catch(() => {});

    res.json({ data: { ok: true, domain: origin, discovery: saved } });
  } catch (err) {
    console.error("Discover error:", err);
    res.status(500).json({ error: "Failed to discover business" });
  }
});

// POST /discover/plan - the dynamic, business-typed discovery ceremony (Movement 1).
// Deterministic (NO LLM): a fast homepage-only fetch → classify the business →
// emit the REAL steps the scan will perform for THIS kind of business, so the
// loader reflects actual work (ecommerce ≠ law firm ≠ SaaS), never a fixed
// animation. Falls back to a generic plan on any failure so the ceremony always
// has steps to show. The heavy /discover call runs right after, and the final
// step holds until it returns - so duration reflects the real work.
const ECOM_PLATFORMS = new Set(["shopify", "woocommerce", "magento", "bigcommerce", "prestashop", "wix_stores", "squarespace_commerce", "ecwid", "shopware", "opencart"]);

function classifyBusinessType(text: string, signals: DiscoverySignals): string {
  const t = (text || "").toLowerCase();
  const plat = (signals.platform?.slug || "").toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => t.includes(w));
  if (ECOM_PLATFORMS.has(plat) || has("add to cart", "add to bag", "checkout", "free shipping", "in stock", "sold out", "my cart", "shopping cart", "עגלה", "הוסף לסל", "משלוח חינם", "לרכישה")) return "ecommerce";
  if (has("law firm", "attorney", "lawyer", "litigation", "practice areas", "legal services", "counsel", "עורך דין", "עורכי דין", "ייעוץ משפטי", "משרד עורכי")) return "legal";
  if (has("free trial", "start free", "start for free", "/pricing", "api documentation", "integrations", "sign up free", "our platform", "software platform", "for developers", "open source")) return "saas";
  if (has("event venue", "event space", "wedding venue", "banquet", "event hall", "host your event", "weddings", "corporate events", "our venue", "book the venue", "אולם אירועים", "גן אירועים", "אולמי אירועים", "חתונות", "בר מצווה", "בת מצווה", "הפקת אירועים", "קייטרינג לאירועים")) return "events";
  if (has("book now", "tours", "vacation", "itinerary", "destinations", "guided tour", "travel", "book your", "טיול", "חופשה", "יעדים", "הזמנת מקום")) return "tourism";
  if (has("view menu", "our menu", "reservation", "reserve a table", "order online", "delivery & pickup", "restaurant", "תפריט", "הזמנת שולחן", "משלוחים", "מסעדה")) return "restaurant";
  if (has("book an appointment", "clinic", "our patients", "treatment", "our doctors", "medical", "dental", "מרפאה", "לקביעת תור", "טיפול", "רופא")) return "health";
  if (has("properties", "listings", "for sale", "for rent", "real estate", "square feet", 'נדל"ן', "דירות", "להשכרה", "למכירה")) return "realestate";
  return "generic";
}

// [key, English, Hebrew] - each step is a genuine phase of the scan.
const DISCOVERY_PLANS: Record<string, Array<[string, string, string]>> = {
  ecommerce: [
    ["platform", "Detecting your ecommerce platform", "מזהה את פלטפורמת המסחר שלכם"],
    ["catalog", "Reading your product catalog", "קורא את קטלוג המוצרים"],
    ["policies", "Finding your shipping & return policies", "מוצא את מדיניות המשלוח וההחזרות"],
    ["channels", "Detecting your customer communication channels", "מזהה את ערוצי התקשורת עם הלקוחות"],
    ["employee", "Preparing your first AI Employee", "מכין את עובד ה-AI הראשון שלכם"],
  ],
  legal: [
    ["services", "Understanding your legal services", "מבין את השירותים המשפטיים שלכם"],
    ["areas", "Reading your practice areas", "קורא את תחומי ההתמחות"],
    ["appointments", "Finding your appointment methods", "מוצא את דרכי קביעת הפגישות"],
    ["channels", "Detecting your communication channels", "מזהה את ערוצי התקשורת"],
    ["employee", "Preparing your first AI Employee", "מכין את עובד ה-AI הראשון שלכם"],
  ],
  saas: [
    ["product", "Understanding your product", "מבין את המוצר שלכם"],
    ["docs", "Reading your documentation", "קורא את התיעוד שלכם"],
    ["helpcenter", "Detecting your Help Center", "מזהה את מרכז העזרה"],
    ["channels", "Detecting your communication channels", "מזהה את ערוצי התקשורת"],
    ["employee", "Preparing your first AI Employee", "מכין את עובד ה-AI הראשון שלכם"],
  ],
  tourism: [
    ["offering", "Understanding your destinations & tours", "מבין את היעדים והטיולים שלכם"],
    ["booking", "Reading your booking options", "קורא את אפשרויות ההזמנה"],
    ["policies", "Finding your cancellation & travel policies", "מוצא את מדיניות הביטול והנסיעה"],
    ["channels", "Detecting your communication channels", "מזהה את ערוצי התקשורת"],
    ["employee", "Preparing your first AI Employee", "מכין את עובד ה-AI הראשון שלכם"],
  ],
  restaurant: [
    ["menu", "Reading your menu", "קורא את התפריט שלכם"],
    ["ordering", "Finding your reservation & ordering options", "מוצא את אפשרויות ההזמנה והשולחנות"],
    ["hours", "Detecting your hours & locations", "מזהה את שעות הפעילות והסניפים"],
    ["channels", "Detecting your communication channels", "מזהה את ערוצי התקשורת"],
    ["employee", "Preparing your first AI Employee", "מכין את עובד ה-AI הראשון שלכם"],
  ],
  health: [
    ["services", "Understanding your services", "מבין את השירותים שלכם"],
    ["appointments", "Finding your appointment methods", "מוצא את דרכי קביעת התורים"],
    ["policies", "Reading your patient information", "קורא את המידע למטופלים"],
    ["channels", "Detecting your communication channels", "מזהה את ערוצי התקשורת"],
    ["employee", "Preparing your first AI Employee", "מכין את עובד ה-AI הראשון שלכם"],
  ],
  realestate: [
    ["listings", "Understanding your listings", "מבין את הנכסים שלכם"],
    ["services", "Reading your services", "קורא את השירותים שלכם"],
    ["contact", "Finding your contact & viewing methods", "מוצא את דרכי יצירת הקשר והצפייה"],
    ["channels", "Detecting your communication channels", "מזהה את ערוצי התקשורת"],
    ["employee", "Preparing your first AI Employee", "מכין את עובד ה-AI הראשון שלכם"],
  ],
  events: [
    ["offering", "Understanding your venue & event types", "מבין את המקום וסוגי האירועים"],
    ["availability", "Reading your booking & availability options", "קורא את אפשרויות ההזמנה והזמינות"],
    ["packages", "Finding your packages & pricing", "מוצא את החבילות והמחירים"],
    ["channels", "Detecting your communication channels", "מזהה את ערוצי התקשורת"],
    ["employee", "Preparing your first AI Employee", "מכין את עובד ה-AI הראשון שלכם"],
  ],
  generic: [
    ["website", "Reading your website", "קורא את האתר שלכם"],
    ["about", "Understanding what you do", "מבין מה אתם עושים"],
    ["brand", "Learning your brand voice", "לומד את קול המותג שלכם"],
    ["channels", "Detecting your communication channels", "מזהה את ערוצי התקשורת"],
    ["employee", "Preparing your first AI Employee", "מכין את עובד ה-AI הראשון שלכם"],
  ],
};

function planSteps(type: string, locale: string): Array<{ key: string; label: string }> {
  const he = locale === "he";
  return (DISCOVERY_PLANS[type] || DISCOVERY_PLANS.generic).map(([key, en, hb]) => ({ key, label: he ? hb : en }));
}

const planSchema = z.object({
  domain: z.string().min(3).max(255),
  locale: z.string().min(2).max(10).optional().default("en"),
});

router.post("/discover/plan", requireRole("ADMIN"), validate(planSchema), async (req: Request, res: Response): Promise<void> => {
  const locale = (req.body?.locale as string) || "en";
  try {
    const origin = normalizeDomain((req.body as { domain: string }).domain);
    if (!origin) { res.json({ data: { ok: false, businessType: "generic", steps: planSteps("generic", locale) } }); return; }
    const home = await fetchPageRaw(origin, 6000);
    let type = "generic";
    if (home) {
      const signals = extractSignals([{ url: origin, html: home.html }]);
      type = classifyBusinessType(home.text, signals);
    }
    res.json({ data: { ok: true, businessType: type, steps: planSteps(type, locale) } });
  } catch (err) {
    // Never block the ceremony - always hand back a usable generic plan.
    res.json({ data: { ok: false, businessType: "generic", steps: planSteps("generic", locale) } });
  }
});

// GET /discovery - the persisted Business Intelligence Report (re-hydrates the
// review, health, and recommendation surfaces on refresh / OAuth return).
router.get("/discovery", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const discovery = await prisma.businessDiscovery.findUnique({ where: { tenantId: req.tenantId! } });
    res.json({ data: { discovery: discovery || null } });
  } catch (err) {
    console.error("Get discovery error:", err);
    res.status(500).json({ error: "Failed to get discovery" });
  }
});

// PATCH /discovery - the customer's one-tap corrections to the reflected-back
// portrait (Movement 2). Only the fields the review surfaces are patchable;
// each is merged so an unrelated correction never wipes another domain.
// Movement keys the resume checkpoint may record (review→ready band). Derived
// state stays authoritative for the coarse stage; `progress` only refines the
// resume position so a reload during movements 6-9 returns to that movement.
const MOVEMENT_KEYS = ["review", "connect", "goal", "integrations", "knowledge", "recommendation", "tune", "ready"] as const;

const discoveryPatchSchema = z.object({
  // Movement 7 - the owner names their employee on the Meet screen; merged
  // into recommendation.employeeName so /complete hires under that name.
  employeeName: z.string().min(1).max(120).optional(),
  business: z.object({
    name: z.string().max(200).optional(),
    industry: z.string().max(120).optional(),
    country: z.string().max(120).optional(),
    summary: z.string().max(2000).optional(),
    valueProp: z.string().max(2000).optional(),
    // Owner-editable products/services list (the scan sometimes over-guesses
    // these - the owner corrects them directly here, not via the flag menu).
    products: z.array(z.string().max(120)).max(24).optional(),
  }).optional(),
  brand: z.object({
    voice: z.string().max(200).optional(),
    tone: z.string().max(200).optional(),
    languages: z.array(z.string().max(20)).max(6).optional(),
  }).optional(),
  // Owner-edited communication channels (identifier/purpose fixed by hand so we
  // use the RIGHT number/address later for suggestions & connection).
  communication: z.object({
    channels: z.array(z.object({
      type: z.string().min(1).max(40),
      identifier: z.string().max(200).optional(),
      purpose: z.string().max(200).optional(),
      provider: z.string().max(40).optional(),
      confidence: z.string().max(40).optional(),
    })).max(24),
  }).optional(),
  // Resume checkpoint (P0): written fire-and-forget on each movement transition.
  progress: z.enum(MOVEMENT_KEYS).optional(),
});

router.patch("/discovery", requireRole("ADMIN"), validate(discoveryPatchSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const existing = await prisma.businessDiscovery.findUnique({ where: { tenantId: req.tenantId! } });
    if (!existing) {
      res.status(404).json({ error: "No discovery to correct yet" });
      return;
    }
    const patch = req.body as { business?: Record<string, unknown>; brand?: Record<string, unknown>; communication?: { channels: unknown[] }; progress?: string; employeeName?: string };
    const data: Record<string, unknown> = {};
    // Only merge a domain when the caller actually sent it, so a bare
    // progress-checkpoint write never re-writes business/brand.
    if (patch.business) data.business = { ...((existing.business as Record<string, unknown>) || {}), ...patch.business };
    if (patch.brand) data.brand = { ...((existing.brand as Record<string, unknown>) || {}), ...patch.brand };
    // Channels are REPLACED wholesale with the owner-edited list (the caller
    // sends the full array), preserving any other communication sub-fields.
    if (patch.communication?.channels) {
      data.communication = { ...((existing.communication as Record<string, unknown>) || {}), channels: patch.communication.channels };
    }
    if (patch.progress) data.progress = patch.progress;
    if (patch.employeeName?.trim()) {
      data.recommendation = { ...((existing.recommendation as Record<string, unknown>) || {}), employeeName: patch.employeeName.trim() };
    }
    const saved = await prisma.businessDiscovery.update({
      where: { tenantId: req.tenantId! },
      data,
    });
    res.json({ data: { discovery: saved } });
  } catch (err) {
    console.error("Patch discovery error:", err);
    res.status(500).json({ error: "Failed to save corrections" });
  }
});

// POST /discovery/correct - per-item corrections on the reflected-back portrait
// (Movement 2): remove / mark-incorrect / ignore a detected channel, tool,
// platform, or gap. The correction persists immediately (the AI "learns" it -
// the item never reappears) and a matching recommendation is dismissed.
const correctSchema = z.object({
  target: z.enum(["channel", "tool", "platform", "gap"]),
  action: z.enum(["remove", "incorrect", "ignore"]),
  key: z.string().min(1).max(200), // channel: type · tool/platform: slug · gap: label
});

router.post("/discovery/correct", requireRole("ADMIN"), validate(correctSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { target, key } = req.body as { target: string; action: string; key: string };
    const existing = await prisma.businessDiscovery.findUnique({ where: { tenantId: req.tenantId! } });
    if (!existing) { res.status(404).json({ error: "No discovery to correct yet" }); return; }

    const data: Record<string, unknown> = {};
    if (target === "channel") {
      const comm = (existing.communication as any) || { channels: [] };
      comm.channels = (Array.isArray(comm.channels) ? comm.channels : []).filter((c: any) => String(c?.type) !== key);
      data.communication = comm;
    } else if (target === "tool") {
      const tech = (existing.technology as any) || {};
      tech.tools = (Array.isArray(tech.tools) ? tech.tools : []).filter((t: any) => String(t?.slug) !== key);
      tech.legacy = (Array.isArray(tech.legacy) ? tech.legacy : []).filter((t: any) => String(t?.slug) !== key);
      tech.tracking = (Array.isArray(tech.tracking) ? tech.tracking : []).filter((t: any) => String(t?.slug) !== key);
      data.technology = tech;
    } else if (target === "platform") {
      const tech = (existing.technology as any) || {};
      tech.platform = null;
      data.technology = tech;
    } else if (target === "gap") {
      const slug = slugifyGap(key);
      data.gaps = (Array.isArray(existing.gaps) ? existing.gaps : []).filter((g: any) => slugifyGap(String(g?.label || "")) !== slug);
      await prisma.recommendation.updateMany({
        where: { tenantId: req.tenantId!, dedupeKey: { in: [`gap:${slug}`, `teach:${slug}`] }, status: "OPEN" },
        data: { status: "DISMISSED", dismissedAt: new Date() },
      }).catch(() => {});
    }

    const saved = await prisma.businessDiscovery.update({ where: { tenantId: req.tenantId! }, data });
    res.json({ data: { ok: true, discovery: saved } });
  } catch (err) {
    console.error("Correct discovery error:", err);
    res.status(500).json({ error: "Failed to apply correction" });
  }
});

// GET /health - Business Health (Movement 3), recomputed against LIVE connection
// state so a channel/system connected after the scan flips its ⚠ to ✓.
router.get("/health", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const discovery = await prisma.businessDiscovery.findUnique({ where: { tenantId: req.tenantId! } });
    if (!discovery) {
      res.json({ data: { health: null } });
      return;
    }
    const coreSystemSlug = await connectedCoreSystem(req.tenantId!);
    const connectedChannel = !!(await prisma.channelAccount.findFirst({
      where: { tenantId: req.tenantId!, connectionStatus: "CONNECTED" },
      select: { id: true },
    }).catch(() => null));
    const health = deriveHealth(
      { knowledge: discovery.knowledge, communication: discovery.communication, technology: discovery.technology },
      { coreSystemSlug, connectedChannel },
    );
    res.json({ data: { health, gaps: discovery.gaps || [] } });
  } catch (err) {
    console.error("Get health error:", err);
    res.status(500).json({ error: "Failed to get health" });
  }
});

// GET /recommendation - the first AI Recommendation (Movement 4), read straight
// off the persisted report.
router.get("/recommendation", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const discovery = await prisma.businessDiscovery.findUnique({
      where: { tenantId: req.tenantId! },
      select: { recommendation: true },
    });
    res.json({ data: { recommendation: discovery?.recommendation || null } });
  } catch (err) {
    console.error("Get recommendation error:", err);
    res.status(500).json({ error: "Failed to get recommendation" });
  }
});

// POST /teach - the customer teaches the AI a gap inline (paste text / give a
// URL). Persists it as real knowledge, resolves the gap on the discovery, and
// completes the matching recommendation. "Teaching a colleague, not a form."
const teachSchema = z.object({
  label: z.string().min(1).max(200),
  method: z.enum(["text", "url"]),
  value: z.string().min(1).max(20000),
});

function slugifyGap(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "item";
}

router.post("/teach", requireRole("ADMIN"), validate(teachSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { label, method, value } = req.body as { label: string; method: "text" | "url"; value: string };

    // Resolve the content to learn.
    let content = value.trim();
    let sourceUrl: string | undefined;
    let sourceType = "text";
    if (method === "url") {
      const origin = normalizeDomain(value) || value.trim();
      const page = await fetchPageRaw(origin, 8000);
      if (!page || page.text.length < 20) {
        res.json({ data: { ok: false, reason: "fetch_failed" } });
        return;
      }
      content = page.text.slice(0, 20000);
      sourceUrl = origin;
      sourceType = "url";
    }

    // Store into the tenant's knowledge base (reuse the first, or create one).
    let kb = await prisma.knowledgeBase.findFirst({ where: { tenantId: req.tenantId! }, select: { id: true } });
    if (!kb) {
      kb = await prisma.knowledgeBase.create({ data: { tenantId: req.tenantId!, name: "Company Knowledge", description: "Taught during onboarding" }, select: { id: true } });
    }
    const doc = await prisma.knowledgeDocument.create({
      data: { knowledgeBaseId: kb.id, tenantId: req.tenantId!, title: label, content, sourceType, sourceUrl, metadata: { taughtDuringOnboarding: true } },
      select: { id: true },
    });

    // Complete the matching recommendation(s) and clear the gap on the report.
    const slug = slugifyGap(label);
    await prisma.recommendation.updateMany({
      where: { tenantId: req.tenantId!, dedupeKey: { in: [`gap:${slug}`, `teach:${slug}`] }, status: "OPEN" },
      data: { status: "COMPLETED", completedAt: new Date() },
    }).catch(() => {});
    const disc = await prisma.businessDiscovery.findUnique({ where: { tenantId: req.tenantId! }, select: { gaps: true } }).catch(() => null);
    if (disc && Array.isArray(disc.gaps)) {
      const remaining = disc.gaps.filter((g: any) => slugifyGap(String(g?.label || "")) !== slug);
      await prisma.businessDiscovery.update({ where: { tenantId: req.tenantId! }, data: { gaps: remaining } }).catch(() => {});
    }

    scheduleOnboardingNudge(req.tenantId!, "1d").catch(() => {});
    res.json({ data: { ok: true, knowledgeDocumentId: doc.id, label } });
  } catch (err) {
    console.error("Teach error:", err);
    res.status(500).json({ error: "Failed to learn that" });
  }
});

// GET /recommendations - the persistent living backlog (defaults to OPEN).
router.get("/recommendations", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "OPEN";
    // A "Connect X" that's already connected is fulfilled - settle it before
    // rendering so the list never asks for something the customer already did.
    await reconcileConnectSystemRecs(req.tenantId!);
    const recommendations = await listRecommendations(req.tenantId!, status);
    res.json({ data: { recommendations } });
  } catch (err) {
    console.error("List recommendations error:", err);
    res.status(500).json({ error: "Failed to list recommendations" });
  }
});

// POST /recommendations/:id/complete | /dismiss - resolve a recommendation.
// A resolved rec is never resurrected by a future re-scan.
router.post("/recommendations/:id/:decision", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const decision = req.params.decision === "dismiss" ? "DISMISSED" : req.params.decision === "complete" ? "COMPLETED" : null;
    if (!decision) { res.status(400).json({ error: "decision must be complete or dismiss" }); return; }
    const ok = await setRecommendationStatus(req.tenantId!, req.params.id as string, decision);
    if (!ok) { res.status(404).json({ error: "Recommendation not found" }); return; }
    res.json({ data: { id: req.params.id, status: decision } });
  } catch (err) {
    console.error("Resolve recommendation error:", err);
    res.status(500).json({ error: "Failed to update recommendation" });
  }
});

// POST /goal - the single earned question (Movement 5). Persisted on the
// discovery AND mirrored onto BusinessProfile.businessGoals so the post-
// onboarding home + mission ordering read it.
const goalSchema = z.object({
  // Multi-select: the owner can pick more than one thing that matters
  // (e.g. customer service + lead management) and the employee is built for all
  // of them. `goal` (single) kept for backward compatibility.
  goals: z.array(z.string().min(1).max(64)).min(1).max(4).optional(),
  goal: z.string().min(1).max(64).optional(),
  // Free-text elaboration - required UX for the "something else" goal, welcome
  // on any goal. Mirrored into BusinessProfile.businessGoals for the generator.
  detail: z.string().max(500).optional(),
}).refine((d) => (Array.isArray(d.goals) && d.goals.length > 0) || !!d.goal, {
  message: "At least one goal is required",
});

router.post("/goal", requireRole("ADMIN"), validate(goalSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as { goals?: string[]; goal?: string; detail?: string };
    // Normalize to a deduped list; the first is the PRIMARY (drives role/dept),
    // the rest STACK into the combined objective in the config generator.
    const goals = Array.from(new Set((body.goals?.length ? body.goals : (body.goal ? [body.goal] : [])).filter((g) => typeof g === "string" && g.trim()))).slice(0, 4);
    const primary = goals[0]!;
    const detail = body.detail;
    await prisma.businessDiscovery.upsert({
      where: { tenantId: req.tenantId! },
      update: { primaryGoal: primary },
      create: { tenantId: req.tenantId!, primaryGoal: primary, status: "PENDING" },
    });
    await prisma.businessProfile.updateMany({
      where: { tenantId: req.tenantId! },
      // Store the full slug list (all selected use-cases) so the generator can
      // combine them; append the free-text detail when present.
      data: { businessGoals: detail?.trim() ? [...goals, detail.trim()] : goals },
    }).catch(() => { /* profile may not exist yet; non-blocking */ });
    scheduleOnboardingNudge(req.tenantId!, "1d").catch(() => {}); // push the nudge forward
    res.json({ data: { primaryGoal: primary, goals } });
  } catch (err) {
    console.error("Set goal error:", err);
    res.status(500).json({ error: "Failed to save goal" });
  }
});

// POST /notify-integration - the owner spotted a tool we don't support yet (a
// ReturnGO-style app the scan flagged as important). One click tells the team so
// we know what to build next. Best-effort email to an env-configured alias; the
// request is always acknowledged to the UI even if mail isn't wired, so the owner
// never sees a dead end.
const notifyIntegrationSchema = z.object({
  integration: z.string().min(1).max(120),
  note: z.string().max(500).optional(),
  source: z.string().max(60).optional(),
});
router.post("/notify-integration", requireRole("ADMIN"), validate(notifyIntegrationSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { integration, note, source } = req.body as { integration: string; note?: string; source?: string };
    const [tenant, user, discovery] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: req.tenantId! }, select: { name: true } }).catch(() => null),
      prisma.user.findUnique({ where: { id: req.user!.userId }, select: { email: true, name: true } }).catch(() => null),
      prisma.businessDiscovery.findUnique({ where: { tenantId: req.tenantId! }, select: { websiteDomain: true } }).catch(() => null),
    ]);
    const sent = await sendIntegrationRequestEmail({
      integration: integration.trim(),
      tenantId: req.tenantId!,
      tenantName: tenant?.name || undefined,
      requestedByEmail: user?.email || undefined,
      requestedByName: user?.name || undefined,
      websiteDomain: discovery?.websiteDomain || undefined,
      note: note?.trim() || undefined,
      source: source?.trim() || "onboarding",
    });
    // Acknowledge regardless of transport state - the owner's intent is captured
    // and logged even if the email itself couldn't go out.
    res.json({ data: { ok: true, notified: sent } });
  } catch (err) {
    console.error("Notify integration error:", err);
    res.status(500).json({ error: "Failed to submit integration request" });
  }
});

// POST /employee-chat - Movement 8: chat with the recommended employee BEFORE
// it's deployed, and let the owner tune it in words. Proxies to services/ai (the
// only place a new LLM call may live) and persists the tuned persona onto the
// discovery, so /complete deploys the employee the owner actually shaped.
async function callAIEmployeeChat(authHeader: string, body: unknown): Promise<any | null> {
  try {
    const res = await fetchWithTimeout(`${AI_SERVICE_URL}/api/ai-assist/onboarding-employee-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify(body),
    }, 30000);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { ok?: boolean; reply?: string; persona?: any } };
    return json?.data?.ok ? json.data : null;
  } catch (err: any) {
    console.warn("[Onboarding] AI employee-chat failed:", err?.message);
    return null;
  }
}

const employeeChatSchema = z.object({
  persona: z.object({
    tone: z.string().max(40).optional(),
    personality: z.string().max(400).optional(),
    focus: z.string().max(200).optional(),
    // Conversational build: the owner-confirmed mandate + what success looks like,
    // captured live in the chat and applied to the employee at deploy.
    goal: z.string().max(600).optional(),
    successCriteria: z.array(z.string().max(300)).max(8).optional(),
    instructions: z.array(z.string().max(400)).max(20).optional(),
  }).optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(2000) })).min(1).max(20),
  locale: z.string().min(2).max(10).optional(),
});

router.post("/employee-chat", requireRole("ADMIN"), validate(employeeChatSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { persona, messages, locale } = req.body as { persona?: any; messages: Array<{ role: string; content: string }>; locale?: string };
    const disc = await prisma.businessDiscovery.findUnique({ where: { tenantId: req.tenantId! } });
    const rec = (disc?.recommendation || {}) as any;
    const dbiz = (disc?.business as any) || {};
    const dbrand = (disc?.brand as any) || {};
    const startPersona = persona || rec.tunedPersona || {};
    // The goal the system defined (from Movement-5) - passed so the build opens by
    // verifying it with the owner rather than inventing one.
    const definedGoal = disc?.primaryGoal ? String(disc.primaryGoal).replace(/_/g, " ") : undefined;
    const result = await callAIEmployeeChat(req.headers.authorization!, {
      name: rec.employeeName, role: rec.employeeRole || "customer_support", locale,
      context: {
        business: dbiz.name, industry: dbiz.industry,
        summary: dbiz.summary, brandVoice: dbrand.voice || dbrand.personality,
        goal: definedGoal,
      },
      persona: startPersona, messages,
    });
    if (!result) { res.json({ data: { ok: false } }); return; }

    // Persist the tuned persona onto the recommendation (deploy uses it) AND the
    // bounded transcript (last 20 turns) so a reload mid-tune resumes the chat.
    if (disc) {
      const transcript = [...messages, { role: "assistant", content: result.reply }]
        .filter((m) => m && typeof m.content === "string")
        .slice(-20);
      await prisma.businessDiscovery.update({
        where: { tenantId: req.tenantId! },
        data: { recommendation: { ...rec, tunedPersona: result.persona }, tuneTranscript: transcript },
      }).catch(() => {});
    }
    res.json({ data: { ok: true, reply: result.reply, persona: result.persona } });
  } catch (err) {
    console.error("Employee chat error:", err);
    res.status(500).json({ error: "Failed to chat with the employee" });
  }
});

// ─── Invite Teammates (Onboarding v2) ────────────────────────
//
// Two flavors:
//   1. POST /invite-team   - array of emails, each gets a magic-link email
//   2. POST /invite-link   - one shareable URL the admin can paste anywhere
//
// Both produce TenantInvite rows. Direct email invites also create a
// placeholder User immediately so we can sign them in via the existing
// magic-link verifier without changing that route's shape.

const inviteTeamSchema = z.object({
  emails: z.array(z.string().email()).min(1).max(25),
  role: z.enum(["ADMIN", "AGENT"]).optional().default("AGENT"),
});

const INVITE_LINK_EXPIRY_DAYS = 14;

router.post("/invite-team", requireRole("ADMIN"), validate(inviteTeamSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { emails, role } = req.body as { emails: string[]; role: "ADMIN" | "AGENT" };
    const tenantId = req.tenantId!;
    const inviter = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { name: true, email: true },
    });
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, slug: true },
    });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const cleanedEmails = Array.from(new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)));
    const results: Array<{ email: string; status: "sent" | "exists" | "failed"; error?: string }> = [];

    for (const email of cleanedEmails) {
      try {
        const existingUser = await prisma.user.findUnique({
          where: { tenantId_email: { tenantId, email } },
          select: { id: true },
        });
        if (existingUser) {
          results.push({ email, status: "exists" });
          continue;
        }

        // Create a placeholder user with a random password - they will
        // log in via the magic link and can change it later from /settings.
        const tempPassword = crypto.randomBytes(24).toString("hex");
        const hashed = await bcrypt.hash(tempPassword, 12);
        const user = await prisma.user.create({
          data: {
            tenantId,
            email,
            password: hashed,
            name: email.split("@")[0] || "Teammate",
            role,
            isActive: true,
          },
          select: { id: true },
        });

        const linkToken = await createMagicLink(tenantId, user.id);
        const inviteToken = crypto.randomBytes(24).toString("hex");
        const expiresAt = new Date(Date.now() + INVITE_LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
        await prisma.tenantInvite.create({
          data: {
            tenantId,
            token: inviteToken,
            email,
            role,
            invitedBy: req.user!.userId,
            userId: user.id,
            expiresAt,
          },
        });

        await sendTeammateInvite({
          email,
          tenantName: tenant.name,
          tenantSlug: tenant.slug,
          inviterName: inviter?.name || inviter?.email || "Your team",
          magicLinkToken: linkToken,
        });

        results.push({ email, status: "sent" });
      } catch (perEmailErr: any) {
        console.error(`[Onboarding] Invite failed for ${email}:`, perEmailErr?.message);
        results.push({ email, status: "failed", error: perEmailErr?.message || "send failed" });
      }
    }

    res.json({ data: { results } });
  } catch (err) {
    console.error("Invite team error:", err);
    res.status(500).json({ error: "Failed to send invites" });
  }
});

router.post("/invite-link", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.tenantId!;
    const role = (req.body?.role as "ADMIN" | "AGENT") === "ADMIN" ? "ADMIN" : "AGENT";

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + INVITE_LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await prisma.tenantInvite.create({
      data: {
        tenantId,
        token,
        role,
        invitedBy: req.user!.userId,
        expiresAt,
      },
    });

    const frontendUrl = process.env.FRONTEND_URL || "https://gotcha.co.il";
    const url = `${frontendUrl}/join?token=${token}`;
    res.json({ data: { url, token, expiresAt } });
  } catch (err) {
    console.error("Generate invite link error:", err);
    res.status(500).json({ error: "Failed to generate invite link" });
  }
});

// Public route - used by the /join page to render tenant context before
// the user fills the form. Auth NOT required.
const publicRouter = Router();

publicRouter.get("/invite/:token", async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.params.token as string;
    const invite = await prisma.tenantInvite.findUnique({
      where: { token },
      include: { tenant: { select: { name: true, slug: true } } },
    });
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      res.status(404).json({ error: "invite_invalid_or_expired" });
      return;
    }
    res.json({
      data: {
        tenant: invite.tenant,
        email: invite.email,
        role: invite.role,
        requiresPassword: !invite.userId,
      },
    });
  } catch (err) {
    console.error("Get invite error:", err);
    res.status(500).json({ error: "Failed to load invite" });
  }
});

const acceptInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
  password: z.string().min(8).max(128),
});

publicRouter.post("/invite/accept", validate(acceptInviteSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, name, email, password } = req.body as {
      token: string; name: string; email?: string; password: string;
    };

    const invite = await prisma.tenantInvite.findUnique({ where: { token } });
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      res.status(404).json({ error: "invite_invalid_or_expired" });
      return;
    }

    const finalEmail = (invite.email || email || "").trim().toLowerCase();
    if (!finalEmail) {
      res.status(400).json({ error: "email_required" });
      return;
    }

    const hashed = await bcrypt.hash(password, 12);
    let user;

    if (invite.userId) {
      // Targeted invite - user row exists from invite-team. Just set
      // their real password + name and mark the invite accepted.
      user = await prisma.user.update({
        where: { id: invite.userId },
        data: { name, password: hashed, isActive: true },
        select: { id: true, email: true, name: true, role: true, tenantId: true },
      });
    } else {
      // Open-link invite - create the user now. Reject if the email is
      // already in this tenant (collision = ask them to log in instead).
      const existing = await prisma.user.findUnique({
        where: { tenantId_email: { tenantId: invite.tenantId, email: finalEmail } },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({ error: "email_already_in_tenant" });
        return;
      }
      user = await prisma.user.create({
        data: {
          tenantId: invite.tenantId,
          email: finalEmail,
          name,
          password: hashed,
          role: invite.role === "ADMIN" ? "ADMIN" : "AGENT",
          isActive: true,
        },
        select: { id: true, email: true, name: true, role: true, tenantId: true },
      });
    }

    await prisma.tenantInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date(), userId: user.id },
    });

    // Don't sign a session here - the /join page redirects to /login
    // with the email pre-filled. Keeps this route stateless and simple.
    res.json({ data: { ok: true, tenantId: user.tenantId } });
  } catch (err) {
    console.error("Accept invite error:", err);
    res.status(500).json({ error: "Failed to accept invite" });
  }
});

export { publicRouter as publicInviteRouter };
export default router;
