import { prisma, recordUnansweredQuestion } from "@chatcenter/shared";
import { isSemanticallyRetrievable } from "./behavior-engine.service";

/**
 * Is a knowledge miss on this message a question the owner should be asked
 * to teach? Not when it came from the test chat (an operator rehearsing, the
 * same rule that keeps test runs out of skill stats: a sandbox turn, or a
 * "sandbox:" conversation). Not when the message carries no question at all -
 * "thanks", "ok", a greeting, an emoji, a bare number - by the SAME classifier
 * that decides whether a message is worth a knowledge search; a strategy that
 * always searches used to record "תודה רבה" as a gap.
 */
export function shouldRecordKnowledgeGap(t: { sandbox?: boolean; customerExternalId?: string | null; message: string }): boolean {
  if (t.sandbox) return false;
  if (String(t.customerExternalId ?? "").startsWith("sandbox:")) return false;
  if (isOnlyCourtesy(t.message)) return false;
  return isSemanticallyRetrievable(t.message);
}

/**
 * Words that make up a message with nothing to answer. The WHOLE message must
 * be made of them: "thanks, do you ship to Eilat?" is a question, "תודה רבה"
 * is not. (The retrieval classifier's prefix patterns end in \b, which in JS
 * only works for ASCII, so "תודה רבה" slipped past it.)
 */
const COURTESY_WORDS = new Set([
  "thanks", "thank", "you", "thx", "ty", "so", "much", "very", "a", "lot", "ok", "okay", "k", "great", "perfect",
  "cool", "nice", "good", "fine", "sure", "got", "it", "bye", "goodbye", "hi", "hello", "hey", "all", "set",
  "תודה", "רבה", "רבות", "מאוד", "ממש", "מעולה", "סבבה", "אחלה", "בסדר", "גמור", "אוקי", "אוקיי", "יופי",
  "נהדר", "מצוין", "שלום", "היי", "להתראות", "ביי", "לכם", "לך", "על", "הכל", "הכול", "טוב", "בטח", "מושלם",
]);

export function isOnlyCourtesy(message: string): boolean {
  const words = String(message ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // Nothing but emoji / punctuation, or only courtesy words.
  return words.length === 0 || words.every((w) => COURTESY_WORDS.has(w));
}
import { generateEmbedding } from "./embedding.service";
import { searchSimilar, SearchResult } from "./qdrant.service";
import { translatedQuery } from "./query-translation.service";

/**
 * Below this top similarity score (the best of the direct and the translated
 * search) a question is recorded as one the Knowledge could not answer.
 *
 * 0.30, measured on dev 2026-10-07 (text-embedding-3-small, two Hebrew
 * documents): answerable questions scored 0.294-0.428 (median ~0.35), clearly
 * unanswerable ones 0.191-0.312 (median ~0.27). The old 0.35 recorded four of
 * six ANSWERED questions as gaps; at 0.30 one answered question (0.294) is
 * still recorded and two unanswered ones (0.308, 0.312) are not. The ranges
 * overlap, so no number separates them perfectly; a sample this thin should be
 * re-measured on a tenant with richer Knowledge. (It was 0.35 in
 * @chatcenter/shared; this service is its only reader.)
 */
export const KNOWLEDGE_GAP_SCORE = 0.30;

/** Two result lists as one: each chunk once, at its best score, best first. */
export function mergeByBestScore(lists: SearchResult[][], limit: number): SearchResult[] {
  const best = new Map<string, SearchResult>();
  for (const list of lists) {
    for (const r of list) {
      const key = `${r.documentId ?? r.documentTitle}#${r.chunkIndex}`;
      const prev = best.get(key);
      if (!prev || (r.score ?? 0) > (prev.score ?? 0)) best.set(key, r);
    }
  }
  return [...best.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
}

export type { SearchResult as RetrievedChunk };

/**
 * Which knowledge bases may this employee read?
 *
 * Retrieval used to search EVERY active knowledge base in the tenant, which
 * made per-employee knowledge scoping inert: an employee with nothing attached
 * still answered from every other employee's knowledge, and a base scoped to
 * one agent or one department leaked to all of them. The schema has carried
 * `scope`, `scopeAgentId`, `scopeDepartmentId` and the AIAgentKnowledge join
 * for a long time; nothing honoured them at read time.
 *
 * A base is readable when ANY of these holds:
 *   - it is explicitly attached to this employee (AIAgentKnowledge), which is
 *     the operator saying "this one, for this employee";
 *   - it is tenant-wide (scope "all", the default) - shared knowledge stays
 *     shared, so attaching nothing does not leave an employee with nothing;
 *   - it is scoped to this employee's department.
 *
 * A base scoped to a DIFFERENT agent or department is excluded unless it was
 * explicitly attached. With no agent in context (internal callers, the
 * onboarding tuning chat) the old tenant-wide behaviour is kept deliberately -
 * there is no employee whose scope could be applied.
 */
export async function readableKnowledgeBaseIds(
  tenantId: string,
  aiAgentId?: string | null,
): Promise<string[]> {
  const bases = await prisma.knowledgeBase.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, scope: true, scopeAgentId: true, scopeDepartmentId: true },
  });
  if (!aiAgentId) return bases.map((b) => b.id);

  const [agent, attached] = await Promise.all([
    prisma.aIAgent.findFirst({
      where: { id: aiAgentId, tenantId },
      select: { departmentId: true },
    }),
    prisma.aIAgentKnowledge.findMany({
      where: { aiAgentId },
      select: { knowledgeBaseId: true },
    }),
  ]);
  // An agent id that does not belong to this tenant resolves to no agent, and
  // must not fall through to "read everything".
  if (!agent) return [];

  const attachedIds = new Set(attached.map((a) => a.knowledgeBaseId));
  return bases
    .filter((b) => {
      if (attachedIds.has(b.id)) return true;
      const scope = b.scope || "all";
      if (scope === "all") return true;
      if (scope === "department") return !!agent.departmentId && b.scopeDepartmentId === agent.departmentId;
      if (scope === "agent") return b.scopeAgentId === aiAgentId;
      return false;
    })
    .map((b) => b.id);
}

