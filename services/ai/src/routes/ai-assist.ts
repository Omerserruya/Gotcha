import { Router, Request, Response } from "express";
import * as crypto from "crypto";
import {
  requireInternalKey,
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireRole,
  resolveConversationLocale,
  resolveEffectiveLocale,
  requireEntitlement,
  getRedis,
  requireVisibleConversation,
} from "@chatcenter/shared";
import * as aiService from "../services/ai-assist.service";
import { runDeduped } from "../services/copilot-dedup.service";
import {
  generateAndStore,
  readStoredSuggestions,
  latestInboundId,
  isGenerating,
} from "../services/copilot-suggestions.service";
import { getCustomerMemory } from "../services/customer-memory.service";
import { getAiActivity } from "../services/ai-activity.service";
import { generateResponse, getDefaultModel } from "../services/ai.service";
import { generateAllAgentConfigs, generateAgentConfig } from "../services/agent-config-generator";
import { getConversationIntelligence, getConversationReplay } from "../services/conversation-intelligence.service";
import { analyzeConversationOnClose } from "../services/conversation-analysis.service";
import { getToolsForTenant, executeTool, getToolExecutions } from "../services/tool-execution.service";
import { executeAdapterTool } from "../services/connectors/integration-framework";
import { getCrmAdapter } from "../services/connectors/crm-adapter-resolver";
import { scoreAgent, getAgentScore } from "../services/agent-performance.service";
import { generateFollowup } from "../services/followup-generator.service";
import { buildCustomerState } from "../services/customer-state.service";
import { getPolicy, setPolicy, validatePolicyPatch, PolicyValidationError } from "../services/policy.service";
import voiceRouter from "./ai-assist-voice";
import { buildAgentPrompt } from "../services/prompt-builder.service";
import { computeBehaviorState } from "../services/behavior-engine.service";
import { discoverBusiness, withoutWideDashes } from "../services/business-discovery.service";
import { previewAnswer, previewQuestions, PREVIEW_STATUSES, QUESTION_MAX, type PreviewLocale } from "../services/onboarding-preview.service";
import { tuneEmployeeChat } from "../services/employee-tuning.service";

const router = Router();

// ─── Business Discovery (Onboarding Intelligence Engine) ───
// The deep 5-domain website scan that produces the Business Intelligence
// Report + first recommendation (Bible Part II). The auth onboarding route
// fetches the pages + detects signals (no LLM) and calls this with the admin
// JWT forwarded - this is the one place onboarding is allowed to make an LLM
// call. Best-effort: returns { ok:false } on a scan miss so the caller can
// fall back to the shallow understanding and never block onboarding.
router.post("/discover-business", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { domain, locale, pages, signals, businessType } = req.body as {
      domain?: string;
      locale?: string;
      pages?: Array<{ url: string; text: string }>;
      signals?: import("../services/business-discovery.service").DiscoverySignals;
      businessType?: string;
    };
    if (!domain || !Array.isArray(pages) || pages.length === 0) {
      res.status(400).json({ error: "domain and pages are required" });
      return;
    }
    const report = await discoverBusiness({
      tenantId: req.tenantId!,
      domain,
      locale,
      pages: pages.filter((p) => p && typeof p.text === "string").slice(0, 8),
      signals: signals || {},
      businessType,
    });
    if (!report) {
      res.json({ data: { ok: false } });
      return;
    }
    res.json({ data: { ok: true, report } });
  } catch (err) {
    console.error("Discover business error:", err);
    res.status(500).json({ error: "Failed to run business discovery" });
  }
});

// Onboarding Movement 8 - chat with the recommended employee before deploy.
// ── Onboarding 00h preview (see onboarding-preview.service) ───────────────
//
// ADMIN only, in a workspace still being set up or ACTIVE. 20 a minute per
// tenant across both routes' answers, and a question length cap: a preview,
// not a free chat. Nothing becomes business state.

const PREVIEW_PER_MINUTE = 20;

async function previewTenantOk(req: Request, res: Response): Promise<boolean> {
  const t = await prisma.tenant.findUnique({ where: { id: req.tenantId! }, select: { status: true } });
  if (!t || !PREVIEW_STATUSES.has(String(t.status))) {
    res.status(403).json({ error: "Not available for this workspace", code: "TENANT_STATUS" });
    return false;
  }
  return true;
}

