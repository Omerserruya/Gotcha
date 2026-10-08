/**
 * Conversation intelligence on every close
 * (docs/architecture/conversation-intelligence-on-close.md).
 *
 * One analyser, one metered micro-model call, a fixed intent list, run once
 * per closed real conversation however it closed: the post-chat subscriber
 * calls it on the close events, the sweeper below on whatever no event
 * announced. A workspace's daily cap bounds the cost; a conversation over the
 * cap stays unanalysed (the Home chat says "recorded for N of M") and the
 * sweeper picks it up on a later day.
 */
import { Queue } from "bullmq";
import { prisma, getRedis, createWorker, resolveEffectiveLocale, REAL_CONVERSATION, readDurableSetting, parseBusinessHours, dayOf } from "@chatcenter/shared";
import { generateResponse, getMicroModel } from "./ai.service";

type Locale = "he" | "en";

// The intents and their labels: one source, shared with Analytics.
import { INTENTS, intentLabel, type Intent } from "@chatcenter/shared/src/lib/conversation-intents";
export { INTENTS, intentLabel, type Intent };

const SENTIMENTS = new Set(["positive", "neutral", "negative"]);
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 500;
const MAX_TRANSCRIPT_CHARS = 6000;
const LOCK_SECONDS = 600;
const SWEEP_DAYS = 7;
const SWEEP_BATCH = 50;
const MAX_CONCURRENT = 2;
const MAX_MODEL_FAILURES = 3;

export const dailyCap = () => Math.max(0, Number(process.env.CONVERSATION_ANALYSIS_DAILY_CAP ?? 300) || 0);

/**
 * Off until switched on: automatic analyses (close events and the sweeper)
 * spend money, and the first sweep is a 7-day backfill. The env decides when
 * set (`CONVERSATION_ANALYSIS=on|off`); otherwise the Redis key
 * `intel:enabled` = "1" (set when Omer approves; no rebuild, no compose
 * change). A person asking for an analysis is never switched off.
 */
export async function analysisEnabled(): Promise<boolean> {
  const env = process.env.CONVERSATION_ANALYSIS;
  if (env === "on") return true;
  if (env === "off") return false;
  return (await getRedis().get("intel:enabled").catch(() => null)) === "1";
}

export type AnalysisOutcome =
  | "disabled"
  | "analyzed"
  | "not_found"
  | "not_closed"
  | "not_real"
  | "voice"
  | "up_to_date"
  | "no_customer_text"
  | "locked"
  | "over_cap"
  | "model_failed"
  | "invalid_output";

// ─── Concurrency: a burst of closes queues, it does not fan out ─────────

let running = 0;
const waiting: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function workspaceDay(tenantId: string): Promise<string> {
  let tz = "UTC";
  try { tz = parseBusinessHours(await readDurableSetting(tenantId, "businessHours"))?.timezone || "UTC"; } catch { /* UTC */ }
  return dayOf(new Date(), tz);
}

/** Take one analysis from today's allowance; false when the cap is reached. */
async function takeFromCap(tenantId: string): Promise<boolean> {
  const cap = dailyCap();
  if (cap <= 0) return false;
  const key = `intel:cap:${tenantId}:${await workspaceDay(tenantId)}`;
  const r = getRedis();
  const used = await r.incr(key);
  if (used === 1) await r.expire(key, 48 * 3600);
  if (used > cap) {
    await r.decr(key);
    return false;
  }
  return true;
}

// ─── The analysis ───────────────────────────────────────────

const SYSTEM = [
  "You analyse one closed customer conversation for the business's reports.",
  `Return JSON only: {"intent": one of ${Object.keys(INTENTS).map((k) => `"${k}"`).join(", ")}, "sentiment": "positive" | "neutral" | "negative", "sentimentScore": a number from -1 to 1, "topics": up to 3 short phrases}.`,
  "intent: what the CUSTOMER wanted across the whole conversation, not their first or last word. Use \"other\" when nothing fits.",
  "sentiment: how the customer felt by the end, from the customer's own messages.",
  "topics: the concrete subjects (a product, an order problem), in the language named below, at most 4 words each.",
].join("\n");