export async function retrieveRelevantChunks(
  tenantId: string,
  query: string,
  limit = 5,
  /**
   * Scopes the search to what this employee may read. Optional so existing
   * internal callers keep working; omitting it searches the whole tenant, as
   * before.
   */
  aiAgentId?: string | null,
  /**
   * Record a miss as a knowledge gap.
   *
   * Opt-in, because not every caller is answering a customer. A readiness test,
   * an admin probe or a KB preview that finds nothing is not a gap in the
   * business's knowledge, and recording those would fill the owner's list with
   * questions no customer ever asked.
   */
  gap: { record?: boolean; askerKey?: string | null } = {},
): Promise<SearchResult[]> {
  try {
    // A question in another language than the Knowledge is also searched in
    // the Knowledge's language (see query-translation.service); null = no
    // mismatch, or the translation was refused / failed: the plain search stands.
    const [queryEmbedding, translated] = await Promise.all([
      generateEmbedding(query, { tenantId }),
      translatedQuery(tenantId, query).catch(() => null),
    ]);

    const activeKBIds = await readableKnowledgeBaseIds(tenantId, aiAgentId);
    if (activeKBIds.length === 0) {
      // No readable knowledge base at all is the purest "no_knowledge" there is.
      if (gap.record) {
        void recordUnansweredQuestion({
          tenantId, question: query, reason: "no_knowledge", askerKey: gap.askerKey,
        });
      }
      return [];
    }

    const direct = await searchSimilar(tenantId, queryEmbedding, limit, activeKBIds);
    let results = direct;
    if (translated) {
      try {
        const translatedEmbedding = await generateEmbedding(translated, { tenantId });
        results = mergeByBestScore([direct, await searchSimilar(tenantId, translatedEmbedding, limit, activeKBIds)], limit);
      } catch (err: any) {
        console.warn("[Knowledge] translated search failed, using the direct one:", err?.message ?? err);
      }
    }

    // Recorded HERE, where the scores are, and never inferred later from a
    // conversation that happened to escalate. By the time anything downstream
    // can see the outcome, the reason why is gone.
    if (gap.record) {
      const topScore = results.length > 0 ? (results[0]!.score ?? 0) : 0;
      if (results.length === 0) {
        void recordUnansweredQuestion({
          tenantId, question: query, reason: "no_knowledge", askerKey: gap.askerKey,
        });
      } else if (topScore < KNOWLEDGE_GAP_SCORE) {
        void recordUnansweredQuestion({
          tenantId, question: query, reason: "low_confidence", askerKey: gap.askerKey,
        });
      }
    }

    return results;
  } catch (err: any) {
    console.error("[Knowledge] Retrieval error:", err.message);
    return [];
  }
}

