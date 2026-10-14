/**
 * AI Employee Readiness Test.
 *
 * After the builder wizard, we run a "will this employee actually cope?" audit:
 * generate the realistic customer questions this employee will face (from the
 * business, its role/goal, its attached knowledge, and its granted tools),
 * then judge how well it's covered and where the gaps are.
 *
 * One JSON-mode LLM call (lives in services/ai - the only service allowed to
 * make new LLM calls). The score is computed deterministically from the
 * per-question coverage so it can't drift with the model's mood.
 */

import { prisma, clusterKeyFor } from "@chatcenter/shared";
import { generateResponse } from "./ai.service";
import { readableKnowledgeBaseIds } from "./knowledge.service";
import { readAnsweredQuestions } from "./readiness-answers";
import { withoutWideDashes } from "../lib/wide-dash";

export type Coverage = "full" | "partial" | "none";

export interface ReadinessQuestion {
  question: string;
  coverage: Coverage;
  reason: string;
  /** What's missing for the uncovered/partly-covered ones. */
  gapType: "knowledge" | "tool" | "data" | "none";
  /** True for a question a person answered from an earlier report (B2): covered by that answer. */
  answered?: boolean;
}

export interface ReadinessRecommendation {
  /** Drives the action button the UI renders. */
  type: "add_knowledge" | "connect_tool" | "add_business_data" | "add_faq" | "create_workflow" | "other";
  title: string;
  detail: string;
}

export interface ReadinessReport {
  score: number; // 0-100
  totals: { full: number; partial: number; none: number; total: number };
  questions: ReadinessQuestion[];
  recommendations: ReadinessRecommendation[];
  generatedAt: string;
}

const LANG_NAMES: Record<string, string> = { en: "English", he: "Hebrew (עברית)", ar: "Arabic (العربية)" };

const MAX_KB_DOCS = 40;
const MAX_TOOLS = 60;

interface ReadinessContext {
  agentName: string;
  role: string;
  goal: string;
  successCriteria: string;
  companyOverview: string;
  organizationName: string;
  industry: string;
  businessDescription: string;
  knowledgeDocs: Array<{ kb: string; title: string; snippet: string }>;
  tools: Array<{ name: string; integration: string; description: string }>;
  knowledgeCount: number;
  /** Questions a person answered from an earlier report: counted as covered, never asked again. */
  answered: string[];
}

async function loadContext(tenantId: string, agentId: string): Promise<ReadinessContext | null> {
  const agent = await prisma.aIAgent.findFirst({
    where: { id: agentId, tenantId },
    select: { id: true, name: true, role: true, goal: true, successCriteria: true, identity: true },
  });
  if (!agent) return null;

  const [profile, readableKbIds, toolRows] = await Promise.all([
    prisma.businessProfile.findUnique({
      where: { tenantId },
      select: { organizationName: true, industry: true, businessDescription: true },
    }),
    // The bases the employee can actually retrieve from at runtime: attached,
    // tenant-wide, its department's and its own (B2). Only the attached ones
    // were read here, so company-wide knowledge (and every answer an owner
    // gave to a question) never counted.
    readableKnowledgeBaseIds(tenantId, agentId),
    // Only tools that can run: a CONNECTED connection and an enabled tool.
    // Grants on a disconnected store stay on the employee but do nothing, and
    // counting them scored Maya 67 on returns and exchanges she could not do
    // (68 dead Shopify grants; the employee hired after her scored 34).
    // Ordered by name so the MAX_TOOLS cap keeps the same tools every run.
    prisma.agentToolPermission.findMany({
      where: {
        tenantId,
        aiAgentId: agentId,
        isAllowed: true,
        tenantTool: { isEnabled: true, tenantIntegration: { status: "CONNECTED" } },
      },
      orderBy: [{ tenantTool: { catalogTool: { name: "asc" } } }, { id: "asc" }],
      select: {
        tenantTool: {
          select: {
            catalogTool: { select: { name: true, description: true } },
            tenantIntegration: { select: { integration: { select: { name: true } } } },
          },
        },
      },
      take: MAX_TOOLS,
    }),
  ]);

  const kbIds: string[] = readableKbIds;
  const [kbRows, answered] = await Promise.all([
    kbIds.length ? prisma.knowledgeBase.findMany({ where: { tenantId, id: { in: kbIds } }, select: { id: true, name: true } }) : Promise.resolve([] as Array<{ id: string; name: string }>),
    readAnsweredQuestions(tenantId, agentId),
  ]);
  const kbNameById = new Map<string, string>(kbRows.map((k: any) => [k.id, k.name]));

  let knowledgeDocs: ReadinessContext["knowledgeDocs"] = [];
  if (kbIds.length) {
    const docs = await prisma.knowledgeDocument.findMany({
      where: { tenantId, knowledgeBaseId: { in: kbIds } },
      select: { knowledgeBaseId: true, title: true, content: true },
      take: MAX_KB_DOCS,
      orderBy: { createdAt: "desc" },
    });
    knowledgeDocs = docs.map((d: any) => ({
      kb: kbNameById.get(d.knowledgeBaseId) || "Knowledge",
      title: d.title,
      snippet: (d.content || "").replace(/\s+/g, " ").slice(0, 200),
    }));
  }

  const identity = (agent.identity as any) || {};
  return {
    agentName: agent.name,
    role: agent.role,
    goal: agent.goal || "",
    successCriteria: agent.successCriteria || "",
    companyOverview: typeof identity.companyOverview === "string" ? identity.companyOverview : "",
    organizationName: profile?.organizationName || "",
    industry: profile?.industry || "",
    businessDescription: profile?.businessDescription || "",
    knowledgeDocs,
    tools: toolRows.map((t: any) => ({
      name: t.tenantTool.catalogTool.name,
      integration: t.tenantTool.tenantIntegration.integration.name,
      description: t.tenantTool.catalogTool.description || "",
    })),
    knowledgeCount: kbIds.length,
    answered: answered.map((a) => a.question),
  };
}