/** Seconds to wait, or null when allowed. Fixed one-minute window per tenant. */
export async function previewRateLimit(tenantId: string, now = Date.now()): Promise<number | null> {
  const windowStart = Math.floor(now / 60_000);
  const key = `onboarding-preview:${tenantId}:${windowStart}`;
  const redis = getRedis();
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 65);
  if (n > PREVIEW_PER_MINUTE) return Math.max(1, 60 - Math.floor((now / 1000) % 60));
  return null;
}

const previewLocale = (v: unknown): PreviewLocale => (String(v ?? "").toLowerCase().startsWith("he") ? "he" : "en");

router.get("/onboarding-preview-questions", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    if (!(await previewTenantOk(req, res))) return;
    res.json({ data: await previewQuestions(req.tenantId!, previewLocale(req.query.locale)) });
  } catch (err) {
    console.error("[onboarding-preview] questions failed:", err);
    res.status(500).json({ error: "Failed to load preview questions" });
  }
});

router.post("/onboarding-preview-answer", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) { res.status(422).json({ error: "Write a question", code: "QUESTION_REQUIRED" }); return; }
    if (question.length > QUESTION_MAX) { res.status(422).json({ error: "The question is too long", code: "QUESTION_TOO_LONG", max: QUESTION_MAX }); return; }
    if (!(await previewTenantOk(req, res))) return;
    const wait = await previewRateLimit(req.tenantId!);
    if (wait !== null) {
      res.setHeader("Retry-After", String(wait));
      res.status(429).json({ error: "Too many questions. Try again in a moment.", code: "PREVIEW_RATE_LIMITED", retryAfterSeconds: wait });
      return;
    }
    const locale = previewLocale(req.body?.locale ?? (/[\u0590-\u05FF]/.test(question) ? "he" : "en"));
    const data = await previewAnswer({ tenantId: req.tenantId!, userId: (req as any).user?.userId ?? null, question, locale });
    res.json({ data });
  } catch (err: any) {
    if (err?.name === "AiUnitsExhaustedError") {
      res.status(402).json({ error: "AI is not available for this workspace right now", code: err.reason });
      return;
    }
    console.error("[onboarding-preview] answer failed:", err);
    res.status(500).json({ error: "Failed to answer" });
  }
});

router.post("/onboarding-employee-chat", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const { name, role, locale, context, persona, messages } = req.body as {
      name?: string; role?: string; locale?: string;
      context?: { business?: string; industry?: string; summary?: string; brandVoice?: string; goal?: string };
      persona?: import("../services/employee-tuning.service").EmployeePersona;
      messages?: Array<{ role: "user" | "assistant"; content: string }>;
    };
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages are required" });
      return;
    }
    const result = await tuneEmployeeChat({
      tenantId: req.tenantId!,
      name: (name || "").slice(0, 120) || "Your AI Employee",
      role: role || "customer_support",
      locale,
      context,
      persona: persona || {},
      messages: messages.filter((m) => m && typeof m.content === "string").slice(-10),
    });
    // The reply and the tuned persona are shown in onboarding and stored on
    // the discovery row: no wide dash in either (same rule as the scan).
    res.json({ data: { ok: true, ...withoutWideDashes(result) } });
  } catch (err) {
    console.error("Employee tuning chat error:", err);
    res.status(500).json({ error: "Failed to chat with the employee" });
  }
});

// ─── Config Generation Endpoints (called during onboarding - tenant may not be active yet) ───

