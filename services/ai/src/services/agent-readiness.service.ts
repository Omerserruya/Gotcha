/**
 * AI Employee Readiness Test.
 *
 * After the builder wizard, we run a "will this employee actually cope?" audit:
 * the realistic customer questions this employee will face (from the business
 * and its role/goal), judged against what it can actually use (its knowledge
 * and its runnable tools), with the gaps and how to close them.
 *
 * Lives in services/ai - the only service allowed to make new LLM calls. The
 * score is computed deterministically from the per-question coverage.
 *
 * STABLE BY DESIGN (B6, 2026-10-14). One call at temperature 0.5 used to both
 * invent the questions and judge them, so Maya scored 34 then 45 with nothing
 * changed. Now:
 *  - The QUESTION SET is made once and stored (TenantSetting
 *    "agent:readiness-questions:<id>"), each question with a stable id. It is
 *    remade only when what a CUSTOMER would ask changes: role, goal, success
 *    criteria, the business, the language (questionFingerprint), or on request
 *    (regenerateQuestions). Knowledge and tools are NOT in it on purpose: the
 *    point is to re-judge the same questions after knowledge is added.
 *  - Each run JUDGES that fixed set, in batches of JUDGE_BATCH at medium
 *    reasoning. NOT at "temperature 0": the gpt-5 models this runs on accept
 *    only the default temperature, and ai.service drops any other value, so
 *    temperature buys nothing here. The cache below is what makes it stable.
 *  - A verdict counts only with EVIDENCE the code can check (B6b): the judge
 *    names the documents and tools it relied on, the code keeps only names that
 *    were in its input, and a "full" or "partial" with none left becomes
 *    "none". gpt-5-mini at low effort over 32 questions at once called all 32
 *    "partial" and said order changes had no tool while Update Order Status
 *    was in its list.
 *  - The judgement is keyed by everything it depends on (inputFingerprint:
 *    the question set, the readable knowledge, the runnable tools, the
 *    answered questions). When that is unchanged the stored report is returned
 *    as it is, with no model call (unchanged: true): nothing changed, same score.
 *  - A question a person answered (readiness-answers) is covered by that
 *    answer: it joins the set if it is not in it, and is marked full without
 *    asking the judge.
 * No migration: two TenantSetting keys; the report stays in AIAgent.readinessReport.
 */

import crypto from "crypto";
import { prisma, clusterKeyFor, readDurableSetting, writeDurableSetting } from "@chatcenter/shared";
import { generateResponse } from "./ai.service";
import { readableKnowledgeBaseIds } from "./knowledge.service";
import { readAnsweredQuestions } from "./readiness-answers";
import { withoutWideDashes } from "../lib/wide-dash";

export type Coverage = "full" | "partial" | "none";

export interface ReadinessQuestion {
  /** Stable across runs: a hash of the question's cluster key. */
  id: string;
  question: string;
  coverage: Coverage;
  reason: string;
  /** What's missing for the uncovered/partly-covered ones. */
  gapType: "knowledge" | "tool" | "data" | "none";
  /** True for a question a person answered (B2): covered by that answer. */
  answered?: boolean;
  /** The documents and tools the verdict rests on, each checked to exist in the input. */
  evidence?: Array<{ kind: "doc" | "tool"; name: string }>;
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
  /** When the question set being judged was made. */
  questionSetGeneratedAt?: string;
  /** Everything the judgement depends on; equal means nothing changed. */
  inputFingerprint?: string;
  /** True when this run found nothing changed and returned the stored report. */
  unchanged?: boolean;
}

export interface StoredQuestionSet {
  fingerprint: string;
  locale: string;
  generatedAt: string;
  questions: Array<{ id: string; question: string }>;
}

const LANG_NAMES: Record<string, string> = { en: "English", he: "Hebrew (עברית)", ar: "Arabic (العربية)" };

const MAX_KB_DOCS = 40;
const MAX_TOOLS = 60;
/** Bumped when the judging prompt changes, so old judgements are not reused. */
const JUDGE_VERSION = "2";
/** Questions per judge call: 32 at once came back all "partial". */
export const JUDGE_BATCH = 8;

export function questionSetKey(aiAgentId: string): string {
  return `agent:readiness-questions:${aiAgentId}`;
}

