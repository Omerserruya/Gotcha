import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "@chatcenter/shared";
import { structuredCall } from "./llm";
import { clusterText, embedForCluster, findCluster, indexCluster } from "./candidate-index";
import {
  recordEvent,
  loadConversationTranscript,
  renderTranscript,
  mapLimited,
  tenantPromptLanguage,
  languageDirective,
  type StageResult,
} from "./stage-utils";

/**
 * Mining the unwritten operating knowledge of the business out of its own
 * conversations.
 *
 * A business's real policies rarely live in a document. They live in the two
 * hundred times somebody asked "can I exchange this after a month" and an
 * employee answered. This stage finds those exchanges, turns them into
 * question/answer candidates, and merges each one into the cluster it belongs
 * to as it goes.
 *
 * ── What it must not produce ──
 *
 * The failure mode here is volume, not scarcity. A naive extractor returns a
 * thousand items, most of which are one customer's order status, somebody's
 * address, a greeting, or a promotion that ended last spring. A review queue
 * with a thousand items in it is a review queue nobody opens, so the prompt
 * spends most of its length on exclusion and this stage deliberately produces
 * fewer, stronger items.
 *
 * ── Why extraction is per conversation ──
 *
 * A question and its answer are two messages apart at minimum and often ten,
 * with the real answer arriving after a clarification. One call per message
 * could never see the pair. One call per conversation sees it, costs one call
 * per customer rather than one per message, and is the smallest unit that
 * contains a complete exchange.
 *
 * ── Why clustering happens here rather than afterwards ──
 *
 * Merging as we go keeps memory flat and the work resumable: each batch leaves
 * the candidate set complete and correct for everything seen so far, so a crash
 * costs one batch rather than the whole import. A separate global pass would
 * have to hold every extraction from every customer at once.
 */

const RawCandidateSchema = z.object({
  topic: z
    .string()
    .min(2)
    .max(60)
    .describe("A short reusable category, for example: Shipping, Returns & Exchanges, Sizing"),
  question: z.string().min(5).max(300).describe("The customer's question, generalized"),
  answer: z.string().min(5).max(800).describe("The business's answer, stated as reusable policy"),
  // Required, not optional: the quotes are the only thing the direction guard
  // below can verify against the transcript. An extraction that cannot point
  // at the exact Customer line it read the question from and the exact
  // Business line it read the answer from is unverifiable, and unverifiable
  // here has a concrete failure mode - see directionGuard.
  quotedQuestion: z.string().min(5).max(400).describe("Verbatim quote of the Customer line the question came from"),
  quotedAnswer: z.string().min(5).max(600).describe("Verbatim quote of the Business line the answer came from"),
});

const ExtractionSchema = z.object({
  items: z.array(RawCandidateSchema).max(8),
});

