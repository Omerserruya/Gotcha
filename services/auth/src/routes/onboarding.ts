import { getInternalServiceKey, safeFetch,
  resolveAppPublicUrl,
  canvasHasRunnableProcess,
  requirePermission } from "@chatcenter/shared";
import { Router, Request, Response } from "express";
import { CORE_SYSTEM_SLUGS, connectedCoreSystem } from "../services/onboarding-state.service";
import { z } from "zod";
import * as crypto from "crypto";
import {
  crawlSite,
  fetchPageRaw,
  classifyBusinessType,
  extractSignals,
  type DiscoverySignals,
} from "../services/site-crawl.service";
import { callDiscoverBusiness, persistCrawlReach } from "../services/business-scan.service";
import { prisma, authenticate, resolveTenant, requireRole, validate, trackAIUsage, meterAiUnits, writeAudit, AuditAction, normalizeDiscoveryRecord, normalizeDiscoveryTechnology, projectDiscoveryTopics, projectPages, projectReadinessAnswers, withoutWideDashes } from "@chatcenter/shared";
import { applyProjection, type SyncReport } from "../services/onboarding-knowledge.service";
import { sendActivationConfirmation, sendOnboardingInvite, sendTeammateInvite, sendIntegrationRequestEmail } from "../services/notification.service";
import { inviteUser, resendSetupLink } from "../services/invitation.service";
import { resolveInviteRoleStrict, resolveInviteRoleWithFallback, ensureRoleAssignment }
  from "../services/invite-role.service";
