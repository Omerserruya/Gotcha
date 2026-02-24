import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma, authenticate, resolveTenant, requireRole, validate } from "@chatcenter/shared";
import { sendActivationConfirmation } from "../services/notification.service";
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
   b) Escalation — when should AI hand off to a human agent
   c) Common customer topics — what do customers usually ask about
   d) Restrictions — topics AI should never handle alone
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
    const response = await client.chat.completions.create({
      model: process.env.ONBOARDING_CHAT_MODEL || "gpt-4o-mini",
      temperature: 0.7,
      max_tokens: 512,
      response_format: { type: "json_object" },
      messages,
    });

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
      reply: `Got it!\n\n**How should the AI handle situations it's unsure about?** Should it escalate to a human quickly, or try to resolve more on its own first?`,
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
      reply: `Thanks! Last one — **are there any topics the AI should NOT handle on its own?** (e.g. refunds, legal, complaints)\n\nIf nothing specific, just say "none".`,
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
      reply: `הבנתי!\n\n**איך ה-AI צריך להתמודד עם מצבים שהוא לא בטוח לגביהם?** להעביר לנציג אנושי מהר, או לנסות לפתור בעצמו קודם?`,
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
      reply: `תודה! שאלה אחרונה — **האם יש נושאים שה-AI לא צריך לטפל בהם לבד?** (למשל: החזרים, משפטי, תלונות)\n\nאם אין משהו ספציפי, פשוט אמרו "אין".`,
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
      include: {
        copilotConfig: { select: { id: true } },
      },
    });

    res.json({
      data: {
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
        onboarding: onboarding || { currentStep: "BUSINESS_PROFILE", completedAt: null },
        businessProfileCompleted: !!businessProfile,
        departmentsConfigured: departments.length,
        departmentsWithCopilotConfig: departments.filter((d) => d.copilotConfig).length,
      },
    });
  } catch (err) {
    console.error("Get onboarding status error:", err);
    res.status(500).json({ error: "Failed to get onboarding status" });
  }
});

// ─── Step A: Save Business Profile ──────────────────────────

