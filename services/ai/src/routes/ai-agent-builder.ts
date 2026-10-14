/**
 * AI Employee Builder - HTTP surface.
 *
 * Mounted at `/api/ai-agents/builder` (BEFORE the ai-agents router so its
 * `GET /:id` never shadows these). The builder is the dynamic replacement
 * for the old static creation wizard:
 *
 *   POST /builder/start          → create a DRAFT AIAgent + return greeting
 *   POST /builder/run            → SSE stream of BuilderEvent (the loop)
 *   GET  /builder/:id/draft      → current draft snapshot (reconnect)
 *   POST /builder/:id/finalize   → validate + return readiness for the review step
 *
 * The DRAFT row's id IS the builder session id. The conversation transcript
 * is stored per-session in SystemAgentMessage (see agent-builder.service).
 * Save → ACTIVE happens via the normal `PATCH /api/ai-agents/:id` route.
 */

import { Router, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { authenticate, resolveTenant, requireOnboardingOrActiveTenant, requireRole, prisma, defaultIntegrationAccess, normalizeGuardrails, GuardrailsError, requireEntitlement, requireCapacity } from "@chatcenter/shared";
import {
  runBuilder,
  loadDraftSnapshot,
  draftReadiness,
  seedDraftFromGoal,
  type BuilderEvent,
  type BuilderDraftSnapshot,
  type SeededDraftContext,
} from "../services/agent-builder.service";
import { generateReadinessReport } from "../services/agent-readiness.service";
import { markReadinessRunning, markReadinessFinished } from "../services/readiness-status";
import { generateSalesContext } from "../services/sales-context-generator.service";
import { createSkill, setAgentSkills, SkillValidationError, SKILL_MODES } from "../services/business-skills.service";
import { processDocument } from "../services/embedding.service";

const router = Router();

const MAX_KB_NAME = 120;
// Under the 100kb request body limit even for Hebrew (two bytes a character).
const MAX_DOC_CONTENT = 50_000;

// Onboarding renders this SAME wizard (setup Movement 8 mounts the shared
// components/aiEmployee/AgentBuilder), and during onboarding the tenant is
// PENDING_ONBOARDING - requireActiveTenant() answered 403 for every builder
// call, so the embedded wizard could not even start. Building the first
// employee is precisely an onboarding activity.
router.use(authenticate, resolveTenant, requireOnboardingOrActiveTenant(), requireRole("ADMIN"));

// Localized opening line. The builder agent itself replies in the admin's
// language (system prompt), but the very first message is static so we map it.
// We already know the company from onboarding, so the opener skips business
// discovery and goes straight to THIS employee's purpose/goal.
function buildGreeting(lang: string, orgName: string): string {
  const who = orgName ? ` for **${orgName}**` : "";
  const whoHe = orgName ? ` עבור **${orgName}**` : "";
  const whoAr = orgName ? ` لـ **${orgName}**` : "";
  if (lang === "he") return `היי! אני כבר מכיר את העסק שלכם${whoHe} מתהליך ההקמה, אז נדלג על זה. בואו נגדיר את עובד ה-AI הזה - מה המטרה שלו ובמה הוא אמור לטפל מול הלקוחות?`;
  if (lang === "ar") return `مرحبًا! أعرف عملك${whoAr} بالفعل من الإعداد، لذا سنتخطى ذلك. لنحدد موظف الذكاء الاصطناعي هذا - ما هدفه وما الذي يجب أن يتولاه مع العملاء؟`;
  return `Hi! I already know your business${who} from onboarding, so we'll skip that. Let's define this AI employee - what's its purpose, and what should it handle for your customers?`;
}
// Goal-first opener: the system just drafted the whole employee from the
// admin's one-line goal + the business twin - present the draft and invite
// corrections. Deterministic (no LLM), mirrors buildGreeting's localization.
function buildSeededGreeting(lang: string, draft: BuilderDraftSnapshot, seeded: SeededDraftContext): string {
  const name = draft.name && draft.name !== "Untitled AI Employee" ? draft.name : null;
  const roleLabelHe: Record<string, string> = {
    customer_support: "שירות לקוחות", sales: "מכירות", sdr: "טיפול בלידים", recruiting: "גיוס",
    booking: "תיאום תורים", billing: "חיובים ותשלומים", research: "מענה מבוסס ידע", custom: "מותאם אישית",
  };
  const roleLabelEn: Record<string, string> = {
    customer_support: "customer support", sales: "sales", sdr: "lead qualification", recruiting: "recruiting",
    booking: "booking", billing: "billing", research: "knowledge answers", custom: "custom",
  };
  if (lang === "he") {
    const lines = [
      `הכנתי טיוטה מלאה של העובד לפי המטרה שנתתם ולפי מה שאני כבר יודע על העסק:`,
      `• **תפקיד:** ${roleLabelHe[draft.role] || draft.role}${name ? `  ·  **שם מוצע:** ${name}` : ""}`,
      `• **מטרה:** ${draft.goal}`,
      seeded.attachedKbCount > 0 ? `• חיברתי ${seeded.attachedKbCount} מאגרי ידע קיימים` : null,
      seeded.grantedToolCount > 0 ? `• נתתי גישה ל-${seeded.grantedToolCount} כלים מהמערכות המחוברות (ללא פעולות רגישות)` : null,
      ``,
      `מה תרצו לשנות או לחדד? אפשר גם פשוט לומר "ממשיכים" ונסגור יחד את כללי ההסלמה.`,
    ].filter((l): l is string => l !== null);
    return lines.join("\n");
  }
  if (lang === "ar") {
    return `أعددت مسودة كاملة للموظف بناءً على هدفك وما أعرفه عن عملك - الدور: ${draft.role}، الهدف: ${draft.goal}. ما الذي تريد تعديله؟ أو قل "تابع" وسننهي قواعد التصعيد معًا.`;
  }
  const lines = [
    `I've drafted the whole employee from your goal plus everything I already know about your business:`,
    `• **Role:** ${roleLabelEn[draft.role] || draft.role}${name ? `  ·  **Proposed name:** ${name}` : ""}`,
    `• **Goal:** ${draft.goal}`,
    seeded.attachedKbCount > 0 ? `• Attached ${seeded.attachedKbCount} existing knowledge base${seeded.attachedKbCount > 1 ? "s" : ""}` : null,
    seeded.grantedToolCount > 0 ? `• Granted ${seeded.grantedToolCount} tools from your connected systems (no sensitive actions)` : null,
    ``,
    `What would you like to change or sharpen? Or just say "continue" and we'll settle the escalation rules together.`,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

async function resolveLocale(tenantId: string, bodyLocale: unknown): Promise<string> {
  if (typeof bodyLocale === "string" && bodyLocale.length >= 2) return bodyLocale.toLowerCase();
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultLocale: true } });
    return ((t as any)?.defaultLocale || "en").toLowerCase();
  } catch {
    return "en";
  }
}

