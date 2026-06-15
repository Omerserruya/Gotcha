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
    const { departmentId, locale } = req.body || {};
    const lang = await resolveLocale(tenantId, locale);

    // The company is already known from onboarding - seed it onto the draft so
    // the builder never has to ask "what does your business do?".
    const profile = await prisma.businessProfile.findUnique({
      where: { tenantId },
      select: { organizationName: true, businessDescription: true },
    });
    const companyOverview = (profile?.businessDescription || "").trim();
    const orgName = (profile?.organizationName || "").trim();

    const agent = await prisma.aIAgent.create({
      data: {
        tenantId,
        name: "Untitled AI Employee",
        role: "customer_support",
        status: "DRAFT",
        departmentId: departmentId || null,
        ...(companyOverview ? { identity: { companyOverview } } : {}),
      },
    });

    const draft = await loadDraftSnapshot(tenantId, agent.id);
    res.status(201).json({
      data: {
        agentId: agent.id,
        draft,
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

    const { name, conversationFlow, customGuardrails } = req.body || {};
    const data: any = {};

    if (typeof name === "string" && name.trim()) {
      data.name = name.trim().slice(0, 120);
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
