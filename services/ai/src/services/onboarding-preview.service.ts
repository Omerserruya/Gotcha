/**
 * Onboarding 00h: "ask your employee something and see how it answers from
 * what it learned" - without any of it becoming business state.
 *
 *   previewQuestions  what to offer the owner to ask: their real unanswered
 *                     questions first, then questions customers ask
 *                     businesses like this one, built from the scan by fixed
 *                     templates (no model call).
 *   previewAnswer     one answer from Knowledge, with its sources. Reads the
 *                     same retrieval the bot and the test chat use; when
 *                     nothing in Knowledge fits it says so and calls no model
 *                     (no guessing). Writes NO conversation, message,
 *                     unanswered question, persona or skill run - only the AI
 *                     usage record (generateResponse) and an audit row.
 */
import { prisma, writeAudit } from "@chatcenter/shared";
import { retrieveRelevantChunks } from "./knowledge.service";
import { generateResponse, getDefaultModel } from "./ai.service";
import { withoutWideDashes } from "./business-discovery.service";

export type PreviewLocale = "he" | "en";
export const QUESTION_MAX = 300;
export const PREVIEW_STATUSES = new Set(["PENDING_ONBOARDING", "PENDING_ADMIN_SETUP", "ACTIVE"]);
/**
 * Below this, an excerpt is not worth asking the model about. Deliberately
 * lower than the gap-recording threshold (0.35): short Hebrew questions score
 * 0.27-0.35 against the very document that answers them (measured on dev).
 * Grounding itself is decided by the model's covered:true plus the excerpts
 * it cites - this floor only saves a call on clearly unrelated questions.
 */
export const RELEVANCE_FLOOR = 0.2;

// ── Questions (pure + reads) ───────────────────────────────────────────────

type Topic = "shipping" | "returns" | "refunds" | "privacy" | "terms" | "contact";

/** Fixed per-locale questions. No wide dashes. */
export const TOPIC_QUESTIONS: Record<Topic, Record<PreviewLocale, string>> = {
  shipping: { en: "What is your shipping policy?", he: "מה מדיניות המשלוחים שלכם?" },
  returns: { en: "How do returns work?", he: "איך עובדות החזרות?" },
  refunds: { en: "How do I get a refund?", he: "איך מקבלים החזר כספי?" },
  privacy: { en: "What do you do with my personal details?", he: "מה אתם עושים עם הפרטים האישיים שלי?" },
  terms: { en: "What are your terms of purchase?", he: "מה תנאי הרכישה שלכם?" },
  contact: { en: "How can I reach you?", he: "איך אפשר ליצור איתכם קשר?" },
};
const POLICY_TOPICS: Topic[] = ["shipping", "returns", "refunds", "privacy", "terms"];
/** What a customer-facing gap is about, read from its id and label. */
const TOPIC_WORDS: Array<[Topic, string[]]> = [
  ["shipping", ["shipping", "delivery", "משלוח"]],
  ["returns", ["return", "exchange", "החזרות", "החזרה", "החלפ"]],
  ["refunds", ["refund", "החזר כספי", "זיכוי"]],
  ["privacy", ["privacy", "פרטיות"]],
  ["terms", ["terms", "תקנון", "תנאי"]],
  ["contact", ["contact", "phone", "email", "טלפון", "אימייל", "יצירת קשר", "ערוצי תקשורת"]],
];
const CUSTOMER_GAP_DOMAINS = new Set(["knowledge", "communication", "customers"]);
const CONFIDENCE_RANK: Record<string, number> = { confirmed: 0, likely: 1, low: 2, needs_verification: 3, unknown: 4 };
const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function gapTopic(gap: any): Topic | null {
  if (!CUSTOMER_GAP_DOMAINS.has(String(gap?.domain ?? ""))) return null;
  const text = `${gap?.id ?? ""} ${gap?.label ?? ""}`.toLowerCase();
  return TOPIC_WORDS.find(([, words]) => words.some((w) => text.includes(w)))?.[0] ?? null;
}