export interface AnalysisResult { intent: Intent; sentiment: "positive" | "neutral" | "negative"; sentimentScore: number; topics: string[] }

/** The model's JSON, or null when any part is not what was asked (never a guess). */
export function parseAnalysis(raw: string): AnalysisResult | null {
  let o: any;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  if (typeof o.intent !== "string" || !(o.intent in INTENTS)) return null;
  if (typeof o.sentiment !== "string" || !SENTIMENTS.has(o.sentiment)) return null;
  const score = Number(o.sentimentScore);
  if (!Number.isFinite(score) || score < -1 || score > 1) return null;
  const topics = Array.isArray(o.topics)
    ? o.topics.filter((t: unknown) => typeof t === "string" && t.trim()).map((t: string) => t.trim().slice(0, 60)).slice(0, 3)
    : [];
  return { intent: o.intent as Intent, sentiment: o.sentiment, sentimentScore: score, topics };
}

/** The last messages, cut, labelled by side, oldest first. */
export function transcriptOf(messages: Array<{ direction: string; body: string | null }>): string {
  const lines = messages
    .filter((m) => m.body && m.body.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => `${m.direction === "INBOUND" ? "Customer" : "Business"}: ${m.body!.trim().slice(0, MAX_MESSAGE_CHARS)}`);
  // Keep the END of the conversation when it is too long: how it closed matters most.
  let out = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = out ? `${lines[i]}\n${out}` : lines[i]!;
    if (next.length > MAX_TRANSCRIPT_CHARS) break;
    out = next;
  }
  return out;
}

function resolutionOf(status: string, messages: Array<{ direction: string; metadata: unknown }>): string {
  if (status !== "CLOSED") return "open";
  const lastOutbound = [...messages].reverse().find((m) => m.direction === "OUTBOUND");
  if ((lastOutbound?.metadata as any)?.systemEvent === "ai_bot_escalation") return "escalated";
  return lastOutbound ? "resolved" : "abandoned";
}

function effortOf(count: number): number {
  return count <= 2 ? 1 : count <= 5 ? 2 : count <= 10 ? 3 : count <= 15 ? 4 : 5;
}

/**
 * Analyse one conversation. `force` (a person asked for it) skips the
 * up-to-date check and the cap, never the real-conversation rule.
 */