const businessProfileSchema = z.object({
  organizationName: z.string().min(1).max(200),
  industry: z.string().min(1).max(100),
  businessDescription: z.string().min(1).max(2000),
  businessPriority: z.enum(["MAXIMIZE_SALES", "FAST_RESPONSE", "PREMIUM_EXPERIENCE", "REDUCE_WORKLOAD"]),
  estimatedDailyConversations: z.number().int().min(1).max(100000),
  numberOfAgents: z.number().int().min(1).max(10000),
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

    const profile = await prisma.businessProfile.upsert({
      where: { tenantId: req.tenantId! },
      update: req.body,
      create: { tenantId: req.tenantId!, ...req.body },
    });

    // Update onboarding tracker
    await prisma.tenantOnboarding.upsert({
      where: { tenantId: req.tenantId! },
      update: { currentStep: "DEPARTMENTS" },
      create: { tenantId: req.tenantId!, currentStep: "DEPARTMENTS" },
    });

    // Update tenant status to PENDING_ONBOARDING if it was PENDING_ADMIN_SETUP
    if (tenant.status === "PENDING_ADMIN_SETUP") {
      await prisma.tenant.update({
        where: { id: req.tenantId! },
        data: { status: "PENDING_ONBOARDING" },
      });
    }

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
      await tx.departmentCopilotConfig.deleteMany({
        where: { department: { tenantId: req.tenantId! } },
      });
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

    const result = await getOnboardingChatReply(message, context, chatHistory, locale);

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

    // Generate agent configs via AI service (this also populates DepartmentCopilotConfig)
    await callAIGenerateConfigs(req.tenantId!, req.headers.authorization!);

    // Fetch the generated configs to return
    const configs = await prisma.departmentCopilotConfig.findMany({
      where: { department: { tenantId: req.tenantId! } },
      include: { department: { select: { name: true } } },
    });

    // Update onboarding step
    await prisma.tenantOnboarding.upsert({
      where: { tenantId: req.tenantId! },
      update: { currentStep: "AI_CONFIG" },
      create: { tenantId: req.tenantId!, currentStep: "AI_CONFIG" },
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
    console.error("Generate configs error:", err);
    res.status(500).json({ error: "Failed to generate configurations" });
  }
});

// ─── Complete Onboarding (Triggers Agent Generation + Activation) ──

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
      res.status(400).json({ error: "Tenant is already active" });
      return;
    }

    // ── Validate: Business profile exists ──
    const profile = await prisma.businessProfile.findUnique({
      where: { tenantId: req.tenantId! },
    });
    if (!profile) {
      res.status(400).json({ error: "Business profile is required before activation" });
      return;
    }

    // ── Validate: At least one department exists ──
    const departments = await prisma.department.findMany({
      where: { tenantId: req.tenantId!, isActive: true },
      select: { id: true, name: true, slaTarget: true },
    });
    if (departments.length === 0) {
      res.status(400).json({ error: "At least one department is required before activation" });
      return;
    }

    // ── Validate: Required SLA fields ──
    const missingSlaDepts = departments.filter((d) => !d.slaTarget);
    if (missingSlaDepts.length > 0) {
      res.status(400).json({
        error: "All departments must have SLA targets defined",
        departments: missingSlaDepts.map((d) => d.name),
      });
      return;
    }

    // ── Validate: Admin account is active ──
    const admin = await prisma.user.findFirst({
      where: { tenantId: req.tenantId!, role: "ADMIN", isActive: true },
    });
    if (!admin) {
      res.status(400).json({ error: "An active admin account is required before activation" });
      return;
    }

    // ── Generate agent configs for all departments via AI service ──
    await callAIGenerateConfigs(req.tenantId!, req.headers.authorization!);

    // ── Verify all departments have copilot configs ──
    const configCount = await prisma.departmentCopilotConfig.count({
      where: { department: { tenantId: req.tenantId! } },
    });
    if (configCount < departments.length) {
      res.status(500).json({ error: "Failed to generate copilot configurations for all departments" });
      return;
    }

    // ── Create CopilotConfig if not exists ──
    // (Tenant-level settings like SLA, auto-greeting, business hours, idle automation
    //  are already saved to Redis during the business profile step via settings APIs)
    await prisma.copilotConfig.upsert({
      where: { tenantId: req.tenantId! },
      update: {},
      create: {
        tenantId: req.tenantId!,
        systemPrompt: "",
        rules: [],
        tools: [
          { id: "kb_search", name: "Knowledge Base Search", enabled: true },
          { id: "conversation_history", name: "Conversation History", enabled: true },
          { id: "customer_lookup", name: "Customer Lookup", enabled: false },
          { id: "order_status", name: "Order Status", enabled: false },
        ],
        model: "gpt-4o-mini",
        provider: "openai",
        temperature: 0.7,
        maxTokens: 1024,
        isActive: true,
      },
    });

    // ── Activate tenant ──
    await prisma.$transaction([
      prisma.tenant.update({
        where: { id: req.tenantId! },
        data: { status: "ACTIVE" },
      }),
      prisma.tenantOnboarding.update({
        where: { tenantId: req.tenantId! },
        data: { currentStep: "COMPLETED", completedAt: new Date() },
      }),
    ]);

    // ── Send activation confirmation (non-blocking) ──
    sendActivationConfirmation(req.tenantId!).catch((err) => {
      console.error("Failed to send activation confirmation:", err);
    });

    res.json({
      data: {
        status: "ACTIVE",
        message: "Tenant onboarding completed successfully",
        departmentsActivated: departments.length,
        copilotConfigsGenerated: configCount,
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
      include: {
        copilotConfig: { select: { id: true, createdAt: true } },
      },
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

    const config = await prisma.departmentCopilotConfig.findUnique({
      where: { departmentId },
    });
    if (!config) {
      res.status(404).json({ error: "Copilot config not yet generated for this department" });
      return;
    }

    res.json({ data: config });
  } catch (err) {
    console.error("Get copilot config error:", err);
    res.status(500).json({ error: "Failed to get copilot config" });
  }
});

export default router;