router.post("/generate-configs", authenticate, resolveTenant, requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    await generateAllAgentConfigs(req.tenantId!);
    const agents = await prisma.aIAgent.findMany({
      where: { tenantId: req.tenantId! },
    });
    res.json({
      data: {
        agentsConfigured: agents.length,
        agents: agents.map(a => ({
          id: a.id,
          name: a.name,
          role: a.role,
          status: a.status,
          // descriptionPreview removed - description column dropped per spec.
          hasIdentity: !!a.identity,
          hasGoals: !!a.goals,
          hasTone: !!a.toneConfig,
          hasBehavioral: !!a.behavioral,
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
    const departmentId = req.params.departmentId as string;
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

// ─── Intent Classification (internal, called by incoming-worker) ───

router.post("/intent", requireInternalKey, async (req: Request, res: Response) => {
  try {
    const { message, intent, intents, tenantId } = req.body;
    // Accept both shapes:
    //   Batch (preferred): { message, intents: ["sales","support",...] }
    //     → returns { data: { matches: string[] } } AND { match, intent }
    //       (single-intent back-compat when exactly one intent was checked)
    //   Single (legacy):   { message, intent: "sales" }
    //     → returns { data: { match: boolean } } plus `matches` array for new callers.
    if (!message || (!intent && (!Array.isArray(intents) || intents.length === 0))) {
      res.status(400).json({ error: "message is required, plus `intent` (string) or `intents` (string[])" });
      return;
    }

    const intentList: string[] = Array.isArray(intents) && intents.length > 0
      ? intents.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim())
      : [intent].filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim());

    let matches: string[] = [];
    try {
      // Ask the LLM once: which of these intents does the message match?
      // Output contract: a JSON array of matching intent strings (may be empty).
      // We use a tight system prompt + low temperature to keep it deterministic.
      const aiResponse = await generateResponse({
        tenantId: tenantId || "system",
        messages: [
          {
            role: "system",
            content:
              `You classify a customer message against a finite list of intents.\n` +
              `Return ONLY a JSON array of the intents from the list that clearly apply.\n` +
              `Example: intents=["sales","support","billing"], message about pricing → ["sales"].\n` +
              `If none apply, return [].\n\n` +
              `Intents: ${JSON.stringify(intentList)}`,
          },
          { role: "user", content: message },
        ],
        temperature: 0,
        maxTokens: 64,
        metadata: { type: "intent_batch", count: intentList.length },
      });

      const raw = (aiResponse.content ?? "").trim();
      // Strip code fences / trailing junk if any.
      const jsonStart = raw.indexOf("[");
      const jsonEnd = raw.lastIndexOf("]");
      if (jsonStart >= 0 && jsonEnd >= jsonStart) {
        const slice = raw.slice(jsonStart, jsonEnd + 1);
        try {
          const parsed = JSON.parse(slice);
          if (Array.isArray(parsed)) {
            matches = parsed
              .filter((v) => typeof v === "string")
              .map((v: string) => v.trim())
              .filter((v) => intentList.includes(v));
          }
        } catch {
          // ignore parse errors - fallthrough to keyword heuristic below
        }
      }
      if (matches.length === 0 && raw && !raw.startsWith("[")) {
        // Some models answer with plain text. Recover a single-intent reply
        // if it looks like one of our intents.
        const lower = raw.toLowerCase();
        matches = intentList.filter((i) => lower.includes(i.toLowerCase()));
      }
      console.log(`[intent] batch message="${String(message).substring(0, 50)}" intents=${JSON.stringify(intentList)} matches=${JSON.stringify(matches)}`);
    } catch (err: any) {
      // AI unavailable - keyword fallback per intent.
      const msgLower = String(message).toLowerCase();
      matches = intentList.filter((i) => msgLower.includes(i.toLowerCase()));
      console.log(`[intent] AI unavailable (${err.message}); keyword fallback matches=${JSON.stringify(matches)}`);
    }

    // Shape the response for both old and new callers:
    //   - Legacy single-intent callers read `data.match` (boolean)
    //   - New batch callers read `data.matches` (string[])
    if (intent && !Array.isArray(intents)) {
      res.json({
        data: {
          match: matches.includes(intent),
          intent,
          matches, // harmless extra field for forward-compat
        },
      });
      return;
    }
    res.json({ data: { matches } });
  } catch (err) {
    console.error("Intent classification error:", err);
    res.status(500).json({ error: "Failed to classify intent" });
  }
});

// ─── Voice stream handler (internal auth, no tenant session required) ───

router.use("/voice", voiceRouter);

// ─── Main AI Routes (require active tenant) ─────────────────

router.use(authenticate, resolveTenant, requireActiveTenant());
// Every /:conversationId route below answers only for a conversation this
// viewer may see (the inbox's rule, shared); 404 otherwise.
router.param("conversationId", requireVisibleConversation);

// Tools registry - MUST be before /:conversationId routes
router.get("/tools/registry", requireRole("ADMIN"), async (req: Request, res: Response) => {
  try {
    const tools = await getToolsForTenant(req.tenantId!);
    res.json({ data: tools });
  } catch (err) { console.error("Tools registry error:", err); res.status(500).json({ error: "Failed to get tools" }); }
});

// Static routes BEFORE parameterized routes
router.get("/config", async (req: Request, res: Response) => {
  try {
    const config = await aiService.getTenantCopilotConfig(req.tenantId!);
    res.json({ data: config });
  } catch (err) { console.error("AI config error:", err); res.status(500).json({ error: "Failed to get config" }); }
});

// ─── Compose: AI-assisted message drafting ──────────────────
// Drafts a single outbound message from a natural-language instruction.
// Used by: template editor, scheduled-message composer, inbox input,
// and the Command Center. Returns plain text (no JSON).
router.post("/compose", async (req: Request, res: Response) => {
  try {
    const {
      instruction,
      surface = "inbox",
      conversationId,
      channel,
      locale,
      currentDraft,
      asTemplate = false,
    } = req.body || {};

    if (!instruction || typeof instruction !== "string" || !instruction.trim()) {
      res.status(400).json({ error: "instruction is required" });
      return;
    }

    const sys: string[] = [
      "You are a senior customer-engagement copywriter inside ChatCenter.",
      "Draft the text of a single outbound message from the operator's instruction.",
      "Output ONLY the message body - no JSON, no surrounding quotes, no prefaces like 'Here is…', no sign-off disclaimers.",
      "Keep it natural, clear, and on-brand. Do not invent facts, prices, dates, links, names, or order numbers that were not provided.",
    ];
    if (channel) sys.push(`The message will be sent via ${channel}. Match the medium's conventions (short, no markdown on WhatsApp/SMS).`);
    if (asTemplate) {
      sys.push("This draft is for a message TEMPLATE. Use placeholders like {{1}}, {{2}} for per-recipient variables (names, amounts, dates). Number from {{1}}.");
    } else {
      sys.push("Do NOT use placeholder syntax like {{1}}. Write concrete finished text.");
    }
    const langMap: Record<string, string> = {
      he: "Hebrew", ar: "Arabic", es: "Spanish", fr: "French",
      de: "German", pt: "Portuguese", ru: "Russian", zh: "Chinese", ja: "Japanese",
    };
    if (locale && langMap[locale]) sys.push(`Write the message in ${langMap[locale]}.`);

    const blocks: string[] = [];

    if (surface === "inbox" && conversationId) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, tenantId: req.tenantId! },
      });
      if (conversation) {
        const msgs = await prisma.message.findMany({
          where: { conversationId, tenantId: req.tenantId! },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { direction: true, body: true, senderName: true },
        });
        const transcript = msgs
          .reverse()
          .filter((m: any) => m.body?.trim())
          .map((m: any) => `${m.direction === "INBOUND" ? "Customer" : (m.senderName || "Agent")}: ${m.body}`)
          .join("\n");
        if (transcript) blocks.push(`## Recent conversation\n${transcript}`);
        if (conversation.customerName) blocks.push(`## Customer name\n${conversation.customerName}`);
      }
    }

    if (currentDraft && typeof currentDraft === "string" && currentDraft.trim()) {
      blocks.push(`## Current draft (refine - keep what works, rewrite what's off)\n${currentDraft.trim()}`);
    }

    blocks.push(`## Operator instruction\n${instruction.trim()}`);

    const result = await generateResponse({
      tenantId: req.tenantId!,
      sessionId: conversationId,
      messages: [
        { role: "system", content: sys.join("\n") },
        { role: "user", content: blocks.join("\n\n") },
      ],
      temperature: 0.7,
      maxTokens: 512,
      metadata: { type: "compose", conversationId },
    });

    // Strip accidental surrounding quotes or code fences.
    const text = (result.content || "")
      .trim()
      .replace(/^```[a-z]*\s*|\s*```$/gi, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();

    res.json({ data: { text, surface } });
  } catch (err: any) {
    console.error("AI compose error:", err);
    res.status(500).json({ error: err?.message || "Failed to compose message" });
  }
});

// Chat Copilot is sold separately from the core inbox, so the suggestion
// endpoints are gated rather than merely hidden in the UI.
//
// ★ READING SUGGESTIONS NEVER CALLS THE MODEL. They are generated when a
// customer message arrives in a conversation a person answers (debounced), or
// when an agent presses "Try again" (POST .../refresh below), and stored. This
// GET used to run the model on every open - old app and v2 alike - which was a
// usage_logs row and metered AI units per open for an unchanged transcript.
// See services/copilot-suggestions.service.ts.

/**
 * The read shape. `{data, copilotMode}` is the old app's contract and is
 * unchanged; the rest is additive.
 *   stale       a customer message exists that these suggestions do not
 *               answer yet (a generation is running, or none ever ran)
 *   generating  a generation is scheduled or running now; the screen will
 *               get `copilot.suggestions.updated` when it lands
 */
async function readSuggestionsPayload(tenantId: string, convId: string): Promise<{ status: number; body: any }> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: convId, tenantId },
    select: { id: true, departmentId: true },
  });
  if (!conversation) return { status: 404, body: { error: "Conversation not found" } };

  const [stored, latest] = await Promise.all([
    readStoredSuggestions(tenantId, convId),
    latestInboundId(tenantId, convId),
  ]);
  const generating = isGenerating(tenantId, convId);

  if (!stored) {
    // A DB read, not a model call: the "not configured" stub the panel has
    // always shown when there is no AI Employee.
    const copilotConfig = await aiService.getEffectiveCopilotConfig(tenantId, (conversation as any).departmentId);
    if (!copilotConfig) {
      return {
        status: 200,
        body: { data: [{ id: "no-config", text: "No AI Employee configured.", confidence: 0, type: "info" }], copilotMode: "READY_MESSAGE" },
      };
    }
    return {
      status: 200,
      body: {
        data: [],
        copilotMode: copilotConfig.copilotMode || "READY_MESSAGE",
        basedOnMessageId: null,
        generatedAt: null,
        stale: latest !== null,
        generating,
      },
    };
  }
  return {
    status: 200,
    body: {
      data: stored.suggestions,
      copilotMode: stored.copilotMode,
      basedOnMessageId: stored.basedOnMessageId,
      generatedAt: stored.generatedAt,
      stale: latest !== null && latest !== stored.basedOnMessageId,
      generating,
    },
  };
}

