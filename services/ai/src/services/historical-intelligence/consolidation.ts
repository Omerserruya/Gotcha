import { z } from "zod";
import { structuredCall } from "./llm";
import { languageDirective } from "./stage-utils";
import { relevantPassages } from "./knowledge-review.stage";

/**
 * Consolidation (2026-11-18, Omer, dry run 2 on Smoovee: 568 of 671 items asked once, "עד 7 ימי עסקים" and "עד 3
 * ימי עסקים" as separate items, "מעל 299" and "מעל 449" both, one "35 ש״ח" fact in three items).
 *
 * Per topic, the model reads every item with its dates and occurrences and writes a SMALL canonical set: one item
 * per distinct sub-question, each answer merging the facts, general ("עד 7 ימי עסקים"), never one customer's
 * case. A contradiction is settled by the newest person answer when it is a clean switch (the note keeps "was X
 * until <date>"); otherwise it is an unresolved conflict for the review, with the competing answers.
 * Approval and auto-approve then work on the canonical items.
 */
export const ConsolidateSchema = z.object({
  items: z.array(z.object({
    question: z.string().min(3).max(300),
    answer: z.string().min(2).max(1500),
    sourceIds: z.array(z.string()).min(1),
    status: z.enum(["ok", "switched", "unresolved"]),
    note: z.string().max(300).optional(),
    /** A policy or technical fact (delivery time, free-shipping threshold, shipping cost, returns, warranty). */
    policy: z.boolean().optional(),
    /** What was chosen and why, for the review, in the business's language: "נבחר: 449 (התשובה החדשה 12.11); הוחלף: 350 עד 06.2026". */
    choice: z.string().max(300).optional(),
    /** Where the chosen fact came from. */
    chosenFrom: z.enum(["document", "newest_answer", "only_answer"]).optional(),
    /** The chosen value and the date of the answer it came from (ISO date; absent for a document). */
    chosenValue: z.string().max(200).optional(),
    chosenAt: z.string().max(30).optional(),
    /** What it replaced and until when (ISO date). */
    previousValue: z.string().max(200).optional(),
    previousUntil: z.string().max(30).optional(),
    /** For "unresolved": the competing answers, each with the source ids that gave it. */
    competing: z.array(z.object({ answer: z.string().min(2).max(800), sourceIds: z.array(z.string()).min(1) })).max(4).optional(),
  })).max(12),
});

export const CONSOLIDATE_PROMPT = `You consolidate a business's question/answer items about ONE topic into a small canonical set for its knowledge base.
Each item has an id, the date its answer was last given, how often it was asked, a question and an answer.

WRITE
- One canonical item per DISTINCT sub-question (usually 2 to 6 for a topic; fewer when the items all ask the same).
- Each canonical answer merges every fact the items give about that sub-question, in one clear answer.
- Generalise: state the rule, never one customer's case. "Do you ship to Cyprus? No" from a question about shipping abroad becomes the business's rule about shipping abroad only if the items support it; never narrow it to one country.
- Never add a fact, number or condition the items do not state.
- The same question about the same device or model is ONE item (five questions about the Tami 4 are one). Questions of the form "which pad for a device of A by B" are ONE item that states the rule from the size table, never one item per size.
- Every question must stand alone, understood without the chat. Rewrite a fragment ("אבל עד לידית מה המידה") into a full question from its answer, or put its id in the item that answers it.

CONTRADICTIONS (two items give different facts for the same sub-question: "up to 3 business days" vs "up to 7")
- If the newer answer clearly replaced the older one (the older stopped being given before the newer started): status "switched", the answer is the NEWEST, and the note says "was <old> until <date>".
- If both are given over the same period, or you cannot tell: status "unresolved", the answer is the newest, and "competing" lists each answer with the ids that gave it.
- Otherwise status "ok".

POLICY AND TECHNICAL FACTS (delivery times, the free-shipping threshold, shipping cost, return windows and fees, warranty, other fixed thresholds): set policy true, and choose the fact in this order:
1. The business's own documents below WIN when they state it: chosenFrom "document".
2. Otherwise the NEWEST person answer wins ("350" five months ago, then "449": 449): chosenFrom "newest_answer".
3. A single answer: chosenFrom "only_answer".
Also give chosenValue (the fact itself, "449 ₪"), chosenAt (the date of the answer it came from, YYYY-MM-DD, absent for a document), and when it replaced another: previousValue and previousUntil (YYYY-MM-DD).
Write "choice" in the business's language: the chosen value with its source or date, and what it replaced with until when ("נבחר: 449 (התשובה החדשה, 12.11); הוחלף: 350 עד 06.2026", or "נבחר: 14 יום (מסמך: תקנון)").
A policy fact is "unresolved" ONLY when a document and the RECENT answers (the last 60 days) disagree, or the recent answers alternate. A document against old answers is no conflict: the document wins.

Every id you are given must appear in the sourceIds of at least one canonical item. Use the business's language.
Reply with ONLY JSON: {"items":[{"question":"...","answer":"...","sourceIds":["..."],"status":"ok","note":"..."}]}`;

