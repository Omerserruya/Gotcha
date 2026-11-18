import { z } from "zod";
import { prisma } from "@chatcenter/shared";
import { structuredCall } from "./llm";
import { randomUUID } from "crypto";
import { consolidateTopic } from "./consolidation";
import { shapeTopics } from "./topic-shaping";
import { dropCandidateVectors } from "./candidate-index";
import { matchQuote } from "./knowledge-extraction.stage";
import {
  recordEvent,
  mapLimited,
  tenantPromptLanguage,
  languageDirective,
  loadConversationTranscript,
  automatedOutboundTexts,
  type StageResult,
} from "./stage-utils";

/**
 * The passes after curation (2026-11-18, Omer: Smoovee's 711 candidates sat unreviewed).
 *
 * 1. Cross-check against the tenant's own knowledge documents: a candidate that contradicts a document is
 *    marked for the reviewer (curationNote starts with DOC_CONFLICT), and a document that presents ANOTHER
 *    business as this one (Smoovee's terms naming "ניו אייג' אסטתיקס") is reported.
 * 2. Topics: the candidates grouped into about 30 to 80 topics, each with one merged answer, its occurrences,
 *    when it was last seen and source quotes. A reviewer reads topics, not 711 rows. The grouping is recorded
 *    as the KNOWLEDGE_TOPICS event (no new columns) and read by GET /:id/topics.
 * 3. Auto-approve: only computed (HISTORICAL_IMPORT_AUTO_APPROVE is a flag for later, default off). Nothing here
 *    publishes or approves anything.
 */

/** The prefix a contradiction with a knowledge document gets in curationNote: machine-readable, shown as is. */
export const DOC_CONFLICT = "[doc-conflict]";

const CheckSchema = z.object({
  results: z.array(z.object({
    id: z.string(),
    relation: z.enum(["agrees", "contradicts", "unrelated"]),
    note: z.string().max(200).optional(),
    /** For "contradicts": the document's title and its sentence that contradicts, for the person approving. */
    document: z.string().max(200).optional(),
    passage: z.string().max(400).optional(),
  })).max(40),
});

const CHECK_PROMPT = `You compare answers mined from a business's conversations with the business's own written knowledge.
For each item you get the question, the answer the business gave in chats, and passages from its documents.
- "contradicts": a passage states something that cannot be true together with the answer (a different price, time, place, rule or condition). Note in one short line what differs, naming the document title; give "document" (the title exactly as shown in brackets) and "passage" (the document's sentence that contradicts, copied as written, at most 160 characters).
- "agrees": a passage says the same thing.
- "unrelated": no passage is about this question.
Judge only what is written. A passage that says less is not a contradiction.
Every id you are given must appear exactly once. Reply with ONLY JSON: {"results":[{"id":"...","relation":"contradicts","note":"...","document":"...","passage":"..."}]}`;

const ForeignSchema = z.object({ names: z.array(z.string().max(80)).max(10) });
const FOREIGN_PROMPT = `You read one document from a business's knowledge base. The business is named below.
List the names of OTHER businesses that the document presents as if they were this business: the seller, the service provider, the party to the terms, "we". Do not list suppliers, brands it sells, couriers, payment providers or partners mentioned as such.
Reply with ONLY JSON: {"names":["..."]}. An empty list when there are none.`;

const TopicAssignSchema = z.object({
  topics: z.array(z.object({ label: z.string().min(2).max(60), ids: z.array(z.string()).min(1) })).max(40),
});
const TOPIC_PROMPT = `You group question/answer items of one business into TOPICS a reviewer can read one at a time.
A topic is one subject a customer asks about ("משלוחים לאילת", "מימוש נקודות", "התאמת משטח למכשיר"), narrower than the category, wider than one phrasing.
Put items that a single knowledge article would answer into the same topic. Aim for few topics: merge when in doubt.
Every id must appear in exactly one topic. Use the business's language for labels, three to five words.
Reply with ONLY JSON: {"topics":[{"label":"...","ids":["...","..."]}]}`;

const MergeSchema = z.object({ answer: z.string().min(2).max(1500) });
const MERGE_PROMPT = `You write ONE knowledge article from several answers a business gave about one topic.
- Use only what the answers say. Never add a fact, a number, a condition or a promise.
- Where answers differ, the NEWEST one (by its date) is the business's current answer; do not mention older ones.
- Write it as the business stating its own policy, clearly, in a few sentences or short lines.
Reply with ONLY JSON: {"answer":"..."}`;