router.get("/:conversationId/suggestions", requireEntitlement("ai.copilot"), async (req: Request, res: Response) => {
  const convId = req.params.conversationId as string;
  const tenantId = req.tenantId!;
  try {
    const out = await readSuggestionsPayload(tenantId, convId);
    console.log(JSON.stringify({
      tag: "copilot.suggestions.read", tenantId, conversationId: convId, status: out.status,
      stale: out.body?.stale ?? null, generating: out.body?.generating ?? null,
    }));
    res.status(out.status).json(out.body);
  } catch (err: any) {
    console.error("AI suggestions read error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to get suggestions" });
  }
});

/** Per-conversation cooldown and per-agent budget for "Try again". */
const REFRESH_COOLDOWN_SECONDS = Number(process.env.COPILOT_REFRESH_COOLDOWN_SECONDS || 15);
const REFRESH_PER_USER_LIMIT = Number(process.env.COPILOT_REFRESH_PER_USER_LIMIT || 20);
const REFRESH_PER_USER_WINDOW_SECONDS = 600;

/**
 * Returns null when allowed, or the seconds to wait. Redis, so the limit holds
 * across restarts and is the same for every tab. Fails OPEN on a Redis error:
 * the alternative blocks an agent's explicit request over an infrastructure
 * hiccup, and the per-request cost is bounded by runDeduped either way.
 */
