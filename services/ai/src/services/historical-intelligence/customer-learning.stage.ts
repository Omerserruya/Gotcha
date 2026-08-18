import { z } from "zod";
import { prisma } from "@chatcenter/shared";
import { structuredCall } from "./llm";
import {
  recordEvent,
  loadConversationTranscript,
  renderTranscript,
  mapLimited,
  type StageResult,
} from "./stage-utils";

/**
 * What GOTCHA learns about each individual customer from their history.
 *
 * The goal is not a summary. A summary of a two-year relationship is read once
 * and never again. What an agent needs, months later and mid-conversation, is a
 * handful of things that are still true: that this person has bought before,
 * that size M did not fit them, that their last delivery was late, that they
 * always ask before ordering.
 *
 * ── The distinction that makes this safe ──
 *
 * "Customer is waiting for a package" was true for four days in March. Stored
 * as durable memory it becomes a lie that an AI will act on - greeting someone
 * about a parcel that arrived a year ago. "Customer previously experienced a
 * delayed shipment" stays true forever and is just as useful.
 *
 * That single distinction is the hardest part of this prompt and most of what
 * the schema is shaped to enforce. Speculative character reading is excluded
 * outright: it is unverifiable, it is uncomfortable when surfaced, and it is
 * not something a business needs in order to serve somebody well.
 */

const FactSchema = z.object({
  text: z
    .string()
    .min(3)
    .max(240)
    .describe("One durable observation, phrased in the past tense where it refers to an event"),
  category: z.enum([
    "purchase_history",
    "product_preference",
    "service_issue",
    "delivery_preference",
    "communication_pattern",
    "other",
  ]),
  confidence: z.enum(["high", "medium", "low"]),
});

const CustomerMemorySchema = z.object({
  /** Empty is a legitimate answer. Most short threads teach nothing durable. */
  facts: z.array(FactSchema).max(8),
  summary: z.string().max(600).optional(),
});

export type CustomerMemory = z.infer<typeof CustomerMemorySchema>;

const SYSTEM_PROMPT = `You extract durable, actionable facts about ONE customer from their past conversations with a business.

WHO IS WHO - READ THIS FIRST
Every transcript line is labeled "Customer:" or "Business:". Facts describe the person on the CUSTOMER side, based on what THEY wrote.
Some threads in this history are not customer relationships at all: the business owner was writing TO another business, and the "Customer:" side is that other company's agent or auto-responder (canned replies like "your request has been received", bots introducing themselves). That is not a customer. Return {"facts":[]} for such a thread - do not build a memory of a service center's answering machine.

WHAT TO EXTRACT
Only things that will still be true in a year and that would help someone serve this customer better:
- what they have bought, and how often
- product preferences and sizes that worked or did not
- service problems they experienced
- how they prefer to receive orders
- consistent patterns in how they buy (for example: always asks questions before purchasing)

WHAT TO REJECT
- Anything transient. "Is waiting for a package", "asked about order 4471 yesterday", "wants a refund" are states that expire. If the underlying event is durable, record the EVENT in the past tense instead: "previously experienced a delayed shipment".
- Speculation about personality, mood, intelligence, wealth or character.
- Anything about a specific order number, tracking code, address or payment detail.
- Anything you inferred rather than observed. If the transcript does not show it, it did not happen.
- Restatements of what the business said unless the customer confirmed it.

CONFIDENCE
high   = stated plainly and more than once, or explicitly confirmed
medium = stated once, clearly
low    = implied but reasonably supported. Do not go below this; omit instead.

An empty facts array is a correct and common answer for a short or unremarkable conversation. Never invent facts to fill it.

Reply with ONLY a JSON object:
{"facts":[{"text":"...","category":"purchase_history","confidence":"high"}],"summary":"..."}
The summary is at most two sentences describing this customer's relationship with the business, or omit it entirely if there is nothing to say.`;

/** LLM calls in flight at once across customers. */
const CONCURRENCY = 4;

/**
 * A thread with almost nothing in it teaches nothing, and asking anyway costs a
 * call per customer across a thousand customers. Three inbound messages is the
 * floor at which a relationship exists at all.
 */
const MIN_INBOUND_MESSAGES = 3;

/** Rows handled per job, so one job stays bounded and resumable. */
const BATCH_SIZE = 60;