function buildPrompt(ctx: ReadinessContext, locale: string): string {
  const lang = LANG_NAMES[locale] || "English";
  const kbBlock = ctx.knowledgeDocs.length
    ? ctx.knowledgeDocs.map((d) => `- [${d.kb}] ${d.title}: ${d.snippet}`).join("\n")
    : "(no knowledge documents attached)";
  const toolBlock = ctx.tools.length
    ? ctx.tools.map((t) => `- ${t.name} (${t.integration})${t.description ? `: ${t.description}` : ""}`).join("\n")
    : "(no action tools granted)";
  // Already answered by a person and counted as covered (B2): asking them again
  // would only count them twice.
  const answeredBlock = ctx.answered.length
    ? `\n## Questions the business already answered (do NOT include these or near-duplicates)\n${ctx.answered.map((q) => `- ${q}`).join("\n")}\n`
    : "";

  return `## Business
Organization: ${ctx.organizationName || "unknown"}
Industry: ${ctx.industry || "unknown"}
What they do: ${ctx.businessDescription || ctx.companyOverview || "unknown"}

## AI Employee
Name: ${ctx.agentName}
Role: ${ctx.role}
Goal: ${ctx.goal || "(not set)"}
Success criteria: ${ctx.successCriteria || "(not set)"}

## Knowledge base documents available to it
${kbBlock}

## Action tools available to it
${toolBlock}
${answeredBlock}
## Your task
Generate 28-36 realistic questions a real customer would ask THIS employee, given the business, industry and the employee's role. Cover the full spread: high-frequency everyday questions, edge cases, awkward/angry customers, pricing, logistics, policy, and post-sale - not just easy ones. Do not pad with near-duplicates; each question must be meaningfully distinct.

For EACH question decide:
- coverage: "full" (answerable now from the knowledge above and/or an available tool), "partial" (only some of it is covered, or it needs data we don't clearly have), or "none" (cannot be handled).
- gapType: if not full, the single biggest missing thing - "knowledge" (missing info/policy/FAQ), "tool" (needs an action/integration we don't have, e.g. order lookup, shipping, refund), or "data" (needs structured business data, e.g. price list, size/measurement table, product catalog). Use "none" only when coverage is "full".
- reason: one short sentence in ${lang}.

Then produce "recommendations": concrete, deduplicated fixes for the gaps you found. Each has a "type" from: "add_knowledge", "connect_tool", "add_business_data", "add_faq", "create_workflow", "other". Examples: add shipping provider integration, upload return policy, add size/measurement table, add product catalog, connect Shopify orders, add FAQ content, create refund workflow. title + detail in ${lang}.

Respond ONLY with JSON of exactly this shape:
{"questions":[{"question":"...","coverage":"full|partial|none","gapType":"knowledge|tool|data|none","reason":"..."}],"recommendations":[{"type":"...","title":"...","detail":"..."}]}
Write all customer-facing text (questions, reasons, titles, details) in ${lang}.`;
}