async function refreshRateLimit(tenantId: string, convId: string, userId: string | undefined): Promise<number | null> {
  try {
    const redis = getRedis();
    const convKey = `copilot:refresh:conv:${tenantId}:${convId}`;
    const ok = await redis.set(convKey, "1", "EX", REFRESH_COOLDOWN_SECONDS, "NX");
    if (ok !== "OK") {
      const ttl = await redis.ttl(convKey);
      return ttl > 0 ? ttl : REFRESH_COOLDOWN_SECONDS;
    }
    if (userId) {
      const userKey = `copilot:refresh:user:${tenantId}:${userId}`;
      const n = await redis.incr(userKey);
      if (n === 1) await redis.expire(userKey, REFRESH_PER_USER_WINDOW_SECONDS);
      if (n > REFRESH_PER_USER_LIMIT) {
        const ttl = await redis.ttl(userKey);
        return ttl > 0 ? ttl : REFRESH_PER_USER_WINDOW_SECONDS;
      }
    }
    return null;
  } catch (err: any) {
    console.warn("[copilot-suggestions] rate limit check failed (allowing):", err?.message ?? err);
    return null;
  }
}

// The agent's explicit "Try again". The only on-demand way to spend tokens on
// suggestions. Answers with the same shape as the GET, after generating.
router.post("/:conversationId/suggestions/refresh", requireEntitlement("ai.copilot"), async (req: Request, res: Response) => {
  const requestInstanceId =
    (req.header("x-request-instance-id") || crypto.randomBytes(12).toString("hex")).slice(0, 64);
  const convId = req.params.conversationId as string;
  const tenantId = req.tenantId!;
  const startedAt = Date.now();
  try {
    const exists = await prisma.conversation.findFirst({ where: { id: convId, tenantId }, select: { id: true } });
    if (!exists) { res.status(404).json({ error: "Conversation not found" }); return; }

    const wait = await refreshRateLimit(tenantId, convId, req.user?.userId);
    if (wait !== null) {
      res.setHeader("Retry-After", String(wait));
      res.status(429).json({ error: "Suggestions were just refreshed. Try again in a moment.", code: "REFRESH_RATE_LIMITED", retryAfterSeconds: wait });
      return;
    }

    const localeOverride = (req.body?.locale as string) || (req.query.locale as string) || undefined;
    const outcome = await runDeduped({
      key: `${tenantId}:${convId}`,
      requestInstanceId,
      fn: async () => {
        await generateAndStore(tenantId, convId, "refresh", { localeOverride, fallbackUserId: req.user?.userId });
        return readSuggestionsPayload(tenantId, convId);
      },
    });
    console.log(JSON.stringify({
      tag: "copilot.suggestions.refresh", tenantId, conversationId: convId, requestInstanceId,
      dedupReason: outcome.reason, totalMs: Date.now() - startedAt, status: outcome.result.status,
    }));
    if ((req as any).aborted || res.headersSent) return;
    res.status(outcome.result.status).json(outcome.result.body);
  } catch (err: any) {
    console.error("AI suggestions refresh error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to refresh suggestions" });
  }
});