/**
 * The customer-facing block when every retrieved source is weak (Tehila
 * 2026-11-04 dev walk: with the five weak sources marked and rule 7 present,
 * "איפה יש נקודות מכירה" still got "אין לנו רשימת נקודות מכירה פיזיות, אפשר
 * איסוף מהסטודיו": a made-up negative and the neighbouring pickup). The weak
 * sources are not shown at all, so there is nothing nearby to answer with.
 */
export const NO_KNOWLEDGE_MATCH_BLOCK = `## KNOWLEDGE BASE CONTEXT

Nothing in this business's Knowledge answers this message.

If the customer asks about the business itself - where it sells or has points of sale, its locations, opening hours, policies, people, contact details, or anything else no tool result in this turn answers - you do NOT know it.
- Do not state anything about it either way: not that it exists, and not that it does not ("אין לנו", "we don't have").
- Do not offer something nearby instead (pickup, shipping, another branch).
- Say plainly that you do not have that information here, and offer to have the team get back to them.
Questions about products, stock and orders are answered from the tools as usual.`;

const TEAM_OFFER = /צוות|נציג|יחזור|יחזרו|אעביר|נעביר|team|get back to you|representative/i;

/**
 * The "I don't have that" reply after NO_KNOWLEDGE_MATCH_BLOCK ends with the
 * team offer (dev re-walk 2026-11-04: 3/3 replies said they did not have it,
 * 0/3 offered anything, and the conversation dead-ended). Left alone when the
 * reply already asks something or offers the team.
 */
export function withTeamOffer(reply: string, locale: "he" | "en"): string {
  const t = String(reply ?? "").trim();
  if (!t || /[?؟]/.test(t) || TEAM_OFFER.test(t)) return reply;
  return `${t}\n${locale === "he" ? "רוצים שאעביר את השאלה לצוות שיחזור אליכם?" : "Would you like me to pass your question to the team so they can get back to you?"}`;
}

// ── Keyword fallback (prod replay 5) ──────────────────────────────────────
// "איפה הסטודיו" and "איסוף מנשר" missed in the vector search (short Hebrew
// asks score under the gap line) while the documents say it outright. These
// words find the chunk that SAYS it; a short ask also brings the words such a
// chunk is written in (an address is written "רחוב", not "איפה").
const LEXICAL_STOP = new Set(["איפה", "יש", "לכם", "לך", "אתם", "מה", "את", "של", "עם", "על", "זה", "זו", "אני", "אפשר", "האם", "כמה", "מתי", "איך", "למה", "גם", "רק", "כן", "לא", "שלכם", "שלך", "עוד", "היי", "שלום", "תודה", "בבקשה", "the", "and", "you", "your", "what", "where", "how", "can", "have", "with", "for", "are", "is"]);
const LEXICAL_EXPANSIONS: Array<[RegExp, string[]]> = [
  [/איפה|כתובת|מיקום|נמצאים|ממוקמים|סטודיו|סניף|חנות פיזית|address|location|where are you|located/iu, ["כתובת", "רחוב", "סטודיו", "סניף", "נמצאים", "ממוקמים", "איסוף"]],
  [/איסוף|לאסוף|pick ?up/iu, ["איסוף", "לאסוף", "עצמי", "נקודת", "נקודות"]],
  [/שעות|פתוח|פתוחים|סגור|hours|open/iu, ["שעות", "פתוחים", "פתיחה"]],
  [/משלוח|שליח|shipping|delivery/iu, ["משלוח", "משלוחים", "שליח"]],
  [/החזר|החלפ|return|exchange/iu, ["החזרה", "החזרות", "החלפה", "זיכוי"]],
  [/טלפון|וואטסאפ|מייל|ליצור קשר|contact|phone|email/iu, ["טלפון", "וואטסאפ", "מייל"]],
];