// ─── Start a builder session ────────────────────────────────
router.post("/start", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const { departmentId, locale, forceNew, goal } = req.body || {};
    const lang = await resolveLocale(tenantId, locale);
    const goalText = typeof goal === "string" ? goal.trim().slice(0, 600) : "";

    // The company is already known from onboarding - seed it onto the draft so
    // the builder never has to ask "what does your business do?".
    const profile = await prisma.businessProfile.findUnique({
      where: { tenantId },
      select: { organizationName: true, businessDescription: true },
    });
    const companyOverview = (profile?.businessDescription || "").trim();
    const orgName = (profile?.organizationName || "").trim();

    // Resume the tenant's most-recent INCOMPLETE wizard draft instead of
    // spawning a new orphan every time "New AI Employee" is opened. This is
    // what keeps abandoned sessions from polluting the account. `forceNew`
    // lets the caller explicitly start a second one.
    let agent = forceNew
      ? null
      : await prisma.aIAgent.findFirst({
          where: { tenantId, status: "DRAFT", builderStep: { not: null } },
          orderBy: { updatedAt: "desc" },
        });
    const resumed = !!agent;

    if (!agent) {
      agent = await prisma.aIAgent.create({
        data: {
          tenantId,
          name: "Untitled AI Employee",
          role: "customer_support",
          status: "DRAFT",
          builderStep: "chat",
          departmentId: departmentId || null,
          // Every system the workspace has today; one connected later stays off.
          integrationAccess: await defaultIntegrationAccess(tenantId),
          ...(companyOverview ? { identity: { companyOverview } } : {}),
        },
      });
    }

    // Goal-first (system-led) entry: the admin gave a one-line goal, so the
    // SYSTEM drafts the rest from the business twin + connected surface, and
    // the chat opens by presenting that draft instead of interviewing.
    // Never overwrite a goal an existing (resumed) draft already captured.
    let seeded: Awaited<ReturnType<typeof seedDraftFromGoal>> | null = null;
    if (goalText && !(agent as any).goal) {
      try {
        seeded = await seedDraftFromGoal(tenantId, agent.id, goalText);
      } catch (e: any) {
        console.warn("Builder goal-seed failed (falling back to interview):", e?.message);
      }
    }

    const draft = await loadDraftSnapshot(tenantId, agent.id);
    res.status(201).json({
      data: {
        agentId: agent.id,
        draft,
        resumed,
        greeting: seeded && draft
          ? buildSeededGreeting(lang, draft, seeded)
          : buildGreeting(lang, orgName),
      },
    });
  } catch (err: any) {
    console.error("Builder start error:", err);
    res.status(500).json({ error: "Failed to start builder" });
  }
});