export async function analyzeConversationOnClose(
  tenantId: string,
  conversationId: string,
  opts: { trigger: "closed" | "updated" | "sweep" | "manual"; force?: boolean },
): Promise<AnalysisOutcome> {
  if (!opts.force && !(await analysisEnabled())) return "disabled";
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { id: true, status: true, channel: true, isTest: true, customerExternalId: true, origin: true, lastMessageAt: true, updatedAt: true, aiSummary: true },
  });
  if (!conv) return "not_found";
  // Imported history has its own analysis (historical-intelligence import).
  if (String(conv.origin) !== "LIVE") return "not_real";
  if (conv.isTest !== REAL_CONVERSATION.isTest || String(conv.customerExternalId ?? "").startsWith(REAL_CONVERSATION.NOT.customerExternalId.startsWith)) return "not_real";
  if (conv.channel === "VOICE") return "voice";
  if (!opts.force && conv.status !== "CLOSED") return "not_closed";

  const prior = await prisma.conversationIntelligence.findUnique({ where: { conversationId }, select: { analyzedAt: true, metadata: true } });
  const contentAt = conv.lastMessageAt ?? conv.updatedAt;
  // Up to date = analysed by THIS analyser after the last message. Rows from the
  // old heuristic path do not count (they carry no `source`).
  const ours = (prior?.metadata as any)?.source === "close-analysis";
  if (!opts.force && prior && ours && contentAt && prior.analyzedAt >= contentAt) return "up_to_date";

  const r = getRedis();
  const lock = `intel:lock:${conversationId}`;
  if ((await r.set(lock, "1", "EX", LOCK_SECONDS, "NX")) !== "OK") return "locked";
  try {
    const messages = await prisma.message.findMany({
      where: { conversationId, tenantId, messageType: { not: "system" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, direction: true, body: true, metadata: true },
    });
    const lastInbound = [...messages].reverse().find((m) => m.direction === "INBOUND" && m.body && m.body.trim());
    // Final outcomes leave a row WITHOUT an intent: "looked at, nothing to
    // record" (the Home chat's coverage does not count it as recorded), and the
    // sweeper does not pick the conversation again until it has new messages.
    const settle = async (outcome: AnalysisOutcome) => {
      const row = { detectedIntent: null, sentiment: null, sentimentScore: null, metadata: { source: "close-analysis", trigger: opts.trigger, outcome }, analyzedAt: new Date() };
      await prisma.conversationIntelligence
        .upsert({ where: { conversationId }, create: { tenantId, conversationId, ...row }, update: row })
        .catch(() => undefined);
      return outcome;
    };
    if (!lastInbound) return settle("no_customer_text");

    if (!opts.force && !(await takeFromCap(tenantId))) return "over_cap";

    const locale = await resolveEffectiveLocale({ tenantId }).then((x) => x.effective).catch(() => "en");
    const language = String(locale).startsWith("he") ? "Hebrew" : "English";
    let parsed: AnalysisResult | null;
    const model = getMicroModel();
    try {
      const res = await withSlot(() =>
        generateResponse({
          tenantId,
          model,
          messages: [
            { role: "system", content: `${SYSTEM}\nWrite topics in ${language}.` },
            { role: "user", content: transcriptOf(messages) },
          ],
          temperature: 0,
          maxTokens: 200,
          responseFormat: { type: "json_object" },
          metadata: { type: "classification", conversationId, purpose: "conversation_analysis" },
        }),
      );
      parsed = parseAnalysis(res.content || "");
    } catch (err: any) {
      // Possibly passing (an outage, an empty wallet): retried by the sweeper,
      // at most MAX_MODEL_FAILURES times, then settled.
      console.warn(`[conversation-analysis] model call failed conv=${conversationId}: ${err?.message}`);
      const failKey = `intel:fail:${conversationId}`;
      const fails = await r.incr(failKey).catch(() => MAX_MODEL_FAILURES);
      await r.expire(failKey, (SWEEP_DAYS + 1) * 86400).catch(() => undefined);
      return fails >= MAX_MODEL_FAILURES ? settle("model_failed") : "model_failed";
    }
    if (!parsed) {
      console.warn(`[conversation-analysis] unusable output conv=${conversationId}`);
      return settle("invalid_output");
    }

    const toolsUsed = await prisma.toolExecution.count({ where: { conversationId, tenantId } }).catch(() => 0);
    const row = {
      summary: conv.aiSummary ?? null,
      detectedIntent: parsed.intent,
      intentConfidence: null,
      sentiment: parsed.sentiment,
      sentimentScore: parsed.sentimentScore,
      topics: parsed.topics,
      toolsUsed: [toolsUsed],
      resolutionOutcome: resolutionOf(conv.status, messages),
      customerEffort: effortOf(messages.length),
      aiConfidence: null,
      metadata: { source: "close-analysis", trigger: opts.trigger, model },
      analyzedAt: new Date(),
    };
    try {
      await prisma.conversationIntelligence.upsert({
        where: { conversationId },
        create: { tenantId, conversationId, ...row },
        update: row,
      });
    } catch (err: any) {
      // Deleted while the model was answering.
      if (err?.code === "P2003" || err?.code === "P2025") return "not_found";
      throw err;
    }
    // The conversation's intent on the message it ends with
    // (conversation-memory.service reads Message.metadata.intent first).
    const priorMeta = lastInbound.metadata && typeof lastInbound.metadata === "object" ? (lastInbound.metadata as Record<string, unknown>) : {};
    await prisma.message
      .update({ where: { id: lastInbound.id }, data: { metadata: { ...priorMeta, intent: parsed.intent } } })
      .catch(() => undefined);
    return "analyzed";
  } finally {
    await r.del(lock).catch(() => undefined);
  }
}