/**
 * GET /:conversationId/ai-activity?limit=20 - the AI's recent steps in this
 * conversation (tool, labelKey, status, timings), newest first, without the
 * tool's arguments or result. Live updates: `ai.activity.updated` on conv:{id}.
 */
router.get("/:conversationId/ai-activity", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const convId = req.params.conversationId as string;
    const exists = await prisma.conversation.findFirst({ where: { id: convId, tenantId }, select: { id: true } });
    if (!exists) { res.status(404).json({ error: "Conversation not found" }); return; }
    const limit = Number(req.query.limit) || 20;
    res.json({ data: await getAiActivity(tenantId, convId, limit) });
  } catch (err: any) {
    console.error("ai-activity read error:", err?.message ?? err);
    res.status(500).json({ error: "Failed to read AI activity" });
  }
});

/**
 * GET /:conversationId/customer-memory - what GOTCHA remembers about this
 * customer, exactly as the AI is given it (services/customer-memory.service.ts:
 * the prompt renders from the same loaders). A read; never calls a model.
 */
router.get("/:conversationId/customer-memory", async (req: Request, res: Response) => {
  try {
    const memory = await getCustomerMemory(req.tenantId!, req.params.conversationId as string);
    if (!memory) { res.status(404).json({ error: "Conversation not found" }); return; }
    res.json({ data: memory });
  } catch (err: any) {
    console.error("customer-memory read error:", err?.message ?? err);
    res.status(500).json({ error: "Failed to read customer memory" });
  }
});

// Gated on communication.crm_summaries - the SAME key as the background
// pipeline, and deliberately NOT ai.copilot. Foundation denies Copilot and
// grants summaries; gating this route on ai.copilot would break exactly the
// plan combination the product sells.
router.get("/:conversationId/summary", requireEntitlement("communication.crm_summaries"), async (req: Request, res: Response) => {
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

    if (!copilotConfig) {
      res.json({ data: { summary: "AI summarization not configured." }, copilotMode: "READY_MESSAGE" });
      return;
    }

    // The AI summary is agent-facing - should track the SYSTEM language,
    // not the customer's. Per-agent override wins; otherwise tenant
    // default; otherwise "en". Explicit query-string override still
    // honored for ad-hoc preview.
    const localeOverride = (req.query.locale as string) || undefined;
    const locale = localeOverride ?? (await resolveEffectiveLocale({
      tenantId: req.tenantId!,
      userId: req.user?.userId,
    }).catch(() => null))?.effective;
    const context: aiService.ConversationContext = {
      tenantId: req.tenantId!, conversationId: conversation.id,
      customerName: conversation.customerName || undefined,
      messages: messages.map((m: any) => ({
        direction: m.direction, body: m.body, senderName: m.senderName || undefined, createdAt: m.createdAt.toISOString(),
      })),
      copilotConfig,
      locale,
    };
    const summary = await aiService.summarizeConversation(context);
    res.json({ data: { summary }, copilotMode: copilotConfig.copilotMode || "READY_MESSAGE" });
  } catch (err) { console.error("AI summary error:", err); res.status(500).json({ error: "Failed to get summary" }); }
});