// ─── Knowledge + tool options (checkbox cards in the builder UI) ─────
// Returns the tenant's available KBs + connected action tools with an
// `attached` flag for this draft, so the panel can render selectable cards
// instead of forcing the admin to dictate them over chat.
router.get("/:id/options", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agentId = req.params.id as string;
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "draft not found" }); return; }

    const [toolRows, kbs, grantedTools, linkedKbs, skills, agentSkills] = await Promise.all([
      prisma.tenantTool.findMany({
        where: { tenantId, isEnabled: true, tenantIntegration: { status: "CONNECTED" } },
        select: {
          id: true,
          catalogTool: { select: { name: true, riskLevel: true } },
          tenantIntegration: { select: { integration: { select: { name: true } } } },
        },
        take: 200,
      }),
      prisma.knowledgeBase.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true }, take: 200 }),
      prisma.agentToolPermission.findMany({ where: { tenantId, aiAgentId: agentId, isAllowed: true }, select: { tenantToolId: true } }),
      prisma.aIAgentKnowledge.findMany({ where: { aiAgentId: agentId }, select: { knowledgeBaseId: true } }),
      // The workspace's skills to pick from (B5); archived ones cannot be given.
      prisma.businessSkill.findMany({ where: { tenantId, status: { not: "archived" } }, select: { id: true, name: true, category: true, status: true }, orderBy: { name: "asc" }, take: 200 }),
      prisma.agentSkill.findMany({ where: { tenantId, aiAgentId: agentId }, select: { skillId: true, mode: true } }),
    ]);
    const skillMode = new Map(agentSkills.map((r: any) => [r.skillId, r.mode as string]));
    const attachedTools = new Set(grantedTools.map((r: any) => r.tenantToolId));
    const attachedKbs = new Set(linkedKbs.map((r: any) => r.knowledgeBaseId));

    res.json({
      data: {
        tools: toolRows.map((t: any) => ({
          tenantToolId: t.id,
          name: t.catalogTool.name,
          integration: t.tenantIntegration.integration.name,
          risk: t.catalogTool.riskLevel,
          attached: attachedTools.has(t.id),
        })),
        knowledgeBases: kbs.map((k: any) => ({ id: k.id, name: k.name, attached: attachedKbs.has(k.id) })),
        skills: skills.map((k: any) => ({ id: k.id, name: k.name, category: k.category, status: k.status, attached: skillMode.has(k.id), mode: skillMode.get(k.id) ?? null })),
      },
    });
  } catch (err: any) {
    console.error("Builder options error:", err);
    res.status(500).json({ error: "Failed to load options" });
  }
});

// POST /:id/tool - attach/detach one tool to the draft (checkbox toggle).
router.post("/:id/tool", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agentId = req.params.id as string;
    const { tenantToolId, toolName, attach } = req.body || {};
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "draft not found" }); return; }
    // By tenantToolId, or by the tool's name ("woocommerce.create_coupon"),
    // the key the employee's tools page lists. A name resolves to the tool of
    // the CONNECTED connection.
    let tt: { id: string } | null = null;
    if (typeof toolName === "string" && toolName.includes(".")) {
      const dot = toolName.indexOf(".");
      tt = await prisma.tenantTool.findFirst({
        where: {
          tenantId,
          catalogTool: { slug: toolName.slice(dot + 1) },
          tenantIntegration: { status: "CONNECTED", integration: { slug: toolName.slice(0, dot) } },
        },
        select: { id: true },
      });
      if (!tt) {
        res.status(404).json({
          error: `"${toolName}" is not set up in this workspace: give it a workspace level first, or connect its integration.`,
          code: "TOOL_NOT_PROVISIONED",
        });
        return;
      }
    } else {
      tt = await prisma.tenantTool.findFirst({ where: { id: String(tenantToolId), tenantId }, select: { id: true } });
      if (!tt) { res.status(404).json({ error: "tool not found" }); return; }
    }

    if (attach !== false) {
      const existing = await prisma.agentToolPermission.findFirst({ where: { tenantId, aiAgentId: agentId, tenantToolId: tt.id }, select: { id: true } });
      if (existing) await prisma.agentToolPermission.update({ where: { id: existing.id }, data: { isAllowed: true } });
      else await prisma.agentToolPermission.create({ data: { tenantId, aiAgentId: agentId, tenantToolId: tt.id, isAllowed: true } });
    } else {
      await prisma.agentToolPermission.deleteMany({ where: { tenantId, aiAgentId: agentId, tenantToolId: tt.id } });
    }
    res.json({ data: { draft: await loadDraftSnapshot(tenantId, agentId) } });
  } catch (err: any) {
    console.error("Builder toggle tool error:", err);
    res.status(500).json({ error: "Failed to toggle tool" });
  }
});

