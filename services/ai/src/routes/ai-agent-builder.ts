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
import { authenticate, resolveTenant, requireActiveTenant, requireRole, prisma } from "@chatcenter/shared";
import {
  runBuilder,
  loadDraftSnapshot,
  draftReadiness,
  type BuilderEvent,
} from "../services/agent-builder.service";
import { generateReadinessReport } from "../services/agent-readiness.service";
import { generateSalesContext } from "../services/sales-context-generator.service";

const router = Router();

router.use(authenticate, resolveTenant, requireActiveTenant(), requireRole("ADMIN"));

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
    const { departmentId, locale, forceNew } = req.body || {};
    const lang = await resolveLocale(tenantId, locale);

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
          ...(companyOverview ? { identity: { companyOverview } } : {}),
        },
      });
    }

    const draft = await loadDraftSnapshot(tenantId, agent.id);
    res.status(201).json({
      data: {
        agentId: agent.id,
        draft,
        resumed,
        greeting: buildGreeting(lang, orgName),
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

    const [toolRows, kbs, grantedTools, linkedKbs] = await Promise.all([
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
    ]);
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
    const { tenantToolId, attach } = req.body || {};
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "draft not found" }); return; }
    const tt = await prisma.tenantTool.findFirst({ where: { id: String(tenantToolId), tenantId }, select: { id: true } });
    if (!tt) { res.status(404).json({ error: "tool not found" }); return; }

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

    if (Array.isArray(customGuardrails)) {
      const rules = customGuardrails
        .map((r: any) => String(r || "").trim())
        .filter(Boolean)
        .map((r: string) => r.slice(0, 280));
      data.customGuardrails = rules.length ? rules : null;
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
    // the admin hasn't authored one already. Best-effort — never blocks the
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
    res.json({ data: { ok: true, salesContextAutofilled: salesContext !== undefined } });
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
// Generates the realistic customer questions this employee will face, scores
// how well it's covered (knowledge + tools), and lists concrete gap fixes.
router.post("/:id/readiness-test", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId! as string;
    const agentId = req.params.id as string;
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, tenantId }, select: { id: true } });
    if (!agent) { res.status(404).json({ error: "draft not found" }); return; }

    const locale = await resolveLocale(tenantId, req.body?.locale);
    const report = await generateReadinessReport(tenantId, agentId, locale);
    if ("error" in report) {
      res.status(report.error === "agent_not_found" ? 404 : 502).json({ error: report.error });
      return;
    }
    // Persist so the owner can re-view without re-running the generator (P1-5).
    // Best-effort: a persistence failure never blocks returning the report.
    try {
      await prisma.aIAgent.update({
        where: { id: agentId },
        data: { readinessReport: report as any },
      });
    } catch (persistErr: any) {
      console.warn("[readiness-test] persist failed (non-fatal):", persistErr?.message);
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