// A location ask, and the shape an address takes in a document: a street word and
// a number, or an address cue ("לכתובת", "איסוף", "סטודיו") followed shortly by a
// name and a number ("לכתובת תהילה רוזנבאום, יוסף לוי 8/2 נהריה"; "נקודת איסוף
// ... מסילה 23 נשר"). Prod replay 6: Tehila's street address is only in the
// returns-by-mail text, and lost to generic chunks at a flat score.
export const LOCATION_ASK = /(?<![\u0590-\u05FF])(?:איפה|כתובת|הכתובת|מיקום|נמצאים|ממוקמים|סטודיו|הסטודיו|סניף|חנות פיזית|לאסוף|איסוף)(?![\u0590-\u05FF])|\b(?:address|location|where are you|located|pick ?up)\b/iu;
// A house number is not a price, a duration or a size ("בדואר רשום בעלות 15 ש"ח").
const NOT_AFTER_NUMBER = String.raw`(?!\d|\s*(?:ש["״']?ח|₪|%|אחוז|שקל|ימי|ימים|יום|שעות|שעה|דקות|ס["״']?מ|מ["״']?מ|ק["״']?ג|ק["״']?מ|יח))`;
const HOUSE = String.raw`(?:[\u0590-\u05FF"'׳]{2,}\s+){1,3}\d{1,4}(?:\/\d{1,3})?` + NOT_AFTER_NUMBER;
const CITY = String.raw`[\u0590-\u05FF]{2,}(?:[\s-][\u0590-\u05FF]{2,})?`;
// After a street word or "כתובת:" the street is certain; the city is optional.
const STREET = new RegExp(String.raw`(?<![\u0590-\u05FF])(?:רח['׳"]?|רחוב|ברחוב|שד['׳]|שדרות|כתובת\s*:|כתובתנו\s*:?)\s*(${HOUSE}(?:\s*,?\s*${CITY})?)`, "u");
// After a looser cue (לכתובת, איסוף, סטודיו...) a city must follow the number.
const CUED = new RegExp(String.raw`(?<![\u0590-\u05FF])(?:כתובת|לכתובת|בכתובת|איסוף|נמצאים|ממוקמים|סטודיו|הסטודיו|מהסטודיו)(?![\u0590-\u05FF])[^.\n]{0,40}?(${HOUSE}\s*,?\s+${CITY})`, "u");
// Words that make "x 15" a price or a time, never a street.
const NOT_A_STREET = /(?<![\u0590-\u05FF])(?:בעלות|עלות|במחיר|מחיר|תוך|עד|מעל|בסך|מינימום|החל|רשום|כ-?)(?![\u0590-\u05FF])/u;
/** The address a text states, or null when it is not clearly one. */
export function extractAddress(text: string): string | null {
  for (const re of [STREET, CUED]) {
    const m = re.exec(String(text ?? ""));
    // From a street word inside what was captured ("המפעל ברח במסילה 23 נשר" -> "רחוב במסילה 23 נשר").
    const a = m?.[1]?.replace(/\s+/g, " ").replace(/[,\s]+$/, "").trim()
      .replace(/^.*?(?<![\u0590-\u05FF])ב?(?:רח['׳"]?|רחוב)\s+/u, "רחוב ");
    if (a && a.length <= 80 && !NOT_A_STREET.test(a)) return a;
  }
  return null;
}
export const hasAddress = (text: string) => extractAddress(text) !== null;

/** The ask's own words (with and without a one-letter prefix: "מנשר" is "from Nesher") and the words an answer to it is written in. */
export function lexicalTerms(query: string): { own: string[]; expanded: string[] } {
  const own = new Set<string>();
  for (const w of String(query ?? "").match(/[\u0590-\u05FFA-Za-z]{3,}/g) ?? []) {
    const lw = w.toLowerCase();
    if (LEXICAL_STOP.has(lw)) continue;
    own.add(lw);
    if (lw.length > 3 && /^[הובלמשכ]/.test(lw)) own.add(lw.slice(1));
    // A final letter becomes plain inside a longer word ("טלפון" in "טלפוני"): the word without it matches both.
    if (lw.length >= 4 && /[ךםןףץ]$/.test(lw)) own.add(lw.slice(0, -1));
  }
  const expanded = new Set<string>();
  for (const [re, words] of LEXICAL_EXPANSIONS) if (re.test(query)) for (const w of words) if (!own.has(w)) expanded.add(w);
  return { own: [...own].slice(0, 10), expanded: [...expanded].slice(0, 12) };
}

/**
 * The chunks that contain the ask's words, ranked by its own words first, then
 * by the answer words. A hit is scored AT the gap line (not "weak"); only a chunk
 * with one of the ask's own words, or two answer words, counts.
 */
export async function lexicalKnowledge(
  tenantId: string, query: string, limit = 5, aiAgentId?: string | null,
  deps: { db?: any; kbIds?: string[] } = {},
): Promise<SearchResult[]> {
  const db = deps.db ?? prisma;
  const { own, expanded } = lexicalTerms(query);
  if (!own.length && !expanded.length) return [];
  const kb = deps.kbIds ?? await readableKnowledgeBaseIds(tenantId, aiAgentId);
  if (!kb.length) return [];
  const rows: any[] = await db.knowledgeChunk.findMany({
    where: { tenantId, document: { knowledgeBaseId: { in: kb } }, OR: [...own, ...expanded].map((t) => ({ content: { contains: t, mode: "insensitive" } })) },
    select: { content: true, chunkIndex: true, documentId: true, document: { select: { title: true } } },
    take: 200,
  });
  const location = LOCATION_ASK.test(query);
  const scored = rows.map((r) => {
    const text = String(r.content ?? "").toLowerCase();
    const ownHits = own.filter((t) => text.includes(t)).length;
    const expHits = expanded.filter((t) => text.includes(t)).length;
    // Distinct terms: the ask's own words count double; an address in the chunk wins a location ask.
    const points = 2 * ownHits + expHits + (location && hasAddress(String(r.content ?? "")) ? 6 : 0);
    return { r, ownHits, expHits, points };
  }).filter((x) => x.ownHits > 0 || x.expHits >= 2)
    .sort((a, b) => b.points - a.points);
  return scored.slice(0, location ? Math.max(limit, 8) : limit).map(({ r, points }) => ({
    content: r.content,
    // From the gap line up by points: an address chunk for a location ask ranks with a strong vector match.
    score: Math.min(KNOWLEDGE_GAP_SCORE + 0.02 * points, 0.55),
    documentTitle: r.document?.title ?? "",
    chunkIndex: r.chunkIndex,
    documentId: r.documentId,
  }));
}

/** Vector hits that clear the gap line first, then keyword hits not already there, then the weak vector hits. */
export function mergeKnowledge(vector: SearchResult[], lexical: SearchResult[], limit = 5): SearchResult[] {
  const key = (c: SearchResult) => `${c.documentId ?? c.documentTitle}#${c.chunkIndex}`;
  const weak = vector.filter((c) => (c.score ?? 0) < KNOWLEDGE_GAP_SCORE);
  // Strong vector hits and keyword hits together, by score; then the weak vector hits.
  const ranked = [...vector.filter((c) => (c.score ?? 0) >= KNOWLEDGE_GAP_SCORE), ...lexical].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const c of [...ranked, ...weak]) if (!seen.has(key(c))) { seen.add(key(c)); out.push(c); }
  return out.slice(0, limit);
}

/** How many chunks a question gets: a location ask keeps more (the address may sit in a returns text). */
export const knowledgeLimit = (query: string) => (LOCATION_ASK.test(query ?? "") ? 8 : 5);

const addressCache = new Map<string, { at: number; value: string | null }>();
/**
 * An address the business's own documents give, for a business whose profile has
 * none (prod replay 6: Tehila's is only in "send returns to ..."): the most
 * frequent one, ten minutes per tenant and employee. The prompt calls it what it
 * is, the address the documents give for returns and pickup, never a shop.
 */
export async function documentAddress(tenantId: string, aiAgentId?: string | null, deps: { db?: any; kbIds?: string[] } = {}): Promise<string | null> {
  const k = `${tenantId}|${aiAgentId ?? ""}`;
  const hit = addressCache.get(k);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const db = deps.db ?? prisma;
  const kb = deps.kbIds ?? await readableKnowledgeBaseIds(tenantId, aiAgentId);
  let value: string | null = null;
  if (kb.length) {
    const rows: any[] = await db.knowledgeChunk.findMany({
      where: { tenantId, document: { knowledgeBaseId: { in: kb } }, OR: ["כתובת", "רחוב", "רח'", "איסוף", "סטודיו"].map((t) => ({ content: { contains: t } })) },
      select: { content: true },
      take: 200,
    });
    const counts = new Map<string, number>();
    for (const r of rows) {
      const text = String(r.content ?? "");
      const a = extractAddress(text);
      if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    value = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  }
  addressCache.set(k, { at: Date.now(), value });
  return value;
}

export function buildKnowledgeContext(chunks: SearchResult[], opts: { dropWhenAllWeak?: boolean; conflicts?: "surface" | "team" } = {}): string {
  if (chunks.length === 0) return "";
  if (opts.dropWhenAllWeak && chunks.every((c) => typeof c.score === "number" && c.score < KNOWLEDGE_GAP_SCORE)) return NO_KNOWLEDGE_MATCH_BLOCK;

  // A source that scored below the gap line is probably about something else
  // (Tehila 2026-11-03: "איפה יש נקודות מכירה" was answered from the shipping
  // doc's "pickup from the studio in Nahariya"). It is marked, and when every
  // source is weak the model is told so before it reads them.
  const weak = (c: SearchResult) => typeof c.score === "number" && c.score < KNOWLEDGE_GAP_SCORE;
  const contextParts = chunks.map((chunk, i) => {
    return `### Source ${i + 1}: ${chunk.documentTitle}${weak(chunk) ? " (weak match: probably NOT about this question)" : ""}\n${chunk.content}`;
  });
  const allWeak = chunks.every(weak)
    ? "\nNone of the sources below clearly matches this question. Unless one of them states the answer outright, say you do not have that information and offer to have the team answer.\n"
    : "";

  return `## KNOWLEDGE BASE CONTEXT (HIGH PRIORITY)

The text below is the PRIMARY source of truth for this turn. It overrides your general knowledge and any prior assumptions about this organization, its products, prices, policies, processes, and people.

Rules:
1. Treat the content below as authoritative. If it answers the question, use it.
2. Prefer the wording, numbers, and definitions found here over anything you "remember".
3. If the answer is NOT covered here, say so plainly - do not guess, do not infer beyond the text, do not fabricate names, prices, dates, links, or policies.
${opts.conflicts === "team"
  // Reply engine v2 (prod replay 8, Tehila: "the terms say X ... another source says Y" sent to a customer).
  ? "4. Do not contradict this content. Never mention sources, documents or that another text says otherwise. If two sources here disagree, give the rule of the more specific policy document (a returns or exchange policy, the terms) over an FAQ or an about page, the stricter one when both are policies, and put the conflict in team_question so the owner can fix it."
  : "4. Do not contradict this content. If two sources here disagree, surface the disagreement instead of picking one silently."}
5. When you use a fact from a specific source, you may reference it by its title or number; never invent sources.
${opts.conflicts === "team"
  // Prod replay 10, Tehila: the address is in the business details, not in a document, and was "not available".
  ? "6. Information NOT present here is unknown for this turn, unless the business details (# The business: its name, address, contact) state it: those stand."
  : "6. Information NOT present here is treated as unknown for this turn."}
7. A source about a NEIGHBOURING topic is not an answer. A shipping or pickup policy does not say where the products are sold in shops (points of sale, נקודות מכירה, חנויות); opening hours of one place are not the hours of another. When the exact thing asked is not stated, say you do not have that information and offer to have the team answer; do not answer with the nearest policy instead. An address or a pickup place stated anywhere (a shipping or pickup text too) DOES answer "where are you" or "what is the address".

${allWeak}---BEGIN KNOWLEDGE---

${contextParts.join("\n\n---\n\n")}

---END KNOWLEDGE---`;
}