// POST /:id/tools/bulk - attach/detach many tools at once (Select all /
// per-category select-all in the wizard). Validates ids against the tenant,
// then flips them in two queries instead of one round-trip per tool.
router.post("/:id/tools/bulk", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agentId = req.params.id as string;
    const { tenantToolIds, attach } = req.body || {};
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "draft not found" }); return; }

    const requested = Array.isArray(tenantToolIds) ? tenantToolIds.map(String) : [];
    if (requested.length > 0) {
      // Only act on tools that genuinely belong to this tenant.
      const valid = await prisma.tenantTool.findMany({ where: { tenantId, id: { in: requested } }, select: { id: true } });
      const ids = valid.map((v) => v.id);
      if (ids.length > 0) {
        if (attach !== false) {
          await prisma.agentToolPermission.createMany({
            data: ids.map((id) => ({ tenantId, aiAgentId: agentId, tenantToolId: id, isAllowed: true })),
            skipDuplicates: true,
          });
          // Flip any rows that already existed but were disabled.
          await prisma.agentToolPermission.updateMany({
            where: { tenantId, aiAgentId: agentId, tenantToolId: { in: ids } },
            data: { isAllowed: true },
          });
        } else {
          await prisma.agentToolPermission.deleteMany({ where: { tenantId, aiAgentId: agentId, tenantToolId: { in: ids } } });
        }
      }
    }
    res.json({ data: { draft: await loadDraftSnapshot(tenantId, agentId) } });
  } catch (err: any) {
    console.error("Builder bulk tools error:", err);
    res.status(500).json({ error: "Failed to update tools" });
  }
});

// POST /:id/knowledge - attach/detach one knowledge base to the draft.
router.post("/:id/knowledge", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agentId = req.params.id as string;
    const { knowledgeBaseId, attach } = req.body || {};
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "draft not found" }); return; }
    const kb = await prisma.knowledgeBase.findFirst({ where: { id: String(knowledgeBaseId), tenantId }, select: { id: true } });
    if (!kb) { res.status(404).json({ error: "knowledge base not found" }); return; }

    if (attach !== false) {
      await prisma.aIAgentKnowledge.createMany({ data: [{ aiAgentId: agentId, knowledgeBaseId: kb.id }], skipDuplicates: true });
    } else {
      await prisma.aIAgentKnowledge.deleteMany({ where: { aiAgentId: agentId, knowledgeBaseId: kb.id } });
    }
    res.json({ data: { draft: await loadDraftSnapshot(tenantId, agentId) } });
  } catch (err: any) {
    console.error("Builder toggle knowledge error:", err);
    res.status(500).json({ error: "Failed to toggle knowledge" });
  }
});

// ─── Knowledge and skills picked in the hire (B5, 2026-10-14) ─────────────
// Step 3 picks from what the workspace has, or adds a new one, instead of an
// on/off switch per item. Knowledge is picked as a whole base. These sit in the
// builder (ADMIN, onboarding or active) because the workspace's own skill
// routes need an ACTIVE tenant and a hire also happens during onboarding.