const SYSTEM_PROMPT = `You read one customer's conversation history with a business and extract REUSABLE business knowledge: questions this business gets asked, and the factual answers it gave.

EXTRACT knowledge that would help answer a DIFFERENT customer in future:
- store policies (returns, exchanges, warranty, cancellation)
- shipping methods, costs and timeframes
- sizing and fit guidance
- payment methods
- opening hours, locations, branches
- how stock and restocking work
- product facts that apply to a product line, not one unit
- procedures the business follows

WHO SAID WHAT - ABSOLUTE:
- Every transcript line is labeled "Customer:" or "Business:". An answer may come ONLY from a "Business:" line. A question may come ONLY from a "Customer:" line. Never swap these roles, no matter how much a Customer line sounds like a policy statement.
- Some conversations in this history are the business owner talking to OTHER businesses (suppliers, service centers, bots). There the "Customer:" side is another company's agent or auto-reply ("your request has been received", "here is our service bot"). That is the OTHER business's knowledge, not this one's. Extract NOTHING from such a conversation - an empty list is the correct answer.

NEVER extract:
- Anything a "Customer:" line stated, even if it reads like policy. Auto-replies and bot messages the business RECEIVED are the clearest case: they are someone else's knowledge.
- Anything specific to one customer or one order. Order numbers, tracking codes, names, addresses, phone numbers, payment details, "your parcel is in Modiin".
- Greetings, thanks, small talk, or the scheduling of a single call.
- The status of one order at one moment.
- Promotions or prices unless stated as a standing rule. A discount code or a sale that ran on a date is not durable knowledge.
- Anything the employee was clearly unsure about ("I think", "let me check", "probably"). An uncertain human answer is not policy.
- Anything the customer asserted that the business did not confirm.
- Anything you are inferring. If the business did not say it, it is not knowledge.

HOW TO PHRASE IT
- question: generalize away the individual. "Can I exchange the shirt I bought on Sunday?" becomes "Can an item be exchanged after purchase?"
- answer: state it as a rule that applies to anyone, in the business's own terms. Do not add conditions the business did not state, and do not soften an answer that was given plainly.
- Keep the business's own numbers exactly. If they said 45 days, write 45 days.
- quotedQuestion: the exact "Customer:" line the question came from, verbatim. quotedAnswer: the exact "Business:" line the answer came from, verbatim. Items whose quotes are not found in the transcript on the correct side are discarded.

Return AT MOST 8 items, and prefer few strong ones over many weak ones. An empty list is a correct answer for a conversation that was only about one order.

Reply with ONLY a JSON object: {"items":[{"topic":"...","question":"...","answer":"...","quotedQuestion":"...","quotedAnswer":"..."}]}`;

const CONCURRENCY = 4;
const BATCH_SIZE = 40;

/** Below this there is no exchange to mine: a question, an answer, some context. */
const MIN_MESSAGES = 4;

/**
 * How many distinct answers we keep for one clustered question before we stop
 * adding more. Three variants is already an unmistakable "your team does not
 * agree about this"; a fourth adds nothing a reviewer can act on.
 */
const MAX_VARIANTS = 3;

export async function runKnowledgeExtractionStage(args: {
  tenantId: string;
  importId: string;
}): Promise<StageResult & { done: boolean }> {
  const { tenantId, importId } = args;
  const startedAt = Date.now();
  // Generated fields follow the org's system language; verbatim quotes do not.
  const language = await tenantPromptLanguage(tenantId);

  // Ordered by volume, then paged by how many we have already done. The
  // customers who talked most produce the densest knowledge, so an import cut
  // short still has the best material in it.
  const alreadyDone = await extractedConversationCount(importId);
  const customers = await prisma.historicalCustomer.findMany({
    where: {
      importId,
      tenantId,
      conversationId: { not: null },
      messageCount: { gte: MIN_MESSAGES },
    },
    select: {
      conversationId: true,
      externalId: true,
      normalizedPhone: true,
      messageCount: true,
    },
    orderBy: [{ messageCount: "desc" }, { externalId: "asc" }],
    take: BATCH_SIZE,
    skip: alreadyDone,
  });

  if (customers.length === 0) {
    await recordEvent(importId, "KNOWLEDGE_EXTRACTION", "SUCCESS", "nothing left to extract", {
      conversations: 0,
    });
    return { ok: true, done: true };
  }

  let extracted = 0;
  let merged = 0;
  let created = 0;
  let conflicts = 0;
  let failures = 0;
  let rejectedByDirection = 0;

  await mapLimited(customers, CONCURRENCY, async (customer) => {
    const transcript = await loadConversationTranscript({
      tenantId,
      conversationId: customer.conversationId!,
    });
    const rendered = renderTranscript(transcript);
    if (!rendered.trim()) return;

    const result = await structuredCall({
      tenantId,
      importId,
      schema: ExtractionSchema,
      system: SYSTEM_PROMPT + languageDirective(language),
      user: `Conversation history between a business and one of its customers:\n\n${rendered}`,
      feature: "historical_knowledge_extraction",
      maxTokens: 1600,
    });

    if (!result) {
      failures += 1;
      return;
    }

    const occurredAt = transcript[transcript.length - 1]?.at ?? null;
    const customerKey = customer.normalizedPhone || customer.externalId;

    for (const item of result.items) {
      // The guard the prompt cannot be trusted to be: the quoted answer must
      // actually be something the BUSINESS sent, and the quoted question
      // something the CUSTOMER sent. The failure mode is real, not
      // theoretical: this history contains threads where the business owner
      // was the CUSTOMER of some other business, and that side's auto-replies
      // ("your request has been received and will be handled shortly") read
      // exactly like policy. The model mined them as this business's answers.
      // Knowledge may enter the pipeline ONLY from the business's own
      // messages; questions only from the customer's.
      if (
        !quoteMatchesDirection(transcript, item.quotedAnswer, "OUTBOUND") ||
        !quoteMatchesDirection(transcript, item.quotedQuestion, "INBOUND")
      ) {
        rejectedByDirection += 1;
        continue;
      }
      extracted += 1;
      const outcome = await mergeIntoCluster({
        tenantId,
        importId,
        item,
        conversationId: customer.conversationId!,
        customerKey,
        occurredAt,
      });
      if (outcome === "created") created += 1;
      else if (outcome === "merged") merged += 1;
      else if (outcome === "conflict") {
        merged += 1;
        conflicts += 1;
      }
    }
  });

  await recordEvent(
    importId,
    "KNOWLEDGE_EXTRACTION",
    failures > 0 ? "PARTIAL" : "SUCCESS",
    null,
    {
      conversations: customers.length,
      extracted,
      created,
      merged,
      newConflicts: conflicts,
      failures,
      rejectedByDirection,
    },
    Date.now() - startedAt,
  );

  return {
    ok: true,
    done: customers.length < BATCH_SIZE,
    detail: { extracted, created, merged, conflicts, failures, rejectedByDirection },
  };
}

