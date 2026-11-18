/**
 * Re-run a history import's knowledge pipeline over its existing conversations and WRITE NOTHING to the
 * database (2026-11-18, Omer: Smoovee's 711 candidates). Extraction, clustering, dedupe, curation and the review
 * (cross-check, topics) run in memory with the current code, and the result goes to a report file next to a
 * comparison with the import's current candidates.
 *
 * The only rows written are the model calls' usage logs, all in the platform-paid "historical_import" lane
 * (feature suffix "_import", outside every tenant figure and budget). No candidate, vector, document, event or
 * import row is touched. The console prints counts only; the report file holds the source quotes.
 *
 *   HISTORICAL_IMPORT_MODEL=gpt-6-luna npx tsx src/scripts/dry-run-import.ts --import <id> [--out <file>] [--limit <n>]
 */
import fs from "fs";
import { prisma, withHistoricalRecords } from "@chatcenter/shared";
import { initAIService, platformPaidScope } from "../services/ai.service";
import { structuredCall, getImportModel } from "../services/historical-intelligence/llm";
import { ExtractionSchema, SYSTEM_PROMPT, parseItems, matchQuote, currentVariant } from "../services/historical-intelligence/knowledge-extraction.stage";
import { judgeSpecificity, redactSpecifics, oneOffOrFluff } from "../services/historical-intelligence/specificity";
import { DEDUPE_PROMPT, DedupeSchema } from "../services/historical-intelligence/knowledge-dedupe.stage";
import { CURATION_PROMPT, CurationSchema, judgeAll } from "../services/historical-intelligence/knowledge-curation.stage";
import { buildReview, humanSourcedIds, autoApprovable, type ReviewCandidate, type ReviewEvidence } from "../services/historical-intelligence/knowledge-review.stage";
import { embedForCluster } from "../services/historical-intelligence/candidate-index";
import { consolidateTopic, type CanonicalItem } from "../services/historical-intelligence/consolidation";
import {
  loadConversationTranscript,
  renderTranscript,
  automatedOutboundTexts,
  mapLimited,
  tenantPromptLanguage,
  languageDirective,
} from "../services/historical-intelligence/stage-utils";

export function parseDryRunArgs(argv: string[]): { importId: string; out: string; limit: number | null } {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const importId = String(get("--import") ?? "").trim();
  if (!importId) throw new Error("usage: dry-run-import.ts --import <id> [--out <file>] [--limit <n>]");
  const limit = get("--limit") ? Number(get("--limit")) : null;
  if (limit !== null && !(limit > 0)) throw new Error("--limit must be a positive number");
  return { importId, out: get("--out") ?? `/tmp/dry-run-import-${importId}.json`, limit };
}

/** Same cut as the clustering stage (CLUSTER_THRESHOLD in candidate-index). */
const CLUSTER_THRESHOLD = 0.9;
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface MemVariant { key: string; answer: string; occurrenceCount: number; customerCount: number; firstSeenAt?: string; lastSeenAt?: string }
export interface MemCandidate {
  id: string; topic: string; category: string; question: string; answer: string; scope: string;
  vector: number[] | null; variants: MemVariant[]; occurrenceCount: number; customers: Set<string>;
  lastSeenAt: Date | null; evidence: ReviewEvidence[];
  curationVerdict: string | null; curationNote: string | null; requiresLiveLookup: boolean;
}
const keyOf = (a: string) => a.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim().slice(0, 160);

/** Fold one answer into a candidate's variants: the newest person answer heads it (as the stage does). */
export function foldVariant(c: MemCandidate, answer: string, at: Date | null, customer: string): void {
  const key = keyOf(answer);
  const iso = at?.toISOString();
  const v = c.variants.find((x) => x.key === key);
  if (v) {
    v.occurrenceCount++;
    if (iso && (!v.lastSeenAt || iso > v.lastSeenAt)) v.lastSeenAt = iso;
    if (iso && (!v.firstSeenAt || iso < v.firstSeenAt)) v.firstSeenAt = iso;
  } else c.variants.push({ key, answer: answer.trim(), occurrenceCount: 1, customerCount: 1, ...(iso ? { firstSeenAt: iso, lastSeenAt: iso } : {}) });
  c.variants = [...c.variants].sort((a, b) => String(b.lastSeenAt ?? "").localeCompare(String(a.lastSeenAt ?? "")) || b.occurrenceCount - a.occurrenceCount).slice(0, 3);
  c.answer = currentVariant(c.variants)?.answer ?? c.answer;
  c.occurrenceCount++;
  c.customers.add(customer);
  if (at && (!c.lastSeenAt || at > c.lastSeenAt)) c.lastSeenAt = at;
}