// POST /:id/knowledge/new {name, description?, title?, content?}: a new base
// that this employee reads (scope "agent"; attaching it to another employee
// later shares it), with an optional first document. Same entitlement and
// capacity as creating a base in Knowledge Center.
router.post(
  "/:id/knowledge/new",
  requireEntitlement("ai.knowledge_base"),
  requireCapacity("limit:knowledge_sources", (tenantId) => prisma.knowledgeBase.count({ where: { tenantId } })),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantId! as string;
      const agentId = req.params.id as string;
      const b = req.body || {};
      const name = typeof b.name === "string" ? b.name.trim() : "";
      const title = typeof b.title === "string" ? b.title.trim() : "";
      const content = typeof b.content === "string" ? b.content.trim() : "";
      if (!name) { res.status(400).json({ error: "A name is required", code: "NAME_REQUIRED" }); return; }
      if (name.length > MAX_KB_NAME) { res.status(400).json({ error: "The name is too long", code: "NAME_TOO_LONG", max: MAX_KB_NAME }); return; }
      if (!!title !== !!content) { res.status(400).json({ error: "A first document needs both a title and content", code: "DOCUMENT_INCOMPLETE" }); return; }
      if (content.length > MAX_DOC_CONTENT) { res.status(400).json({ error: "The content is too long", code: "CONTENT_TOO_LONG", max: MAX_DOC_CONTENT }); return; }
      const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
      if (!agent) { res.status(404).json({ error: "draft not found" }); return; }

      const kb = await prisma.knowledgeBase.create({
        data: { tenantId, name, description: typeof b.description === "string" && b.description.trim() ? b.description.trim().slice(0, 500) : null, scope: "agent", scopeAgentId: agentId },
        select: { id: true, name: true },
      });
      await prisma.aIAgentKnowledge.createMany({ data: [{ aiAgentId: agentId, knowledgeBaseId: kb.id }], skipDuplicates: true });
      let documentId: string | null = null;
      if (title) {
        const doc = await prisma.knowledgeDocument.create({
          data: { knowledgeBaseId: kb.id, tenantId, title: title.slice(0, 200), content, sourceType: "text", status: "pending" },
          select: { id: true },
        });
        documentId = doc.id;
        // Embedded in the background, as Knowledge Center's own upload does.
        processDocument(doc.id).catch((err) => console.error(`[builder] knowledge/new ${doc.id} did not embed:`, err?.message));
      }
      res.status(201).json({ data: { knowledgeBase: kb, documentId, draft: await loadDraftSnapshot(tenantId, agentId) } });
    } catch (err: any) {
      console.error("Builder new knowledge error:", err);
      res.status(500).json({ error: "Failed to add knowledge" });
    }
  },
);

/** The employee's skills as setAgentSkills takes them, in their order. */
async function currentSkillItems(tenantId: string, agentId: string) {
  const rows = await prisma.agentSkill.findMany({ where: { tenantId, aiAgentId: agentId }, orderBy: { order: "asc" }, select: { skillId: true, mode: true, order: true } });
  return rows.map((r: any) => ({ skillId: r.skillId, mode: r.mode, order: r.order }));
}

function skillModeOf(v: unknown): string | null {
  return typeof v === "string" && (SKILL_MODES as readonly string[]).includes(v) ? v : null;
}

// POST /:id/skill {skillId, attach, mode?}: give one skill to the draft, or
// take it away. A new one goes last in "watch" unless a mode is given; a
// given one keeps its place. Removing it ends its open runs (setAgentSkills).
router.post("/:id/skill", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agentId = req.params.id as string;
    const { skillId, attach, mode } = req.body || {};
    if (typeof skillId !== "string" || !skillId) { res.status(400).json({ error: "skillId is required", code: "SKILL_REQUIRED" }); return; }
    if (mode !== undefined && !skillModeOf(mode)) { res.status(400).json({ error: `mode must be one of ${SKILL_MODES.join(", ")}`, code: "INVALID_MODE" }); return; }
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "draft not found" }); return; }
    const skill = await prisma.businessSkill.findFirst({ where: { id: skillId, tenantId, status: { not: "archived" } }, select: { id: true } });
    if (!skill) { res.status(404).json({ error: "skill not found", code: "SKILL_NOT_FOUND" }); return; }

    const items = await currentSkillItems(tenantId, agentId);
    const at = items.findIndex((i) => i.skillId === skill.id);
    if (attach === false) {
      if (at >= 0) items.splice(at, 1);
    } else if (at >= 0) {
      if (mode) items[at]!.mode = mode;
    } else {
      items.push({ skillId: skill.id, mode: skillModeOf(mode) ?? "watch", order: items.length ? Math.max(...items.map((i) => i.order)) + 1 : 0 });
    }
    await setAgentSkills(tenantId, agentId, items);
    res.json({ data: { draft: await loadDraftSnapshot(tenantId, agentId) } });
  } catch (err: any) {
    if (err instanceof SkillValidationError) { res.status(422).json({ error: err.message, field: err.field, code: "INVALID_SKILLS" }); return; }
    console.error("Builder toggle skill error:", err);
    res.status(500).json({ error: "Failed to toggle skill" });
  }
});