/**
 * The suggested questions, up to `room`: policies the scan FOUND (best
 * confidence first) - those have a real answer to show - then at most ONE
 * customer-facing gap, honestly showing what is missing. A policy that was not
 * found never becomes a question by itself.
 */
export function suggestedQuestions(discovery: { knowledge?: any; gaps?: any } | null, locale: PreviewLocale, room: number): Array<{ question: string; basis: string }> {
  if (room <= 0 || !discovery) return [];
  const out: Array<{ question: string; basis: string }> = [];
  const policies = discovery.knowledge?.policies && typeof discovery.knowledge.policies === "object" ? discovery.knowledge.policies : {};
  const found = POLICY_TOPICS
    .map((t, i) => ({ t, i, p: policies[t] }))
    .filter((x) => x.p && x.p.found === true)
    .sort((a, b) => (CONFIDENCE_RANK[a.p.confidence] ?? 5) - (CONFIDENCE_RANK[b.p.confidence] ?? 5) || a.i - b.i);
  for (const f of found) {
    if (out.length >= room) return out;
    out.push({ question: TOPIC_QUESTIONS[f.t][locale], basis: `policy:${f.t}` });
  }
  if (out.length >= room) return out;
  const gaps = (Array.isArray(discovery.gaps) ? discovery.gaps : [])
    .map((g: any, i: number) => ({ g, i, topic: gapTopic(g) }))
    .filter((x: any) => x.topic && !out.some((o) => o.basis === `policy:${x.topic}`))
    .sort((a: any, b: any) => (SEVERITY_RANK[a.g.severity] ?? 3) - (SEVERITY_RANK[b.g.severity] ?? 3) || a.i - b.i);
  const gap = gaps[0];
  if (gap) out.push({ question: TOPIC_QUESTIONS[gap.topic as Topic][locale], basis: `gap:${gap.g.id ?? gap.topic}` });
  return out;
}

export async function previewQuestions(tenantId: string, locale: PreviewLocale) {
  const [real, discovery] = await Promise.all([
    prisma.unansweredQuestion.findMany({
      where: { tenantId, resolvedAt: null },
      orderBy: { lastAskedAt: "desc" },
      take: 3,
      select: { id: true, question: true, askCount: true },
    }),
    prisma.businessDiscovery.findUnique({ where: { tenantId }, select: { knowledge: true, gaps: true } }),
  ]);
  return { real, suggested: suggestedQuestions(discovery as any, locale, 3 - real.length) };
}

// ── Answer ─────────────────────────────────────────────────────────────────

const NOT_LEARNED: Record<PreviewLocale, string> = {
  he: "את זה עוד לא למדתי ממה שהעליתם. אפשר ללמד אותי את התשובה, ואז אדע לענות.",
  en: "I don't have this in what I learned yet. Teach me the answer and I will know it.",
};

export interface PreviewSource { documentId: string; title: string; sourceUrl: string | null; path: string }

async function voiceFor(tenantId: string): Promise<string | null> {
  const [profile, discovery] = await Promise.all([
    prisma.businessProfile.findUnique({ where: { tenantId }, select: { observedVoice: true } }).catch(() => null),
    prisma.businessDiscovery.findUnique({ where: { tenantId }, select: { brand: true } }).catch(() => null),
  ]);
  const saved = profile?.observedVoice?.trim();
  if (saved) return saved;
  const b = (discovery?.brand ?? {}) as any;
  const parts = [b.voice, b.tone, b.style].filter((x) => typeof x === "string" && x.trim());
  return parts.length ? parts.join("; ") : null;
}