/**
 * Does this quote actually appear in the transcript ON THE CLAIMED SIDE?
 *
 * The renderer clips each line to 400 chars before the model sees it, so the
 * quote may be a prefix of the stored body. A 60-char normalized head is long
 * enough to be unambiguous and short enough to survive the clipping. The
 * reverse containment (body inside quote) covers a model that quoted a short
 * line and kept typing; the length floor stops a two-word body ("תודה רבה")
 * from matching everything.
 */
export function quoteMatchesDirection(
  transcript: Array<{ direction: "INBOUND" | "OUTBOUND"; body: string }>,
  quote: string,
  direction: "INBOUND" | "OUTBOUND",
): boolean {
  const q = normalizeForMatch(quote);
  if (q.length < 5) return false;
  const head = q.slice(0, 60);
  return transcript.some((m) => {
    if (m.direction !== direction) return false;
    const b = normalizeForMatch(m.body);
    if (b.length === 0) return false;
    return b.includes(head) || (b.length >= 20 && q.includes(b.slice(0, 60)));
  });
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

type MergeOutcome = "created" | "merged" | "conflict" | "skipped";

/**
 * Put one extraction where it belongs: into an existing candidate, or into a
 * new one.
 */
async function mergeIntoCluster(args: {
  tenantId: string;
  importId: string;
  item: z.infer<typeof RawCandidateSchema>;
  conversationId: string;
  customerKey: string;
  occurredAt: Date | null;
}): Promise<MergeOutcome> {
  const { tenantId, importId, item, conversationId, customerKey, occurredAt } = args;

  const vector = await embedForCluster(tenantId, clusterText(item.topic, item.question));
  if (!vector) return "skipped";

  const existing = await findCluster({ tenantId, importId, vector });

  if (!existing) {
    // Qdrant point ids must be a UUID or an integer, so the candidate's row id
    // is a UUID too and the two stay the same value. Same approach the KB
    // chunks already take.
    const candidateId = randomUUID();
    const clusterKey = candidateId;
    try {
      await prisma.knowledgeCandidate.create({
        data: {
          id: candidateId,
          tenantId,
          importId,
          topic: item.topic.trim(),
          question: item.question.trim(),
          answer: item.answer.trim(),
          clusterKey,
          occurrenceCount: 1,
          customerCount: 1,
          firstSeenAt: occurredAt,
          lastSeenAt: occurredAt,
          variants: [
            {
              key: variantKey(item.answer),
              answer: item.answer.trim(),
              occurrenceCount: 1,
              customerCount: 1,
            },
          ] as unknown as object,
        },
      });
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
      return "skipped";
    }
    await addEvidence({
      tenantId,
      candidateId,
      conversationId,
      item,
      occurredAt,
      representative: true,
    });
    await indexCluster({ pointId: candidateId, tenantId, importId, candidateId, vector });
    return "created";
  }

  return mergeIntoExisting({
    tenantId,
    candidateId: existing.candidateId,
    item,
    conversationId,
    customerKey,
    occurredAt,
  });
}

/**
 * Fold an extraction into a candidate that already exists, and notice when the
 * business has answered the same question two different ways.
 *
 * The conflict check is the reason variants are kept at all. Two answers to one
 * question is not noise to be averaged - it is the single most valuable thing
 * this pipeline can surface, because it means the business itself does not have
 * a settled answer and every customer who asks gets a coin flip. Choosing one
 * silently would hide that and enshrine a guess as policy.
 */
async function mergeIntoExisting(args: {
  tenantId: string;
  candidateId: string;
  item: z.infer<typeof RawCandidateSchema>;
  conversationId: string;
  customerKey: string;
  occurredAt: Date | null;
}): Promise<MergeOutcome> {
  const { tenantId, candidateId, item, conversationId, customerKey, occurredAt } = args;

  const candidate = await prisma.knowledgeCandidate.findFirst({
    where: { id: candidateId, tenantId },
    select: {
      id: true,
      variants: true,
      occurrenceCount: true,
      firstSeenAt: true,
      lastSeenAt: true,
      status: true,
    },
  });
  if (!candidate) return "skipped";

  // A candidate the owner has already decided on is left alone. Re-opening a
  // rejected suggestion because a fifth customer asked the same thing would
  // make rejection meaningless.
  if (candidate.status !== "PENDING") return "skipped";

  const variants = normalizeVariants(candidate.variants);
  const key = variantKey(item.answer);
  const existingVariant = variants.find((v) => v.key === key);

  let isNewVariant = false;
  if (existingVariant) {
    existingVariant.occurrenceCount += 1;
  } else if (variants.length < MAX_VARIANTS) {
    variants.push({
      key,
      answer: item.answer.trim(),
      occurrenceCount: 1,
      customerCount: 1,
    });
    isNewVariant = true;
  }

  // Distinct customers, counted from the evidence rows rather than incremented.
  // "126 conversations, 103 customers" is only meaningful if the second number
  // is really distinct people, and one customer asking six times must not read
  // as six customers.
  const distinctCustomers = await countDistinctCustomers(tenantId, candidateId, customerKey);

  const conflict = variants.length > 1;
  // The variant the business actually gave most often becomes the headline
  // answer. It is still only a suggestion, and on a conflicted candidate the UI
  // shows every variant rather than this one.
  const dominant = [...variants].sort((a, b) => b.occurrenceCount - a.occurrenceCount)[0];

  await prisma.knowledgeCandidate.updateMany({
    where: { id: candidateId, tenantId, status: "PENDING" },
    data: {
      occurrenceCount: { increment: 1 },
      customerCount: distinctCustomers,
      answer: dominant?.answer ?? item.answer.trim(),
      conflict,
      variants: variants as unknown as object,
      firstSeenAt:
        candidate.firstSeenAt && occurredAt && occurredAt < candidate.firstSeenAt
          ? occurredAt
          : candidate.firstSeenAt ?? occurredAt,
      lastSeenAt:
        candidate.lastSeenAt && occurredAt && occurredAt > candidate.lastSeenAt
          ? occurredAt
          : candidate.lastSeenAt ?? occurredAt,
    },
  });

  await addEvidence({
    tenantId,
    candidateId,
    conversationId,
    item,
    occurredAt,
    // A new variant always gets a shown example. Without one, "we found
    // conflicting answers" is an assertion the reviewer cannot check.
    representative: isNewVariant,
    variantKey: key,
  });

  return conflict && isNewVariant ? "conflict" : "merged";
}

interface Variant {
  key: string;
  answer: string;
  occurrenceCount: number;
  customerCount: number;
}

function normalizeVariants(raw: unknown): Variant[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v) => v && typeof v === "object")
    .map((v: any) => ({
      key: String(v.key ?? variantKey(String(v.answer ?? ""))),
      answer: String(v.answer ?? ""),
      occurrenceCount: Number(v.occurrenceCount ?? 0) || 0,
      customerCount: Number(v.customerCount ?? 0) || 0,
    }))
    .filter((v) => v.answer.length > 0);
}