import { ingestTaughtDocument, updateTaughtDocument } from "../services/teach-ingest";
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
      "x-internal-key": getInternalServiceKey(),
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
  // ADOPT-OR-GENERATE.
  //
  // Onboarding now renders the SAME creation wizard as AI Studio (see
  // components/aiEmployee/AgentBuilder). That wizard creates the employee on
  // its `/start` call as a DRAFT carrying `builderStep`. If the owner went
  // through it, the employee already exists and generating another here would
  // leave the tenant with a duplicate - one configured by the owner and one
  // machine-generated. So: adopt the draft when there is one, and only fall
  // back to generation for owners who skipped the wizard entirely.
  const existingDraft = await prisma.aIAgent.findFirst({
    where: { tenantId, status: "DRAFT", builderStep: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (existingDraft) {
    // Finish what the wizard started: clear the resume pointer and activate.
    await prisma.aIAgent.update({
      where: { id: existingDraft.id },
      data: { builderStep: null, status: "ACTIVE" },
    });
  } else {
    await callAIGenerateConfigs(tenantId, authHeader);
  }

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

  // An employee the owner configured in the wizard is authoritative: the
  // recommendation's name/role/persona are DEFAULTS for the generated path,
  // not corrections to a deliberate choice.
  const adoptedFromWizard = !!existingDraft && existingDraft.id === agentId;
  if (adoptedFromWizard) return;

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

    // No wide dash in what the owner reads (the model writes them anyway).
    const parsed = withoutWideDashes(JSON.parse(content));
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

router.get("/status", requirePermission("analytics:workspace:read"), async (req: Request, res: Response): Promise<void> => {
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

router.post("/business-profile", requirePermission("settings:workspace:update"), validate(businessProfileSchema), async (req: Request, res: Response): Promise<void> => {
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

    // A tenant provisioned on a paid plan does not become ACTIVE by finishing
    // setup. Only verified payment does that, in checkout-activation.service,
    // which grants the subscription and the credits in the same transaction.
    //
    // Without this branch, finishing onboarding flipped the tenant to ACTIVE
    // and the access matrix then allowed the whole paid product - so the plan
    // was, in practice, optional. Onboarding still COMPLETES: the customer's
    // work is real and must not be thrown away or repeated after they pay.
    const awaitingPayment = tenant.status === "PENDING_PAYMENT";

    await prisma.$transaction([
      ...(awaitingPayment
        ? []
        : [
            prisma.tenant.update({
              where: { id: req.tenantId! },
              data: { status: "ACTIVE" },
            }),
          ]),
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

    // Only when the workspace is genuinely live. Telling a customer their
    // plan is active while it is still waiting on payment is the kind of
    // email that gets forwarded back to us with a screenshot.
    if (!awaitingPayment) {
      sendActivationConfirmation(req.tenantId!).catch((err) => {
        console.error("Failed to send activation confirmation:", err);
      });
    }

    // Re-arm the nudge one last time: if they activated without a live channel,
    // the sweep sends "your AI employee is waiting to start working"; if they're
    // fully live it computes nothing and is SKIPPED. (No manual cancel needed.)
    scheduleOnboardingNudge(req.tenantId!, "1d").catch(() => {});

    // Provision billing (entity + trial + included AI Units) for the new tenant.
    // Best-effort: never block activation on billing availability.
    provisionBilling(req.tenantId!).catch((err) => {
      console.error(`[Onboarding] Billing provisioning failed for tenant ${req.tenantId}:`, err.message);
    });

    // Knowledge health at the finish line.
    //
    // Onboarding is NOT blocked on this - a customer whose site failed to scan
    // must still be able to finish, and their work must not be thrown away.
    // What is forbidden is finishing SILENTLY: the success screen may not claim
    // the employee is ready while its knowledge base is empty or every document
    // failed to embed. The client renders a warning with a retry from these
    // counts instead of a clean "you're all set".
    const knowledgeHealth = await (async () => {
      try {
        const docs = await prisma.knowledgeDocument.findMany({
          where: { tenantId: req.tenantId! },
          select: { status: true },
        });
        const total = docs.length;
        const ready = docs.filter((d) => d.status === "ready").length;
        const failed = docs.filter((d) => d.status === "error").length;
        const pending = total - ready - failed;
        return {
          total,
          ready,
          failed,
          pending,
          // "Usable" means the employee can actually retrieve something. An
          // empty knowledge base and one where every document errored are the
          // same experience for the customer asking a question.
          usable: ready > 0,
        };
      } catch {
        return null;
      }
    })();

    res.json({
      data: {
        status: awaitingPayment ? "PENDING_PAYMENT" : "ACTIVE",
        // The client routes on this flag, not on prose. Setup is finished
        // either way; what differs is whether the workspace opens or the
        // customer is handed to payment.
        paymentRequired: awaitingPayment,
        message: awaitingPayment
          ? "Setup complete. The workspace opens once payment is confirmed."
          : "Tenant activated. AI configurations generating in background.",
        departmentsActivated: departments.length,
        knowledge: knowledgeHealth,
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
        deepLink: "/settings/business-systems",
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

// GET /journey - THE canonical setup-readiness state. The Getting Started
// page, the sidebar "Complete setup" panel, and the nav badge all derive from
// this one endpoint, so they can never contradict each other.
//
// Five canonical actions, every one DERIVED from persisted product state
// (never a visited-page flag, an opened modal, or a started OAuth):
//   1. connect_source_of_truth  - a USABLE core system (CONNECTED and, for
//      Airtable, field-mapped; see connectedCoreSystem).
//   2. connect_channel          - at least one ChannelAccount CONNECTED + active.
//      A tenant whose only channel turned ERROR/DISCONNECTED is NOT complete.
//   3. connect_knowledge        - at least one ACTIVE knowledge base that has
//      real content (a document or an active synced integration). An empty
//      KB shell does not count.
//   4. create_ai_employee       - an AIAgent in ACTIVE/PAUSED. A mid-wizard
//      DRAFT counts as in_progress, never as done.
//   5. create_process           - at least one persisted ChatbotFlow.
//
// Each item carries `state`: done | in_progress | attention | not_started.
// `attention` = a resource exists but is unhealthy (ERROR/DISCONNECTED) and
// nothing usable remains - the UI shows a fix/reconnect CTA for it.
router.get("/journey", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.tenantId!;
    const [agent, draftAgent, coreSlug, coreRows, channelRows, discovery, usableKbCount, canvas, flowCount, profile] = await Promise.all([
      prisma.aIAgent.findFirst({
        where: { tenantId, status: { in: ["ACTIVE", "PAUSED"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, role: true, status: true },
      }).catch(() => null),
      prisma.aIAgent.findFirst({
        where: { tenantId, status: "DRAFT" },
        select: { id: true },
      }).catch(() => null),
      connectedCoreSystem(tenantId).catch(() => null),
      prisma.tenantIntegration.findMany({
        where: { tenantId, integration: { slug: { in: CORE_SYSTEM_SLUGS as unknown as string[] } } },
        select: { status: true },
      }).catch(() => [] as Array<{ status: string }>),
      prisma.channelAccount.findMany({
        where: { tenantId },
        select: { connectionStatus: true, isActive: true },
      }).catch(() => [] as Array<{ connectionStatus: string; isActive: boolean }>),
      prisma.businessDiscovery.findUnique({
        where: { tenantId },
        select: { communication: true, business: true },
      }).catch(() => null),
      prisma.knowledgeBase.count({
        where: {
          tenantId,
          isActive: true,
          OR: [{ documents: { some: {} } }, { integrations: { some: { isActive: true } } }],
        },
      }).catch(() => 0),
      // The builder saves to FlowCanvas, and FlowCanvas is what the executor
      // runs. Counting chatbotFlow (a different, legacy store) meant a process
      // a customer had built and saved never marked this milestone done. The
      // legacy count is still read so tenants with old ChatbotFlow rows keep
      // their progress.
      prisma.flowCanvas.findUnique({
        where: { tenantId },
        select: { nodes: true, edges: true },
      }).catch(() => null),
      prisma.chatbotFlow.count({ where: { tenantId } }).catch(() => 0),
      prisma.businessProfile.findUnique({
        where: { tenantId },
        select: { organizationName: true, industry: true },
      }).catch(() => null),
    ]);

    // A process exists when the canvas the executor reads holds a trigger
    // that leads somewhere. Legacy ChatbotFlow rows still count, so a tenant
    // who built one under the old store keeps this milestone.
    const hasProcess =
      canvasHasRunnableProcess(canvas?.nodes, canvas?.edges) || flowCount > 0;

    const PRIMARY_CH = new Set(["whatsapp", "instagram", "facebook", "messenger", "telegram"]);
    const detectedChannels = (((discovery?.communication as any)?.channels || []) as Array<{ type?: string; identifier?: string }>)
      .filter((c) => c?.type && PRIMARY_CH.has(String(c.type).toLowerCase()));
    const channelHint = detectedChannels.slice(0, 3)
      .map((c) => `${String(c.type)}${c.identifier ? ` · ${c.identifier}` : ""}`)
      .join("  ·  ");

    // Health classification (see the endpoint doc block above).
    const usableChannel = channelRows.some((c) => c.connectionStatus === "CONNECTED" && c.isActive);
    const pendingChannel = channelRows.some((c) => c.connectionStatus === "PENDING");
    const brokenChannel = channelRows.some((c) => c.connectionStatus === "ERROR" || c.connectionStatus === "DISCONNECTED");
    const corePending = coreRows.some((r) => r.status === "PENDING" || r.status === "TESTING");
    // CONNECTED core row while connectedCoreSystem() says none usable =
    // mid-setup (e.g. Airtable awaiting its field mapping).
    const coreConnectedRaw = coreRows.some((r) => r.status === "CONNECTED");
    const coreBroken = coreRows.some((r) => r.status === "ERROR" || r.status === "DISCONNECTED");

    type State = "done" | "in_progress" | "attention" | "not_started";
    const stateOf = (done: boolean, attention: boolean, inProgress: boolean): State =>
      done ? "done" : attention ? "attention" : inProgress ? "in_progress" : "not_started";

    type Milestone = { id: string; done: boolean; state: State; deepLink: string; manageLink?: string; hint?: string };
    const milestones: Milestone[] = [
      {
        id: "connect_source_of_truth",
        done: !!coreSlug,
        state: stateOf(!!coreSlug, coreBroken, corePending || coreConnectedRaw),
        deepLink: "/settings/business-systems",
        manageLink: "/settings/business-systems",
      },
      {
        id: "connect_channel",
        done: usableChannel,
        state: stateOf(usableChannel, brokenChannel, pendingChannel),
        deepLink: "/settings/channels",
        manageLink: "/settings/channels",
        hint: channelHint || undefined,
      },
      {
        id: "connect_knowledge",
        done: usableKbCount > 0,
        state: stateOf(usableKbCount > 0, false, false),
        deepLink: "/ai-studio?tab=knowledge",
        manageLink: "/ai-studio?tab=knowledge",
      },
      {
        id: "create_ai_employee",
        done: !!agent,
        state: stateOf(!!agent, false, !!draftAgent),
        deepLink: agent ? `/ai-studio/agents/${agent.id}` : "/ai-studio?tab=team",
        manageLink: agent ? `/ai-studio/agents/${agent.id}` : "/ai-studio?tab=team",
      },
      {
        id: "create_process",
        // A canvas holding a lone trigger is not a process: the executor
        // starts there, follows no edge, and answers nothing. Marking that
        // done would promise a customer their automation is live.
        done: hasProcess,
        state: stateOf(hasProcess, false, false),
        deepLink: "/ai-studio?tab=playbooks",
        manageLink: "/ai-studio?tab=playbooks",
      },
    ];

    let activeAssigned = false;
    const out = milestones.map((m) => {
      // Legacy tri-state kept alongside `state` for existing consumers.
      let status: "done" | "active" | "pending";
      if (m.done) { status = "done"; }
      else if (!activeAssigned) { status = "active"; activeAssigned = true; }
      else { status = "pending"; }
      return { id: m.id, done: m.done, state: m.state, status, deepLink: m.deepLink, manageLink: m.manageLink, hint: m.hint };
    });

    const doneCount = milestones.filter((m) => m.done).length;
    const biz = (discovery?.business || {}) as any;
    res.json({
      data: {
        complete: milestones.every((m) => m.done),
        summary: { done: doneCount, total: milestones.length },
        employee: agent,
        business: {
          name: profile?.organizationName || biz.name || null,
          industry: profile?.industry || biz.industry || null,
        },
        context: {
          coreSystem: coreSlug,
          kbCount: usableKbCount,
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

// The list and the "connected + usable" rule live in ONE place,
// services/onboarding-state.service.ts (the onboarding snapshot, the nudge
// engine and system views read the same list).

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
router.get("/setup-map", requirePermission("analytics:workspace:read"), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.tenantId!;
    const [coreSlug, kbCount, aiAgent, canvas, flowCount, userCount, channel, connectedIntegrations, profile] = await Promise.all([
      connectedCoreSystem(tenantId),
      prisma.knowledgeBase.count({ where: { tenantId } }).catch(() => 0),
      prisma.aIAgent.findFirst({ where: { tenantId }, select: { id: true, status: true } }).catch(() => null),
      // Same store the builder writes and the executor runs - see the journey
      // handler above.
      prisma.flowCanvas.findUnique({ where: { tenantId }, select: { nodes: true, edges: true } }).catch(() => null),
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
      { id: "workflows", done: canvasHasRunnableProcess(canvas?.nodes, canvas?.edges) || (flowCount || 0) > 0, deepLink: "/ai-studio", stage: "core" as const },
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
  try {
    // SSRF-hardened: the origin is user-supplied. safeFetch enforces the
    // scheme allowlist, blocks private/link-local/metadata addresses at DNS
    // resolution, and revalidates every redirect hop.
    const r = await safeFetch(origin, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GotchaOnboarding/1.0; +https://gotcha.co.il)",
        Accept: "text/html,application/xhtml+xml",
      },
      timeoutMs,
    });
    if (!r.ok) return null;
    const ct = r.contentType || "";
    if (!ct.includes("text/html") && !ct.includes("xhtml")) return null;
    const html = r.text;
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
        const p = withoutWideDashes(JSON.parse(content));
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

// The site crawl and its deterministic signal extraction now live in
// services/site-crawl.service.ts - see `crawlSite`. Onboarding calls that
// service rather than holding its own copy, so the rescan route and this
// flow cannot drift into crawling differently while sharing a name.
async function callAIDiscoverBusiness(
  authHeader: string,
  body: { domain: string; locale: string; pages: Array<{ url: string; text: string }>; signals: DiscoverySignals; businessType?: string },
): Promise<any | null> {
  // ONE bridge, shared with the rescan path - see business-scan.service.
  // A second copy is a second place for the timeout and the failure handling
  // to drift, and the two would then disagree about what a failed scan is.
  return callDiscoverBusiness(authHeader, body, fetchWithTimeout as any);
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
  /**
   * The admin ticked the Terms and Privacy Policy box on the first setup
   * screen. Optional so an older client still works, and never trusted as a
   * gate: the checkbox is the consent, this is the record of it.
   */
  legalAccepted: z.boolean().optional(),
});

router.post("/discover", requireRole("ADMIN"), validate(discoverSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { domain, locale, legalAccepted } = req.body as { domain: string; locale: string; legalAccepted?: boolean };
    const origin = normalizeDomain(domain);
    if (!origin) {
      res.json({ data: { ok: false, reason: "invalid_domain" } });
      return;
    }

    // A tickbox nobody recorded is not evidence of anything. This is the first
    // write of the whole setup, so it is where acceptance gets a timestamp, an
    // actor and the document list. Fire-and-forget: failing to log the consent
    // must not block the person who just gave it.
    if (legalAccepted) {
      prisma.auditLog.create({
        data: {
          tenantId: req.tenantId!,
          actorType: "user",
          actorId: (req as any).userId || null,
          action: "legal.terms.accepted",
          targetType: "tenant",
          targetId: req.tenantId!,
          metadata: { surface: "onboarding_setup", documents: ["terms-of-service", "privacy-policy"], locale },
        },
      }).catch((err: any) => console.warn("[onboarding] consent audit failed:", err?.message));
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
      // A fresh scan restarts the journey - clear the resume checkpoint so the
      // monotonic guard on PATCH /discovery starts from zero for the new run.
      update: { status: "SCANNING", websiteDomain: origin, scanPhase: "homepage", progress: null },
      create: { tenantId: req.tenantId!, status: "SCANNING", websiteDomain: origin, scanPhase: "homepage" },
    });

    // ONE crawler. This flow and the rescan route both go through crawlSite,
    // so neither can start crawling differently while sharing the name. The
    // phase callback is what keeps the ceremony's checkmarks tied to real
    // events rather than a timer - the frontend polls GET /discovery during
    // the scan.
    const crawl = await crawlSite(origin, {
      onPhase: async (phase) => {
        if (phase === "pages") {
          await prisma.businessDiscovery.update({ where: { tenantId: req.tenantId! }, data: { scanPhase: "pages" } }).catch(() => {});
        }
      },
    });
    if (!crawl) {
      await prisma.businessDiscovery.update({
        where: { tenantId: req.tenantId! },
        data: { status: "FAILED" },
      }).catch(() => {});
      res.json({ data: { ok: false, reason: "fetch_failed", domain: origin } });
      return;
    }
    const { home, okPages, pages, signals } = crawl;

    // What the crawl could SEE, recorded alongside what the model concluded.
    // The review screen reads this row, and without it the screen can only quote
    // pages.length - which on a password-protected store is 17 for a site nobody
    // could read. See persistCrawlReach and the schema comment on `crawl`.
    await persistCrawlReach(req.tenantId!, {
      requested: crawl.requested.length,
      pagesRead: crawl.pages.length,
      distinctTextPages: crawl.distinctTextPages,
      coverage: crawl.pages.map((p) => p.url),
    });

    const businessType = crawl.businessType;

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
        // Normalized so the checkpoint writes the FULL shape. This used to
        // persist only `platform` and `tools`, and because it is also the
        // fallback that survives a failed synthesis, that half-object was
        // what the review screen read - and crashed on.
        technology: normalizeDiscoveryTechnology({
          platform: signals.platform,
          tools: signals.tools.map((s) => ({ slug: s, name: s })),
        }),
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
        technology: report.technology ? normalizeDiscoveryTechnology(report.technology) : undefined,
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
        technology: report.technology ? normalizeDiscoveryTechnology(report.technology) : undefined,
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

    // Project the scan into real Knowledge Base entries. Until this existed,
    // everything above was written to Json columns that only the "Your
    // Business" page could read - the AI employee retrieves from
    // KnowledgeDocument chunks and had no access to any of it. A customer who
    // had just watched us describe their business in detail would then be told
    // "I don't have that information".
    //
    // Awaited, not fire-and-forget: the response carries the honest ingestion
    // result so the UI can show what landed and what failed instead of a
    // success screen over a broken ingest. Failures never fail the scan - the
    // discovery record is already saved.
    let knowledgeSync: SyncReport | null = null;
    try {
      const profile = await prisma.businessProfile.findUnique({
        where: { tenantId: req.tenantId! },
        select: {
          organizationName: true, industry: true, businessDescription: true,
          country: true, primaryLanguage: true,
        },
      }).catch(() => null);

      const ctx = { language: locale || profile?.primaryLanguage || "en", now: new Date().toISOString() };
      const projected = [
        ...projectDiscoveryTopics(saved as any, profile ?? {}, ctx),
        // `okPages`, not `pages`: the latter is truncated to 2800 chars per
        // page purely to keep the LLM request under its body-parser limit.
        // Ingesting that truncation would put a knowingly half-read shipping
        // policy in front of customers. The knowledge base gets the full text.
        ...projectPages(
          [
            { url: origin, content: home.text },
            ...okPages.map((p) => ({ url: p.url, content: p.text })),
          ],
          ctx,
        ),
      ];

      knowledgeSync = await applyProjection(
        { prisma, fetchFn: fetchWithTimeout as any, authHeader: req.headers.authorization! },
        req.tenantId!,
        projected,
        // Only crawled pages may be retired by a re-scan. A topic summary the
        // synthesis step failed to produce this time must not delete the good
        // summary from the previous scan.
        { removeMissing: true, removeScope: ["url"] },
      );

      void writeAudit({
        tenantId: req.tenantId!,
        actorType: "user",
        actorId: (req as any).user?.userId,
        action: AuditAction.KNOWLEDGE_SCAN_SYNCED,
        targetType: "knowledge_base",
        targetId: knowledgeSync.knowledgeBaseId ?? "-",
        metadata: {
          domain: origin,
          added: knowledgeSync.added,
          updated: knowledgeSync.updated,
          unchanged: knowledgeSync.unchanged,
          preserved: knowledgeSync.preserved,
          removed: knowledgeSync.removed,
          failed: knowledgeSync.failed,
        },
      });
    } catch (err) {
      console.error("[Onboarding] Knowledge projection failed:", err);
      knowledgeSync = null;
    }

    // Re-arm the onboarding nudge: if they go quiet after discovery, the sweep
    // will send "I noticed you stopped after Business Discovery" ~a day later.
    scheduleOnboardingNudge(req.tenantId!, "1d").catch(() => {});

    res.json({
      data: {
        ok: true,
        domain: origin,
        discovery: normalizeDiscoveryRecord(saved as Record<string, unknown>),
        // The honest ingestion outcome. `null` means the projection itself
        // threw - the UI must say knowledge sync failed and offer a retry,
        // not imply the knowledge base is populated.
        knowledge: knowledgeSync,
      },
    });
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
    // Normalized on the way out, so a reader never receives a half-written
    // technology object. The row can legitimately be partial: the mid-scan
    // checkpoint writes what it knows, and a failed synthesis leaves it
    // that way on purpose. The API contract should not inherit that.
    res.json({ data: { discovery: normalizeDiscoveryRecord(discovery as Record<string, unknown> | null) } });
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
    // MONOTONIC checkpoint guard (authoritative): the resume checkpoint may
    // only ADVANCE along MOVEMENT_KEYS. The wizard routes users back through
    // earlier movements to edit (e.g. Movement-5 "Connect" re-enters `connect`),
    // and a regressed checkpoint would reopen a completed step as the current
    // one on the next reload/OAuth return. A rescan resets it (see /discover).
    if (patch.progress) {
      const cur = MOVEMENT_KEYS.indexOf(((existing.progress as string) || "") as typeof MOVEMENT_KEYS[number]);
      const next = MOVEMENT_KEYS.indexOf(patch.progress as typeof MOVEMENT_KEYS[number]);
      if (next > cur) data.progress = patch.progress;
    }
    if (patch.employeeName?.trim()) {
      data.recommendation = { ...((existing.recommendation as Record<string, unknown>) || {}), employeeName: patch.employeeName.trim() };
    }
    const saved = await prisma.businessDiscovery.update({
      where: { tenantId: req.tenantId! },
      data,
    });
    res.json({ data: { discovery: normalizeDiscoveryRecord(saved as Record<string, unknown>) } });
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
      // Normalize FIRST so a correction never writes back the partial shape
      // it was handed. Removing one tool should not be the thing that
      // decides whether `legacy` exists.
      const tech = normalizeDiscoveryTechnology(existing.technology);
      data.technology = {
        ...tech,
        tools: tech.tools.filter((t) => t.slug !== key),
        legacy: tech.legacy.filter((t) => t.slug !== key),
        tracking: tech.tracking.filter((t) => t.slug !== key),
      };
    } else if (target === "platform") {
      data.technology = { ...normalizeDiscoveryTechnology(existing.technology), platform: null };
    } else if (target === "gap") {
      const slug = slugifyGap(key);
      data.gaps = (Array.isArray(existing.gaps) ? existing.gaps : []).filter((g: any) => slugifyGap(String(g?.label || "")) !== slug);
      await prisma.recommendation.updateMany({
        where: { tenantId: req.tenantId!, dedupeKey: { in: [`gap:${slug}`, `teach:${slug}`] }, status: "OPEN" },
        data: { status: "DISMISSED", dismissedAt: new Date() },
      }).catch(() => {});
    }

    const saved = await prisma.businessDiscovery.update({ where: { tenantId: req.tenantId! }, data });
    res.json({ data: { ok: true, discovery: normalizeDiscoveryRecord(saved as Record<string, unknown>) } });
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
  // "file": the document was ALREADY ingested via the knowledge-base upload
  // endpoint (multipart, parsing, processing) - `value` is the created
  // KnowledgeDocument id; this route only closes the gap/recommendation.
  method: z.enum(["text", "url", "file"]),
  value: z.string().min(1).max(20000),
});

function slugifyGap(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "item";
}

/** Shared teach epilogue: complete matching recs + strip the gap from the report. */
async function completeTaughtGap(tenantId: string, label: string): Promise<void> {
  const slug = slugifyGap(label);
  await prisma.recommendation.updateMany({
    where: { tenantId, dedupeKey: { in: [`gap:${slug}`, `teach:${slug}`] }, status: "OPEN" },
    data: { status: "COMPLETED", completedAt: new Date() },
  }).catch(() => {});
  const disc = await prisma.businessDiscovery.findUnique({ where: { tenantId }, select: { gaps: true } }).catch(() => null);
  if (disc && Array.isArray(disc.gaps)) {
    const remaining = disc.gaps.filter((g: any) => slugifyGap(String(g?.label || "")) !== slug);
    await prisma.businessDiscovery.update({ where: { tenantId }, data: { gaps: remaining } }).catch(() => {});
  }
}

router.post("/teach", requireRole("ADMIN"), validate(teachSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { label, method, value } = req.body as { label: string; method: "text" | "url" | "file"; value: string };

    if (method === "file") {
      // The upload already created + processed the document; verify it really
      // belongs to this tenant, then close the gap below.
      const uploaded = await prisma.knowledgeDocument.findFirst({
        where: { id: value.trim(), tenantId: req.tenantId! },
        select: { id: true },
      });
      if (!uploaded) {
        res.json({ data: { ok: false, reason: "document_not_found" } });
        return;
      }
      await completeTaughtGap(req.tenantId!, label);
      scheduleOnboardingNudge(req.tenantId!, "1d").catch(() => {});
      res.json({ data: { ok: true, documentId: uploaded.id } });
      return;
    }

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

    // Answering the same gap twice used to create a second document, so a
    // customer who corrected their own answer left both the old and the new
    // one in retrieval and the employee could quote either. Route the answer
    // through the same projection the scan uses: it carries a dedupe key, so
    // re-answering REPLACES rather than accumulates.
    const taught = projectReadinessAnswers(
      [{ question: label, answer: content }],
      { language: (req.body?.locale as string) || "en", now: new Date().toISOString() },
    )[0];

    // Matched in JS rather than SQL: the dedupe key lives inside a Json column
    // and Prisma's JSON filters are not portable across the versions this repo
    // supports. A tenant's own knowledge base is small enough for this to be
    // cheap, and the query stays tenant-scoped.
    const existingTaught = taught
      ? await prisma.knowledgeDocument
          .findMany({
            where: { tenantId: req.tenantId!, knowledgeBaseId: kb.id },
            select: { id: true, metadata: true },
          })
          .then((all) =>
            all.find((d) => {
              const m = d.metadata as Record<string, unknown> | null;
              return !!m && typeof m === "object" && m.dedupeKey === taught.metadata.dedupeKey;
            }) ?? null,
          )
          .catch(() => null)
      : null;

    // Preserve the source provenance the caller actually used (a URL answer
    // keeps its URL) while keeping the readiness dedupe key.
    const metadata = taught
      ? { ...taught.metadata, sourceType: sourceType === "url" ? "url" : taught.metadata.sourceType, sourceUrl }
      : undefined;

    // Create the document THROUGH services/ai so it is actually embedded
    // (chunked into Qdrant). A bare prisma.create here left it `pending` with no
    // vectors - never retrievable - so "Learned" was a false success.
    const documentId = existingTaught
      ? await updateTaughtDocument(kb.id, existingTaught.id, req.headers.authorization!, { title: label, content, metadata }, fetchWithTimeout)
      : await ingestTaughtDocument(
          kb.id,
          req.headers.authorization!,
          { title: label, content, sourceType, sourceUrl, metadata },
          fetchWithTimeout,
        );

    if (!documentId) {
      // Ingestion failed: do NOT complete the gap. Reporting "Learned" for
      // knowledge that never got embedded would be a false success.
      res.json({ data: { ok: false, reason: "ingest_failed" } });
      return;
    }

    // Complete the matching recommendation(s) and clear the gap on the report.
    await completeTaughtGap(req.tenantId!, label);

    scheduleOnboardingNudge(req.tenantId!, "1d").catch(() => {});
    res.json({ data: { ok: true, knowledgeDocumentId: documentId, label } });
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

// POST /recommendations/:id/complete | /dismiss | /reopen.
// A resolved rec is never resurrected by a future re-scan; `reopen` is the
// explicit human undo (with confirmation in the UI) and restores OPEN.
// Every transition writes an audit event with the acting user.
router.post("/recommendations/:id/:decision", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const decision =
      req.params.decision === "dismiss" ? "DISMISSED"
      : req.params.decision === "complete" ? "COMPLETED"
      : req.params.decision === "reopen" ? "OPEN"
      : null;
    if (!decision) { res.status(400).json({ error: "decision must be complete, dismiss or reopen" }); return; }
    const result = await setRecommendationStatus(req.tenantId!, req.params.id as string, decision);
    if (!result.ok) { res.status(404).json({ error: "Recommendation not found" }); return; }
    void writeAudit({
      tenantId: req.tenantId!,
      actorType: "user",
      actorId: (req as any).user?.userId,
      action:
        decision === "COMPLETED" ? AuditAction.RECOMMENDATION_COMPLETED
        : decision === "DISMISSED" ? AuditAction.RECOMMENDATION_DISMISSED
        : AuditAction.RECOMMENDATION_REOPENED,
      targetType: "recommendation",
      targetId: String(req.params.id),
      metadata: { previous: result.previous, next: decision },
    });
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
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(2000) })).max(20).optional(),
  locale: z.string().min(2).max(10).optional(),
  // personaOnly: persist the tuned persona WITHOUT an LLM turn. Used when the
  // owner adds a standing rule via a quick-tune chip - the rule must land in
  // tunedPersona (deploy reads it) but should NOT become a chat message.
  personaOnly: z.boolean().optional(),
}).refine((b) => b.personaOnly === true || (Array.isArray(b.messages) && b.messages.length >= 1), {
  message: "messages required unless personaOnly",
});

router.post("/employee-chat", requireRole("ADMIN"), validate(employeeChatSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { persona, messages = [], locale, personaOnly } = req.body as { persona?: any; messages?: Array<{ role: string; content: string }>; locale?: string; personaOnly?: boolean };
    const disc = await prisma.businessDiscovery.findUnique({ where: { tenantId: req.tenantId! } });
    const rec = (disc?.recommendation || {}) as any;

    // Rule-only save: no LLM round-trip, no transcript append.
    if (personaOnly) {
      if (disc && persona) {
        await prisma.businessDiscovery.update({
          where: { tenantId: req.tenantId! },
          data: { recommendation: { ...rec, tunedPersona: persona } },
        }).catch(() => {});
      }
      res.json({ data: { ok: true, persona } });
      return;
    }
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
  // A TenantRole id, or the keywords "ADMIN"/"AGENT".
  //
  // It was `z.enum(["ADMIN","AGENT"])`, which meant a tenant could create a
  // custom role through /api/permissions/roles and then had no way to invite
  // anybody into it. The keywords still work, so every existing caller is
  // unaffected; anything else is resolved against THIS tenant's roles and
  // refused if it names nothing - see invite-role.service.ts.
  role: z.string().min(1).max(64).optional().default("AGENT"),
});

/**
 * Record that somebody joined on a different role from the one they were
 * offered, because the offered one had been deleted meanwhile.
 *
 * Its own audit ACTION rather than metadata on role.assigned: the audit-log
 * API does not return `metadata`, so a fallback recorded only there would be
 * invisible in the one place an admin looks. Someone silently joining with
 * fewer permissions than they were promised is the kind of wrong that nobody
 * goes looking for, so it has to be legible from the action alone.
 *
 * Never throws - an audit failure must not fail an acceptance.
 */
async function recordRoleFallback(
  invite: { tenantId: string; role: string; id: string },
  userId: string,
  resolved: { fellBack: boolean; roleName: string | null; tenantRoleId: string | null },
): Promise<void> {
  if (!resolved.fellBack) return;
  try {
    await writeAudit({
      tenantId: invite.tenantId,
      actorType: "system",
      action: AuditAction.ROLE_ASSIGNED_FALLBACK,
      targetType: "user",
      targetId: userId,
      metadata: {
        requestedRole: invite.role,
        requestedRoleExists: false,
        grantedRole: resolved.roleName,
        grantedRoleId: resolved.tenantRoleId,
        inviteId: invite.id,
      },
    });
  } catch (err: unknown) {
    console.error("[invite] role fallback audit failed:", (err as { message?: string })?.message ?? err);
  }
}

const INVITE_LINK_EXPIRY_DAYS = 14;

router.post("/invite-team", requireRole("ADMIN"), validate(inviteTeamSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { emails, role } = req.body as { emails: string[]; role: string };
    const tenantId = req.tenantId!;

    // Resolved ONCE, before any invitation is sent. An unknown or
    // other-tenant role id is refused outright here rather than downgraded -
    // an admin who mistypes a role should be told, not discover later that
    // twenty-five people joined as agents.
    const resolved = await resolveInviteRoleStrict(tenantId, role);
    if (!resolved) {
      res.status(400).json({ error: "unknown_role", role });
      return;
    }
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

        // Provision identity + local account together. No placeholder password
        // exists to leak: the invitee sets their own credential inside
        // Authentik via the setup link below.
        const invited = await inviteUser(
          tenantId,
          email,
          email.split("@")[0] || "Teammate",
          resolved.coarse,
        );
        const user = { id: invited.user.id };

        // BOTH systems, not either. `inviteUser` writes the coarse enum that
        // `requireRole` reads; this writes the assignment that the permission
        // system reads. Until now only the first happened, so every invited
        // user had no entry in the real role system at all.
        await ensureRoleAssignment(user.id, resolved.tenantRoleId, req.user!.userId);

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
          // An identity that already signed in elsewhere has no password to
          // set - the invite just points them at the app to pick the tenant.
          setupUrl: invited.setupLink
            ?? resolveAppPublicUrl(process.env) + "/",
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
    // Same resolution as invite-team. This route collapsed anything that was
    // not the literal string "ADMIN" to "AGENT", so a custom role id pasted
    // here produced a link that silently granted agent.
    const requestedRole = String(req.body?.role ?? "AGENT");
    const resolved = await resolveInviteRoleStrict(tenantId, requestedRole);
    if (!resolved) {
      res.status(400).json({ error: "unknown_role", role: requestedRole });
      return;
    }
    const role = requestedRole;

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

    const frontendUrl = resolveAppPublicUrl(process.env);
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

// Accepting an invite no longer takes a password: GOTCHA has nowhere to put
// one. It links the person to the tenant and answers with the Authentik setup
// link where they choose their own credential.
const acceptInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
});

publicRouter.post("/invite/accept", validate(acceptInviteSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, name, email } = req.body as {
      token: string; name: string; email?: string;
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

    let user: { id: string; tenantId: string };
    // Null when the invitee's identity already has a password (existing user
    // of another tenant) - the client just sends them to sign in.
    let setupLink: string | null;

    if (invite.userId) {
      // Targeted invite - the row already exists from invite-team, and its
      // identity was provisioned then. Confirm the name and re-issue a setup
      // link (the emailed one may have expired or been lost).
      const updated = await prisma.user.update({
        where: { id: invite.userId },
        data: { name, isActive: true },
        select: { id: true, tenantId: true },
      });
      user = updated;
      setupLink = await resendSetupLink(updated.id);

      // THE BRANCH THAT USED TO IGNORE THE ROLE ENTIRELY. invite-team creates
      // the user at INVITE time, so this path only confirmed a name - which
      // meant a fix applied to the open-link branch below would have left
      // invite-team exactly as broken as it was.
      //
      // Re-resolved rather than trusted: if the role was deleted in between,
      // the assignment made at invite time has already cascaded away, and this
      // is the last moment anyone can notice.
      const resolved = await resolveInviteRoleWithFallback(invite.tenantId, invite.role);
      if (resolved.fellBack) {
        await prisma.user.update({ where: { id: updated.id }, data: { role: resolved.coarse as any } });
      }
      await ensureRoleAssignment(updated.id, resolved.tenantRoleId, invite.invitedBy);
      await recordRoleFallback(invite, updated.id, resolved);
    } else {
      // Open-link invite - provision identity + account now.
      const existing = await prisma.user.findUnique({
        where: { tenantId_email: { tenantId: invite.tenantId, email: finalEmail } },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({ error: "email_already_in_tenant" });
        return;
      }
      // Fallback rather than strict: a role can be deleted while an invitation
      // is outstanding, and acceptance is the last step of someone joining a
      // company. The invitee is the one person who cannot fix it.
      const resolved = await resolveInviteRoleWithFallback(invite.tenantId, invite.role);
      const invited = await inviteUser(
        invite.tenantId,
        finalEmail,
        name,
        resolved.coarse,
      );
      user = { id: invited.user.id, tenantId: invited.user.tenantId };
      setupLink = invited.setupLink;
      await ensureRoleAssignment(user.id, resolved.tenantRoleId, invite.invitedBy);
      await recordRoleFallback(invite, user.id, resolved);
    }

    await prisma.tenantInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date(), userId: user.id },
    });

    res.json({ data: { ok: true, tenantId: user.tenantId, setupLink } });
  } catch (err) {
    console.error("Accept invite error:", err);
    res.status(500).json({ error: "Failed to accept invite" });
  }
});

export { publicRouter as publicInviteRouter };
export default router;
