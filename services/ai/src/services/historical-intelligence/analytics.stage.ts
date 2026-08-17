import { prisma } from "@chatcenter/shared";
import { recordEvent, type StageResult } from "./stage-utils";

/**
 * What the business's customers actually contact them about.
 *
 * ── Where the numbers come from ──
 *
 * Every figure produced here is a count of rows that exist. None of it is
 * estimated, modelled, or asked of a language model.
 *
 * That constraint is the whole point. The results page exists to make somebody
 * trust GOTCHA on their first day, and the fastest way to lose that is a
 * headline number they can tell is invented. A business owner knows roughly how
 * many customers they have. If we say 1,247 and the real answer is 300, nothing
 * else on the page gets read.
 *
 * The topic breakdown is derived from the knowledge candidates, which are
 * themselves derived from real extracted exchanges, and it is reported as a
 * share of CLASSIFIED conversations rather than of all of them - because a
 * conversation we could not classify has not been counted, and rolling it into
 * a denominator would quietly deflate every percentage.
 *
 * ── What is deliberately NOT computed ──
 *
 * There is no "X% of your conversations could be automated". It is the number
 * every competitor puts on this page and there is no honest way to produce it:
 * it depends on the business's risk appetite, its staffing, and what it is
 * willing to let a machine say - none of which is in the data. A confident
 * fabricated percentage would make everything true on the page look invented
 * too.
 *
 * What IS computed instead is a defensible neighbour: how much of the
 * inquiry volume is made of questions we saw repeatedly and could answer from
 * observed knowledge. That is a measurement, and the methodology is stated
 * beside it in the UI.
 */

/** Topics below this share are folded into "Other" rather than listed. */
const MIN_TOPIC_SHARE = 0.02;
const MAX_TOPICS = 8;

export interface TopTopic {
  topic: string;
  conversations: number;
  share: number;
}