// POST /:id/skill/new {...the business-skills create body, mode?}: create a
// skill (validated exactly as POST /api/business-skills) and give it to the
// draft, last, in "watch" unless a mode is given.
router.post("/:id/skill/new", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agentId = req.params.id as string;
    const { mode, ...body } = req.body || {};
    if (mode !== undefined && !skillModeOf(mode)) { res.status(400).json({ error: `mode must be one of ${SKILL_MODES.join(", ")}`, code: "INVALID_MODE" }); return; }
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "draft not found" }); return; }
    const skill = await createSkill(tenantId, (req as any).user?.userId, body);
    const items = await currentSkillItems(tenantId, agentId);
    items.push({ skillId: skill.id, mode: skillModeOf(mode) ?? "watch", order: items.length ? Math.max(...items.map((i) => i.order)) + 1 : 0 });
    await setAgentSkills(tenantId, agentId, items);
    res.status(201).json({ data: { skill, draft: await loadDraftSnapshot(tenantId, agentId) } });
  } catch (err: any) {
    if (err instanceof SkillValidationError) { res.status(422).json({ error: err.message, field: err.field, code: "INVALID_SKILL" }); return; }
    console.error("Builder new skill error:", err);
    res.status(500).json({ error: "Failed to create the skill" });
  }
});

// POST /:id/refinements - save the optional creation-wizard refinements
// (display name, conversation flow, custom guardrails) DETERMINISTICALLY,
// from the dedicated wizard step - instead of relying on the conversational
// builder to volunteer them. Send only the fields you're changing; an empty
// array clears that field. Returns the refreshed draft snapshot.
router.post("/:id/refinements", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agentId = req.params.id as string;
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "draft not found" }); return; }

    const { name, conversationFlow, customGuardrails, brandArchetype } = req.body || {};
    const data: any = {};

    if (typeof name === "string" && name.trim()) {
      data.name = name.trim().slice(0, 120);
    }

    // Brand voice / personalization: an archetype that shapes HOW the employee
    // sounds. Stored on persona.brand_archetype, merged so we never wipe other
    // persona keys (gender/traits) - mirrors the editor's Brand Voice control.
    if (typeof brandArchetype === "string") {
      const cur = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { persona: true } });
      const persona: Record<string, unknown> =
        cur?.persona && typeof cur.persona === "object" ? { ...(cur.persona as any) } : {};
      const v = brandArchetype.trim().slice(0, 60);
      if (v) persona.brand_archetype = v;
      else delete persona.brand_archetype;
      data.persona = Object.keys(persona).length ? persona : null;
    }

    if (Array.isArray(conversationFlow)) {
      const flow = conversationFlow
        .filter((s: any) => s && typeof s.action === "string" && s.action.trim())
        .map((s: any, i: number) => ({
          id: typeof s.id === "string" && s.id ? s.id : `cf_${i}`,
          action: String(s.action).trim().slice(0, 280),
          details: String(s.details || "").trim().slice(0, 500),
        }));
      data.conversationFlow = flow.length ? flow : null;
    }

    // The employee's own rules (B4): the same list and limits as PUT
    // /api/ai-agents/:id/rules; over a limit is refused, never cut.
    if (customGuardrails === null) data.customGuardrails = Prisma.DbNull;
    else if (customGuardrails !== undefined) {
      try {
        const rules = normalizeGuardrails(customGuardrails);
        data.customGuardrails = rules.length ? rules : Prisma.DbNull;
      } catch (e) {
        if (e instanceof GuardrailsError) {
          res.status(400).json({ error: e.message, code: e.code, field: "customGuardrails", reason: e.reason, ...(e.max !== undefined ? { max: e.max } : {}), ...(e.index !== undefined ? { index: e.index } : {}) });
          return;
        }
        throw e;
      }
    }

    if (Object.keys(data).length > 0) {
      await prisma.aIAgent.update({ where: { id: agentId }, data });
    }

    res.json({ data: { draft: await loadDraftSnapshot(tenantId, agentId) } });
  } catch (err: any) {
    console.error("Builder refinements error:", err);
    res.status(500).json({ error: "Failed to save refinements" });
  }
});