export async function runCustomerLearningStage(args: {
  tenantId: string;
  importId: string;
}): Promise<StageResult & { done: boolean }> {
  const { tenantId, importId } = args;
  const startedAt = Date.now();

  const pending = await prisma.historicalCustomer.findMany({
    where: { importId, tenantId, learningStatus: "PENDING" },
    select: {
      id: true,
      externalId: true,
      normalizedPhone: true,
      contactId: true,
      conversationId: true,
      inboundCount: true,
      messageCount: true,
    },
    orderBy: { messageCount: "desc" },
    take: BATCH_SIZE,
  });

  if (pending.length === 0) {
    await recordEvent(importId, "CUSTOMER_LEARNING", "SUCCESS", "no customers pending");
    return { ok: true, done: true };
  }

  let learned = 0;
  let skipped = 0;
  let failed = 0;

  await mapLimited(pending, CONCURRENCY, async (customer) => {
    if (!customer.conversationId || customer.inboundCount < MIN_INBOUND_MESSAGES) {
      await prisma.historicalCustomer.update({
        where: { id: customer.id },
        data: { learningStatus: "SKIPPED" },
      });
      skipped += 1;
      return;
    }

    const transcript = await loadConversationTranscript({
      tenantId,
      conversationId: customer.conversationId,
    });
    const rendered = renderTranscript(transcript);
    if (!rendered.trim()) {
      await prisma.historicalCustomer.update({
        where: { id: customer.id },
        data: { learningStatus: "SKIPPED" },
      });
      skipped += 1;
      return;
    }

    const memory = await structuredCall({
      tenantId,
      importId,
      schema: CustomerMemorySchema,
      system: SYSTEM_PROMPT,
      user: `Conversation history with one customer:\n\n${rendered}`,
      feature: "historical_customer_memory",
      maxTokens: 900,
    });

    if (!memory) {
      await prisma.historicalCustomer.update({
        where: { id: customer.id },
        data: { learningStatus: "FAILED", learningError: "no schema-valid model output" },
      });
      failed += 1;
      return;
    }

    // Nothing durable found is a real outcome, not a failure. Writing an empty
    // memory row would put "we know nothing about this person" into agent
    // context, which is worse than saying nothing.
    if (memory.facts.length === 0) {
      await prisma.historicalCustomer.update({
        where: { id: customer.id },
        data: { learningStatus: "SKIPPED" },
      });
      skipped += 1;
      return;
    }

    const key = customer.normalizedPhone || customer.externalId;
    const now = new Date();

    // Upsert, never append.
    //
    // This is what makes a retry safe. The unique key is (tenant, customer), so
    // a re-run REPLACES what we knew rather than adding a second copy of it -
    // a crashed pipeline cannot leave one customer carrying three versions of
    // the same observation.
    await prisma.customerHistoricalMemory.upsert({
      where: { tenantId_customerExternalId: { tenantId, customerExternalId: key } },
      create: {
        tenantId,
        customerExternalId: key,
        contactId: customer.contactId,
        facts: memory.facts.map((f) => ({
          ...f,
          evidenceConversationIds: [customer.conversationId],
          firstSeenAt: transcript[0]?.at?.toISOString() ?? now.toISOString(),
          lastSeenAt: transcript[transcript.length - 1]?.at?.toISOString() ?? now.toISOString(),
        })) as unknown as object,
        summary: memory.summary ?? null,
        source: "historical_whatsapp_import",
        importId,
        messageCount: customer.messageCount,
      },
      update: {
        contactId: customer.contactId,
        facts: memory.facts.map((f) => ({
          ...f,
          evidenceConversationIds: [customer.conversationId],
          firstSeenAt: transcript[0]?.at?.toISOString() ?? now.toISOString(),
          lastSeenAt: transcript[transcript.length - 1]?.at?.toISOString() ?? now.toISOString(),
        })) as unknown as object,
        summary: memory.summary ?? null,
        source: "historical_whatsapp_import",
        importId,
        messageCount: customer.messageCount,
      },
    });

    await prisma.historicalCustomer.update({
      where: { id: customer.id },
      data: { learningStatus: "DONE", learningError: null },
    });
    learned += 1;
  });

  // Counted from rows rather than accumulated, so the number the customer sees
  // survives a crash halfway through a batch.
  const analyzed = await prisma.historicalCustomer.count({
    where: { importId, tenantId, learningStatus: { not: "PENDING" } },
  });
  await prisma.historicalImport.update({
    where: { id: importId },
    data: { customersAnalyzed: analyzed },
  });

  const remaining = await prisma.historicalCustomer.count({
    where: { importId, tenantId, learningStatus: "PENDING" },
  });

  await recordEvent(
    importId,
    "CUSTOMER_LEARNING",
    failed > 0 ? "PARTIAL" : "SUCCESS",
    null,
    { batch: pending.length, learned, skipped, failed, analyzed, remaining },
    Date.now() - startedAt,
  );

  return { ok: true, done: remaining === 0, detail: { learned, skipped, failed, remaining } };
}