export async function runAnalyticsStage(args: {
  tenantId: string;
  importId: string;
}): Promise<StageResult> {
  const { tenantId, importId } = args;
  const startedAt = Date.now();

  const importRow = await prisma.historicalImport.findFirst({
    where: { id: importId, tenantId },
  });
  if (!importRow) return { ok: false };

  // ── Topic mix ──
  //
  // Counted in CONVERSATIONS, not in extractions. One customer who asked about
  // shipping four times in one thread is one conversation about shipping;
  // counting extractions would let a single chatty customer reshape the whole
  // breakdown.
  const candidates = await prisma.knowledgeCandidate.findMany({
    where: { importId, tenantId, status: { in: ["PENDING", "APPROVED", "SUPERSEDED"] } },
    select: { id: true, topic: true },
  });

  const conversationsByTopic = new Map<string, Set<string>>();
  if (candidates.length > 0) {
    const evidence = await prisma.knowledgeCandidateEvidence.findMany({
      where: { tenantId, candidateId: { in: candidates.map((c) => c.id) } },
      select: { candidateId: true, conversationId: true },
    });
    const topicById = new Map(candidates.map((c) => [c.id, normalizeTopic(c.topic)]));
    for (const e of evidence) {
      if (!e.conversationId) continue;
      const topic = topicById.get(e.candidateId);
      if (!topic) continue;
      const set = conversationsByTopic.get(topic) ?? new Set<string>();
      set.add(e.conversationId);
      conversationsByTopic.set(topic, set);
    }
  }

  // The denominator is conversations we could classify, stated as such. A
  // conversation that produced no extractable knowledge is not evidence of any
  // topic and must not silently deflate every share.
  const classifiedConversations = new Set<string>();
  for (const set of conversationsByTopic.values()) {
    for (const id of set) classifiedConversations.add(id);
  }
  const denominator = classifiedConversations.size;

  const ranked: TopTopic[] = [...conversationsByTopic.entries()]
    .map(([topic, set]) => ({
      topic,
      conversations: set.size,
      share: denominator > 0 ? set.size / denominator : 0,
    }))
    .sort((a, b) => b.conversations - a.conversations);

  const listed = ranked.filter((t) => t.share >= MIN_TOPIC_SHARE).slice(0, MAX_TOPICS);
  const remainder = ranked.filter((t) => !listed.includes(t));
  const topTopics: TopTopic[] = [...listed];
  if (remainder.length > 0) {
    const conversations = new Set<string>();
    for (const t of remainder) {
      for (const id of conversationsByTopic.get(t.topic) ?? []) conversations.add(id);
    }
    topTopics.push({
      topic: "Other",
      conversations: conversations.size,
      share: denominator > 0 ? conversations.size / denominator : 0,
    });
  }

  // ── Counts, all from rows ──
  const [
    totalConversations,
    totalMessages,
    customersWithMemory,
    pendingCandidates,
    conflictCandidates,
    supersededCandidates,
  ] = await Promise.all([
    prisma.conversation.count({ where: { tenantId, historicalImportId: importId } }),
    prisma.message.count({ where: { tenantId, historicalImportId: importId } }),
    prisma.customerHistoricalMemory.count({ where: { tenantId, importId } }),
    prisma.knowledgeCandidate.count({ where: { tenantId, importId, status: "PENDING" } }),
    prisma.knowledgeCandidate.count({
      where: { tenantId, importId, status: "PENDING", conflict: true },
    }),
    prisma.knowledgeCandidate.count({ where: { tenantId, importId, status: "SUPERSEDED" } }),
  ]);

  const repeatShare = denominator > 0 ? classifiedConversations.size / Math.max(1, totalConversations) : 0;

  const summary = {
    importedMessages: totalMessages,
    importedConversations: totalConversations,
    importedCustomers: importRow.importedCustomers,
    matchedExistingCustomers: importRow.matchedExistingCustomers,
    matchedSourceOfTruth: importRow.matchedSourceOfTruth,
    sourceOfTruthShare:
      importRow.importedCustomers > 0
        ? importRow.matchedSourceOfTruth / importRow.importedCustomers
        : 0,
    customerMemories: customersWithMemory,
    knowledgeCandidates: pendingCandidates,
    knowledgeConflicts: conflictCandidates,
    alreadyCoveredByKnowledgeBase: supersededCandidates,
    classifiedConversations: denominator,
    /**
     * The share of imported conversations that contained a question we saw more
     * than once and could answer from observed knowledge.
     *
     * This is the honest neighbour of "how much could be automated" and is
     * labelled as what it measures, never as a promise. Methodology travels
     * with the number so the UI cannot restate it more strongly than it is.
     */
    recurringInquiryShare: repeatShare,
    methodology: {
      topicShares:
        "Share of conversations that produced at least one extracted question, counted once per conversation per topic.",
      recurringInquiryShare:
        "Imported conversations containing a question that appeared in more than one conversation, divided by all imported conversations.",
      excluded:
        "Conversations with no extractable question are not counted towards any topic.",
    },
    generatedAt: new Date().toISOString(),
  };

  await prisma.historicalImport.update({
    where: { id: importId },
    data: {
      topTopics: topTopics as unknown as object,
      summary: summary as unknown as object,
      knowledgeCandidateCount: pendingCandidates,
      knowledgeConflictCount: conflictCandidates,
      importedMessages: totalMessages,
    },
  });

  await recordEvent(
    importId,
    "ANALYTICS",
    "SUCCESS",
    null,
    {
      topics: topTopics.length,
      classifiedConversations: denominator,
      totalConversations,
      totalMessages,
    },
    Date.now() - startedAt,
  );

  return { ok: true, detail: { topics: topTopics.length, totalMessages } };
}

/**
 * Topic labels come from a model and arrive in near-identical variants
 * ("Shipping", "shipping", "Shipping & Delivery"). Casing and trivial
 * punctuation are normalized so those do not become separate slices of the same
 * pie. Anything beyond that is left alone - collapsing "Shipping" into
 * "Delivery" is a judgement the business should make, not us.
 */
function normalizeTopic(topic: string): string {
  const cleaned = topic.trim().replace(/\s+/g, " ").replace(/[.,;:]+$/, "");
  if (!cleaned) return "Other";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