/**
 * A stable key for "is this the same answer".
 *
 * Deliberately crude: lowercase, strip punctuation, collapse whitespace. It
 * groups "Within 45 days." and "within 45 days" and separates "30 days" from
 * "45 days", which is the distinction that matters. Anything cleverer risks
 * merging two answers that differ only in the number - the exact case a
 * conflict must be raised for.
 */
function variantKey(answer: string): string {
  return answer
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

async function countDistinctCustomers(
  tenantId: string,
  candidateId: string,
  newCustomerKey: string,
): Promise<number> {
  const rows = await prisma.knowledgeCandidateEvidence.findMany({
    // Scoped by tenant as well as by candidate. A cuid is unguessable and the
    // candidate was already resolved under a tenant filter, so this is
    // redundant today - and it is exactly the kind of redundancy that stops
    // being redundant the first time somebody adds a lookup by something other
    // than a primary key.
    where: { tenantId, candidateId },
    select: { conversationId: true },
  });
  const keys = new Set(rows.map((r) => r.conversationId ?? "").filter(Boolean));
  keys.add(newCustomerKey);
  return keys.size;
}

/**
 * The conversations behind a candidate.
 *
 * Only a handful are marked representative. The review UI shows those; the rest
 * exist so a reviewer who wants to check can, and so the count on the card is
 * backed by rows rather than by a number somebody incremented.
 */
async function addEvidence(args: {
  tenantId: string;
  candidateId: string;
  conversationId: string;
  item: z.infer<typeof RawCandidateSchema>;
  occurredAt: Date | null;
  representative: boolean;
  variantKey?: string;
}): Promise<void> {
  const existingRepresentatives = args.representative
    ? 0
    : await prisma.knowledgeCandidateEvidence.count({
        where: { tenantId: args.tenantId, candidateId: args.candidateId, representative: true },
      });

  await prisma.knowledgeCandidateEvidence.create({
    data: {
      candidateId: args.candidateId,
      tenantId: args.tenantId,
      conversationId: args.conversationId,
      variantKey: args.variantKey ?? null,
      questionText: (args.item.quotedQuestion || args.item.question).slice(0, 400),
      answerText: (args.item.quotedAnswer || args.item.answer).slice(0, 600),
      occurredAt: args.occurredAt,
      representative: args.representative || existingRepresentatives < 3,
    },
  });
}

/**
 * How many conversations this import has already extracted from.
 *
 * Read from the audit trail rather than a new column: extraction is the only
 * stage whose unit of work has no per-row status of its own, and the event log
 * already records exactly this number for every batch that ran.
 */
async function extractedConversationCount(importId: string): Promise<number> {
  const events = await prisma.historicalImportEvent.findMany({
    where: { importId, step: "KNOWLEDGE_EXTRACTION" },
    select: { detail: true },
  });
  let total = 0;
  for (const e of events) {
    const d = e.detail as Record<string, unknown> | null;
    if (d && typeof d.conversations === "number") total += d.conversations;
  }
  return total;
}
