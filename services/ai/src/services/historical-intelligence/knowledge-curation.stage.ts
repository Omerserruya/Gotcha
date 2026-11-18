import { z } from "zod";
import { prisma } from "@chatcenter/shared";
import { structuredCall } from "./llm";
import { dropCandidateVectors } from "./candidate-index";
import {
  recordEvent,
  tenantPromptLanguage,
  languageDirective,
  type StageResult,
} from "./stage-utils";

/**
 * The last pass before a person sees any of this.
 *
 * Everything upstream judges one exchange at a time. That is the right unit for
 * finding knowledge and the wrong one for deciding whether it is worth keeping,
 * because three of the four faults that survive to this point are only visible
 * from the whole set or from reading the answer as a person would:
 *
 *   1. **Answers that do not stand alone.** "יש יין באולם?" answered "כן בטח"
 *      is real knowledge - there is wine - stored as two words that mean
 *      nothing on their own. The fix is to restate it, not to delete it. This
 *      is the single most common problem and the one that most improves the
 *      result, because the knowledge was already there.
 *   2. **Answers that depend on live data.** "When can we meet?" answered
 *      "Thursday or Friday" is not a policy; it depended on who was free that
 *      week. An agent that repeats it will promise a slot nobody checked.
 *      Still worth keeping - they really do prefer Thursday and Friday - but as
 *      a tendency that must be confirmed against the calendar.
 *   3. **One customer's logistics wearing a question mark.** "Is it OK if Dani
 *      brings the things tomorrow around 13:30?" is not a question this
 *      business gets asked. The deterministic gate cannot catch it: it holds no
 *      order number, and a clock time is not disqualifying because opening
 *      hours are made of clock times.
 *   4. **The same question in different words.** Embedding clustering and the
 *      dedupe pass both work on similarity; some duplicates are only obvious to
 *      a reader.
 *
 * ── The rule this stage must not break ──
 *
 * Rarity is never a reason to drop. The entire point of the rework was that a
 * question asked once is worth as much as one asked two hundred times if the
 * answer serves the next customer, and a curation pass is exactly where that
 * gets quietly undone by a model optimising for a tidy list. The prompt says so
 * repeatedly, the stage counts how many singletons it kept versus dropped, and
 * that count goes into the event so a regression is visible as a number rather
 * than as a vague sense that the output got thinner.
 */

const Verdict = z.object({
  id: z.string(),
  verdict: z.enum(["keep", "rewrite", "live_data", "drop", "duplicate"]),
  /** Required for rewrite and live_data: the answer as it should read. */
  answer: z.string().max(800).optional(),
  /** Required for duplicate: the id this one folds into. */
  duplicateOf: z.string().optional(),
  /** One short line for the reviewer. */
  note: z.string().max(200).optional(),
});

export const CurationSchema = z.object({
  verdicts: z.array(Verdict).max(80),
});

export const CURATION_PROMPT = `You are reviewing question/answer pairs mined from a business's real customer conversations, before a human sees them. Decide what each one is.

VERDICTS
- "keep": the answer is correct, complete, and reads as an answer on its own.
- "rewrite": the knowledge is real but the ANSWER TEXT does not stand alone. This is the most common case and the most valuable thing you do. A bare confirmation is not an answer: "Is there wine at the venue?" answered "sure" must become "Yes, wine is available at the venue." Restate it as a full sentence using the subject of the question. Never invent detail the business did not give - if they said only yes, the rewrite says only yes, in a complete sentence.
- "live_data": use this ONLY when BOTH are true: (a) the question is one other customers will genuinely ask too, and (b) the answer varies with something that must be checked - a calendar, someone's availability, current stock, a price that moves. Rewrite it to state the GENERAL PATTERN and drop the specific instance entirely: "When can we meet?" answered "Thursday or Friday" becomes "Viewings are usually held on Thursdays and Fridays; the exact time depends on availability and must be confirmed."
  This is NOT a place to keep one customer's appointment. "We'll meet today around 19:00", "agreed on Wednesday at 19:00", "I'm dialling you now" are records of one conversation, not answers to a recurring question - those are "drop". The test: after you remove the specific date, time and person, is a general answer left that helps the NEXT customer? If nothing is left, the verdict is "drop", not "live_data".
- "drop": there is no reusable knowledge at all. Use this for one customer's own logistics phrased as a question ("is it OK if Dani brings the things tomorrow at 13:30"), for pure pleasantries ("sure, what do you need?"), for a named individual's phone number or personal contact details, and for an answer that means nothing even after a rewrite.
- "duplicate": another item in this list asks the same question and the other one is phrased better. Give its id in duplicateOf. Only for genuinely the same question needing the same answer.

RARITY IS NOT A REASON TO DROP - READ THIS TWICE
A question asked once by one customer is worth exactly as much as one asked two hundred times, as long as the answer would serve a different customer. The unusual questions are the valuable ones: the common ones are already known to everyone who works there, and the unusual ones are what a new employee gets wrong. Never drop something for being niche, oddly specific to a situation that could recur, or unlike the others in the list. Judge only: would this help someone answer a DIFFERENT customer?

Every id you are given must appear exactly once in your reply. Do not invent ids.

Reply with ONLY a JSON object: {"verdicts":[{"id":"...","verdict":"keep"},{"id":"...","verdict":"rewrite","answer":"...","note":"..."}]}`;

