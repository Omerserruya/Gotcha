/**
 * Run the reworked history processing against a real import and PRINT what it
 * would produce. Writes nothing: no candidates, no vectors, no knowledge
 * documents, no import-row updates.
 *
 * The point is to see the shape of the output before paying for persistence and
 * a review UI around it. The knowledge half is sampled (one LLM call per
 * conversation, so a full 1,033-customer import is 1,033 calls); the brand-voice
 * half is exhaustive, because it is pure counting and costs nothing to run over
 * every message.
 *
 *   tsx src/scripts/dry-run-intelligence.ts <importId> [sampleSize]
 */
import { prisma, withHistoricalRecords } from "@chatcenter/shared";
// A standalone script gets none of the service bootstrap, and the OpenAI client
// is module state that index.ts installs at startup. Without this every call
// fails with "Not initialized" and the retry layer reports it as a network
// error, which is a long way from the truth.
import { initAIService } from "../services/ai.service";
import { structuredCall } from "../services/historical-intelligence/llm";
import {
  ExtractionSchema,
  SYSTEM_PROMPT,
  parseItems,
  quoteMatchesDirection,
} from "../services/historical-intelligence/knowledge-extraction.stage";
import { judgeSpecificity, redactSpecifics } from "../services/historical-intelligence/specificity";
import {
  analyzeBrandVoice,
  renderVoiceStats,
  type VoiceMessage,
} from "../services/historical-intelligence/brand-voice";
import {
  loadConversationTranscript,
  renderTranscript,
  mapLimited,
  tenantPromptLanguage,
  languageDirective,
} from "../services/historical-intelligence/stage-utils";

const importId = process.argv[2];
const SAMPLE = Number(process.argv[3] || 60);
if (!importId) {
  console.error("usage: dry-run-intelligence.ts <importId> [sampleSize]");
  process.exit(1);
}

/**
 * Spread the sample across the whole population instead of taking the top N.
 *
 * Ordering by message count and taking the head is what the real stage does for
 * paging, but as a SAMPLE it would answer the wrong question: the heaviest
 * threads are the most repetitive ones, and the entire purpose of this rework
 * is to find out whether the rare questions in the tail survive. An even stride
 * over the ordered population sees both ends.
 */
function stride<T>(rows: T[], n: number): T[] {
  if (rows.length <= n) return rows;
  const step = rows.length / n;
  return Array.from({ length: n }, (_, i) => rows[Math.floor(i * step)]);
}

