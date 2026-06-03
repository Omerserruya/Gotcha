import { Router, Request, Response } from "express";
import { z } from "zod";
import * as crypto from "crypto";
import * as bcrypt from "bcryptjs";
import { prisma, authenticate, resolveTenant, requireRole, validate, trackAIUsage } from "@chatcenter/shared";
import { sendActivationConfirmation, createMagicLink, sendOnboardingInvite, sendTeammateInvite } from "../services/notification.service";
import OpenAI from "openai";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";

async function callAIGenerateConfigs(tenantId: string, authHeader: string): Promise<void> {
  const res = await fetch(`${AI_SERVICE_URL}/api/ai-assist/generate-configs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": authHeader },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AI service generate-configs failed (${res.status}): ${body}`);
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

IMPORTANT RULES — follow these exactly:
1. You MUST respond ONLY with a valid JSON object. No text outside the JSON.
2. Format: {"reply": "your message here", "readyToGenerate": false}
3. You MUST write your reply in **${lang}**. All text in the "reply" field must be in ${lang}.
4. On the VERY FIRST message, introduce yourself briefly, mention the business name and their departments from the context below, then ask your first question about communication tone.
5. Ask ONE question at a time. Keep it short (2-4 sentences max).
6. You need to understand these 4 things:
   a) Communication tone — formal vs casual vs friendly
   b) Agent workflow — when should conversations be transferred to a specialist or supervisor
   c) Common customer topics — what do customers usually ask about
   d) Restrictions — topics agents should never handle without supervisor approval