// ─── Persist wizard progress (resumable creation) ───────────
// The frontend posts the current step on every transition so an abandoned
// session can be resumed from exactly where the admin stopped. Only moves
// the pointer while the agent is still a DRAFT - never resurrects a
// completed/active agent back into the wizard.
const BUILDER_STEPS = new Set(["chat", "kb", "refine", "tools"]);
router.post("/:id/step", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agentId = req.params.id as string;
    const step = String(req.body?.step || "");
    if (!BUILDER_STEPS.has(step)) {
      res.status(400).json({ error: "invalid step" });
      return;
    }
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true, status: true } });
    if (!agent) { res.status(404).json({ error: "draft not found" }); return; }
    if (agent.status === "DRAFT") {
      await prisma.aIAgent.update({ where: { id: agentId }, data: { builderStep: step } });
    }
    res.json({ data: { ok: true, step } });
  } catch (err: any) {
    console.error("Builder step error:", err);
    res.status(500).json({ error: "Failed to save step" });
  }
});

// ─── Complete the creation wizard ───────────────────────────
// Called when the wizard hands the admin off to the editor (readiness panel
// "Save live" / "Skip to editor"). Clears the resumable progress pointer so
// the editor renders instead of re-entering the builder, and promotes the
// finished employee DRAFT → ACTIVE. PAUSED/ACTIVE agents keep their status
// (only the step pointer is cleared) so this can't reactivate a paused agent.
router.post("/:id/complete", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agentId = req.params.id as string;
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true, status: true, salesContext: true } });
    if (!agent) { res.status(404).json({ error: "draft not found" }); return; }

    // Server-side readiness gate: promotion to ACTIVE is only legal when the
    // draft actually satisfies the same rules the wizard shows (name, role,
    // goal-or-funnel, >=1 knowledge base). The frontend gates this too, but
    // any API client could otherwise activate an empty employee.
    if (agent.status === "DRAFT") {
      const snapshot = await loadDraftSnapshot(tenantId, agentId);
      const readiness = snapshot ? draftReadiness(snapshot) : { ready: false, missing: ["draft"] };
      if (!readiness.ready) {
        res.status(422).json({ error: "draft_not_ready", missing: readiness.missing });
        return;
      }
    }

    // Auto-fill the Sales Context (Product Qualification Context) the first time
    // an employee finishes the wizard, so the admin lands in the editor with the
    // six fields pre-proposed (still fully editable) instead of blank. Only when
    // the admin hasn't authored one already. Best-effort - never blocks the
    // promotion. See sales-context-generator.service.ts.
    let salesContext: unknown = undefined;
    const hasSalesContext =
      agent.salesContext && typeof agent.salesContext === "object" && Object.keys(agent.salesContext as object).length > 0;
    if (!hasSalesContext) {
      const generated = await generateSalesContext(tenantId, agentId);
      if (generated) salesContext = generated;
    }

    await prisma.aIAgent.update({
      where: { id: agentId },
      data: {
        builderStep: null,
        ...(agent.status === "DRAFT" ? { status: "ACTIVE" as const } : {}),
        ...(salesContext !== undefined ? { salesContext: salesContext as any } : {}),
      },
    });
    // A hire (DRAFT -> ACTIVE) runs the readiness report in the background
    // (A6, Omer 2026-10-13): one LLM call, stored on the employee; the manual
    // route re-runs it. Never blocks or fails the hire.
    const hired = agent.status === "DRAFT";
    if (hired) {
      // "running" is written BEFORE the answer, so the page's first read of
      // the employee already shows the check in progress.
      const runId = await markReadinessRunning(tenantId, agentId);
      void resolveLocale(tenantId, req.body?.locale)
        .then((locale) => runAndStoreReadiness(tenantId, agentId, locale, runId))
        .then((r) => { if ("error" in r) console.warn(`[readiness] after hire ${agentId}: ${r.error}`); })
        .catch((err: any) => console.warn(`[readiness] after hire ${agentId} failed:`, err?.message));
    }
    res.json({ data: { ok: true, salesContextAutofilled: salesContext !== undefined, readinessQueued: hired } });
  } catch (err: any) {
    console.error("Builder complete error:", err);
    res.status(500).json({ error: "Failed to complete builder" });
  }
});

// ─── Current draft (reconnect / review fetch) ───────────────
router.get("/:id/draft", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const draft = await loadDraftSnapshot(tenantId, req.params.id as string);
    if (!draft) {
      res.status(404).json({ error: "draft not found" });
      return;
    }
    res.json({ data: { draft, ...draftReadiness(draft) } });
  } catch (err: any) {
    console.error("Builder draft error:", err);
    res.status(500).json({ error: "Failed to load draft" });
  }
});