// ─── Agent Chat with AI (CHAT mode) ──────────────────────────
router.post("/:conversationId/chat", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const { message, history, locale } = req.body;

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

    if (!copilotConfig) {
      res.status(400).json({ error: "No AI Employee configured. Set up an AI Employee in AI Studio." });
      return;
    }

    const reply = await aiService.chatWithAgent({
      tenantId: req.tenantId!,
      conversationId: conversation.id,
      customerName: conversation.customerName || undefined,
      messages: messages.map((m: any) => ({
        direction: m.direction, body: m.body, senderName: m.senderName || undefined, createdAt: m.createdAt.toISOString(),
      })),
      copilotConfig,
      locale: locale || undefined,
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
    const behaviorState = computeBehaviorState({
      mode: "copilot",
      identity: { hasContact: false, contactLifecycle: null, priorConversationCount: 0 },
      request: { lastMessage: "", messageCount: 0 },
    });
    const systemPrompt = buildAgentPrompt({
      behaviorState,
      agent: config.agent,
    });
    res.json({
      data: {
        systemPrompt,
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

// ─── Conversation Intelligence & Replay ─────────────────────

router.get("/:conversationId/intelligence", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const intelligence = await getConversationIntelligence(req.tenantId!, convId);
    res.json({ data: intelligence });
  } catch (err) { console.error("Intelligence error:", err); res.status(500).json({ error: "Failed to get conversation intelligence" }); }
});

router.post("/:conversationId/analyze", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    // A person asked: analysed now (the cap and the up-to-date check do not
    // apply; the real-conversation rule does).
    const outcome = await analyzeConversationOnClose(req.tenantId!, convId, { trigger: "manual", force: true });
    if (outcome === "not_found") { res.status(404).json({ error: "Conversation not found" }); return; }
    const intelligence = await getConversationIntelligence(req.tenantId!, convId);
    res.json({ data: intelligence, outcome });
  } catch (err) { console.error("Analyze error:", err); res.status(500).json({ error: "Failed to analyze conversation" }); }
});

router.get("/:conversationId/replay", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const replay = await getConversationReplay(req.tenantId!, convId);
    res.json({ data: replay });
  } catch (err) { console.error("Replay error:", err); res.status(500).json({ error: "Failed to get conversation replay" }); }
});

// ─── Tool Execution ──────────────────────────────────────────

router.get("/:conversationId/tools", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const executions = await getToolExecutions(req.tenantId!, convId);
    res.json({ data: executions });
  } catch (err) { console.error("Tool executions error:", err); res.status(500).json({ error: "Failed to get tool executions" }); }
});

router.post("/:conversationId/tools/execute", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const { tenantToolId, input } = req.body;
    if (!tenantToolId) { res.status(400).json({ error: "tenantToolId is required" }); return; }
    const execution = await executeTool({
      tenantId: req.tenantId!,
      conversationId: convId,
      tenantToolId,
      input: input || {},
      triggeredBy: (req as any).user?.id || "agent",
    });
    res.json({ data: execution });
  } catch (err: any) {
    console.error("Tool execute error:", err);
    if (err.message === "Tool not found") { res.status(404).json({ error: err.message }); return; }
    res.status(500).json({ error: "Failed to execute tool" });
  }
});

/**
 * Bridge endpoint for adapter-framework providers (HubSpot, Salesforce,
 * Monday, etc.) - they aren't HTTP-catalog tools, so the shared CRM client
 * in `packages/shared/lib/crm.ts` reaches them through this endpoint.
 *
 * Body: { toolFunctionName: "hubspot.search_with_criteria", args: {...} }
 *
 * Returns the adapter result (whatever shape the provider's execute()
 * function returns) on `data.output`, mirroring the catalog-tool execute
 * envelope so callers can treat both paths uniformly.
 */
router.post("/:conversationId/adapter-tools/execute", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const { toolFunctionName, args } = req.body;
    if (typeof toolFunctionName !== "string" || !toolFunctionName.includes(".")) {
      res.status(400).json({ error: "toolFunctionName must be 'provider.tool'" });
      return;
    }
    const result = await executeAdapterTool({
      tenantId: req.tenantId!,
      conversationId: convId === "system" ? undefined : convId,
      toolFunctionName,
      args: args || {},
    });
    if (!result.ok) {
      res.json({ data: { ok: false, error: result.reason } });
      return;
    }
    res.json({ data: { ok: true, output: result.result } });
  } catch (err: any) {
    console.error("Adapter tool execute error:", err);
    res.status(500).json({ error: "Failed to execute adapter tool" });
  }
});