export interface ConsolidationMember {
  id: string; question: string; answer: string; occurrenceCount: number;
  firstSeenAt: Date | null; lastSeenAt: Date | null; curationVerdict: string | null; curationNote: string | null; requiresLiveLookup: boolean;
}
export interface CanonicalItem {
  question: string; answer: string; sourceIds: string[]; status: "ok" | "switched" | "unresolved"; note: string | null;
  occurrences: number; firstSeenAt: Date | null; lastSeenAt: Date | null;
  /** Dated variants: a switch reads as settled, an unresolved conflict as unsettled (knowledge-review unresolvedConflict). */
  variants: Array<{ key: string; answer: string; occurrenceCount: number; customerCount: number; firstSeenAt?: string; lastSeenAt?: string }>;
  conflict: boolean; requiresLiveLookup: boolean; curationVerdict: string; curationNote: string | null;
  policy: boolean; chosenFrom: string | null;
  /** For the review (Frontend contract 2026-11-18): basis "policy" for a document, "latest" for the newest answer. */
  chosen: { value: string; basis: "latest" | "policy"; at: string | null } | null;
  previous: { value: string; until: string | null } | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : undefined);
const min = (ds: Array<Date | null>) => ds.filter(Boolean).reduce<Date | null>((a, b) => (!a || (b as Date) < a ? (b as Date) : a), null);
const max = (ds: Array<Date | null>) => ds.filter(Boolean).reduce<Date | null>((a, b) => (!a || (b as Date) > a ? (b as Date) : a), null);
const keyOf = (a: string) => a.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim().slice(0, 160);

/**
 * The model's set, checked: ids only from the topic, every member placed (one left out stays as its own item),
 * occurrences and dates summed from the sources, the verdict and the live flag carried over.
 */
export function canonicalFrom(members: ConsolidationMember[], raw: z.infer<typeof ConsolidateSchema> | null): CanonicalItem[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  const used = new Set<string>();
  const out: CanonicalItem[] = [];
  const build = (question: string, answer: string, ids: string[], status: CanonicalItem["status"], note: string | null, competing?: Array<{ answer: string; sourceIds: string[] }>, extra: { policy?: boolean; choice?: string | null; chosenFrom?: string; chosenValue?: string; chosenAt?: string; previousValue?: string; previousUntil?: string } = {}): CanonicalItem => {
    const chosenFrom = extra.chosenFrom;
    const src = ids.map((id) => byId.get(id)!).filter(Boolean);
    const first = min(src.map((m) => m.firstSeenAt ?? m.lastSeenAt));
    const last = max(src.map((m) => m.lastSeenAt));
    const variantOf = (a: string, vids: string[]) => {
      const vs = vids.map((id) => byId.get(id)).filter(Boolean) as ConsolidationMember[];
      return { key: keyOf(a), answer: a, occurrenceCount: vs.reduce((n, m) => n + m.occurrenceCount, 0), customerCount: vs.length, firstSeenAt: iso(min(vs.map((m) => m.firstSeenAt ?? m.lastSeenAt))), lastSeenAt: iso(max(vs.map((m) => m.lastSeenAt))) };
    };
    // The model's "unresolved" stands even when the dates alone read like a switch: marked on the variants.
    const variants = status !== "ok" && competing?.length
      ? competing.map((c) => ({ ...variantOf(c.answer, c.sourceIds.filter((id) => byId.has(id))), ...(status === "unresolved" ? { unresolved: true } : {}) }))
      : [variantOf(answer, ids)];
    const verdicts = src.map((m) => m.curationVerdict);
    // A source that contradicted a document no longer bars the item when the document is what was chosen.
    const docNote = chosenFrom === "document" ? null : src.map((m) => m.curationNote).find((n) => String(n ?? "").startsWith("[doc-conflict]")) ?? null;
    return {
      question, answer, sourceIds: ids, status, note,
      occurrences: src.reduce((n, m) => n + m.occurrenceCount, 0), firstSeenAt: first, lastSeenAt: last,
      variants, conflict: status !== "ok" && variants.length > 1,
      requiresLiveLookup: src.some((m) => m.requiresLiveLookup),
      // A canonical answer is a rewrite of its sources; one no call could judge keeps that mark.
      curationVerdict: verdicts.includes("unjudged") || verdicts.includes(null) ? "unjudged" : src.some((m) => m.curationVerdict === "live_data") ? "live_data" : "rewritten",
      // The review shows why this value: the choice line first (Omer 2026-11-18), else the switch note.
      curationNote: docNote ?? ((extra.choice ?? note) ? String(extra.choice ?? note).slice(0, 300) : null),
      policy: !!extra.policy, chosenFrom: chosenFrom ?? null,
      chosen: extra.chosenValue ? { value: extra.chosenValue, basis: chosenFrom === "document" ? "policy" : "latest", at: extra.chosenAt ?? null } : null,
      previous: extra.previousValue ? { value: extra.previousValue, until: extra.previousUntil ?? null } : null,
    };
  };
  for (const it of raw?.items ?? []) {
    const ids = [...new Set(it.sourceIds.filter((id) => byId.has(id)))];
    if (!ids.length) continue;
    ids.forEach((id) => used.add(id));
    out.push(build(it.question.trim(), it.answer.trim(), ids, it.status, it.note?.trim() || null, it.competing, { policy: it.policy, choice: it.choice?.trim() || null, chosenFrom: it.chosenFrom, chosenValue: it.chosenValue?.trim() || undefined, chosenAt: it.chosenAt, previousValue: it.previousValue?.trim() || undefined, previousUntil: it.previousUntil }));
  }
  // Whatever the model left out stays as it was: never lost.
  for (const m of members) if (!used.has(m.id)) out.push(build(m.question, m.answer, [m.id], "ok", null));
  return out;
}