/** A question's stable id: the same question (by cluster key) always has the same id. */
export function questionIdFor(question: string): string {
  return "q_" + crypto.createHash("sha256").update(clusterKeyFor(question)).digest("hex").slice(0, 12);
}

function hashOf(v: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);
}

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
  /** Every readable document by id and last change: what the knowledge part of the fingerprint is. */
  knowledgeVersion: Array<[string, string]>;
  tools: Array<{ name: string; integration: string; description: string }>;
  knowledgeCount: number;
  /** Questions a person answered: always covered. */
  answered: string[];
  previousReport: ReadinessReport | null;
}

async function loadContext(tenantId: string, agentId: string): Promise<ReadinessContext | null> {
  const agent = await prisma.aIAgent.findFirst({
    where: { id: agentId, tenantId },
    select: { id: true, name: true, role: true, goal: true, successCriteria: true, identity: true, readinessReport: true },
  });
  if (!agent) return null;

  const [profile, readableKbIds, toolRows] = await Promise.all([
    prisma.businessProfile.findUnique({
      where: { tenantId },
      select: { organizationName: true, industry: true, businessDescription: true },
    }),
    // The bases the employee can actually retrieve from at runtime: attached,
    // tenant-wide, its department's and its own (B2).
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
  const [kbRows, answered, versions] = await Promise.all([
    kbIds.length ? prisma.knowledgeBase.findMany({ where: { tenantId, id: { in: kbIds } }, select: { id: true, name: true } }) : Promise.resolve([] as Array<{ id: string; name: string }>),
    readAnsweredQuestions(tenantId, agentId),
    kbIds.length
      ? prisma.knowledgeDocument.findMany({ where: { tenantId, knowledgeBaseId: { in: kbIds } }, select: { id: true, updatedAt: true }, orderBy: { id: "asc" } })
      : Promise.resolve([] as Array<{ id: string; updatedAt: Date }>),
  ]);
  const kbNameById = new Map<string, string>(kbRows.map((k: any) => [k.id, k.name]));

  let knowledgeDocs: ReadinessContext["knowledgeDocs"] = [];
  if (kbIds.length) {
    const docs = await prisma.knowledgeDocument.findMany({
      where: { tenantId, knowledgeBaseId: { in: kbIds } },
      select: { knowledgeBaseId: true, title: true, content: true },
      take: MAX_KB_DOCS,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    knowledgeDocs = docs.map((d: any) => ({
      kb: kbNameById.get(d.knowledgeBaseId) || "Knowledge",
      title: d.title,
      snippet: (d.content || "").replace(/\s+/g, " ").slice(0, 200),
    }));
  }

  const identity = (agent.identity as any) || {};
  const prev = agent.readinessReport as any;
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
    knowledgeVersion: versions.map((v: any) => [v.id, new Date(v.updatedAt).toISOString()] as [string, string]),
    tools: toolRows.map((t: any) => ({
      name: t.tenantTool.catalogTool.name,
      integration: t.tenantTool.tenantIntegration.integration.name,
      description: t.tenantTool.catalogTool.description || "",
    })),
    knowledgeCount: kbIds.length,
    answered: answered.map((a) => a.question),
    previousReport: prev && typeof prev === "object" && Array.isArray(prev.questions) ? (prev as ReadinessReport) : null,
  };
}

/** What a customer would ask depends on these, and only these. */
function questionFingerprint(ctx: ReadinessContext, locale: string): string {
  return hashOf({
    role: ctx.role,
    goal: ctx.goal,
    successCriteria: ctx.successCriteria,
    organizationName: ctx.organizationName,
    industry: ctx.industry,
    business: ctx.businessDescription || ctx.companyOverview,
    locale,
  });
}

function businessBlock(ctx: ReadinessContext): string {
  return `## Business
Organization: ${ctx.organizationName || "unknown"}
Industry: ${ctx.industry || "unknown"}
What they do: ${ctx.businessDescription || ctx.companyOverview || "unknown"}

## AI Employee
Name: ${ctx.agentName}
Role: ${ctx.role}
Goal: ${ctx.goal || "(not set)"}
Success criteria: ${ctx.successCriteria || "(not set)"}`;
}

function buildQuestionsPrompt(ctx: ReadinessContext, locale: string): string {
  const lang = LANG_NAMES[locale] || "English";
  const answeredBlock = ctx.answered.length
    ? `\n## Questions the business already answered (do NOT include these or near-duplicates)\n${ctx.answered.map((q) => `- ${q}`).join("\n")}\n`
    : "";
  return `${businessBlock(ctx)}
${answeredBlock}
## Your task
Generate 28-36 realistic questions a real customer would ask THIS employee, given the business, industry and the employee's role. Cover the full spread: high-frequency everyday questions, edge cases, awkward/angry customers, pricing, logistics, policy, and post-sale - not just easy ones. Do not pad with near-duplicates; each question must be meaningfully distinct. Do not judge whether the employee can answer them.

Respond ONLY with JSON of exactly this shape:
{"questions":["...","..."]}
Write the questions in ${lang}.`;
}

function buildJudgePrompt(ctx: ReadinessContext, questions: Array<{ id: string; question: string }>, locale: string): string {
  const lang = LANG_NAMES[locale] || "English";
  const kbBlock = ctx.knowledgeDocs.length
    ? ctx.knowledgeDocs.map((d) => `- doc "${d.title}" [${d.kb}]: ${d.snippet}`).join("\n")
    : "(no knowledge documents available)";
  const toolBlock = ctx.tools.length
    ? ctx.tools.map((t) => `- tool "${t.name}" (${t.integration})${t.description ? `: ${t.description}` : ""}`).join("\n")
    : "(no action tools granted)";
  return `${businessBlock(ctx)}

## Knowledge base documents available to it
${kbBlock}

## Action tools available to it
${toolBlock}

## Customer questions to judge (fixed list; judge every id, add none)
${questions.map((q) => `- [${q.id}] ${q.question}`).join("\n")}

## Your task
For EACH question id decide:
- evidence: the documents and tools above that answer it, by their exact quoted name: [{"kind":"doc","name":"<doc title>"}, {"kind":"tool","name":"<tool name>"}]. Only what is listed above; [] when nothing does.
- coverage: "full" (the evidence answers it completely), "partial" (the evidence answers part of it), or "none" (nothing listed answers it). A tool that does what the customer asks (e.g. looking up or changing their order) IS evidence. With no evidence the coverage is "none" - do not hedge with "partial".
- gapType: if not full, the single biggest missing thing - "knowledge" (missing info/policy/FAQ), "tool" (needs an action/integration not listed, e.g. refunds when no refund tool is listed), or "data" (needs structured business data, e.g. price list, size/measurement table, product catalog). Use "none" only when coverage is "full".
- reason: one short sentence in ${lang}.

Then produce "recommendations": concrete, deduplicated fixes for the gaps you found. Each has a "type" from: "add_knowledge", "connect_tool", "add_business_data", "add_faq", "create_workflow", "other". title + detail in ${lang}.

Respond ONLY with JSON of exactly this shape:
{"judgements":[{"id":"q_...","evidence":[{"kind":"doc|tool","name":"..."}],"coverage":"full|partial|none","gapType":"knowledge|tool|data|none","reason":"..."}],"recommendations":[{"type":"...","title":"...","detail":"..."}]}`;
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
const NO_EVIDENCE_REASON: Record<string, string> = {
  en: "No document or tool it has answers this.",
  he: "אין מסמך או כלי שעונים על השאלה הזו.",
};
const NOT_JUDGED_REASON: Record<string, string> = {
  en: "The check did not return a verdict for this question.",
  he: "הבדיקה לא החזירה תשובה לשאלה הזו.",
};

const VALID_COVERAGE = new Set<Coverage>(["full", "partial", "none"]);
const VALID_GAP = new Set(["knowledge", "tool", "data", "none"]);
const VALID_REC = new Set(["add_knowledge", "connect_tool", "add_business_data", "add_faq", "create_workflow", "other"]);

export async function readQuestionSet(tenantId: string, aiAgentId: string): Promise<StoredQuestionSet | null> {
  try {
    const raw = await readDurableSetting(tenantId, questionSetKey(aiAgentId));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v.fingerprint !== "string" || !Array.isArray(v.questions)) return null;
    return v as StoredQuestionSet;
  } catch {
    return null;
  }
}

/**
 * A failed write never fails the run: the report is still right, the set is
 * only made again next time (and the score may then move, as before B6).
 */
async function storeQuestionSet(tenantId: string, aiAgentId: string, set: StoredQuestionSet): Promise<void> {
  try {
    await writeDurableSetting(tenantId, questionSetKey(aiAgentId), JSON.stringify(set), "readiness");
  } catch (err: any) {
    console.warn(`[readiness] question set write failed for ${aiAgentId}:`, err?.message);
  }
}

/** Keep each question once (by id), in order. */
function uniqueQuestions(qs: Array<{ id: string; question: string }>): Array<{ id: string; question: string }> {
  const seen = new Set<string>();
  return qs.filter((q) => (seen.has(q.id) ? false : (seen.add(q.id), true)));
}

/**
 * The question set to judge: the stored one when it still fits, else a new
 * one. Answered questions are always in it (an older answer, from before the
 * set existed, joins it here).
 */
async function questionSetFor(
  tenantId: string,
  agentId: string,
  ctx: ReadinessContext,
  locale: string,
  regenerate: boolean,
): Promise<StoredQuestionSet | { error: string }> {
  const fingerprint = questionFingerprint(ctx, locale);
  const answered = ctx.answered.map((q) => ({ id: questionIdFor(q), question: q }));
  let set = regenerate ? null : await readQuestionSet(tenantId, agentId);
  if (set && set.fingerprint !== fingerprint) set = null;

  if (!set) {
    let raw: string;
    try {
      const res = await generateResponse({
        tenantId,
        messages: [
          { role: "system", content: "You write the realistic questions customers ask a business. You output only valid JSON." },
          { role: "user", content: buildQuestionsPrompt(ctx, locale) },
        ],
        temperature: 0.5,
        maxTokens: 3000,
        responseFormat: { type: "json_object" },
        metadata: { type: "agent_readiness_questions", aiAgentId: agentId },
      } as any);
      raw = (res as any)?.content || "";
    } catch (err: any) {
      console.error("[readiness] question generation failed:", err?.message);
      return { error: "llm_unavailable" };
    }
    let parsed: any;
    try {
      parsed = withoutWideDashes(JSON.parse(raw));
    } catch {
      return { error: "bad_model_output" };
    }
    const made = (Array.isArray(parsed.questions) ? parsed.questions : [])
      .map((q: any) => String(typeof q === "string" ? q : q?.question || "").trim().slice(0, 400))
      .filter(Boolean)
      .map((q: string) => ({ id: questionIdFor(q), question: q }));
    set = { fingerprint, locale, generatedAt: new Date().toISOString(), questions: uniqueQuestions([...made, ...answered]) };
    await storeQuestionSet(tenantId, agentId, set);
    return set;
  }

  const have = new Set(set.questions.map((q) => q.id));
  const missing = answered.filter((a) => !have.has(a.id));
  if (missing.length) {
    set = { ...set, questions: [...set.questions, ...missing] };
    await storeQuestionSet(tenantId, agentId, set);
  }
  return set;
}

export async function generateReadinessReport(
  tenantId: string,
  agentId: string,
  locale = "en",
  opts: { regenerateQuestions?: boolean } = {},
): Promise<ReadinessReport | { error: string }> {
  const ctx = await loadContext(tenantId, agentId);
  if (!ctx) return { error: "agent_not_found" };

  const set = await questionSetFor(tenantId, agentId, ctx, locale, !!opts.regenerateQuestions);
  if ("error" in set) return set;

  const answeredIds = new Set(ctx.answered.map((q) => questionIdFor(q)));
  const inputFingerprint = hashOf({
    v: JUDGE_VERSION,
    set: [set.fingerprint, set.generatedAt, set.questions.map((q) => q.id)],
    knowledge: ctx.knowledgeVersion,
    tools: ctx.tools.map((t) => [t.name, t.integration]),
    answered: [...answeredIds].sort(),
    locale,
  });
  // Nothing it depends on changed: the same report, with no model call.
  if (ctx.previousReport && ctx.previousReport.inputFingerprint === inputFingerprint) {
    return { ...ctx.previousReport, unchanged: true };
  }

  const toJudge = set.questions.filter((q) => !answeredIds.has(q.id));
  const judged = new Map<string, { coverage: Coverage; gapType: ReadinessQuestion["gapType"]; reason: string; evidence: Array<{ kind: "doc" | "tool"; name: string }> }>();
  const recs: ReadinessRecommendation[] = [];
  // Only names that were in the judge's input count as evidence.
  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const docNames = new Map(ctx.knowledgeDocs.map((d) => [norm(d.title), d.title]));
  const toolNames = new Map(ctx.tools.map((t) => [norm(t.name), t.name]));
  const batches: Array<Array<{ id: string; question: string }>> = [];
  for (let i = 0; i < toJudge.length; i += JUDGE_BATCH) batches.push(toJudge.slice(i, i + JUDGE_BATCH));

  const outs = await Promise.all(batches.map(async (batch) => {
    try {
      const res = await generateResponse({
        tenantId,
        messages: [
          { role: "system", content: "You are a meticulous QA auditor for AI customer-service employees. You output only valid JSON." },
          { role: "user", content: buildJudgePrompt(ctx, batch, locale) },
        ],
        // Ignored by the gpt-5 models (see the header); harmless elsewhere.
        temperature: 0,
        reasoningEffort: "medium",
        maxTokens: 3000,
        responseFormat: { type: "json_object" },
        metadata: { type: "agent_readiness", aiAgentId: agentId },
      } as any);
      return { raw: String((res as any)?.content || "") };
    } catch (err: any) {
      console.error("[readiness] LLM call failed:", err?.message);
      return { error: "llm_unavailable" as const };
    }
  }));

  for (const out of outs) {
    if ("error" in out) return { error: out.error! };
    let parsed: any;
    try {
      parsed = withoutWideDashes(JSON.parse(out.raw));
    } catch {
      return { error: "bad_model_output" };
    }
    for (const j of Array.isArray(parsed.judgements) ? parsed.judgements : []) {
      if (typeof j?.id !== "string") continue;
      const evidence = (Array.isArray(j.evidence) ? j.evidence : [])
        .map((e: any) => {
          const kind = e?.kind === "tool" ? "tool" : e?.kind === "doc" ? "doc" : null;
          const name = kind === "tool" ? toolNames.get(norm(e?.name)) : kind === "doc" ? docNames.get(norm(e?.name)) : undefined;
          return kind && name ? { kind, name } : null;
        })
        .filter((e: any, i: number, all: any[]) => e && all.findIndex((x) => x && x.kind === e.kind && x.name === e.name) === i);
      let coverage: Coverage = VALID_COVERAGE.has(j.coverage) ? j.coverage : "none";
      let gapType = VALID_GAP.has(j.gapType) ? j.gapType : (coverage === "full" ? "none" : "knowledge");
      let reason = String(j.reason || "").slice(0, 400);
      // A verdict with nothing real behind it is "none".
      if (coverage !== "none" && evidence.length === 0) {
        coverage = "none";
        if (gapType === "none") gapType = "knowledge";
        reason = NO_EVIDENCE_REASON[locale] ?? NO_EVIDENCE_REASON.en!;
      }
      if (coverage !== "full" && gapType === "none") gapType = "knowledge";
      judged.set(j.id, { coverage, gapType, reason, evidence });
    }
    for (const r of Array.isArray(parsed.recommendations) ? parsed.recommendations : []) {
      const rec = {
        type: (VALID_REC.has(r?.type) ? r.type : "other") as ReadinessRecommendation["type"],
        title: String(r?.title || "").slice(0, 200),
        detail: String(r?.detail || "").slice(0, 500),
      };
      // One per title across the batches.
      if (rec.title && !recs.some((x) => norm(x.title) === norm(rec.title))) recs.push(rec);
    }
  }
  const recommendations = recs.slice(0, 12);

  const questions: ReadinessQuestion[] = set.questions.map((q) => {
    if (answeredIds.has(q.id)) {
      return { id: q.id, question: q.question, coverage: "full", gapType: "none", reason: ANSWERED_REASON[locale] ?? ANSWERED_REASON.en!, answered: true };
    }
    // A question the judge skipped is counted as not handled, and says so.
    const j = judged.get(q.id) ?? { coverage: "none" as Coverage, gapType: "knowledge" as const, reason: NOT_JUDGED_REASON[locale] ?? NOT_JUDGED_REASON.en!, evidence: [] };
    return { id: q.id, question: q.question, ...j };
  });

  const { score, totals } = computeScore(questions);
  return {
    score,
    totals,
    questions,
    recommendations,
    generatedAt: new Date().toISOString(),
    questionSetGeneratedAt: set.generatedAt,
    inputFingerprint,
  };
}