export async function previewAnswer(input: { tenantId: string; userId: string | null; question: string; locale: PreviewLocale }) {
  const question = input.question.trim();
  // The same retrieval as the bot and the test chat; never records a gap.
  const chunks = (await retrieveRelevantChunks(input.tenantId, question, 5, null, { record: false }))
    .filter((c: any) => (c.score ?? 0) >= RELEVANCE_FLOOR);

  let answer = NOT_LEARNED[input.locale];
  let grounded = false;
  let sources: PreviewSource[] = [];
  let tokens = { input: 0, output: 0 };

  if (chunks.length) {
    const voice = await voiceFor(input.tenantId);
    const excerpts = chunks.map((c: any, i: number) => `[${i + 1}] ${c.documentTitle ?? ""}\n${String(c.content ?? "").slice(0, 1500)}`).join("\n\n");
    const resp = await generateResponse({
      tenantId: input.tenantId,
      model: getDefaultModel(),
      temperature: 0.2,
      maxTokens: 500,
      responseFormat: { type: "json_object" },
      metadata: { type: "onboarding_preview_answer" },
      messages: [
        {
          role: "system",
          content: [
            "You are the business's AI employee answering a customer's question, as a preview for the owner.",
            "Answer ONLY from the numbered knowledge excerpts. If they do not answer the question, set covered to false. Never guess, never add facts that are not in the excerpts.",
            // Measured on dev 2026-10-07: "What do you sell?" against a Hebrew
            // overview saying "an online store of urban products" came back
            // covered:false ("no product descriptions were found").
            "The excerpts may be in another language than the question: translate what they say. An answer drawn from them is covered even when its language differs.",
            "A general answer the excerpts support (for example the kind of business or products) is covered, even when they lack detail. Say covered is false only when nothing in them answers the question.",
            voice ? `Write in this voice: ${voice}` : "",
            `Write the answer in ${input.locale === "he" ? "Hebrew" : "English"}, short, as a message to the customer.`,
            "Never write the em-dash (U+2014), the en-dash (U+2013) or the horizontal bar (U+2015). Use a regular hyphen, a comma or a period.",
            'Respond ONLY with JSON: { "answer": string, "covered": boolean, "used": number[] } where used lists the excerpt numbers the answer relies on.',
          ].filter(Boolean).join("\n"),
        },
        { role: "user", content: `Question: ${question}\n\nKnowledge excerpts:\n${excerpts}` },
      ],
    });
    tokens = { input: resp.usage?.input_tokens ?? 0, output: resp.usage?.output_tokens ?? 0 };
    let parsed: any = null;
    try { parsed = JSON.parse(String(resp.content ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { parsed = null; }
    const used = Array.isArray(parsed?.used) ? parsed.used.map(Number).filter((n: number) => n >= 1 && n <= chunks.length) : [];
    if (parsed?.covered === true && typeof parsed.answer === "string" && parsed.answer.trim() && used.length) {
      grounded = true;
      answer = withoutWideDashes(parsed.answer.trim());
      const docIds = [...new Set(used.map((n: number) => (chunks[n - 1] as any).documentId).filter(Boolean))] as string[];
      const docs = docIds.length
        ? await prisma.knowledgeDocument.findMany({
            where: { tenantId: input.tenantId, id: { in: docIds } },
            select: { id: true, title: true, sourceUrl: true, knowledgeBase: { select: { name: true } } },
          })
        : [];
      const byId = new Map(docs.map((d: any) => [d.id, d]));
      sources = docIds.filter((id) => byId.has(id)).map((id) => {
        const d: any = byId.get(id);
        return { documentId: d.id, title: d.title, sourceUrl: d.sourceUrl ?? null, path: `${d.knowledgeBase?.name ?? "Knowledge"} / ${d.title}` };
      });
      if (!sources.length) { grounded = false; answer = NOT_LEARNED[input.locale]; }
    }
  }

  // CLAUDE.md §5: every AI interaction is logged. generateResponse already
  // wrote the usage record; this row carries what the owner asked and why.
  await writeAudit({
    tenantId: input.tenantId,
    actorType: "ai",
    actorId: input.userId,
    action: "ai.onboarding_preview_answer",
    targetType: "tenant",
    targetId: input.tenantId,
    metadata: {
      question: question.slice(0, QUESTION_MAX),
      grounded,
      sources: sources.map((s) => s.documentId),
      contextChunks: chunks.length,
      modelCalled: chunks.length > 0,
      tokens,
    },
  });

  return { answer, grounded, sources };
}