// ─── Uniform CRM identity lookup ─────────────────────────────
// Search the connected system-of-record by email/phone through the
// CRMAdapter.findCustomer interface. Unlike the per-vendor catalog
// `lead_search`/`contact_search` tools (which only Zoho-style providers
// register), this covers EVERY source-of-truth integration connectable at
// onboarding - HubSpot, Salesforce, Zoho, Shopify, Fireberry, Airtable -
// through one code path. Shared's searchLeads/searchContacts fall back here
// for providers that don't expose the catalog search tools.
router.post("/:conversationId/crm/find", async (req: Request, res: Response) => {
  try {
    const { phone, email, external_id } = req.body || {};
    if (!phone && !email && !external_id) {
      res.json({ data: { ok: true, contacts: [] } });
      return;
    }
    const adapter = await getCrmAdapter(req.tenantId!);
    if (adapter.capabilities?.is_stub) {
      res.json({ data: { ok: false, reason: "no_crm_configured", contacts: [] } });
      return;
    }
    const result = await adapter.findCustomer({ phone, email, external_id });
    res.json({
      data: { ok: result.ok, contacts: result.contacts ?? [], reason: result.reason },
    });
  } catch (err: any) {
    console.error("CRM find error:", err);
    res.status(500).json({ error: "Failed to search CRM" });
  }
});

// ─── Agent Scoring ───────────────────────────────────────────

router.get("/:conversationId/score", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const score = await getAgentScore(req.tenantId!, convId);
    if (!score) {
      res.status(404).json({ error: "No agent assigned to this conversation" });
      return;
    }
    res.json({ data: score });
  } catch (err) {
    console.error("Get agent score error:", err);
    res.status(500).json({ error: "Failed to get agent score" });
  }
});

router.post("/:conversationId/score", async (req: Request, res: Response) => {
  try {
    const convId = req.params.conversationId as string;
    const score = await scoreAgent(req.tenantId!, convId);
    if (!score) {
      res.status(404).json({ error: "No agent assigned to this conversation" });
      return;
    }
    res.json({ data: score });
  } catch (err) {
    console.error("Score agent error:", err);
    res.status(500).json({ error: "Failed to score agent" });
  }
});

// F8.4 - business policy admin API (UI-neutral)
router.get(
  "/policy",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  async (req: Request, res: Response) => {
    const policy = await getPolicy(req.tenantId!);
    res.json({ data: policy });
  },
);
router.put(
  "/policy",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  requireRole("ADMIN"),
  async (req: Request, res: Response) => {
    try {
      // Validated before it is merged. This used to spread `req.body` straight
      // into the stored JSON, and the lists in that JSON are composed verbatim
      // into the AI's system prompt - so an unbounded, untyped write here was
      // arbitrary text reaching the model on every future turn.
      const patch = validatePolicyPatch(req.body ?? {});
      const policy = await setPolicy(req.tenantId!, patch);
      res.json({ data: policy });
    } catch (err) {
      if (err instanceof PolicyValidationError) {
        res.status(400).json({ error: err.message, field: err.field });
        return;
      }
      console.error("policy update error:", err);
      res.status(500).json({ error: "Failed to update policy" });
    }
  },
);

// F7.2/F7.5 - compact customer state object (decisions, summaries, tags)
router.get(
  "/customer-state/:contactId",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  async (req: Request, res: Response) => {
    try {
      const state = await buildCustomerState(req.tenantId!, String(req.params.contactId));
      if (!state) return res.status(404).json({ error: "Contact not found" });
      return res.json({ data: state });
    } catch (err) {
      console.error("customer-state error:", err);
      return res.status(500).json({ error: "Failed to build customer state" });
    }
  },
);

// F6.3 - generate a contextual follow-up for a stale conversation
router.post(
  "/:conversationId/followup",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  async (req: Request, res: Response) => {
    try {
      const result = await generateFollowup(req.tenantId!, String(req.params.conversationId));
      if (!result) return res.json({ data: null, reason: "nothing useful to send" });
      return res.json({ data: result });
    } catch (err: any) {
      console.error("followup generator error:", err);
      return res.status(500).json({ error: "Failed to generate follow-up" });
    }
  },
);

export default router;