/** A document conflict with its source, for the review screen (both sides shown). */
export interface DocConflictSource { documentId: string | null; document: string | null; passage: string | null; note: string }

/**
 * The tenant's real document a cross-check note names (the model's title is never trusted: Smoovee's 13 notes
 * spell one catalogue four ways, with ״, „ ”, « » and bare). Titles compared without quote marks, dashes,
 * punctuation and spacing; the model's `document` first, then its note; else, when every passage sent came from
 * one document, that one; else null.
 */
const titleKey = (s: unknown) => String(s ?? "").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
export function matchDocument(docs: Array<{ id: string; title: string }>, said: unknown, note: unknown, sent: Array<{ title: string }>): { id: string; title: string } | null {
  const keyed = docs.map((d) => ({ d, k: titleKey(d.title) })).filter((x) => x.k.length >= 2);
  const exact = (s: unknown) => { const k = titleKey(s); return k ? keyed.find((x) => x.k === k)?.d ?? null : null; };
  // The longest title the note contains, so "שאלות נפוצות" is not taken for "שאלות".
  const inNote = (s: unknown) => { const k = titleKey(s); return keyed.filter((x) => x.k.length >= 3 && k.includes(x.k)).sort((a, b) => b.k.length - a.k.length)[0]?.d ?? null; };
  const hit = exact(said) ?? inNote(said) ?? inNote(note);
  if (hit) return { id: hit.id, title: hit.title };
  const titles = [...new Set(sent.map((p) => p.title))];
  if (titles.length === 1) { const d = docs.find((x) => x.title === titles[0]); if (d) return { id: d.id, title: d.title }; }
  return null;
}

export interface TopicGroup {
  label: string;
  category: string | null;
  candidateIds: string[];
  mergedAnswer: string | null;
  occurrences: number;
  customers: number;
  lastSeenAt: string | null;
  /** A candidate in it whose conflict the newest answer does not settle (per question, not per topic). */
  conflict: boolean;
  unresolvedConflicts: number;
  docConflict: boolean;
  quotes: Array<{ question: string; answer: string; occurredAt: string | null }>;
  autoApprovable: number;
}

/** HISTORICAL_IMPORT_AUTO_APPROVE=true|1: a flag for later; this stage only counts, it never approves. */
export function autoApproveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.HISTORICAL_IMPORT_AUTO_APPROVE ?? "").trim());
}

/**
 * Would this candidate be approved without a person? Human-sourced (a person's line behind it), asked at least 3
 * times, no conflict between answers or with a document, curated "kept", and no live data.
 */
export function autoApprovable(c: {
  humanSourced: boolean;
  occurrenceCount: number;
  conflict: boolean;
  variants?: unknown;
  curationVerdict: string | null;
  curationNote: string | null;
  requiresLiveLookup: boolean;
}): boolean {
  return c.humanSourced
    && c.occurrenceCount >= 3
    && !unresolvedConflict(c)
    && !String(c.curationNote ?? "").startsWith(DOC_CONFLICT)
    && (c.curationVerdict === "kept" || c.curationVerdict === "rewritten")
    && !c.requiresLiveLookup;
}

/**
 * A conflict the newest person answer does NOT settle (dry run 2026-11-18: 45 of 103 topics "conflicted", every
 * big one). Settled when the newest answer first appeared after every other answer was last given: the business
 * switched (Nesher to Tivon). Unsettled when the answers alternate, share a last date, or are undated. Judged per
 * candidate (one question), never per topic: a topic holds different questions.
 */
export function unresolvedConflict(c: { conflict: boolean; variants?: unknown }): boolean {
  if (!c.conflict) return false;
  const vs = (Array.isArray(c.variants) ? c.variants : []).filter((v: any) => v && typeof v === "object") as Array<{ firstSeenAt?: string; lastSeenAt?: string }>;
  // Flagged without two variants to compare: nothing shows it settled.
  if (vs.length < 2) return true;
  // Marked unresolved by the consolidation (the model saw them overlap): unresolved, whatever the dates say.
  if (vs.some((v: any) => v.unresolved === true)) return true;
  const newest = [...vs].sort((a, b) => String(b.lastSeenAt ?? "").localeCompare(String(a.lastSeenAt ?? "")))[0];
  const start = String(newest.firstSeenAt ?? newest.lastSeenAt ?? "");
  if (!start) return true;
  return vs.some((v) => v !== newest && (!v.lastSeenAt || String(v.lastSeenAt) >= start));
}