// ─── The sweeper: closes no event announced ─────────────────

/**
 * Closed real conversations of the last days whose analysis is missing, from
 * the old heuristic path, or older than their last message. The filter is in
 * the query, never after its LIMIT (a filtered page would stop the sweep at
 * the first page of up-to-date rows). Raw SQL gets no automatic LIVE filter,
 * so origin is stated.
 */
export async function findUnanalyzed(days = SWEEP_DAYS, limit = SWEEP_BATCH, excludeTenants: string[] = [], excludeIds: string[] = []): Promise<Array<{ id: string; tenantId: string }>> {
  const since = new Date(Date.now() - days * 86400_000);
  const rows = await prisma.$queryRaw<Array<{ id: string; tenant_id: string }>>`
    SELECT c.id, c.tenant_id
      FROM conversations c
      LEFT JOIN conversation_intelligence i ON i.conversation_id = c.id
     WHERE c.status = 'CLOSED'
       AND c.origin = 'LIVE'
       AND c.is_test = false
       AND c.customer_external_id NOT LIKE 'sandbox:%'
       AND c.channel <> 'VOICE'
       AND c.updated_at >= ${since}
       AND NOT (c.tenant_id = ANY(${excludeTenants}::text[]))
       AND NOT (c.id = ANY(${excludeIds}::text[]))
       AND (i.id IS NULL
            OR COALESCE(i.metadata->>'source', '') <> 'close-analysis'
            OR i.analyzed_at < COALESCE(c.last_message_at, c.updated_at))
     ORDER BY c.updated_at DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

/**
 * One sweep: batches until nothing is left, a workspace over its cap leaves
 * the sweep (its conversations wait for a later day), and a sweep is bounded.
 * What this sweep already tried is excluded IN THE QUERY: a passing failure
 * leaves no row, so the same page came back and the sweep stopped there (the
 * dev backfill reached 50 of 68).
 */
export async function runSweep(days = SWEEP_DAYS, maxBatches = 10, batchSize = SWEEP_BATCH): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (!(await analysisEnabled())) return counts;
  const capped: string[] = [];
  const seen = new Set<string>();
  for (let b = 0; b < maxBatches; b++) {
    const batch = await findUnanalyzed(days, batchSize, capped, [...seen]);
    if (!batch.length) break;
    for (const c of batch) {
      seen.add(c.id);
      if (capped.includes(c.tenantId)) continue;
      const out = await analyzeConversationOnClose(c.tenantId, c.id, { trigger: "sweep" }).catch((err) => {
        console.warn(`[conversation-analysis] sweep failed conv=${c.id}: ${err?.message}`);
        return "model_failed" as const;
      });
      if (out === "over_cap") capped.push(c.tenantId);
      counts[out] = (counts[out] ?? 0) + 1;
    }
  }
  if (Object.keys(counts).length) console.log(`[conversation-analysis] sweep ${JSON.stringify(counts)}`);
  return counts;
}

const QUEUE_NAME = "conversation-analysis-sweep";
const SWEEP_CRON = process.env.CONVERSATION_ANALYSIS_SWEEP_CRON || "*/15 * * * *";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
let _started = false;
export async function startConversationAnalysisSweeper(): Promise<void> {
  if (_started) return;
  _started = true;
  const queue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });
  await queue
    .add("sweep", { type: "sweep" }, { repeat: { pattern: SWEEP_CRON }, removeOnComplete: { count: 10 }, removeOnFail: { count: 20 } })
    .catch((err) => console.error("[conversation-analysis] failed to schedule the sweep:", err?.message));
  // createWorker wraps the processor in withCrossTenantAccess: the sweep spans
  // workspaces (each analysis is scoped by its own tenantId).
  createWorker(QUEUE_NAME, async () => { await runSweep(); }, 1);
  console.log(`[conversation-analysis] sweeper started (cron="${SWEEP_CRON}", cap ${dailyCap()}/workspace/day)`);
}