// ─── Validate + readiness for the review step ───────────────
router.post("/:id/finalize", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const draft = await loadDraftSnapshot(tenantId, req.params.id as string);
    if (!draft) {
      res.status(404).json({ error: "draft not found" });
      return;
    }
    res.json({ data: { draft, ...draftReadiness(draft) } });
  } catch (err: any) {
    console.error("Builder finalize error:", err);
    res.status(500).json({ error: "Failed to finalize draft" });
  }
});

// ─── Readiness Test ─────────────────────────────────────────
/**
 * Generate the readiness report and store it on the employee
 * (AIAgent.readinessReport), so it can be re-viewed without re-running.
 * Persisting is best-effort: a failure never blocks returning the report.
 * Shared by the manual route and the automatic run after a hire.
 */
export async function runAndStoreReadiness(tenantId: string, agentId: string, locale: string, runId?: string, opts: { regenerateQuestions?: boolean } = {}) {
  // The run's status (running / done / failed) is stored beside the report,
  // so the page shows the truth instead of guessing how long a check takes.
  const run = runId ?? (await markReadinessRunning(tenantId, agentId));
  let report: Awaited<ReturnType<typeof generateReadinessReport>>;
  try {
    report = await generateReadinessReport(tenantId, agentId, locale, opts);
  } catch (err) {
    await markReadinessFinished(tenantId, agentId, run, { ok: false, error: "internal_error" });
    throw err;
  }
  if ("error" in report) {
    await markReadinessFinished(tenantId, agentId, run, { ok: false, error: String(report.error) });
    return report;
  }
  try {
    await prisma.aIAgent.update({ where: { id: agentId }, data: { readinessReport: report as any } });
  } catch (persistErr: any) {
    console.warn("[readiness-test] persist failed (non-fatal):", persistErr?.message);
    // The report was made but not kept: the page has nothing new to show.
    await markReadinessFinished(tenantId, agentId, run, { ok: false, error: "persist_failed" });
    return report;
  }
  await markReadinessFinished(tenantId, agentId, run, { ok: true });
  return report;
}

// Generates the realistic customer questions this employee will face, scores
// how well it's covered (knowledge + tools), and lists concrete gap fixes.
router.post("/:id/readiness-test", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agentId = req.params.id as string;
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "draft not found" }); return; }

    const locale = await resolveLocale(tenantId, req.body?.locale);
    // regenerateQuestions: a fresh question set; otherwise the stored one is
    // judged again, and an unchanged input returns the same report (B6).
    const report = await runAndStoreReadiness(tenantId, agentId, locale, undefined, { regenerateQuestions: req.body?.regenerateQuestions === true });
    if ("error" in report) {
      res.status(report.error === "agent_not_found" ? 404 : 502).json({ error: report.error });
      return;
    }
    res.json({ data: report });
  } catch (err: any) {
    console.error("Builder readiness-test error:", err);
    res.status(500).json({ error: "Failed to run readiness test" });
  }
});

// ─── Run a turn (SSE) ───────────────────────────────────────
router.post("/run", async (req: Request, res: Response) => {
  const tenantId = req.tenantId! as string;
  const userId = ((req as any).user?.userId ?? (req as any).user?.id) as string | undefined;
  if (!userId) {
    res.status(401).json({ error: "no user context" });
    return;
  }

  const { agentId, message, locale } = req.body ?? {};
  if (typeof agentId !== "string" || !agentId) {
    res.status(400).json({ error: "agentId (string) is required" });
    return;
  }
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message (non-empty string) is required" });
    return;
  }

  // Tenant-scope guard: the draft must belong to this tenant.
  const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
  if (!agent) {
    res.status(404).json({ error: "draft not found" });
    return;
  }

  // SSE headers (same setup as /api/agent/run).
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  req.on("close", () => { closed = true; });

  const send = (ev: BuilderEvent) => {
    if (closed) return;
    res.write(`event: ${ev.type}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write(": ping\n\n");
  }, 25_000);

  try {
    await runBuilder(
      {
        tenantId,
        userId,
        agentId,
        // Cap input length - defends the LLM context budget from pasted walls
        // of text. 4000 chars is ample for an answer in the interview.
        message: message.trim().slice(0, 4000),
        locale: await resolveLocale(tenantId, locale),
        authToken: (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || undefined,
      },
      send,
    );
  } catch (err: any) {
    send({ type: "error", message: err?.message || "builder run failed" });
  } finally {
    clearInterval(heartbeat);
    if (!closed) {
      res.write("event: close\ndata: {}\n\n");
      res.end();
    }
  }
});

export default router;