function computeScore(questions: ReadinessQuestion[]): { score: number; totals: ReadinessReport["totals"] } {
  const totals = { full: 0, partial: 0, none: 0, total: questions.length };
  for (const q of questions) {
    if (q.coverage === "full") totals.full++;
    else if (q.coverage === "partial") totals.partial++;
    else totals.none++;
  }
  const score = totals.total === 0 ? 0 : Math.round((100 * (totals.full + totals.partial * 0.5)) / totals.total);
  return { score, totals };
}

const ANSWERED_REASON: Record<string, string> = {
  en: "Answered by the team; the answer is in the knowledge.",
  he: "הצוות ענה על השאלה, והתשובה נמצאת בידע.",
};

const VALID_COVERAGE = new Set<Coverage>(["full", "partial", "none"]);
const VALID_GAP = new Set(["knowledge", "tool", "data", "none"]);
const VALID_REC = new Set(["add_knowledge", "connect_tool", "add_business_data", "add_faq", "create_workflow", "other"]);

export async function generateReadinessReport(
  tenantId: string,
  agentId: string,
  locale = "en",
): Promise<ReadinessReport | { error: string }> {
  const ctx = await loadContext(tenantId, agentId);
  if (!ctx) return { error: "agent_not_found" };

  let raw: string;
  try {
    const res = await generateResponse({
      tenantId,
      messages: [
        { role: "system", content: "You are a meticulous QA auditor for AI customer-service employees. You output only valid JSON." },
        { role: "user", content: buildPrompt(ctx, locale) },
      ],
      temperature: 0.5,
      maxTokens: 4500,
      responseFormat: { type: "json_object" },
      metadata: { type: "agent_readiness", aiAgentId: agentId },
    } as any);
    raw = (res as any)?.content || "";
  } catch (err: any) {
    console.error("[readiness] LLM call failed:", err?.message);
    return { error: "llm_unavailable" };
  }

  let parsed: any;
  try {
    parsed = withoutWideDashes(JSON.parse(raw));
  } catch {
    return { error: "bad_model_output" };
  }

  const answeredKeys = new Set(ctx.answered.map((q) => clusterKeyFor(q)));
  const questions: ReadinessQuestion[] = (Array.isArray(parsed.questions) ? parsed.questions : [])
    .map((q: any) => {
      const coverage: Coverage = VALID_COVERAGE.has(q?.coverage) ? q.coverage : "none";
      const gapType = VALID_GAP.has(q?.gapType) ? q.gapType : (coverage === "full" ? "none" : "knowledge");
      return {
        question: String(q?.question || "").slice(0, 400),
        coverage,
        gapType: gapType as ReadinessQuestion["gapType"],
        reason: String(q?.reason || "").slice(0, 400),
      };
    })
    .filter((q: ReadinessQuestion) => q.question)
    // One the model asked again anyway is the answered one, not a new gap.
    .filter((q: ReadinessQuestion) => !answeredKeys.has(clusterKeyFor(q.question)));
  // Each answered question is covered: its answer is knowledge the employee
  // retrieves. Counted once, as the person asked it.
  for (const question of ctx.answered) {
    questions.push({ question, coverage: "full", gapType: "none", reason: ANSWERED_REASON[locale] ?? ANSWERED_REASON.en!, answered: true });
  }

  const recommendations: ReadinessRecommendation[] = (Array.isArray(parsed.recommendations) ? parsed.recommendations : [])
    .map((r: any) => ({
      type: (VALID_REC.has(r?.type) ? r.type : "other") as ReadinessRecommendation["type"],
      title: String(r?.title || "").slice(0, 200),
      detail: String(r?.detail || "").slice(0, 500),
    }))
    .filter((r: ReadinessRecommendation) => r.title);

  const { score, totals } = computeScore(questions);
  return { score, totals, questions, recommendations, generatedAt: new Date().toISOString() };
}