async function main(): Promise<void> {
  const args = parseDryRunArgs(process.argv.slice(2));
  initAIService({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    defaultModel: process.env.OPENAI_DEFAULT_MODEL || undefined,
    defaultEmbeddingModel: process.env.EMBEDDING_MODEL || undefined,
  });
  const imp = await prisma.historicalImport.findUnique({ where: { id: args.importId }, select: { id: true, tenantId: true } });
  if (!imp) throw new Error(`import ${args.importId} not found`);
  const tenantId = imp.tenantId;
  const importId = imp.id;
  console.log(`[dry-run-import] import ${importId}, model ${getImportModel()}, writes nothing but usage logs (lane historical_import)`);

  await platformPaidScope.run({ reason: "historical_import" }, async () => {
    const language = await tenantPromptLanguage(tenantId);
    const directive = languageDirective(language);
    const automated = await automatedOutboundTexts(tenantId);
    const customers = await prisma.historicalCustomer.findMany({
      where: { importId, tenantId, conversationId: { not: null }, messageCount: { gte: 4 } },
      select: { conversationId: true, externalId: true, normalizedPhone: true },
      orderBy: [{ messageCount: "desc" }, { externalId: "asc" }],
      ...(args.limit ? { take: args.limit } : {}),
    });

    const counts = { conversations: customers.length, items: 0, botSourced: 0, wrongSide: 0, specific: 0, oneOff: 0, failures: 0, kept: 0 };
    type Extract = { item: ReturnType<typeof parseItems>[number]; conversationId: string; customer: string; at: Date | null };
    const extracts: Extract[] = [];

    // ── Extraction ──
    await mapLimited(customers, 4, async (cu) => {
      const transcript = await loadConversationTranscript({ tenantId, conversationId: cu.conversationId!, automated });
      const rendered = renderTranscript(transcript);
      if (!rendered.trim()) return;
      const r = await structuredCall({ tenantId, importId, schema: ExtractionSchema, system: SYSTEM_PROMPT + directive, tier: "import", maxTokens: 4000, feature: "historical_knowledge_extraction", user: `Conversation history between a business and one of its customers:\n\n${rendered}` });
      if (!r) { counts.failures++; return; }
      for (let item of parseItems(r.items)) {
        counts.items++;
        const person = matchQuote(transcript, item.quotedAnswer, "OUTBOUND");
        const asked = matchQuote(transcript, item.quotedQuestion, "INBOUND");
        if (!person || !asked) {
          // The model quoted a bot line: what the old pipeline would have kept as "Business".
          if (asked && matchQuote(transcript.map((t) => ({ ...t, speaker: undefined })), item.quotedAnswer, "OUTBOUND")) counts.botSourced++;
          else counts.wrongSide++;
          continue;
        }
        let verdict = judgeSpecificity(item);
        if (!verdict.ok && !verdict.reasons.includes("one-off-scope")) {
          const red = { ...item, question: redactSpecifics(item.question), answer: redactSpecifics(item.answer) };
          const again = judgeSpecificity(red);
          if (again.ok) { item = red; verdict = again; }
        }
        if (!verdict.ok) { counts.specific++; continue; }
        if (oneOffOrFluff(item)) { counts.oneOff++; continue; }
        counts.kept++;
        extracts.push({ item, conversationId: cu.conversationId!, customer: cu.normalizedPhone || cu.externalId, at: person.at ?? null });
      }
    });
    console.log(`[dry-run-import] extraction: ${JSON.stringify(counts)}`);

    // ── Clustering, in memory ──
    let clusters: MemCandidate[] = [];
    let seq = 0;
    for (const e of extracts) {
      const vector = await embedForCluster(tenantId, e.item.question);
      const best = vector ? clusters.map((c) => ({ c, s: c.vector ? cosine(vector, c.vector) : 0 })).sort((a, b) => b.s - a.s)[0] : undefined;
      const ev: ReviewEvidence = { candidateId: "", conversationId: e.conversationId, questionText: e.item.quotedQuestion.slice(0, 400), answerText: e.item.quotedAnswer.slice(0, 600), occurredAt: e.at };
      if (best && best.s >= CLUSTER_THRESHOLD) {
        foldVariant(best.c, e.item.answer, e.at, e.customer);
        if (best.c.evidence.length < 3) best.c.evidence.push({ ...ev, candidateId: best.c.id });
        continue;
      }
      const c: MemCandidate = {
        id: `m${++seq}`, topic: e.item.topic, category: e.item.category, question: e.item.question, answer: e.item.answer, scope: e.item.scope,
        vector, variants: [], occurrenceCount: 0, customers: new Set(), lastSeenAt: null, evidence: [],
        curationVerdict: null, curationNote: null, requiresLiveLookup: false,
      };
      foldVariant(c, e.item.answer, e.at, e.customer);
      c.evidence.push({ ...ev, candidateId: c.id });
      clusters.push(c);
    }
    const afterClustering = clusters.length;

    // ── Dedupe, in memory ──
    clusters.sort((a, b) => a.category.localeCompare(b.category) || a.topic.localeCompare(b.topic) || a.question.localeCompare(b.question));
    let dedupeMerged = 0;
    for (let i = 0; i < clusters.length; i += 60) {
      const batch = clusters.slice(i, i + 60);
      const r = await structuredCall({ tenantId, importId, schema: DedupeSchema, system: DEDUPE_PROMPT + directive, tier: "import", maxTokens: 4000, feature: "historical_knowledge_dedupe", user: `Candidates (id | topic | question):\n\n${batch.map((c) => `${c.id} | ${c.topic} | ${c.question}`).join("\n")}` });
      const seen = new Set<string>();
      for (const g of r?.groups ?? []) {
        const members = g.ids.filter((id) => batch.some((c) => c.id === id) && !seen.has(id)).map((id) => batch.find((c) => c.id === id)!);
        members.forEach((m) => seen.add(m.id));
        if (members.length < 2) continue;
        const survivor = members.reduce((a, b) => (b.occurrenceCount > a.occurrenceCount ? b : a));
        for (const o of members.filter((m) => m !== survivor)) {
          for (const v of o.variants) for (let k = 0; k < v.occurrenceCount; k++) foldVariant(survivor, v.answer, v.lastSeenAt ? new Date(v.lastSeenAt) : null, `merged:${o.id}`);
          survivor.occurrenceCount = survivor.occurrenceCount - o.variants.reduce((n, v) => n + v.occurrenceCount, 0) + o.occurrenceCount;
          o.customers.forEach((x) => survivor.customers.add(x));
          survivor.customers.forEach((x) => { if (x.startsWith("merged:")) survivor.customers.delete(x); });
          survivor.evidence.push(...o.evidence.map((e) => ({ ...e, candidateId: survivor.id })).slice(0, Math.max(0, 3 - survivor.evidence.length)));
          dedupeMerged++;
        }
        survivor.question = g.question;
        survivor.topic = g.topic;
        clusters = clusters.filter((c) => !members.includes(c) || c === survivor);
      }
    }

    // ── Curation, in memory ──
    const verdicts = new Map<string, any>();
    for (let i = 0; i < clusters.length; i += 40) {
      const batch = clusters.slice(i, i + 40).map((c) => ({ id: c.id, question: c.question, answer: c.answer, topic: c.topic, occurrenceCount: c.occurrenceCount }));
      const m = await judgeAll(batch, (items) => structuredCall({ tenantId, importId, schema: CurationSchema, system: CURATION_PROMPT + directive, tier: "import", maxTokens: 6000, feature: "historical_knowledge_curation", user: `Review these ${items.length} items:\n\n${items.map((c) => `${c.id}\n  topic: ${c.topic}\n  Q: ${c.question}\n  A: ${c.answer}`).join("\n\n")}` }));
      for (const [k, v] of m) verdicts.set(k, v);
    }
    const curation = { kept: 0, rewritten: 0, liveData: 0, dropped: 0, duplicates: 0, unjudged: 0 };
    clusters = clusters.filter((c) => {
      const v = verdicts.get(c.id);
      if (!v) { curation.unjudged++; c.curationVerdict = "unjudged"; return true; }
      if (v.verdict === "drop") { curation.dropped++; return false; }
      if (v.verdict === "duplicate" && v.duplicateOf && v.duplicateOf !== c.id) { curation.duplicates++; return false; }
      if ((v.verdict === "rewrite" || v.verdict === "live_data") && String(v.answer ?? "").trim()) {
        c.answer = String(v.answer).trim();
        c.requiresLiveLookup = v.verdict === "live_data";
        c.curationVerdict = v.verdict === "live_data" ? "live_data" : "rewritten";
        c.curationNote = v.note?.trim() || null;
        if (v.verdict === "live_data") curation.liveData++; else curation.rewritten++;
        return true;
      }
      c.curationVerdict = "kept";
      curation.kept++;
      return true;
    });

    // ── Review: cross-check and topics ──
    const docs = await prisma.knowledgeDocument.findMany({ where: { tenantId, approvedFromCandidates: { none: {} } }, select: { id: true, title: true, content: true }, take: 60 });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    const review = await buildReview({
      tenantId, importId, language, tenantName: tenant?.name ?? "", docs,
      candidates: clusters.map((c): ReviewCandidate => ({
        id: c.id, topic: c.topic, category: c.category, question: c.question, answer: c.answer, occurrenceCount: c.occurrenceCount,
        customerCount: c.customers.size, lastSeenAt: c.lastSeenAt, conflict: c.variants.length > 1, variants: c.variants, curationVerdict: c.curationVerdict,
        curationNote: c.curationNote, requiresLiveLookup: c.requiresLiveLookup,
      })),
      evidence: clusters.flatMap((c) => c.evidence),
      // Every new candidate came from a person's line: extraction admits nothing else now.
      humanSourced: new Set(clusters.map((c) => c.id)),
    });

    // ── The import's current candidates, for comparison ──
    const current = await prisma.knowledgeCandidate.findMany({
      where: { tenantId, importId },
      select: { id: true, status: true, question: true, answer: true, curationVerdict: true, conflict: true },
    });
    const currentEvidence = await withHistoricalRecords(() => prisma.knowledgeCandidateEvidence.findMany({
      where: { tenantId, candidateId: { in: current.map((c) => c.id) }, representative: true },
      select: { candidateId: true, conversationId: true, questionText: true, answerText: true, occurredAt: true },
    }));
    const currentHuman = await humanSourcedIds(tenantId, currentEvidence);
    const withEvidence = new Set(currentEvidence.map((e) => e.candidateId));
    const comparison = {
      current: current.length,
      currentPending: current.filter((c) => c.status === "PENDING").length,
      currentNoVerdict: current.filter((c) => !c.curationVerdict).length,
      currentConflicts: current.filter((c) => c.conflict).length,
      currentBotSourced: current.filter((c) => withEvidence.has(c.id) && !currentHuman.has(c.id)).length,
      currentOneOffOrFluff: current.filter((c) => oneOffOrFluff(c)).length,
      now: clusters.length,
      nowTopics: review.topicCount,
      mergedByClustering: counts.kept - afterClustering,
      mergedByDedupe: dedupeMerged,
    };

    const report = {
      importId, tenantId, model: getImportModel(), generatedAt: new Date().toISOString(),
      extraction: counts, curation, comparison,
      contradictions: review.contradictions, foreignBusinessDocs: review.foreignBusinessDocs,
      autoApprovable: review.autoApprovable,
      topics: review.topics.map((t) => ({
        ...t,
        items: t.candidateIds.map((id) => {
          const c = clusters.find((x) => x.id === id)!;
          return { question: c.question, answer: c.answer, occurrences: c.occurrenceCount, lastSeenAt: c.lastSeenAt?.toISOString() ?? null, source: "person", verdict: c.curationVerdict, note: c.curationNote, variants: c.variants.map(({ answer, occurrenceCount, lastSeenAt }) => ({ answer, occurrenceCount, lastSeenAt })) };
        }),
      })),
    };
    // ── Consolidation, in memory: per topic, the canonical set (2026-11-18) ──
    const byIdC = new Map(clusters.map((c) => [c.id, c]));
    const canonical: Array<CanonicalItem & { topic: string; category: string }> = [];
    await mapLimited(review.topics, 4, async (t) => {
      const members = t.candidateIds.map((id) => byIdC.get(id)).filter(Boolean).map((c) => ({
        id: c!.id, question: c!.question, answer: c!.answer, occurrenceCount: c!.occurrenceCount,
        firstSeenAt: c!.variants.map((v) => v.firstSeenAt).filter(Boolean).sort()[0] ? new Date(c!.variants.map((v) => v.firstSeenAt).filter(Boolean).sort()[0]!) : c!.lastSeenAt,
        lastSeenAt: c!.lastSeenAt, curationVerdict: c!.curationVerdict, curationNote: c!.curationNote, requiresLiveLookup: c!.requiresLiveLookup,
      }));
      const out = await consolidateTopic({ tenantId, importId, language, label: t.label, members });
      for (const it of out) canonical.push({ ...it, topic: t.label, category: t.category ?? "OTHER" });
    });
    const canonApprovable = canonical.filter((c) => autoApprovable({ humanSourced: true, occurrenceCount: c.occurrences, conflict: c.conflict, variants: c.variants, curationVerdict: c.curationVerdict, curationNote: c.curationNote, requiresLiveLookup: c.requiresLiveLookup }));
    const canonByCat: Record<string, number> = {};
    for (const c of canonApprovable) canonByCat[c.category] = (canonByCat[c.category] ?? 0) + 1;
    (report as any).consolidation = {
      before: clusters.length, canonical: canonical.length,
      switched: canonical.filter((c) => c.status === "switched").length,
      unresolved: canonical.filter((c) => c.status === "unresolved").length,
      autoApprovable: canonApprovable.length, autoApprovableByCategory: canonByCat,
      samples: canonical.filter((c) => c.sourceIds.length > 1).slice(0, 8).map((c) => ({ topic: c.topic, question: c.question, answer: c.answer, status: c.status, note: c.note, sources: c.sourceIds.length, occurrences: c.occurrences })),
      conflicts: canonical.filter((c) => c.status !== "ok").slice(0, 20).map((c) => ({ topic: c.topic, question: c.question, status: c.status, note: c.note, competing: c.variants.map((v) => ({ answer: v.answer, lastSeenAt: v.lastSeenAt, occurrences: v.occurrenceCount })) })),
    };
    console.log(`[dry-run-import] consolidation ${clusters.length} -> ${canonical.length} canonical (switched ${(report as any).consolidation.switched}, unresolved ${(report as any).consolidation.unresolved}), auto-approvable ${canonApprovable.length} ${JSON.stringify(canonByCat)}`);

    // Auto-approvable per category, and five of them to read (2026-11-18).
    const approvable = clusters.filter((c) => autoApprovable({ humanSourced: true, occurrenceCount: c.occurrenceCount, conflict: c.variants.length > 1, variants: c.variants, curationVerdict: c.curationVerdict, curationNote: c.curationNote, requiresLiveLookup: c.requiresLiveLookup }));
    const byCat: Record<string, number> = {};
    for (const c of approvable) byCat[c.category] = (byCat[c.category] ?? 0) + 1;
    (report as any).autoApprovableByCategory = byCat;
    (report as any).autoApprovableSamples = approvable.slice(0, 5).map((c) => ({ category: c.category, question: c.question, answer: c.answer, occurrences: c.occurrenceCount }));
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`[dry-run-import] curation ${JSON.stringify(curation)}`);
    console.log(`[dry-run-import] comparison ${JSON.stringify(comparison)}`);
    console.log(`[dry-run-import] topics ${review.topicCount} (with an unresolved conflict ${review.topics.filter((t) => t.conflict).length}), contradictions ${review.contradictions}, other-business docs ${review.foreignBusinessDocs.length}, auto-approvable ${approvable.length}`);
    console.log(`[dry-run-import] auto-approvable by category ${JSON.stringify(byCat)}`);
    console.log(`[dry-run-import] report: ${args.out}`);
  });
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error("[dry-run-import] failed:", err?.message ?? err); process.exit(1); });
}