/**
 * Batched by category, so the duplicate check has a chance of seeing both
 * copies. Sixty is what the dedupe pass uses and it comfortably fits with the
 * answers included, which this prompt needs and dedupe did not.
 */
const BATCH = 40;

type Item = { id: string; question: string; answer: string; topic: string; occurrenceCount: number };
type CurationVerdict = z.infer<typeof Verdict>;

/**
 * Verdicts for a batch, never fewer than it has (2026-11-18: 351 of Smoovee's 711 had none). A failed call is
 * retried once; a batch that still fails is split in halves down to single items; ids the model left out are
 * judged again on their own. A single item no call could judge comes back null: "unjudged", recorded as such.
 */
export async function judgeAll(
  batch: Item[],
  call: (items: Item[]) => Promise<{ verdicts: CurationVerdict[] } | null>,
  depth = 0,
): Promise<Map<string, CurationVerdict | null>> {
  const out = new Map<string, CurationVerdict | null>();
  if (batch.length === 0) return out;
  let result = await call(batch);
  if (!result) result = await call(batch);
  if (!result) {
    if (batch.length === 1) { out.set(batch[0].id, null); return out; }
    const mid = Math.ceil(batch.length / 2);
    for (const half of [batch.slice(0, mid), batch.slice(mid)]) for (const [k, v] of await judgeAll(half, call, depth + 1)) out.set(k, v);
    return out;
  }
  const byId = new Map(result.verdicts.map((v) => [v.id, v]));
  const missing = batch.filter((c) => !byId.has(c.id));
  for (const c of batch) if (byId.has(c.id)) out.set(c.id, byId.get(c.id)!);
  if (missing.length) {
    // Left out: judged again on their own. When the model answered none of a batch, that is a failure: split.
    if (missing.length === batch.length) {
      if (batch.length === 1) { out.set(batch[0].id, null); return out; }
      const mid = Math.ceil(batch.length / 2);
      for (const half of [batch.slice(0, mid), batch.slice(mid)]) for (const [k, v] of await judgeAll(half, call, depth + 1)) out.set(k, v);
    } else if (depth < 6) {
      for (const [k, v] of await judgeAll(missing, call, depth + 1)) out.set(k, v);
    } else for (const c of missing) out.set(c.id, null);
  }
  return out;
}