/**
 * A fragment the model left as a question of its own ("אבל עד לידית מה המידה", 5 words): 5 words or fewer, opening with
 * אבל, אז, גם, ומה or a joined ו. It folds into the item of the same topic whose answer shares the most words with
 * its answer; with no shared word it stays as it is (a visible fragment is better than a wrong merge).
 */
const FRAGMENT_OPEN = /^\s*(?:אבל|אז|גם|ומה|ו[\u0590-\u05FF]{2,})(?![\u0590-\u05FF])/u;
export function isFragment(question: string): boolean {
  const q = String(question ?? "").trim();
  return q.split(/\s+/).filter(Boolean).length <= 5 && FRAGMENT_OPEN.test(q);
}
const answerWords = (t: string) => new Set((String(t ?? "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) as string[]);
export function foldFragments(items: CanonicalItem[]): CanonicalItem[] {
  const out = [...items];
  for (const f of items.filter((x) => isFragment(x.question))) {
    const fw = answerWords(f.answer);
    const best = out.filter((o) => o !== f && !isFragment(o.question)).map((o) => ({ o, s: [...answerWords(o.answer)].filter((w) => fw.has(w)).length })).sort((a, b) => b.s - a.s)[0];
    if (!best || best.s === 0) continue;
    const o = best.o;
    o.sourceIds = [...new Set([...o.sourceIds, ...f.sourceIds])];
    o.occurrences += f.occurrences;
    if (f.lastSeenAt && (!o.lastSeenAt || f.lastSeenAt > o.lastSeenAt)) o.lastSeenAt = f.lastSeenAt;
    if (f.firstSeenAt && (!o.firstSeenAt || f.firstSeenAt < o.firstSeenAt)) o.firstSeenAt = f.firstSeenAt;
    if (f.requiresLiveLookup) o.requiresLiveLookup = true;
    out.splice(out.indexOf(f), 1);
  }
  return out;
}

export async function consolidateTopic(args: { tenantId: string; importId?: string; language: string; label: string; members: ConsolidationMember[]; docs?: Array<{ title: string; content: string }> }): Promise<CanonicalItem[]> {
  if (args.members.length < 2) return canonicalFrom(args.members, null);
  // The business's own documents on this topic: a policy fact they state wins (Omer 2026-11-18).
  const passages = args.docs?.length ? relevantPassages(args.members.map((m) => m.question).join(" "), args.members.map((m) => m.answer).join(" "), args.docs, 5) : [];
  const listing = args.members.map((m) => `${m.id} | ${m.lastSeenAt ? m.lastSeenAt.toISOString().slice(0, 10) : "undated"} | x${m.occurrenceCount}\n  Q: ${m.question}\n  A: ${m.answer}`).join("\n\n");
  const raw = await structuredCall({
    tenantId: args.tenantId, importId: args.importId, schema: ConsolidateSchema, tier: "import", maxTokens: 6000,
    feature: "historical_knowledge_consolidation", system: CONSOLIDATE_PROMPT + languageDirective(args.language),
    user: `Topic: ${args.label}\n${args.members.length} items:\n\n${listing}${passages.length ? `\n\nThe business's own documents:\n${passages.map((p) => `[${p.title}] ${p.text}`).join("\n")}` : "\n\nThe business's own documents: none on this topic."}`,
  });
  return foldFragments(canonicalFrom(args.members, raw));
}