7. After collecting answers on at least 3 of these areas, set "readyToGenerate": true and tell the user you're generating their configs.
8. If the user says "skip", "just do it", "go ahead", "I don't care", or anything impatient — immediately set "readyToGenerate": true.
9. Do NOT use emojis. Do NOT give generic greetings. Do NOT ask "how can I help you". You already know what to do — configure their AI.
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
      reply: `Hi! I'll help set up your AI copilot for **${ctx.organizationName}**.\n\nYou're in **${ctx.industry}** with ${ctx.departments.length} department(s): ${deptNames}.\n\nQuick question — **what communication style do your customers expect?** Formal, casual, or somewhere in between?`,
      readyToGenerate: false,
    };
  }
  if (exchanges === 1) {
    return {
      reply: `Got it!\n\n**When should conversations be transferred to a specialist or supervisor?** For example — after a certain time, for specific topics, or when the customer requests it?`,
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
      reply: `Thanks! Last one — **are there any topics that should always require supervisor approval?** (e.g. refunds, legal, complaints)\n\nIf nothing specific, just say "none".`,
      readyToGenerate: false,
    };
  }

  // 4+ exchanges — ready to generate
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
      reply: `שלום! אעזור לכם להגדיר את עוזר ה-AI עבור **${ctx.organizationName}**.\n\nאתם בתחום **${ctx.industry}** עם ${ctx.departments.length} מחלקות: ${deptNames}.\n\nשאלה ראשונה — **איזה סגנון תקשורת הלקוחות שלכם מצפים?** רשמי, ידידותי, או משהו באמצע?`,
      readyToGenerate: false,
    };
  }
  if (exchanges === 1) {
    return {
      reply: `הבנתי!\n\n**מתי צריך להעביר שיחות למומחה או למנהל?** למשל — אחרי זמן מסוים, לנושאים ספציפיים, או כשהלקוח מבקש?`,
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
      reply: `תודה! שאלה אחרונה — **האם יש נושאים שתמיד דורשים אישור מנהל?** (למשל: החזרים, משפטי, תלונות)\n\nאם אין משהו ספציפי, פשוט אמרו "אין".`,
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
      select: { id: true, name: true, slug: true, status: true },
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

    res.json({
      data: {
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
        onboarding: onboarding || { currentStep: "BUSINESS_PROFILE", completedAt: null },
        businessProfileCompleted: !!businessProfile,
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
// Minimal schema — only the two fields actually surfaced in Screen 1.
// Legacy fields (industry, businessPriority, daily conversations, agents)
// are kept on the model but defaulted server-side so a future settings
// page can still surface them without forcing them through onboarding.

const businessProfileSchema = z.object({
  organizationName: z.string().min(1).max(200),
  businessDescription: z.string().min(1).max(2000),
  locale: z.string().min(2).max(10).optional(),
  // Onboarding v2 — multi-select goals and the original domain the user
  // typed (so we can re-analyze later from settings without making them
  // retype it). Both optional so the legacy single-screen flow still
  // works against this endpoint.
  businessGoals: z.array(z.string().min(1).max(64)).max(6).optional(),
  websiteDomain: z.string().max(255).optional(),
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

    const { organizationName, businessDescription, locale, businessGoals, websiteDomain } = req.body as {
      organizationName: string;
      businessDescription: string;
      locale?: string;
      businessGoals?: string[];
      websiteDomain?: string;
    };

    const existing = await prisma.businessProfile.findUnique({
      where: { tenantId: req.tenantId! },
      select: { industry: true, businessPriority: true, estimatedDailyConversations: true, numberOfAgents: true },
    });

    const profile = await prisma.businessProfile.upsert({
      where: { tenantId: req.tenantId! },
      update: {
        organizationName,
        businessDescription,
        ...(businessGoals !== undefined ? { businessGoals } : {}),
        ...(websiteDomain !== undefined ? { websiteDomain } : {}),
      },
      create: {
        tenantId: req.tenantId!,
        organizationName,
        businessDescription,
        industry: existing?.industry ?? "Other",
        businessPriority: existing?.businessPriority ?? "FAST_RESPONSE",
        estimatedDailyConversations: existing?.estimatedDailyConversations ?? 100,
        numberOfAgents: existing?.numberOfAgents ?? 5,
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
//   4. Fire-and-forget the AI config generation — the user enters the app
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

    // Auto-create a single "General" department if the tenant has none.
    // Keeps the AI generator happy without forcing the user through a
    // wizard step they don't need on day one.
    let departments = await prisma.department.findMany({
      where: { tenantId: req.tenantId!, isActive: true },
      select: { id: true, name: true },
    });
    if (departments.length === 0) {
      const dept = await prisma.department.create({
        data: {
          tenantId: req.tenantId!,
          name: "General",
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

    const authHeader = req.headers.authorization;
    if (authHeader) {
      callAIGenerateConfigs(req.tenantId!, authHeader).catch((err) => {
        console.error(`[Onboarding] Async generate-configs failed for tenant ${req.tenantId}:`, err.message);
      });
    }

    sendActivationConfirmation(req.tenantId!).catch((err) => {
      console.error("Failed to send activation confirmation:", err);
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
// Five hardcoded missions, status derived from existing tables.
// `done` if completed, `active` for the first incomplete one, `pending` for the rest.
// `deepLink` is consumed by the sidebar MissionPanel so route changes stay server-side.

type MissionId =
  | "confirm_business"
  | "connect_channel"
  | "send_test_reply"
  | "review_agent_tone"
  | "invite_teammate";

interface MissionResult {
  id: MissionId;
  done: boolean;
  deepLink: string;
}

router.get("/missions", requireRole("ADMIN"), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.tenantId!;

    const [profile, connectedChannel, outboundMessage, agentForTone, userCount] = await Promise.all([
      prisma.businessProfile.findUnique({ where: { tenantId }, select: { id: true } }),
      prisma.channelAccount.findFirst({
        where: { tenantId, connectionStatus: "CONNECTED" },
        select: { id: true },
      }),
      prisma.message.findFirst({
        where: { tenantId, direction: "OUTBOUND" },
        select: { id: true },
      }),
      prisma.aIAgent.findFirst({
        where: { tenantId },
        select: { id: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.user.count({ where: { tenantId, isActive: true } }),
    ]);

    const agentTouched =
      agentForTone &&
      agentForTone.updatedAt.getTime() - agentForTone.createdAt.getTime() > 60_000;

    const missions: MissionResult[] = [
      {
        id: "confirm_business",
        done: !!profile,
        deepLink: "/setup",
      },
      {
        id: "connect_channel",
        done: !!connectedChannel,
        deepLink: "/channels",
      },
      {
        id: "send_test_reply",
        done: !!outboundMessage,
        deepLink: "/conversations",
      },
      {
        id: "review_agent_tone",
        done: !!agentTouched,
        deepLink: agentForTone ? `/ai-studio/agents/${agentForTone.id}` : "/ai-studio",
      },
      {
        id: "invite_teammate",
        done: userCount > 1,
        deepLink: "/settings",
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
      return { id: m.id, status, deepLink: m.deepLink };
    });

    res.json({ data: { missions: out } });
  } catch (err) {
    console.error("Get missions error:", err);
    res.status(500).json({ error: "Failed to get missions" });
  }
});

// ─── Domain Analysis (Onboarding v2 — AI-suggested description) ──
//
// Fetches the user's homepage and asks the LLM to produce a one-sentence
// "what this business does" suggestion the user can confirm or edit.
// Falls through to a structured failure response if either step fails —
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
    // Cheap extraction — strip scripts/styles/tags, collapse whitespace,
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
    let suggestion: string | null = null;
    try {
      const response = await client.chat.completions.create({
        model,
        temperature: 0.3,
        max_tokens: 160,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You analyze a business homepage and produce a one-sentence summary of WHAT THE BUSINESS DOES, written in ${lang}. Respond ONLY with JSON: {"description": "..."}. The description must be 1-2 sentences, plain text, no emojis, no marketing fluff, no mention of the homepage or the analysis. If you cannot tell what the business does, set description to an empty string.`,
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
      }

      const content = response.choices[0]?.message?.content;
      if (content) {
        const parsed = JSON.parse(content);
        const desc = typeof parsed.description === "string" ? parsed.description.trim() : "";
        if (desc.length >= 10) suggestion = desc;
      }
    } catch (err: any) {
      console.warn("[Onboarding] Domain analysis LLM failed:", err?.message);
    }

    if (!suggestion) {
      res.json({ data: { ok: false, reason: "no_summary", domain: origin } });
      return;
    }

    res.json({ data: { ok: true, domain: origin, description: suggestion } });
  } catch (err) {
    console.error("Analyze domain error:", err);
    res.status(500).json({ error: "Failed to analyze domain" });
  }
});

// ─── Invite Teammates (Onboarding v2) ────────────────────────
//
// Two flavors:
//   1. POST /invite-team   — array of emails, each gets a magic-link email
//   2. POST /invite-link   — one shareable URL the admin can paste anywhere
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

        // Create a placeholder user with a random password — they will
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

// Public route — used by the /join page to render tenant context before
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
      // Targeted invite — user row exists from invite-team. Just set
      // their real password + name and mark the invite accepted.
      user = await prisma.user.update({
        where: { id: invite.userId },
        data: { name, password: hashed, isActive: true },
        select: { id: true, email: true, name: true, role: true, tenantId: true },
      });
    } else {
      // Open-link invite — create the user now. Reject if the email is
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

    // Don't sign a session here — the /join page redirects to /login
    // with the email pre-filled. Keeps this route stateless and simple.
    res.json({ data: { ok: true, tenantId: user.tenantId } });
  } catch (err) {
    console.error("Accept invite error:", err);
    res.status(500).json({ error: "Failed to accept invite" });
  }
});

export { publicRouter as publicInviteRouter };
export default router;