export async function runKnowledgeCurationStage(args: {
  tenantId: string;
  importId: string;
  /** Only candidates with no verdict yet (or "unjudged"): finishing a curation that stopped (finish-curation). */
  onlyUncurated?: boolean;
}): Promise<StageResult> {
  const { tenantId, importId } = args;
  const startedAt = Date.now();

  const candidates = await prisma.knowledgeCandidate.findMany({
    where: {
      tenantId,
      importId,
      status: "PENDING",
      ...(args.onlyUncurated ? { OR: [{ curationVerdict: null }, { curationVerdict: "unjudged" }] } : {}),
    },
    // Same ordering rationale as dedupe: related items must share a batch or
    // the duplicate verdict can never fire.
    orderBy: [{ category: "asc" }, { topic: "asc" }, { question: "asc" }],
    select: { id: true, question: true, answer: true, topic: true, occurrenceCount: true },
  });

  if (candidates.length === 0) {
    await recordEvent(importId, "KNOWLEDGE_CURATION", "SKIPPED", "nothing to curate", {});
    return { ok: true, detail: { examined: 0 } };
  }

  const language = await tenantPromptLanguage(tenantId);
  let kept = 0;
  let rewritten = 0;
  let liveData = 0;
  let dropped = 0;
  let duplicates = 0;
  let unjudged = 0;
  // The guard against a tidy-looking regression: how much of what was dropped
  // was rare. See the note at the top of this file.
  let singletonsSeen = 0;
  let singletonsDropped = 0;

  const call = (items: Item[]) => structuredCall({
    tenantId,
    importId,
    schema: CurationSchema,
    system: CURATION_PROMPT + languageDirective(language),
    user: `Review these ${items.length} items:\n\n${items.map((c) => `${c.id}\n  topic: ${c.topic}\n  Q: ${c.question}\n  A: ${c.answer}`).join("\n\n")}`,
    feature: "historical_knowledge_curation",
    tier: "import",
    maxTokens: 6000,
  });

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const verdicts = await judgeAll(batch, call);

    for (const c of batch) {
      const isSingleton = c.occurrenceCount <= 1;
      if (isSingleton) singletonsSeen += 1;

      const v = verdicts.get(c.id) ?? null;
      if (!v) {
        // No call could judge it: KEPT, and recorded as unjudged so the finish script picks it up again.
        unjudged += 1;
        await prisma.knowledgeCandidate.updateMany({ where: { id: c.id, tenantId, status: "PENDING" }, data: { curationVerdict: "unjudged" } });
        continue;
      }

      if (v.verdict === "drop" || (v.verdict === "duplicate" && v.duplicateOf && v.duplicateOf !== c.id)) {
        await prisma.knowledgeCandidate.deleteMany({
          where: { id: c.id, tenantId, status: "PENDING" },
        });
        await dropCandidateVectors(tenantId, [c.id]);
        if (v.verdict === "drop") dropped += 1;
        else duplicates += 1;
        if (isSingleton) singletonsDropped += 1;
        continue;
      }

      if (v.verdict === "rewrite" || v.verdict === "live_data") {
        const answer = (v.answer ?? "").trim();
        // A rewrite verdict with no rewrite is not a rewrite. Keep the original
        // rather than blanking a real answer.
        if (!answer) {
          kept += 1;
          await prisma.knowledgeCandidate.updateMany({ where: { id: c.id, tenantId, status: "PENDING" }, data: { curationVerdict: "kept" } });
          continue;
        }
        await prisma.knowledgeCandidate.updateMany({
          where: { id: c.id, tenantId, status: "PENDING" },
          data: {
            answer,
            requiresLiveLookup: v.verdict === "live_data",
            curationVerdict: v.verdict === "live_data" ? "live_data" : "rewritten",
            curationNote: v.note?.trim() || null,
          },
        });
        if (v.verdict === "live_data") liveData += 1;
        else rewritten += 1;
        continue;
      }

      // A keep is a verdict too (2026-11-18): before, it wrote nothing, so a kept item read as never curated.
      kept += 1;
      await prisma.knowledgeCandidate.updateMany({ where: { id: c.id, tenantId, status: "PENDING" }, data: { curationVerdict: "kept", ...(v.note?.trim() ? { curationNote: v.note.trim() } : {}) } });
    }
  }

  const finalCount = await prisma.knowledgeCandidate.count({
    where: { tenantId, importId, status: "PENDING" },
  });
  await prisma.historicalImport.update({
    where: { id: importId },
    data: { knowledgeCandidateCount: finalCount },
  });

  const detail = {
    examined: candidates.length,
    kept,
    rewritten,
    liveData,
    dropped,
    duplicates,
    unjudged,
    singletonsSeen,
    singletonsDropped,
    finalCount,
  };
  await recordEvent(importId, "KNOWLEDGE_CURATION", "SUCCESS", null, detail, Date.now() - startedAt);
  return { ok: true, detail };
}