async function main(): Promise<void> {
  initAIService({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    defaultModel: process.env.OPENAI_DEFAULT_MODEL || undefined,
    defaultEmbeddingModel: process.env.EMBEDDING_MODEL || undefined,
  });

  const imp = await prisma.historicalImport.findUnique({
    where: { id: importId },
    select: { id: true, tenantId: true, status: true, importedMessages: true, importedCustomers: true },
  });
  if (!imp) throw new Error(`import ${importId} not found`);

  const tenant = await prisma.tenant.findUnique({
    where: { id: imp.tenantId },
    select: { name: true, defaultLocale: true },
  });
  const language = await tenantPromptLanguage(imp.tenantId);

  console.log("=".repeat(78));
  console.log(`DRY RUN - nothing is written`);
  console.log(`Tenant   : ${tenant?.name}  (locale ${tenant?.defaultLocale}, prompts in ${language})`);
  console.log(`Import   : ${imp.id}  ${imp.status}`);
  console.log(`Source   : ${imp.importedMessages} messages / ${imp.importedCustomers} customers`);
  console.log("=".repeat(78));

  const customers = await prisma.historicalCustomer.findMany({
    where: { importId, tenantId: imp.tenantId, conversationId: { not: null }, messageCount: { gte: 4 } },
    select: { conversationId: true, externalId: true, normalizedPhone: true, messageCount: true },
    orderBy: [{ messageCount: "desc" }, { externalId: "asc" }],
  });
  console.log(`\nEligible conversations (>=4 messages): ${customers.length}`);

  // ── BRAND VOICE (exhaustive, deterministic, no LLM) ──
  const conversationIds = customers.map((c) => c.conversationId!).filter(Boolean);
  const outbound = await withHistoricalRecords(() =>
    prisma.message.findMany({
      where: {
        tenantId: imp.tenantId,
        conversationId: { in: conversationIds },
        direction: "OUTBOUND",
        NOT: { body: "" },
      },
      select: { body: true, conversationId: true, createdAt: true },
    }),
  );
  const voiceMessages: VoiceMessage[] = outbound.map((m) => ({
    body: m.body,
    conversationId: m.conversationId!,
    at: m.createdAt,
  }));
  const stats = analyzeBrandVoice(voiceMessages, 15);

  console.log("\n" + "-".repeat(78));
  console.log("BRAND LANGUAGE  (counted over every outbound message, no sampling)");
  console.log("-".repeat(78));
  console.log(renderVoiceStats(stats));

  // ── KNOWLEDGE (sampled, one LLM call per conversation) ──
  const sample = stride(customers, SAMPLE);
  console.log("\n" + "-".repeat(78));
  console.log(`KNOWLEDGE  (sample of ${sample.length} of ${customers.length} conversations, strided across the volume distribution)`);
  console.log("-".repeat(78));

  let calls = 0;
  let raw = 0;
  let byDirection = 0;
  let bySpecificity = 0;
  let redeemed = 0;
  let failures = 0;
  const rejectReasons = new Map<string, number>();
  const scopes = new Map<string, number>();

  interface Kept {
    topic: string;
    category: string;
    question: string;
    answer: string;
    reasoning: string;
    scope: string;
    customers: Set<string>;
    occurrences: number;
  }
  const kept = new Map<string, Kept>();

  await mapLimited(sample, 3, async (customer) => {
    const transcript = await loadConversationTranscript({
      tenantId: imp.tenantId,
      conversationId: customer.conversationId!,
    });
    const rendered = renderTranscript(transcript);
    if (!rendered.trim()) return;

    calls += 1;
    const result = await structuredCall({
      tenantId: imp.tenantId,
      importId,
      schema: ExtractionSchema,
      system: SYSTEM_PROMPT + languageDirective(language),
      user: `Conversation history between a business and one of its customers:\n\n${rendered}`,
      feature: "historical_knowledge_extraction_dryrun",
      maxTokens: 4000,
    });
    if (!result) {
      failures += 1;
      return;
    }

    const customerKey = customer.normalizedPhone || customer.externalId;
    // Same per-item validation the stage uses, so the dry run reports the same
    // numbers the pipeline would produce rather than a more optimistic set.
    for (let item of parseItems(result.items)) {
      raw += 1;
      scopes.set(item.scope, (scopes.get(item.scope) ?? 0) + 1);

      if (
        !quoteMatchesDirection(transcript, item.quotedAnswer, "OUTBOUND") ||
        !quoteMatchesDirection(transcript, item.quotedQuestion, "INBOUND")
      ) {
        byDirection += 1;
        continue;
      }

      let verdict = judgeSpecificity(item);
      if (!verdict.ok && !verdict.reasons.includes("one-off-scope")) {
        const red = { ...item, question: redactSpecifics(item.question), answer: redactSpecifics(item.answer) };
        const second = judgeSpecificity(red);
        if (second.ok) {
          item = red as typeof item;
          verdict = second;
          redeemed += 1;
        }
      }
      if (!verdict.ok) {
        bySpecificity += 1;
        for (const r of verdict.reasons) rejectReasons.set(r, (rejectReasons.get(r) ?? 0) + 1);
        continue;
      }

      // In-memory clustering only: exact normalized question. Deliberately
      // weaker than the real pipeline's embedding + LLM dedupe, so the counts
      // printed below are a FLOOR on how much this finds, never a ceiling.
      const key = item.question.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
      const existing = kept.get(key);
      if (existing) {
        existing.occurrences += 1;
        existing.customers.add(customerKey);
      } else {
        kept.set(key, {
          topic: item.topic,
          category: item.category,
          question: item.question,
          answer: item.answer,
          reasoning: item.reasoning,
          scope: item.scope,
          customers: new Set([customerKey]),
          occurrences: 1,
        });
      }
    }
  });

  const items = [...kept.values()].sort((a, b) => b.customers.size - a.customers.size || b.occurrences - a.occurrences);
  const singletons = items.filter((i) => i.occurrences === 1).length;

  console.log(`\nLLM calls          : ${calls}  (${failures} failed)`);
  console.log(`Raw items proposed : ${raw}`);
  console.log(`  rejected: wrong speaker  : ${byDirection}`);
  console.log(`  rejected: too specific   : ${bySpecificity}`);
  console.log(`  saved by redaction       : ${redeemed}`);
  console.log(`Distinct knowledge items   : ${items.length}   (of which asked once: ${singletons})`);
  console.log(`\nscope labels the model assigned: ${[...scopes].map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`specificity reject reasons    : ${[...rejectReasons].sort((a,b)=>b[1]-a[1]).map(([k, v]) => `${k}=${v}`).join("  ") || "(none)"}`);

  const byTopic = new Map<string, Kept[]>();
  for (const i of items) {
    const t = i.category.trim();
    const arr = byTopic.get(t);
    if (arr) arr.push(i);
    else byTopic.set(t, [i]);
  }
  const distinctTopics = new Set(items.map((i) => i.topic.trim().toLowerCase())).size;
  console.log(`\nCategories: ${byTopic.size}   distinct topics inside them: ${distinctTopics}`);

  console.log("\n" + "-".repeat(78));
  console.log("THE KNOWLEDGE BASE THIS WOULD BUILD");
  console.log("-".repeat(78));
  for (const [topic, group] of [...byTopic.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n### ${topic}  (${group.length})`);
    for (const i of group) {
      console.log(`\n  [${i.topic}]`);
      console.log(`  Q: ${i.question}`);
      console.log(`  A: ${i.answer}`);
      console.log(`  → how they think: ${i.reasoning}`);
      console.log(`     [${i.scope}] ${i.customers.size} customer(s), ${i.occurrences} time(s)`);
    }
  }

  console.log("\n" + "=".repeat(78));
  console.log("END - nothing was written");
  console.log("=".repeat(78));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