/** The stems a question and a passage share: enough to send the passage along, never a verdict. */
const stems = (t: string) => new Set((String(t ?? "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((w) => w.replace(/^[הובלמשכ](?=[֐-׿]{3,})/u, "").slice(0, 5)));
export function relevantPassages(question: string, answer: string, docs: Array<{ title: string; content: string }>, max = 3): Array<{ title: string; text: string }> {
  const q = stems(`${question} ${answer}`);
  const scored: Array<{ title: string; text: string; score: number }> = [];
  for (const d of docs) {
    for (const p of String(d.content ?? "").split(/\n{2,}|(?<=[.!?])\s+(?=\S)/u).map((x) => x.trim()).filter((x) => x.length >= 20)) {
      let score = 0;
      for (const s of stems(p)) if (q.has(s)) score++;
      if (score >= 2) scored.push({ title: d.title, text: p.slice(0, 500), score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map(({ title, text }) => ({ title, text }));
}

export interface ReviewCandidate {
  id: string; topic: string; category: string | null; question: string; answer: string;
  occurrenceCount: number; customerCount: number; lastSeenAt: Date | null; conflict: boolean; variants?: unknown;
  curationVerdict: string | null; curationNote: string | null; requiresLiveLookup: boolean;
}
export interface ReviewEvidence { candidateId: string; conversationId: string | null; questionText: string; answerText: string; occurredAt: Date | null }

/**
 * The review aids from data handed in: the stage reads it from the database, the dry run (dry-run-import.ts) from
 * memory. Writes only through onContradiction, which the dry run leaves out.
 */
export async function buildReview(input: {
  tenantId: string;
  importId?: string;
  language: string;
  tenantName: string;
  candidates: ReviewCandidate[];
  evidence: ReviewEvidence[];
  humanSourced: ReadonlySet<string>;
  docs: Array<{ id: string; title: string; content: string }>;
  onContradiction?: (candidateId: string, note: string, source?: DocConflictSource) => Promise<void>;
  /** The topics as already decided (after consolidation): no topic call, and no cross-check (done once before). */
  fixedGroups?: Array<{ label: string; category: string; ids: string[] }>;
}): Promise<{
  topics: TopicGroup[]; topicCount: number; candidates: number; contradictions: number;
  foreignBusinessDocs: Array<{ documentId: string; title: string; names: string[] }>;
  humanSourced: number; autoApprovable: number; autoApproveEnabled: boolean;
}> {
  const { tenantId, importId, candidates, evidence, humanSourced, docs } = input;
  const directive = languageDirective(input.language);

  // ── 1. The tenant's own documents ──
  let contradictions = 0;
  const checkable = docs.length && !input.fixedGroups
    ? candidates.map((c) => ({ c, passages: relevantPassages(c.question, c.answer, docs) })).filter((x) => x.passages.length > 0)
    : [];
  for (let i = 0; i < checkable.length; i += 20) {
    const batch = checkable.slice(i, i + 20);
    const result = await structuredCall({
      tenantId, importId, schema: CheckSchema, system: CHECK_PROMPT + directive, tier: "import", maxTokens: 4000,
      feature: "historical_knowledge_crosscheck",
      user: batch.map(({ c, passages }) => `${c.id}\n  Q: ${c.question}\n  A: ${c.answer}\n${passages.map((p) => `  [${p.title}] ${p.text}`).join("\n")}`).join("\n\n"),
    });
    for (const r of result?.results ?? []) {
      const hit = batch.find((x) => x.c.id === r.id);
      if (!hit || r.relation !== "contradicts") continue;
      const note = `${DOC_CONFLICT} ${String(r.note ?? "").trim()}`.trim().slice(0, 300);
      // A real document of the tenant, matched in code; its stored title, never the model's spelling.
      const doc = matchDocument(docs, r.document, r.note, hit.passages);
      const passage = doc ? String(r.passage ?? "").trim().slice(0, 160) || null : null;
      await input.onContradiction?.(hit.c.id, note, { documentId: doc?.id ?? null, document: doc?.title ?? null, passage, note: String(r.note ?? "").trim().slice(0, 200) });
      hit.c.curationNote = note;
      contradictions++;
    }
  }

  const foreign: Array<{ documentId: string; title: string; names: string[] }> = [];
  await mapLimited(input.fixedGroups ? [] : docs, 3, async (d) => {
    const r = await structuredCall({
      tenantId, importId, schema: ForeignSchema, system: FOREIGN_PROMPT, tier: "import", maxTokens: 800,
      feature: "historical_knowledge_crosscheck",
      user: `The business: ${input.tenantName}\nDocument title: ${d.title}\n\n${String(d.content ?? "").slice(0, 6000)}`,
    });
    const own = String(input.tenantName ?? "").trim().toLowerCase();
    const names = (r?.names ?? []).map((n) => n.trim()).filter((n) => n && n.toLowerCase() !== own);
    if (names.length) foreign.push({ documentId: d.id, title: d.title, names });
  });

  // ── 2. Topics, per category ──
  const byCategory = new Map<string, ReviewCandidate[]>();
  for (const c of candidates) {
    const k = c.category ?? "OTHER";
    byCategory.set(k, [...(byCategory.get(k) ?? []), c]);
  }
  const groups: Array<{ label: string; category: string; ids: string[] }> = input.fixedGroups ? input.fixedGroups.map((g) => ({ ...g, ids: g.ids.filter((id) => candidates.some((c) => c.id === id)) })).filter((g) => g.ids.length) : [];
  for (const [category, items] of input.fixedGroups ? [] : byCategory) {
    const assigned = new Set<string>();
    if (items.length > 1) {
      const r = await structuredCall({
        tenantId, importId, schema: TopicAssignSchema, system: TOPIC_PROMPT + directive, tier: "import", maxTokens: 8000,
        feature: "historical_knowledge_topics",
        user: `Category ${category}, ${items.length} items:\n\n${items.map((c) => `${c.id} | ${c.topic} | ${c.question}`).join("\n")}`,
      });
      for (const t of r?.topics ?? []) {
        const ids = t.ids.filter((id) => items.some((c) => c.id === id) && !assigned.has(id));
        ids.forEach((id) => assigned.add(id));
        if (ids.length) groups.push({ label: t.label.trim(), category, ids });
      }
    }
    // Whatever the model left out keeps its own topic label: never lost from the review.
    for (const c of items.filter((x) => !assigned.has(x.id))) {
      assigned.add(c.id);
      const same = groups.find((g) => g.category === category && g.label === c.topic);
      if (same) same.ids.push(c.id);
      else groups.push({ label: c.topic, category, ids: [c.id] });
    }
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const topics: TopicGroup[] = [];
  await mapLimited(groups, 4, async (g) => {
    const members = g.ids.map((id) => byId.get(id)!).filter(Boolean);
    const quotes = evidence.filter((e) => g.ids.includes(e.candidateId))
      .sort((a, b) => (b.occurredAt?.getTime() ?? 0) - (a.occurredAt?.getTime() ?? 0)).slice(0, 3)
      .map((e) => ({ question: e.questionText, answer: e.answerText, occurredAt: e.occurredAt ? e.occurredAt.toISOString() : null }));
    let mergedAnswer: string | null = members.length === 1 ? members[0].answer : null;
    if (members.length > 1) {
      const r = await structuredCall({
        tenantId, importId, schema: MergeSchema, system: MERGE_PROMPT + directive, tier: "import", maxTokens: 2000,
        feature: "historical_knowledge_topics",
        user: `Topic: ${g.label}\n\n${members.map((c) => `[${c.lastSeenAt ? c.lastSeenAt.toISOString().slice(0, 10) : "undated"}] Q: ${c.question}\nA: ${c.answer}`).join("\n\n")}`,
      });
      mergedAnswer = r?.answer?.trim() || null;
    }
    const last = members.map((c) => c.lastSeenAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    topics.push({
      label: g.label,
      category: g.category,
      candidateIds: members.map((c) => c.id),
      mergedAnswer,
      occurrences: members.reduce((n, c) => n + c.occurrenceCount, 0),
      customers: members.reduce((n, c) => n + c.customerCount, 0),
      lastSeenAt: last ? new Date(last).toISOString() : null,
      conflict: members.some((c) => unresolvedConflict(c)),
      unresolvedConflicts: members.filter((c) => unresolvedConflict(c)).length,
      docConflict: members.some((c) => String(c.curationNote ?? "").startsWith(DOC_CONFLICT)),
      quotes,
      autoApprovable: members.filter((c) => autoApprovable({ ...c, humanSourced: humanSourced.has(c.id) })).length,
    });
  });
  topics.sort((a, b) => Number(b.conflict || b.docConflict) - Number(a.conflict || a.docConflict) || b.occurrences - a.occurrences);

  return {
    topics,
    topicCount: topics.length,
    candidates: candidates.length,
    contradictions,
    foreignBusinessDocs: foreign,
    humanSourced: humanSourced.size,
    autoApprovable: topics.reduce((n, t) => n + t.autoApprovable, 0),
    autoApproveEnabled: autoApproveEnabled(),
  };
}

/** Human-sourced: a representative quote of the candidate is a PERSON's line in its conversation. */
export async function humanSourcedIds(tenantId: string, evidence: ReviewEvidence[]): Promise<Set<string>> {
  const automated = await automatedOutboundTexts(tenantId);
  const out = new Set<string>();
  const transcripts = new Map<string, Awaited<ReturnType<typeof loadConversationTranscript>>>();
  await mapLimited([...new Set(evidence.map((e) => e.conversationId).filter(Boolean) as string[])], 4, async (conversationId) => {
    transcripts.set(conversationId, await loadConversationTranscript({ tenantId, conversationId, automated }));
  });
  for (const e of evidence) {
    const t = e.conversationId ? transcripts.get(e.conversationId) : null;
    if (t && matchQuote(t, e.answerText, "OUTBOUND")) out.add(e.candidateId);
  }
  return out;
}

export async function runKnowledgeReviewStage(args: { tenantId: string; importId: string }): Promise<StageResult> {
  const { tenantId, importId } = args;
  const startedAt = Date.now();
  const language = await tenantPromptLanguage(tenantId);

  const candidates = await prisma.knowledgeCandidate.findMany({
    where: { tenantId, importId, status: "PENDING" },
    orderBy: [{ category: "asc" }, { topic: "asc" }],
    select: {
      id: true, topic: true, category: true, question: true, answer: true, occurrenceCount: true, customerCount: true,
      lastSeenAt: true, conflict: true, variants: true, curationVerdict: true, curationNote: true, requiresLiveLookup: true,
    },
  });
  if (candidates.length === 0) {
    await recordEvent(importId, "KNOWLEDGE_TOPICS", "SKIPPED", "nothing to review", { topics: [] });
    return { ok: true, detail: { topics: 0 } };
  }
  // Not the documents this import approved: those would only agree with themselves.
  const docs = await prisma.knowledgeDocument.findMany({
    where: { tenantId, approvedFromCandidates: { none: {} } },
    select: { id: true, title: true, content: true },
    take: 60,
  });
  const evidence = await prisma.knowledgeCandidateEvidence.findMany({
    where: { tenantId, candidateId: { in: candidates.map((c) => c.id) }, representative: true },
    select: { candidateId: true, conversationId: true, questionText: true, answerText: true, occurredAt: true },
  });
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  // Each document conflict with its document and sentence (read by GET /:id/topics, no new columns).
  const conflictSource = new Map<string, DocConflictSource>();
  const first = await buildReview({
    tenantId, importId, language, tenantName: tenant?.name ?? "", candidates, evidence,
    humanSourced: await humanSourcedIds(tenantId, evidence), docs,
    onContradiction: async (id, note, source) => {
      if (source) conflictSource.set(id, source);
      await prisma.knowledgeCandidate.updateMany({ where: { id, tenantId, status: "PENDING" }, data: { curationNote: note } });
    },
  });

  // Consolidation: per topic, a small canonical set replaces its items (2026-11-18). The canonical rows take the
  // items' evidence; the items and their vectors go, the way dedupe merges.
  const fresh = await prisma.knowledgeCandidate.findMany({
    where: { tenantId, importId, status: "PENDING" },
    select: { id: true, topic: true, category: true, question: true, answer: true, reasoning: true, occurrenceCount: true, customerCount: true, firstSeenAt: true, lastSeenAt: true, curationVerdict: true, curationNote: true, requiresLiveLookup: true },
  });
  const freshById = new Map(fresh.map((c) => [c.id, c]));
  const fixedGroups: Array<{ label: string; category: string; ids: string[] }> = [];
  let canonicalCount = 0, replaced = 0, unresolved = 0, switched = 0;
  // What each canonical item chose and what it replaced, for the review (read by GET /:id/topics).
  const choices: Record<string, { chosen: unknown; previous: unknown; policy: boolean }> = {};
  const docConflicts: Record<string, DocConflictSource> = {};
  // The tail joined to its topics, the big topics split (2026-11-18, the Smoovee rerun): the groups consolidated.
  const shaped = await shapeTopics({
    tenantId, importId, language,
    groups: first.topics.map((t) => ({ label: t.label, category: t.category ?? "OTHER", candidateIds: t.candidateIds.filter((id) => freshById.has(id)) })).filter((g) => g.candidateIds.length),
    byId: new Map(fresh.map((c) => [c.id, { id: c.id, question: c.question, answer: c.answer }])),
  });
  await mapLimited(shaped.groups, 4, async (t) => {
    const members = t.candidateIds.map((id) => freshById.get(id)).filter(Boolean) as any[];
    if (members.length < 2) { fixedGroups.push({ label: t.label, category: t.category ?? "OTHER", ids: members.map((m) => m.id) }); canonicalCount += members.length; return; }
    const canon = await consolidateTopic({ tenantId, importId, language, label: t.label, members, docs });
    const ids: string[] = [];
    for (const c of canon) {
      // An item placed alone and unchanged keeps its row.
      if (c.sourceIds.length === 1 && c.status === "ok" && c.answer === freshById.get(c.sourceIds[0])?.answer) {
        ids.push(c.sourceIds[0]);
        const s0 = conflictSource.get(c.sourceIds[0]);
        if (s0) docConflicts[c.sourceIds[0]] = s0;
        continue;
      }
      const src = c.sourceIds.map((id) => freshById.get(id)!).filter(Boolean);
      const id = randomUUID();
      await prisma.knowledgeCandidate.create({
        data: {
          id, tenantId, importId, topic: t.label.slice(0, 60), category: src[0]?.category ?? t.category ?? "OTHER", scope: "standing_rule",
          question: c.question, answer: c.answer, reasoning: src.find((m) => m.reasoning)?.reasoning ?? null, clusterKey: id,
          occurrenceCount: c.occurrences, customerCount: src.reduce((n, m) => n + (m.customerCount ?? 0), 0),
          firstSeenAt: c.firstSeenAt, lastSeenAt: c.lastSeenAt, conflict: c.conflict, variants: c.variants as any,
          requiresLiveLookup: c.requiresLiveLookup, curationVerdict: c.curationVerdict, curationNote: c.curationNote,
        },
      });
      await prisma.knowledgeCandidateEvidence.updateMany({ where: { tenantId, candidateId: { in: c.sourceIds } }, data: { candidateId: id } });
      const gone = c.sourceIds.filter((sid) => sid !== id);
      await dropCandidateVectors(tenantId, gone).catch(() => undefined);
      await prisma.knowledgeCandidate.deleteMany({ where: { tenantId, importId, status: "PENDING", id: { in: gone } } });
      replaced += gone.length;
      ids.push(id);
      if (c.chosen || c.previous) choices[id] = { chosen: c.chosen, previous: c.previous, policy: c.policy };
      // The conflict stays with the canonical item while it still carries it (a document that was chosen settles it).
      const src0 = String(c.curationNote ?? "").startsWith(DOC_CONFLICT) ? c.sourceIds.map((sid) => conflictSource.get(sid)).find(Boolean) : undefined;
      if (src0) docConflicts[id] = src0;
      if (c.status === "unresolved") unresolved++;
      if (c.status === "switched") switched++;
    }
    canonicalCount += ids.length;
    fixedGroups.push({ label: t.label, category: t.category ?? "OTHER", ids });
  });

  // The topics again, over the canonical items, with the same labels.
  const after = await prisma.knowledgeCandidate.findMany({
    where: { tenantId, importId, status: "PENDING" },
    select: { id: true, topic: true, category: true, question: true, answer: true, occurrenceCount: true, customerCount: true, lastSeenAt: true, conflict: true, variants: true, curationVerdict: true, curationNote: true, requiresLiveLookup: true },
  });
  const evidence2 = await prisma.knowledgeCandidateEvidence.findMany({
    where: { tenantId, candidateId: { in: after.map((c) => c.id) }, representative: true },
    select: { candidateId: true, conversationId: true, questionText: true, answerText: true, occurredAt: true },
  });
  const second = await buildReview({
    tenantId, importId, language, tenantName: tenant?.name ?? "", candidates: after, evidence: evidence2,
    humanSourced: await humanSourcedIds(tenantId, evidence2), docs, fixedGroups,
  });
  const detail = { ...second, contradictions: first.contradictions, foreignBusinessDocs: first.foreignBusinessDocs, consolidation: { before: candidates.length, canonical: canonicalCount, replaced, switched, unresolved }, choices, docConflicts, shaping: shaped.detail };
  await recordEvent(importId, "KNOWLEDGE_TOPICS", "SUCCESS", null, detail as any, Date.now() - startedAt);
  return { ok: true, detail: { topics: detail.topicCount, contradictions: detail.contradictions, foreign: detail.foreignBusinessDocs.length } };
}
