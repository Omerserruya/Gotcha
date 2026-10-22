import {
  prisma,
  getRedis,
  normalizeConversationIntent,
  isFrustrated,
  scoreQueueItem,
  rankQueueItems,
  toActivityEvent,
  approvalToActivityEvent,
  toolSubject,
  isoWeekKey,
  visibilityClause, type Viewer,
  buildQuietDayList, waitingForPersonWhere } from "@chatcenter/shared";
import { intentLabel } from "@chatcenter/shared/src/lib/conversation-intents";

// ─── Helpers ─────────────────────────────────────────────────

function parseDateRange(from?: string, to?: string): { fromDate: Date; toDate: Date } {
  const toDate = to ? new Date(to) : new Date();
  toDate.setHours(23, 59, 59, 999);
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  fromDate.setHours(0, 0, 0, 0);
  return { fromDate, toDate };
}

function priorPeriod(fromDate: Date, toDate: Date): { priorFrom: Date; priorTo: Date } {
  const spanMs = toDate.getTime() - fromDate.getTime();
  const priorTo = new Date(fromDate.getTime() - 1);
  const priorFrom = new Date(priorTo.getTime() - spanMs);
  return { priorFrom, priorTo };
}


/**
 * Average time from a customer's message to the first reply after it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACES, AND WHY THE OLD NUMBER WAS NOT A RESPONSE TIME
 *
 * `analytics.worker.ts` computed `now - claim_time` on every `agent_response`.
 * So the figure behind "average response time" was:
 *
 *   · measured from the moment a HUMAN CLAIMED the conversation, not from the
 *     customer's message - a conversation that sat unclaimed for forty minutes
 *     and was then answered in ten seconds reported 10s, and the customer's real
 *     wait was invisible to it
 *   · an average over EVERY agent reply, not the first
 *   · blind to AI-answered conversations entirely, because they have no claim
 *   · and drifting UPWARD with conversation length, because `claim_time` is SET
 *     with a 7-day TTL and never deleted, so the fifth reply in a thread
 *     measured from the original claim
 *
 * This measures the thing the label claims: for each inbound message, how long
 * until the next outbound. It covers AI replies, needs no event stream and no
 * Redis, and cannot drift.
 *
 * ── Exclusions are deliberate, and each has cost something before ──
 *
 * `origin = LIVE` on both sides: imported history would otherwise contribute
 * years-old gaps. `isTest = false` and `customerExternalId NOT LIKE 'sandbox:%'`
 * because sandbox rows carry `isTest = false` and two analytics figures have
 * already counted rehearsals as business by filtering only the flag.
 *
 * Raw SQL because the shape is a correlated MIN per inbound, which Prisma cannot
 * express - and note `applyLiveByDefault` does NOT apply to $queryRaw, so the
 * origin filter here is mandatory rather than inherited.
 * ════════════════════════════════════════════════════════════════════════════
 */
export async function getAvgFirstReplyMs(
  tenantId: string,
  since: Date,
): Promise<{ avgMs: number | null; pairs: number }> {
  // A metric must not take the dashboard down. The old figure came from a Redis
  // list read that degraded to null when Redis was empty; this one is a SQL
  // query, and an unavailable database or a schema surprise would otherwise turn
  // the whole dashboard into a 500 over one number. Found by an existing test
  // that started failing for exactly that reason.
  let rows: Array<{ avg_ms: number | null; pairs: bigint }> = [];
  try {
    rows = await prisma.$queryRaw<Array<{ avg_ms: number | null; pairs: bigint }>>`
    SELECT avg(reply_ms)::float8 AS avg_ms, count(*)::bigint AS pairs FROM (
      SELECT EXTRACT(EPOCH FROM (MIN(o.created_at) - i.created_at)) * 1000 AS reply_ms
      FROM messages i
      JOIN conversations c ON c.id = i.conversation_id
      JOIN messages o ON o.conversation_id = i.conversation_id
                     AND o.direction = 'OUTBOUND'::"MessageDirection"
                     AND o.created_at > i.created_at
                     AND o.origin = 'LIVE'::"RecordOrigin"
      WHERE i.tenant_id = ${tenantId}
        AND i.direction = 'INBOUND'::"MessageDirection"
        AND i.origin = 'LIVE'::"RecordOrigin"
        AND i.created_at >= ${since}
        AND c.is_test = false
        AND c.customer_external_id NOT LIKE 'sandbox:%'
      GROUP BY i.id, i.created_at
    ) t
  `;
  } catch (err: any) {
    console.warn(`[analytics] first-reply metric unavailable for ${tenantId}: ${err?.message}`);
    // Null, not zero: the number is unknown, and "we replied instantly" is a
    // claim this has no basis to make.
    return { avgMs: null, pairs: 0 };
  }
  const row = rows[0];
  const avg = row?.avg_ms;
  return {
    // Null rather than zero when nothing matched: "no customer wrote today" and
    // "we replied instantly" are different facts.
    avgMs: typeof avg === "number" && Number.isFinite(avg) ? Math.round(avg) : null,
    pairs: Number(row?.pairs ?? 0),
  };
}

export async function getDashboardStats(tenantId: string) {
  const redis = getRedis();
  const today = new Date().toISOString().slice(0, 10);
  const [activeConversations, waitingConversations, dailyData, resolutionTimes, firstReply] = await Promise.all([
    prisma.conversation.count({ where: { tenantId, ...REAL_CONVERSATION, status: "OPEN" } }),
    prisma.conversation.count({ where: { tenantId, ...REAL_CONVERSATION, status: "WAITING" } }),
    redis.hgetall(`analytics:${tenantId}:${today}`),
    redis.lrange(`analytics:${tenantId}:resolution_times:${today}`, 0, -1),
    // Replaces the claim-based figure. Same field name because the NAME was
    // always right - "average response time" is the time from a customer's
    // message to a reply - and only the computation was wrong. Four live screens
    // read this field; changing the number under it is the fix, and removing the
    // field would break them while leaving the wrong figure in the last place
    // nobody has looked.
    getAvgFirstReplyMs(tenantId, new Date(`${today}T00:00:00.000Z`)),
  ]);
  const avgResolutionTimeMs = resolutionTimes.length ? resolutionTimes.reduce((sum, t) => sum + parseInt(t, 10), 0) / resolutionTimes.length : null;
  return {
    activeConversations, waitingConversations,
    closedToday: parseInt(dailyData.conversations_closed || "0", 10),
    totalMessagesToday: parseInt(dailyData.messages_total || "0", 10),
    avgResponseTimeMs: firstReply.avgMs,
    // How many inbound/outbound pairs the average is built from, so a screen can
    // tell a real 4s from an average of one message.
    avgResponseSampleSize: firstReply.pairs,
    avgResolutionTimeMs: avgResolutionTimeMs ? Math.round(avgResolutionTimeMs) : null,
  };
}

/**
 * The team: people who handle conversations, then AI employees.
 *
 * People are ADMIN and AGENT. It used to be AGENT only, and no dev tenant has
 * an AGENT, so the team was empty everywhere. SYSTEM_ADMIN is excluded: that
 * is the platform operator, not the business's team.
 *
 * AI employees (ACTIVE or PAUSED; a DRAFT owns nothing) come with
 * `kind: "ai"`. Their `claimedToday` and `avgResponseTimeMs` are null, not 0:
 * an AI never claims, and the response time here is claim-to-first-reply, so
 * both are undefined for it - a 0 would read as "did nothing today".
 */
export async function getAgentStats(tenantId: string) {
  const redis = getRedis();
  const today = new Date().toISOString().slice(0, 10);
  const agents = await prisma.user.findMany({
    where: { tenantId, role: { in: ["ADMIN", "AGENT"] }, isActive: true },
    select: { id: true, name: true, email: true, _count: { select: { conversations: { where: { status: { not: "CLOSED" } } } } } },
  });
  const stats = [];
  for (const agent of agents) {
    const [agentData, responseTimes] = await Promise.all([
      redis.hgetall(`analytics:${tenantId}:agent:${agent.id}:${today}`),
      redis.lrange(`analytics:${tenantId}:agent:${agent.id}:response_times:${today}`, 0, -1),
    ]);
    const avgResponseTimeMs = responseTimes.length ? responseTimes.reduce((sum, t) => sum + parseInt(t, 10), 0) / responseTimes.length : null;
    stats.push({
      kind: "human" as const,
      agentId: agent.id, name: agent.name, email: agent.email,
      activeConversations: agent._count.conversations,
      claimedToday: parseInt(agentData.claimed || "0", 10) as number | null,
      avgResponseTimeMs: avgResponseTimeMs ? Math.round(avgResponseTimeMs) : null,
    });
  }

  const aiAgents = await prisma.aIAgent.findMany({
    where: { tenantId, status: { in: ["ACTIVE", "PAUSED"] } },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  if (aiAgents.length > 0) {
    const owned = await prisma.conversation.groupBy({
      by: ["assignedAiAgentId"],
      where: {
        tenantId,
        // Sandbox rehearsals carry isTest=false, and they are exactly the
        // conversations an AI employee is tried out on.
        ...REAL_CONVERSATION,
        status: { not: "CLOSED" },
        assignedAiAgentId: { in: aiAgents.map((a) => a.id) },
      },
      _count: { _all: true },
    });
    const countByAi = new Map(owned.map((o: any) => [o.assignedAiAgentId, o._count._all]));
    for (const ai of aiAgents) {
      stats.push({
        kind: "ai" as const,
        agentId: ai.id, name: ai.name, email: null,
        activeConversations: countByAi.get(ai.id) ?? 0,
        claimedToday: null,
        avgResponseTimeMs: null,
        nullReasons: { claimedToday: "ai_does_not_claim", avgResponseTimeMs: "not_measured_for_ai" },
      } as any);
    }
  }
  return stats;
}

export async function getHourlyVolume(tenantId: string, date?: string) {
  const redis = getRedis();
  const targetDate = date || new Date().toISOString().slice(0, 10);
  const hours = [];
  for (let h = 0; h < 24; h++) {
    const hourStr = h.toString().padStart(2, "0");
    const key = `analytics:${tenantId}:hourly:${targetDate}T${hourStr}`;
    const data = await redis.hgetall(key);
    hours.push({ hour: `${hourStr}:00`, inbound: parseInt(data.messages_inbound || "0", 10), outbound: parseInt(data.messages_outbound || "0", 10) });
  }
  return hours;
}

export async function getDailyVolume(tenantId: string, days = 30) {
  const redis = getRedis();
  const volumes = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    const data = await redis.hgetall(`analytics:${tenantId}:${dateKey}`);
    volumes.push({
      date: dateKey, total: parseInt(data.messages_total || "0", 10),
      inbound: parseInt(data.messages_inbound || "0", 10), outbound: parseInt(data.messages_outbound || "0", 10),
      closed: parseInt(data.conversations_closed || "0", 10),
    });
  }
  return volumes;
}

/**
 * "Waiting for a person" is defined ONCE, in @chatcenter/shared
 * (conversation-queue.ts): Home's count and ranked queue here, the inbox's
 * queue view in the conversation service, and the assistant all use it.
 */
export { waitingForPersonWhere };

export async function getQueueDepth(tenantId: string) {
  const waitingConversations = await prisma.conversation.findMany({
    where: waitingForPersonWhere(tenantId),
    select: { createdAt: true, lastMessageAt: true },
  });
  const now = Date.now();
  const waitTimes = waitingConversations.map((c: { createdAt: Date; lastMessageAt: Date | null }) => {
    const ref = c.lastMessageAt || c.createdAt;
    return now - ref.getTime();
  });
  const avgWaitTimeMs = waitTimes.length ? Math.round(waitTimes.reduce((sum: number, t: number) => sum + t, 0) / waitTimes.length) : null;
  return { waiting: waitingConversations.length, avgWaitTimeMs };
}

// ─── New Analytics Functions ──────────────────────────────────

export async function getOverview(tenantId: string, from?: string, to?: string) {
  const { fromDate, toDate } = parseDateRange(from, to);
  const { priorFrom, priorTo } = priorPeriod(fromDate, toDate);

  const dateFilter = { gte: fromDate, lte: toDate };
  const priorFilter = { gte: priorFrom, lte: priorTo };

  const [
    totalConversations,
    resolvedConversations,
    totalMessages,
    closedConvs,
    priorTotal,
    priorResolved,
    priorMessages,
    pendingApprovalCount,
  ] = await Promise.all([
    prisma.conversation.count({ where: { tenantId, ...REAL_CONVERSATION, createdAt: dateFilter } }),
    prisma.conversation.count({ where: { tenantId, ...REAL_CONVERSATION, status: "CLOSED", createdAt: dateFilter } }),
    prisma.message.count({ where: { tenantId, conversation: REAL_CONVERSATION, createdAt: dateFilter } }),
    prisma.conversation.findMany({
      where: { tenantId, status: "CLOSED", closedAt: dateFilter },
      select: { createdAt: true, closedAt: true, assignedAgentId: true, messages: { select: { metadata: true }, take: 1, where: { direction: "OUTBOUND" } } },
    }),
    prisma.conversation.count({ where: { tenantId, ...REAL_CONVERSATION, createdAt: priorFilter } }),
    prisma.conversation.count({ where: { tenantId, ...REAL_CONVERSATION, status: "CLOSED", createdAt: priorFilter } }),
    prisma.message.count({ where: { tenantId, conversation: REAL_CONVERSATION, createdAt: priorFilter } }),
    // Deliberately NOT filtered by the date range. Every other figure here
    // describes a period; this one answers "how many actions are waiting on a
    // human right now", and an approval raised before `from` is still waiting.
    //
    // `expiresAt > now` matches how approval-requests.ts decides an approval is
    // still actionable: the sweeper that flips PENDING to EXPIRED runs on its
    // own schedule, so status alone would count approvals nobody can act on and
    // the strip would disagree with the list it sends the operator to.
    prisma.approvalRequest.count({
      where: { tenantId, status: "PENDING", expiresAt: { gt: new Date() } },
    }),
  ]);

  const resolutionTimes = closedConvs
    .filter((c: { closedAt: Date | null; createdAt: Date }) => c.closedAt)
    .map((c: { closedAt: Date | null; createdAt: Date }) => c.closedAt!.getTime() - c.createdAt.getTime());

  const avgResolutionTimeMs = resolutionTimes.length
    ? Math.round(resolutionTimes.reduce((s: number, t: number) => s + t, 0) / resolutionTimes.length)
    : null;

  // AI handled = conversations where first outbound message has metadata.source = "ai_bot"
  const allConvs = await prisma.conversation.findMany({
    where: { tenantId, createdAt: dateFilter },
    select: { id: true },
  });
  const convIds = allConvs.map((c: { id: string }) => c.id);

  let aiHandledCount = 0;
  if (convIds.length > 0) {
    const aiConvs = await prisma.message.findMany({
      where: {
        tenantId,
        conversation: REAL_CONVERSATION,
        conversationId: { in: convIds },
        direction: "OUTBOUND",
        metadata: { path: ["source"], equals: "ai_bot" },
      },
      select: { conversationId: true },
      distinct: ["conversationId"],
    });
    aiHandledCount = aiConvs.length;
  }

  const humanHandledCount = Math.max(0, totalConversations - aiHandledCount);
  const aiHandledPct = totalConversations > 0 ? Math.round((aiHandledCount / totalConversations) * 100) : 0;
  const resolutionRate = totalConversations > 0 ? Math.round((resolvedConversations / totalConversations) * 100) : 0;

  // Response time from Redis for the date range
  const redis = getRedis();
  const days: string[] = [];
  for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  const allResponseTimes: number[] = [];
  for (const day of days) {
    const times = await redis.lrange(`analytics:${tenantId}:response_times:${day}`, 0, -1);
    allResponseTimes.push(...times.map((t: string) => parseInt(t, 10)));
  }
  const avgResponseTimeMs = allResponseTimes.length
    ? Math.round(allResponseTimes.reduce((s, t) => s + t, 0) / allResponseTimes.length)
    : null;

  // Deltas vs prior period
  const totalDelta = priorTotal > 0 ? Math.round(((totalConversations - priorTotal) / priorTotal) * 100) : null;
  const resolvedDelta = priorResolved > 0 ? Math.round(((resolvedConversations - priorResolved) / priorResolved) * 100) : null;
  const messagesDelta = priorMessages > 0 ? Math.round(((totalMessages - priorMessages) / priorMessages) * 100) : null;

  return {
    totalConversations,
    resolvedConversations,
    resolutionRate,
    avgResponseTimeMs,
    avgResolutionTimeMs,
    aiHandledCount,
    humanHandledCount,
    aiHandledPct,
    totalMessages,
    pendingApprovalCount,
    deltas: { totalConversationsPct: totalDelta, resolvedConversationsPct: resolvedDelta, totalMessagesPct: messagesDelta },
    period: { from: fromDate.toISOString(), to: toDate.toISOString() },
  };
}

// "other" is the analysis on close's catch-all; "unknown"/"general" are what
// older rows held.
const VAGUE_INTENTS = new Set(["unknown", "general", "other"]);

/**
 * The rows the analysis on close wrote (docs/architecture/
 * conversation-intelligence-on-close.md) for real conversations. Older rows
 * came from English keyword guesses ("general" for any Hebrew text) or a
 * failed call ("unknown"): not something a customer asked about.
 */
// A function: REAL_CONVERSATION is declared further down this module.
const analysed = () => ({
  metadata: { path: ["source"], equals: "close-analysis" },
  conversation: REAL_CONVERSATION,
});
export function isVagueIntent(intent: string | null | undefined): boolean {
  return intent == null || VAGUE_INTENTS.has(String(intent).trim().toLowerCase());
}

/** Trim, collapse whitespace, cap; "" when there is nothing a person wrote. */
export function normalizeQuestion(body: string | null | undefined): string {
  return String(body ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * A message that is only a greeting or filler: a closed list (Hebrew and
 * English), anything of 3 characters or fewer, or emoji / punctuation alone.
 * Trailing punctuation and repeated letters are tolerated ("היייי!", "hi!!").
 */
const GREETINGS = new Set([
  "היי", "הי", "שלום", "אהלן", "הלו", "בוקר טוב", "ערב טוב", "צהריים טובים", "שלום רב",
  "hi", "hey", "hello", "hiya", "yo", "good morning", "good evening",
]);
export function isGreetingOnly(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length <= 3) return true;
  if (!/[\p{L}\p{N}]/u.test(t)) return true; // emoji or punctuation only
  const bare = t.replace(/[\s!?.,~\-:;)(]+$/u, "").replace(/(\p{L})\1{2,}/gu, "$1");
  return GREETINGS.has(bare) || GREETINGS.has(bare.replace(/(\p{L})\1+$/u, "$1"));
}

/**
 * The most common FIRST inbound message of the conversations in each vague
 * intent group - the customer's opening question, in their words. Deduped
 * case-insensitively; the first spelling seen is the one shown. Up to 5 per
 * group. Test and sandbox conversations are excluded: a rehearsal is not
 * something a customer asked.
 */
export async function customerQuestionExamples(
  tenantId: string,
  dateFilter: { gte: Date; lte: Date },
  intents: string[],
  perGroup = 5,
): Promise<Map<string, Array<{ question: string; count: number }>>> {
  const out = new Map<string, Array<{ question: string; count: number }>>();
  const rows = await prisma.conversationIntelligence.findMany({
    where: { tenantId, analyzedAt: dateFilter, detectedIntent: { in: intents }, ...analysed() },
    select: { conversationId: true, detectedIntent: true },
    take: 2000,
  });
  if (rows.length === 0) return out;
  const intentByConversation = new Map(rows.map((r: any) => [r.conversationId, r.detectedIntent as string]));

  const messages = await prisma.message.findMany({
    where: {
      tenantId,
      direction: "INBOUND",
      conversationId: { in: [...intentByConversation.keys()] },
      conversation: REAL_CONVERSATION,
    },
    select: { conversationId: true, body: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  // The first inbound message that SAYS something. A conversation that opens
  // with "היי" asks its question in the next message; take that one. When
  // there is no next message, the greeting is still shown rather than the
  // conversation being dropped.
  const firstByConversation = new Map<string, string>();
  const greetingFallback = new Map<string, string>();
  for (const m of messages as any[]) {
    if (firstByConversation.has(m.conversationId)) continue;
    const q = normalizeQuestion(m.body);
    if (q.length < 2) continue;
    if (isGreetingOnly(q)) {
      if (!greetingFallback.has(m.conversationId)) greetingFallback.set(m.conversationId, q);
      continue;
    }
    firstByConversation.set(m.conversationId, q);
  }
  for (const [conversationId, greeting] of greetingFallback) {
    if (!firstByConversation.has(conversationId)) firstByConversation.set(conversationId, greeting);
  }

  const tallies = new Map<string, Map<string, { question: string; count: number }>>();
  for (const [conversationId, question] of firstByConversation) {
    const intent = intentByConversation.get(conversationId)!;
    const byKey = tallies.get(intent) ?? new Map();
    const key = question.toLowerCase();
    const cur = byKey.get(key);
    if (cur) cur.count++;
    else byKey.set(key, { question, count: 1 });
    tallies.set(intent, byKey);
  }
  for (const [intent, byKey] of tallies) {
    out.set(intent, [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, perGroup));
  }
  return out;
}

export async function getTopQuestions(tenantId: string, from?: string, to?: string, limit = 10, locale: "he" | "en" = "en") {
  const { fromDate, toDate } = parseDateRange(from, to);
  const dateFilter = { gte: fromDate, lte: toDate };

  // Group by detectedIntent from ConversationIntelligence
  const intentGroups = await prisma.conversationIntelligence.groupBy({
    by: ["detectedIntent"],
    where: { tenantId, analyzedAt: dateFilter, detectedIntent: { not: null }, ...analysed() },
    _count: { detectedIntent: true },
    orderBy: { _count: { detectedIntent: "desc" } },
    take: limit,
  });

  if (intentGroups.length > 0) {
    // `key` is the stable intent; `label` (and `question`, which screens show
    // verbatim) is its name in the reader's language, from the one shared map.
    const groups = intentGroups.map((g: { detectedIntent: string | null; _count: { detectedIntent: number } }) => {
      const key = String(g.detectedIntent);
      const label = intentLabel(key, locale);
      return { key, label, question: label, intent: key, count: g._count.detectedIntent, automatable: g._count.detectedIntent > 5 };
    });
    // A group named "unknown" or "general" says nothing a person can read.
    // For those, add what the customers actually wrote (additive: the fields
    // above are unchanged).
    const vague = groups.filter((g: any) => isVagueIntent(g.intent));
    if (vague.length === 0) return groups;
    const examplesByIntent = await customerQuestionExamples(tenantId, dateFilter, vague.map((g: any) => g.intent as string));
    return groups.map((g: any) => (isVagueIntent(g.intent) ? { ...g, examples: examplesByIntent.get(g.intent) ?? [] } : g));
  }

  // Fallback: analyze inbound message bodies
  const messages = await prisma.message.findMany({
    where: { tenantId, direction: "INBOUND", createdAt: dateFilter, conversation: REAL_CONVERSATION },
    select: { body: true },
    take: 1000,
  });

  const freq: Record<string, number> = {};
  for (const msg of messages) {
    const key = msg.body.slice(0, 120).trim().toLowerCase();
    if (key.length > 5) freq[key] = (freq[key] || 0) + 1;
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([question, count]) => ({ question, intent: null, count, automatable: count > 5 }));
}

export async function getToolUsageStats(tenantId: string, from?: string, to?: string) {
  const { fromDate, toDate } = parseDateRange(from, to);
  const dateFilter = { gte: fromDate, lte: toDate };

  // TWO SOURCES, because the product executes tools by two different routes and
  // this only ever read one of them.
  //
  //   ToolExecution   catalog-backed HTTP tools, written by the axios executor
  //                   in tool-execution.service.ts. Its single writer stamps
  //                   `toolName: catalogTool.name`.
  //   AuditLog        `adapter.*` rows written by auditAdapterCall for every
  //                   connector tool - shopify.*, stripe.*, the dotted family.
  //
  // Reading only the first is why this route answered "nothing here" on a
  // tenant with thousands of tool calls: the dev estate holds 0 ToolExecution
  // rows and 3,475 adapter records. The connector executions were never
  // missing; they were in the other table, and nothing joined them up.
  //
  // Reading rather than back-filling is deliberate. Writing ToolExecution rows
  // from the connector path too would duplicate the same event into two tables,
  // add a write to the AI hot path, and still show nothing until the day it
  // shipped. This surfaces the history that already exists.
  const [executions, adapterCalls] = await Promise.all([
    prisma.toolExecution.findMany({
      where: { tenantId, createdAt: dateFilter },
      select: {
        tenantToolId: true,
        // The denormalised name, which this did not read. It exists precisely
        // so a row outlives the tenant tool it ran through - disconnecting an
        // integration nulls `tenantToolId` (SetNull), and without this the
        // surviving audit row reported as "unknown" anyway, defeating the
        // column that was added to save it.
        toolName: true,
        success: true,
        durationMs: true,
        tenantTool: { select: { catalogTool: { select: { name: true } } } },
      },
    }),
    prisma.auditLog.findMany({
      where: { tenantId, action: { startsWith: "adapter." }, createdAt: dateFilter },
      select: { metadata: true },
    }),
  ]);

  type Bucket = {
    toolName: string;
    total: number;
    successes: number;
    refused: number;
    errored: number;
    unclassifiedFailures: number;
    durations: number[];
  };
  const byTool: Record<string, Bucket> = {};
  const bucket = (key: string, toolName: string): Bucket =>
    (byTool[key] ??= { toolName, total: 0, successes: 0, refused: 0, errored: 0, unclassifiedFailures: 0, durations: [] });

  for (const ex of executions) {
    // Prefer the live catalog name, fall back to the name captured at execution
    // time, and only then admit we cannot name it.
    const toolName = ex.tenantTool?.catalogTool?.name || ex.toolName || "unknown";
    // KEYED BY NAME, not by `tenantToolId`. That id is null for every connector
    // execution and for every row whose tool was disconnected, so keying on it
    // collapsed all of them into ONE bucket labelled after whichever row
    // happened to arrive first. Fixing the name without fixing the key would
    // have produced a single confidently-mislabelled row.
    const b = bucket(toolName, toolName);
    b.total += 1;
    if (ex.success) b.successes += 1;
    else b.unclassifiedFailures += 1; // ToolExecution has no refused/errored split
    if (ex.durationMs != null) b.durations.push(ex.durationMs);
  }

  for (const row of adapterCalls) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const toolName = typeof meta.tool === "string" && meta.tool ? meta.tool : "unknown";
    const b = bucket(toolName, toolName);
    b.total += 1;
    if (meta.ok === true) {
      b.successes += 1;
    } else if (meta.failure === "refused") {
      b.refused += 1;
    } else if (meta.failure === "errored") {
      b.errored += 1;
    } else {
      // Written before `failure` was recorded. NOT counted as errored: a
      // refusal is the product working correctly, and guessing would make a
      // functioning approval policy read as a broken integration.
      b.unclassifiedFailures += 1;
    }
    const ms = meta.durationMs;
    if (typeof ms === "number" && Number.isFinite(ms)) b.durations.push(ms);
  }

  return Object.entries(byTool)
    .map(([toolName, s]) => ({
      toolId: toolName,
      toolName,
      executionCount: s.total,
      // Attempts that SUCCEEDED over all attempts. A refusal is included in the
      // denominator because it was an attempt, and is reported separately so a
      // reader can tell a tool that keeps breaking from one a policy keeps
      // stopping - the difference between fixing an integration and reviewing a
      // rule.
      successRate: s.total > 0 ? Math.round((s.successes / s.total) * 100) : 0,
      successCount: s.successes,
      refusedCount: s.refused,
      erroredCount: s.errored,
      unclassifiedFailureCount: s.unclassifiedFailures,
      avgDurationMs: s.durations.length
        ? Math.round(s.durations.reduce((sum, d) => sum + d, 0) / s.durations.length)
        : null,
    }))
    .sort((a, b) => b.executionCount - a.executionCount);
}

export async function getChannelPerformance(tenantId: string, from?: string, to?: string) {
  const { fromDate, toDate } = parseDateRange(from, to);
  const dateFilter = { gte: fromDate, lte: toDate };

  const conversations = await prisma.conversation.findMany({
    where: { tenantId, ...REAL_CONVERSATION, createdAt: dateFilter },
    select: { id: true, channel: true, status: true, createdAt: true, closedAt: true },
  });

  const convIds = conversations.map((c: { id: string }) => c.id);
  const messages = convIds.length > 0
    ? await prisma.message.groupBy({
        by: ["conversationId"],
        // convIds came from a query that already excludes test conversations,
        // so this inherits the exclusion rather than repeating it.
        where: { tenantId, conversationId: { in: convIds } },
        _count: { id: true },
      })
    : [];

  const msgCountByConv: Record<string, number> = {};
  for (const m of messages) {
    if (m.conversationId) {
      msgCountByConv[m.conversationId] = m._count.id;
    }
  }

  type ChannelStats = {
    conversationCount: number;
    messageCount: number;
    closedCount: number;
    resolutionTimes: number[];
  };

  const byChannel: Record<string, ChannelStats> = {};
  for (const conv of conversations) {
    const ch = conv.channel as string;
    if (!byChannel[ch]) byChannel[ch] = { conversationCount: 0, messageCount: 0, closedCount: 0, resolutionTimes: [] };
    byChannel[ch].conversationCount += 1;
    byChannel[ch].messageCount += msgCountByConv[conv.id] || 0;
    if (conv.status === "CLOSED") {
      byChannel[ch].closedCount += 1;
      if (conv.closedAt) {
        byChannel[ch].resolutionTimes.push(conv.closedAt.getTime() - conv.createdAt.getTime());
      }
    }
  }

  return Object.entries(byChannel).map(([channel, stats]) => ({
    channel,
    conversationCount: stats.conversationCount,
    messageCount: stats.messageCount,
    avgResolutionTimeMs: stats.resolutionTimes.length
      ? Math.round(stats.resolutionTimes.reduce((s, t) => s + t, 0) / stats.resolutionTimes.length)
      : null,
    resolutionRate: stats.conversationCount > 0
      ? Math.round((stats.closedCount / stats.conversationCount) * 100)
      : 0,
  }));
}

export async function getDepartmentPerformance(tenantId: string, from?: string, to?: string) {
  const { fromDate, toDate } = parseDateRange(from, to);
  const dateFilter = { gte: fromDate, lte: toDate };

  const [departments, conversations] = await Promise.all([
    prisma.department.findMany({
      where: { tenantId },
      select: { id: true, name: true, members: { select: { userId: true } } },
    }),
    prisma.conversation.findMany({
      where: { tenantId, ...REAL_CONVERSATION, createdAt: dateFilter, departmentId: { not: null } },
      select: { departmentId: true, status: true, assignedAgentId: true, createdAt: true, lastMessageAt: true },
    }),
  ]);

  const redis = getRedis();
  const days: string[] = [];
  for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }

  type DeptStats = { conversationCount: number; resolvedCount: number; responseTimes: number[] };
  const byDept: Record<string, DeptStats> = {};

  for (const conv of conversations) {
    const deptId = conv.departmentId!;
    if (!byDept[deptId]) byDept[deptId] = { conversationCount: 0, resolvedCount: 0, responseTimes: [] };
    byDept[deptId].conversationCount += 1;
    if (conv.status === "CLOSED") byDept[deptId].resolvedCount += 1;
  }

  // Gather response times from Redis per day
  const allResponseTimes: Record<string, number[]> = {};
  for (const day of days) {
    const times = await redis.lrange(`analytics:${tenantId}:response_times:${day}`, 0, -1);
    if (times.length > 0) {
      // We don't have department-level response time in Redis, so we'll approximate using global
      const nums = times.map((t: string) => parseInt(t, 10));
      allResponseTimes[day] = nums;
    }
  }
  const flatResponseTimes = Object.values(allResponseTimes).flat();
  const globalAvgResponseMs = flatResponseTimes.length
    ? Math.round(flatResponseTimes.reduce((s, t) => s + t, 0) / flatResponseTimes.length)
    : null;

  return departments.map((dept: { id: string; name: string; members: { userId: string }[] }) => {
    const stats = byDept[dept.id] || { conversationCount: 0, resolvedCount: 0, responseTimes: [] };
    return {
      departmentId: dept.id,
      departmentName: dept.name,
      conversationCount: stats.conversationCount,
      resolvedCount: stats.resolvedCount,
      avgResponseTimeMs: globalAvgResponseMs,
      agentCount: dept.members.length,
    };
  });
}

export async function getAIPerformance(tenantId: string, from?: string, to?: string) {
  const { fromDate, toDate } = parseDateRange(from, to);
  const dateFilter = { gte: fromDate, lte: toDate };

  const [totalAIMessages, totalOutboundMessages, intelligence, tokenSums, approvalRows] = await Promise.all([
    prisma.message.count({
      where: { tenantId, direction: "OUTBOUND", createdAt: dateFilter, metadata: { path: ["source"], equals: "ai_bot" } },
    }),
    prisma.message.count({ where: { tenantId, conversation: REAL_CONVERSATION, direction: "OUTBOUND", createdAt: dateFilter } }),
    prisma.conversationIntelligence.findMany({
      where: { tenantId, analyzedAt: dateFilter },
      select: { aiConfidence: true, resolutionOutcome: true },
    }),
    prisma.usageLog.aggregate({
      where: { tenantId, type: "ai_tokens", createdAt: dateFilter },
      _sum: { quantity: true, promptTokens: true, completionTokens: true },
    }),
    // HITL governance rows - the source for approval rate + override rate
    // (mandated AI metrics; previously computed nowhere).
    prisma.approvalRequest.findMany({
      where: { tenantId, createdAt: dateFilter },
      select: { status: true, modifiedParams: true, createdAt: true, decidedAt: true },
    }),
  ]);

  const totalHumanMessages = Math.max(0, totalOutboundMessages - totalAIMessages);

  const confidenceValues = intelligence
    .filter((i: { aiConfidence: number | null }) => i.aiConfidence != null)
    .map((i: { aiConfidence: number | null }) => i.aiConfidence!);
  const avgAIConfidence = confidenceValues.length
    ? Math.round((confidenceValues.reduce((s: number, c: number) => s + c, 0) / confidenceValues.length) * 100) / 100
    : null;

  const resolvedByAI = intelligence.filter((i: { resolutionOutcome: string | null }) => i.resolutionOutcome === "resolved").length;
  const escalated = intelligence.filter((i: { resolutionOutcome: string | null }) => i.resolutionOutcome === "escalated").length;
  const total = intelligence.length;

  const aiResolutionRate = total > 0 ? Math.round((resolvedByAI / total) * 100) : 0;
  const escalationRate = total > 0 ? Math.round((escalated / total) * 100) : 0;

  // Approval governance: approval rate = approved / decided; override rate =
  // approved-with-modified-params / approved (the human changed what the AI
  // proposed before running it); decision latency = created → decided.
  const approvedRows = approvalRows.filter((a: any) => a.status === "APPROVED");
  const rejectedCount = approvalRows.filter((a: any) => a.status === "REJECTED").length;
  const decidedCount = approvedRows.length + rejectedCount;
  const overriddenCount = approvedRows.filter(
    (a: any) => a.modifiedParams && typeof a.modifiedParams === "object" && Object.keys(a.modifiedParams).length > 0,
  ).length;
  const decisionLatencies = approvalRows
    .filter((a: any) => a.decidedAt)
    .map((a: any) => new Date(a.decidedAt).getTime() - new Date(a.createdAt).getTime());
  const avgDecisionMinutes = decisionLatencies.length
    ? Math.round(decisionLatencies.reduce((s: number, v: number) => s + v, 0) / decisionLatencies.length / 60000)
    : null;

  return {
    totalAIMessages,
    totalHumanMessages,
    aiResolutionRate,
    avgAIConfidence,
    escalationRate,
    approvals: {
      requested: approvalRows.length,
      approved: approvedRows.length,
      rejected: rejectedCount,
      pending: approvalRows.filter((a: any) => a.status === "PENDING").length,
      expired: approvalRows.filter((a: any) => a.status === "EXPIRED").length,
      approvalRate: decidedCount > 0 ? Math.round((approvedRows.length / decidedCount) * 100) : null,
      overrideRate: approvedRows.length > 0 ? Math.round((overriddenCount / approvedRows.length) * 100) : null,
      avgDecisionMinutes,
    },
    tokenUsage: {
      total: tokenSums._sum.quantity || 0,
      prompt: tokenSums._sum.promptTokens || 0,
      completion: tokenSums._sum.completionTokens || 0,
    },
  };
}

export async function getAIInsights(tenantId: string) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const dateFilter = { gte: thirtyDaysAgo };

  const [topIntents, departmentConvs, channelConvs, escalated, lowConfidence] = await Promise.all([
    prisma.conversationIntelligence.groupBy({
      by: ["detectedIntent"],
      where: { tenantId, analyzedAt: dateFilter, detectedIntent: { not: null } },
      _count: { detectedIntent: true },
      orderBy: { _count: { detectedIntent: "desc" } },
      take: 5,
    }),
    prisma.conversation.groupBy({
      by: ["departmentId"],
      where: { tenantId, ...REAL_CONVERSATION, createdAt: dateFilter, departmentId: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 3,
    }),
    prisma.conversation.groupBy({
      by: ["channel"],
      where: { tenantId, ...REAL_CONVERSATION, createdAt: dateFilter },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 1,
    }),
    prisma.conversationIntelligence.count({
      where: { tenantId, analyzedAt: dateFilter, resolutionOutcome: "escalated" },
    }),
    prisma.conversationIntelligence.count({
      where: { tenantId, analyzedAt: dateFilter, aiConfidence: { lt: 0.5 } },
    }),
  ]);

  const totalAnalyzed = await prisma.conversationIntelligence.count({
    where: { tenantId, analyzedAt: dateFilter },
  });

  /**
   * Insights carry a CODE and the numbers that go in the blanks - never a
   * sentence.
   *
   * This block used to compose English prose with the figures interpolated
   * ("The intent X appeared 43 times in the last 30 days"). On a Hebrew screen
   * that renders English, it cannot be translated, and a translation table
   * keyed on the English breaks the first time someone rewords it.
   *
   * The activity stream already solved this - see activity-events.ts - and this
   * is the same treatment: `<noun>.<observation>` plus `values`. The client
   * owns the wording, the clause order and the direction of the text.
   *
   * `id` is deliberately unchanged: dismissals are keyed on it, and rewriting
   * them would silently un-dismiss every card a tenant has already put away.
   */
  const insights: Array<{
    id: string;
    kind: string;
    values: Record<string, unknown>;
    impact: string;
    actionable: boolean;
  }> = [];

  // Insight 1: Top automatable intent
  if (topIntents.length > 0) {
    const top = topIntents[0] as { detectedIntent: string | null; _count: { detectedIntent: number } };
    insights.push({
      id: "top-intent-automation",
      kind: "intent.automatable",
      // Normalized, so this and the queue chip name the intent the same way.
      values: {
        intent: normalizeConversationIntent(top.detectedIntent),
        count: top._count.detectedIntent,
        days: 30,
      },
      impact: "high",
      actionable: true,
    });
  }

  // Insight 2: Escalation rate
  if (totalAnalyzed > 0) {
    const escalationRate = Math.round((escalated / totalAnalyzed) * 100);
    if (escalationRate > 20) {
      insights.push({
        id: "high-escalation-rate",
        kind: "escalation.rate_high",
        values: { percent: escalationRate, escalated, analyzed: totalAnalyzed, days: 30 },
        impact: escalationRate > 40 ? "high" : "medium",
        actionable: true,
      });
    }
  }

  // Insight 3: Low AI confidence
  if (lowConfidence > 0 && totalAnalyzed > 0) {
    const lowPct = Math.round((lowConfidence / totalAnalyzed) * 100);
    insights.push({
      id: "low-ai-confidence",
      kind: "confidence.below_threshold",
      values: { percent: lowPct, count: lowConfidence, analyzed: totalAnalyzed, threshold: 50, days: 30 },
      impact: "medium",
      actionable: true,
    });
  }

  // Insight 4: Top volume channel
  if (channelConvs.length > 0) {
    const topChannel = channelConvs[0] as { channel: string; _count: { id: number } };
    insights.push({
      id: "top-volume-channel",
      kind: "channel.highest_volume",
      // The platform's ChannelType, as every other endpoint returns it.
      values: { channel: topChannel.channel, count: topChannel._count.id, days: 30 },
      impact: "medium",
      actionable: false,
    });
  }

  // Insight 5: Multiple frequent intents
  if (topIntents.length > 2) {
    const automatable = (topIntents as Array<{ detectedIntent: string | null; _count: { detectedIntent: number } }>)
      .filter((i) => i._count.detectedIntent > 5)
      .length;
    if (automatable > 1) {
      insights.push({
        id: "multi-intent-automation",
        kind: "intent.multiple_automatable",
        values: { count: automatable, minOccurrences: 5, days: 30 },
        impact: "high",
        actionable: true,
      });
    }
  }

  // Insight 6: Department load imbalance
  if (departmentConvs.length > 1) {
    const top = departmentConvs[0] as { departmentId: string | null; _count: { id: number } };
    const second = departmentConvs[1] as { departmentId: string | null; _count: { id: number } };
    if (top._count.id > second._count.id * 2) {
      const dept = top.departmentId
        ? await prisma.department.findUnique({ where: { id: top.departmentId }, select: { name: true } })
        : null;
      insights.push({
        id: "department-load-imbalance",
        kind: "department.load_imbalance",
        // A department NAME is tenant data, not display copy: the same string
        // in every language, so it travels as a value.
        values: {
          department: dept?.name ?? null,
          departmentId: top.departmentId,
          count: top._count.id,
          nextCount: second._count.id,
          days: 30,
        },
        impact: "medium",
        actionable: true,
      });
    }
  }

  // Insights are DERIVED on every request, so a dismissal cannot be a flag on
  // one - it is a record that this tenant said no to that id. Filtering here
  // rather than in the route means every caller of getAIInsights honours it.
  const dismissed = await prisma.insightDismissal.findMany({
    where: { tenantId, insightId: { in: insights.map((i) => i.id) } },
    select: { insightId: true },
  });
  if (dismissed.length === 0) return insights;
  const hidden = new Set(dismissed.map((d) => d.insightId));
  return insights.filter((i) => !hidden.has(i.id));
}

/**
 * Hide an insight for this tenant.
 *
 * Idempotent by construction: dismissing twice is not two events, and the
 * unique index says so. Recorded rather than deleted, because "nobody wants to
 * hear about the escalation rate" is itself worth knowing.
 */
export async function dismissInsight(tenantId: string, insightId: string, userId?: string) {
  await prisma.insightDismissal.upsert({
    where: { tenantId_insightId: { tenantId, insightId } },
    create: { tenantId, insightId, dismissedBy: userId ?? null },
    update: {},
  });
}

// ─── Home: "needs you now" ────────────────────────────────────

/**
 * The ranked queue.
 *
 * `getQueueDepth` above answers "how many", which is a number on a card.
 * This answers "which ones, and why that one first", which is what an
 * operator acts on.
 *
 * WHICH CONVERSATIONS COUNT
 * The same predicate the inbox uses for its default view: unassigned, not
 * closed, and not currently being driven by automation. A conversation the AI
 * is handling is not waiting for a human, and putting it in a list titled
 * "needs you now" would be false. `isHandedOver` brings back the ones the AI
 * gave up on, which are exactly the ones that do need somebody.
 *
 * WHY THE WHOLE SET IS SCORED BEFORE PAGING
 * Rank is computed, not stored, so the database cannot order by it. The
 * candidate set is the tenant's unassigned open conversations - tens, not
 * millions - and it is capped anyway. Ordering a page at a time would rank
 * within the page and produce a "top" row that is only top of its slice.
 */
const QUEUE_CANDIDATE_CAP = 500;

export async function getQueueItems(
  tenantId: string,
  opts: { limit?: number; cursor?: string; viewer?: Viewer } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  // The cursor is an offset into a deterministic ordering, not a row id: the
  // sort key is derived, so there is no column to seek on. rankQueueItems
  // imposes a total order (score, then age, then id) precisely so that this
  // offset means the same thing across two requests.
  const offset = (() => {
    const n = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();

  // The same "waiting for a person" as Home's count (see waitingForPersonWhere).
  const where = waitingForPersonWhere(tenantId);
  // 2026-10-09: the inbox's rule, kept in AND (its OR is the visibility
  // clause's own). The count reads the same `where`, so it cannot leak a total.
  const clause = opts.viewer ? visibilityClause(opts.viewer) : null;
  if (clause) (where.AND as unknown[]).push({ OR: clause });

  const [candidates, totalWaiting] = await Promise.all([
    prisma.conversation.findMany({
      where,
      select: {
        id: true,
        createdAt: true,
        channel: true,
        customerName: true,
        customerExternalId: true,
        // Newest first, then walked backwards below: we need the last inbound
        // and how many inbounds have gone unanswered, and both live at the end
        // of the thread.
        messages: {
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { direction: true, body: true, createdAt: true },
        },
      },
      orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
      take: QUEUE_CANDIDATE_CAP,
    }),
    prisma.conversation.count({ where }),
  ]);

  if (candidates.length === 0) {
    return { data: [], nextCursor: null, totalWaiting };
  }

  const intel = await prisma.conversationIntelligence.findMany({
    where: { tenantId, conversationId: { in: candidates.map((c) => c.id) } },
    select: {
      conversationId: true,
      detectedIntent: true,
      sentiment: true,
      sentimentScore: true,
      customerEffort: true,
    },
  });
  const intelByConversation = new Map(intel.map((i) => [i.conversationId, i]));

  const now = new Date();
  const scored = candidates.map((c) => {
    // Walk newest-first and stop at our reply: everything before it is a
    // message the customer sent that nobody has answered.
    let unansweredInbound = 0;
    let lastInboundAt: Date | null = null;
    let preview = "";
    for (const m of c.messages) {
      if (m.direction === "OUTBOUND") break;
      unansweredInbound += 1;
      if (!lastInboundAt) {
        lastInboundAt = m.createdAt;
        preview = (m.body ?? "").trim();
      }
    }

    // Falling back to createdAt rather than lastMessageAt: an outbound reply
    // is not the customer waiting, and using it would restart the clock every
    // time we said something without resolving anything.
    const waitingSince = lastInboundAt ?? c.createdAt;

    const i = intelByConversation.get(c.id);
    const intent = normalizeConversationIntent(i?.detectedIntent, {
      sentiment: i?.sentiment,
      sentimentScore: i?.sentimentScore,
      customerEffort: i?.customerEffort,
    });
    const { score, urgency } = scoreQueueItem(
      {
        waitingSince,
        intent,
        unansweredInbound: Math.max(1, unansweredInbound),
        // Reported alongside, not folded into, `intent`: the chip shows what to
        // act on, the score reflects how hot it is.
        frustrated: isFrustrated(i?.detectedIntent, {
          sentiment: i?.sentiment,
          sentimentScore: i?.sentimentScore,
          customerEffort: i?.customerEffort,
        }),
      },
      now,
    );

    return {
      id: c.id,
      waitingSince,
      score,
      row: {
        conversationId: c.id,
        customer: {
          // The channel identifier is the id here because a conversation is not
          // guaranteed a Contact row; `name` stays null rather than being
          // filled with a phone number dressed up as a name.
          id: c.customerExternalId,
          name: c.customerName ?? null,
        },
        // The platform's ChannelType, uppercase, as every other endpoint
        // returns it. A second lowercase vocabulary for the same concept would
        // mean the frontend maintaining two maps for one idea.
        channel: c.channel,
        preview: preview.length > 160 ? `${preview.slice(0, 159)}…` : preview,
        intent,
        waitingSince: waitingSince.toISOString(),
        urgency,
      },
    };
  });

  const ranked = rankQueueItems(scored);
  const page = ranked.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    data: page.map((r) => ({ ...r.row, rank: r.rank })),
    nextCursor: nextOffset < ranked.length ? String(nextOffset) : null,
    totalWaiting,
  };
}

// ─── Home: what the AI has been doing ─────────────────────────

/**
 * The activity stream.
 *
 * `getToolUsageStats` answers "how often, how fast, how reliably", which is a
 * management report. This answers "what happened, in order", which is what the
 * card on Home shows.
 *
 * TWO SOURCES, ONE TIMELINE. ToolExecution records what ran; ApprovalRequest
 * records what is still waiting for a human to say yes. Merging them is the
 * point: an operator scanning the card needs the pending refund to appear
 * beside the completed ones, because that is the only entry they can still
 * change the outcome of.
 *
 * Emits `kind` + `values`, never a rendered sentence - see activity-events.ts.
 */
export async function getActivity(
  tenantId: string,
  opts: { limit?: number; cursor?: string; viewer?: Viewer } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  // The cursor is a timestamp: the merged stream has no single id sequence to
  // seek on, and both tables are indexed on (tenantId, createdAt).
  const before = (() => {
    if (!opts.cursor) return null;
    const d = new Date(opts.cursor);
    return Number.isNaN(d.getTime()) ? null : d;
  })();
  const timeFilter = before ? { lt: before } : undefined;

  const executionWhere = { tenantId, ...(timeFilter ? { createdAt: timeFilter } : {}) };
  const executionSelect = {
    id: true, toolName: true, input: true, output: true,
    success: true, createdAt: true, conversationId: true,
  } as const;
  const approvalWhere = {
    tenantId,
    status: "PENDING" as const,
    // Same actionability rule as the overview's count, so the card and the
    // metric strip cannot disagree about what is still pending.
    expiresAt: { gt: new Date() },
    ...(timeFilter ? { createdAt: timeFilter } : {}),
  };
  const approvalSelect = { id: true, tool: true, params: true, createdAt: true, conversationId: true } as const;

  // 2026-10-09: a restricted viewer (department agent) sees only rows from
  // conversations the inbox shows them. `null` = unrestricted, unchanged path.
  const clause = opts.viewer ? visibilityClause(opts.viewer) : null;
  let floor: Date | null = null;
  let executions;
  let approvals;
  if (!clause) {
    // Over-fetch from each source: the merge keeps only the newest `limit` of the
    // combined set, and taking exactly `limit` from each would drop older rows
    // from one source that belong on this page.
    [executions, approvals] = await Promise.all([
      prisma.toolExecution.findMany({
        where: executionWhere,
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        select: executionSelect,
      }),
      prisma.approvalRequest.findMany({
        where: approvalWhere,
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        select: approvalSelect,
      }),
    ]);
  } else {
    const order = [{ createdAt: "desc" as const }, { id: "desc" as const }];
    const [e, a] = await Promise.all([
      scanVisible(
        (skip, take) => prisma.toolExecution.findMany({ where: executionWhere, orderBy: order, skip, take, select: executionSelect }),
        tenantId, clause, limit + 1,
      ),
      scanVisible(
        (skip, take) => prisma.approvalRequest.findMany({ where: approvalWhere, orderBy: order, skip, take, select: approvalSelect }),
        tenantId, clause, limit + 1,
      ),
    ]);
    executions = e.rows;
    approvals = a.rows;
    // A source that hit the scan cap was not read below its floor, so the
    // other source's older rows would jump that gap: nothing below it here.
    floor = [e.floor, a.floor].reduce<Date | null>((x, y) => (y && (!x || y > x) ? y : x), null);
  }

  let merged = [
    ...executions.map((e) => ({
      at: e.createdAt,
      event: toActivityEvent({ ...e, conversationId: e.conversationId ?? null }),
    })),
    ...approvals.map((a) => ({
      at: a.createdAt,
      event: approvalToActivityEvent({ ...a, conversationId: a.conversationId ?? null }),
    })),
  ].sort((x, y) => y.at.getTime() - x.at.getTime() || x.event.id.localeCompare(y.event.id));
  if (floor) merged = merged.filter((m) => m.at >= floor!);

  const page = merged.slice(0, limit);
  // Only claim another page when a source actually had more to give. Saying so
  // on a short merge would hand the client a cursor that returns nothing.
  const hasMore =
    merged.length > limit || executions.length > limit || approvals.length > limit || floor !== null;
  const last = page.length > 0 ? page[page.length - 1]!.at : floor;

  return {
    data: page.map((p) => p.event),
    nextCursor: hasMore && last ? last.toISOString() : null,
  };
}

/**
 * How far a restricted viewer's activity read scans before it stops (2026-10-09).
 * Filtering in batches rather than after one LIMIT, so hidden rows never leave
 * a short page with no next cursor; the cap bounds the cost when most are hidden.
 */
const ACTIVITY_SCAN_BATCH = 200;
const ACTIVITY_SCAN_CAP = 2000;

/** Which of these conversations the viewer's clause lets them see. */
async function visibleConversationIds(
  tenantId: string,
  ids: string[],
  clause: Record<string, unknown>[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const where = { tenantId, id: { in: ids }, OR: clause };
  const rows = await prisma.conversation.findMany({
    where,
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * Newest rows of one source the viewer may see, up to `want`. A row with no
 * conversation is not hidden by the rule (no conversation to hide it behind).
 * `floor` is set only when the cap stopped the scan: the oldest row read.
 */
async function scanVisible<T extends { createdAt: Date; conversationId: string | null }>(
  fetchPage: (skip: number, take: number) => Promise<T[]>,
  tenantId: string,
  clause: Record<string, unknown>[],
  want: number,
): Promise<{ rows: T[]; floor: Date | null }> {
  const rows: T[] = [];
  let oldest: Date | null = null;
  for (let skip = 0; skip < ACTIVITY_SCAN_CAP; skip += ACTIVITY_SCAN_BATCH) {
    const batch = await fetchPage(skip, ACTIVITY_SCAN_BATCH);
    const ids = [...new Set(batch.map((r) => r.conversationId).filter((x): x is string => !!x))];
    const visible = await visibleConversationIds(tenantId, ids, clause);
    for (const r of batch) {
      if (r.conversationId && !visible.has(r.conversationId)) continue;
      rows.push(r);
      if (rows.length >= want) return { rows, floor: null };
    }
    if (batch.length < ACTIVITY_SCAN_BATCH) return { rows, floor: null };
    oldest = batch[batch.length - 1]!.createdAt;
  }
  return { rows, floor: oldest };
}

// ─── Home: time saved ─────────────────────────────────────────

/**
 * Seconds the AI saved, and the arithmetic behind it.
 *
 * `basis` is not decoration. This figure sits on the product's first screen and
 * is the single easiest number in the product to inflate, so it ships with
 * everything needed to reconstruct it: how many conversations, how many seconds
 * each, where that per-conversation figure came from and how big its sample was.
 * A number nobody can derive is a number nobody believes twice.
 *
 * HOW LONG A CONVERSATION COSTS A HUMAN
 * Measured from the tenant's own history where there is enough of it, because a
 * platform average is a statement about somebody else's business. The measure is
 * the median span from the customer's first message to the agent's last reply,
 * over conversations a human actually handled.
 *
 * The median rather than the mean: one conversation left open over a weekend
 * would drag a mean into fiction. The cap below does the same job for the
 * middle of the distribution.
 */

/**
 * Nothing above this counts as one conversation's worth of agent time.
 *
 * A thread the customer returned to the next morning spans sixteen hours and
 * cost nobody sixteen hours. Without a ceiling those rows do not just skew the
 * average, they decide it.
 */
const HANDLING_SPAN_CAP_SECONDS = 60 * 60;

/**
 * Fewer measured conversations than this and the tenant's own median is noise,
 * so the platform figure is used and `basis.source` says so.
 */
const MIN_MEASURED_SAMPLE = 20;

/**
 * The platform's assumption when a tenant has no history of its own.
 *
 * Deliberately conservative. Overstating what the product saved is the one
 * error that costs the number its credibility permanently, and understating it
 * costs nothing but a smaller headline. Override per deployment with
 * SECONDS_PER_CONVERSATION.
 */
const PLATFORM_SECONDS_PER_CONVERSATION = 62;

function platformSecondsPerConversation(): number {
  const raw = Number(process.env.SECONDS_PER_CONVERSATION);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : PLATFORM_SECONDS_PER_CONVERSATION;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export async function getTimeSaved(tenantId: string, from?: string, to?: string) {
  const { fromDate, toDate } = parseDateRange(from, to);
  const dateFilter = { gte: fromDate, lte: toDate };

  // The conversations the AI answered - the ones where the saving happened.
  // Same definition getOverview uses (first outbound tagged source=ai_bot), so
  // the two cards cannot report different amounts of AI involvement.
  const aiConversations = await prisma.message.findMany({
    where: {
      tenantId,
      // Sandbox rehearsals carry isTest=false; the sandbox prefix is the marker
      // (same exclusion as /daily and /team, so the three count the same set).
      conversation: REAL_CONVERSATION,
      direction: "OUTBOUND",
      metadata: { path: ["source"], equals: "ai_bot" },
      createdAt: dateFilter,
    },
    select: { conversationId: true },
    distinct: ["conversationId"],
  });
  const conversationsHandled = aiConversations.length;

  // The comparison set: conversations a human drove. `handledBy: "human"` or a
  // takeover, and an assigned agent - a conversation nobody was assigned to is
  // not evidence of what an agent's time costs.
  const humanHandled = await prisma.conversation.findMany({
    where: {
      tenantId,
      ...REAL_CONVERSATION,
      createdAt: dateFilter,
      assignedAgentId: { not: null },
      OR: [{ handledBy: "human" }, { isHandedOver: true }],
    },
    select: {
      id: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { direction: true, createdAt: true },
      },
    },
    take: 500,
  });

  const spans: number[] = [];
  for (const c of humanHandled) {
    const firstInbound = c.messages.find((m) => m.direction === "INBOUND");
    const lastOutbound = [...c.messages].reverse().find((m) => m.direction === "OUTBOUND");
    if (!firstInbound || !lastOutbound) continue;
    const seconds = (lastOutbound.createdAt.getTime() - firstInbound.createdAt.getTime()) / 1000;
    // A negative span means the only outbound preceded the only inbound - an
    // outreach, not a handled request. It is not a zero-cost conversation, it
    // is not this kind of conversation at all.
    if (seconds <= 0) continue;
    spans.push(Math.min(seconds, HANDLING_SPAN_CAP_SECONDS));
  }

  const measured = spans.length >= MIN_MEASURED_SAMPLE ? median(spans) : null;
  const secondsPerConversation = measured ?? platformSecondsPerConversation();

  return {
    secondsSaved: Math.round(conversationsHandled * secondsPerConversation),
    basis: {
      conversationsHandled,
      secondsPerConversation: Math.round(secondsPerConversation),
      // Which of the two answers above produced the figure, so the screen can
      // say "based on your own conversations" rather than implying a precision
      // the platform default does not have.
      source: measured === null ? "platform_default" : "measured",
      sampleSize: spans.length,
      method:
        measured === null
          ? "platform_default"
          : "median_span_first_inbound_to_last_outbound",
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
    },
  };
}

// ─── Per-day series (06 Overview, 06b) ────────────────────────

/**
 * An outbound message the AI sent. Live data has three markers, and checking
 * one of them counted the bot's own post-approval messages as a person's:
 *   metadata.source "ai_bot"                 the bot's replies
 *   metadata.source "approval_continuation"  the bot telling the customer the
 *                                            outcome of an approved action
 *   senderName "AI Bot"                      every bot path writes it
 * (+ metadata.aiGenerated). Everything else outbound and not a system event
 * is a person.
 */
const AI_SOURCES = new Set(["ai_bot", "approval_continuation"]);
export function isAiOutbound(m: { metadata?: unknown; senderName?: string | null }): boolean {
  const meta = (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>;
  return AI_SOURCES.has(String(meta.source ?? "")) || meta.aiGenerated === true || m.senderName === "AI Bot";
}

/** A conversation a person took over, judged from its current state. */
export function wasPassedOver(c: { isHandedOver?: boolean | null; assignedAgentId?: string | null; handledBy?: string | null }): boolean {
  return Boolean(c.isHandedOver || c.assignedAgentId || c.handledBy === "human");
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The last `days` days, one row each, oldest first (UTC days):
 *   gotcha / team   conversations ANSWERED that day, split by who answered:
 *                   "team" if a person sent any reply in it that day, else
 *                   "gotcha" (only the AI replied).
 *   alone / passedOver   conversations STARTED that day, split by whether a
 *                   person has taken them over (handed over, assigned, or
 *                   human-handled) - judged from their state now, since
 *                   handover history is only recorded from 2026-10 on.
 * Test and sandbox conversations are excluded from both.
 */
export async function getDailySeries(tenantId: string, days = 7) {
  const n = Math.min(Math.max(Math.floor(days) || 7, 1), 90);
  const end = new Date();
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - (n - 1)));

  const [replies, started] = await Promise.all([
    prisma.message.findMany({
      where: {
        tenantId,
        direction: "OUTBOUND",
        messageType: { not: "system" },
        createdAt: { gte: start, lte: end },
        conversation: REAL_CONVERSATION,
      },
      select: { conversationId: true, createdAt: true, metadata: true, senderName: true },
      take: 50_000,
    }),
    prisma.conversation.findMany({
      where: { tenantId, ...REAL_CONVERSATION, createdAt: { gte: start, lte: end } },
      select: { createdAt: true, isHandedOver: true, assignedAgentId: true, handledBy: true },
      take: 50_000,
    }),
  ]);

  const rows = new Map<string, { date: string; gotcha: number; team: number; alone: number; passedOver: number }>();
  for (let i = 0; i < n; i++) {
    const d = dayKey(new Date(start.getTime() + i * 86_400_000));
    rows.set(d, { date: d, gotcha: 0, team: 0, alone: 0, passedOver: 0 });
  }

  // conversation x day -> did a person reply?
  const byConvDay = new Map<string, boolean>();
  for (const m of replies as any[]) {
    const k = `${dayKey(m.createdAt)}|${m.conversationId}`;
    byConvDay.set(k, (byConvDay.get(k) ?? false) || !isAiOutbound(m));
  }
  for (const [k, human] of byConvDay) {
    const row = rows.get(k.slice(0, 10));
    if (row) human ? row.team++ : row.gotcha++;
  }
  for (const c of started as any[]) {
    const row = rows.get(dayKey(c.createdAt));
    if (row) wasPassedOver(c) ? row.passedOver++ : row.alone++;
  }

  return { days: n, from: start.toISOString(), to: end.toISOString(), timezone: "UTC", series: [...rows.values()] };
}

// ─── Team report (06c) ────────────────────────────────────────

interface TeamMemberRow {
  kind: "human" | "ai";
  id: string;
  name: string;
  handled: number;
  firstReplyMedianMs: number | null;
  resolvedRate: number | null;
  loadByDay: number[];
}

/**
 * 06c Team: per person (people + AI employees) and the cards above them.
 *
 * Window: the last `days` UTC days (default 7). Attribution is by ownership,
 * because a reply carries no author id - only a display name:
 *   a person handled the conversations ASSIGNED to them that had a reply in
 *   the window; an AI employee handled the ones bound to it
 *   (assignedAiAgentId) where the AI replied in the window.
 * firstReplyMedianMs  median, over those conversations, of the gap from the
 *   first customer message in the window to the first reply after it by that
 *   kind of replier (a person's reply for people, the AI's for the AI).
 *   No target or SLA for the AI (decided).
 * resolvedRate  share of those conversations that are CLOSED now.
 * loadByDay  conversations handled per day, oldest first.
 * People are ADMIN + AGENT, active; SYSTEM_ADMIN is not the business's team.
 * Test and sandbox conversations are excluded throughout.
 *
 * Cards: handledByPeople (conversations with a person's reply in the
 * window), firstReplyMedianMs (people), resolvedRate (people),
 * handedBackToGotcha (handovers back to the AI in the window - recorded
 * from 2026-10 on), busiestHourUtc (the hour with the most customer
 * messages, with the 24-hour histogram so a screen can shift time zones).
 */
export async function getTeamReport(tenantId: string, days = 7) {
  const n = Math.min(Math.max(Math.floor(days) || 7, 1), 90);
  const end = new Date();
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - (n - 1)));
  const window = { gte: start, lte: end };
  const dayIndex = (d: Date) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start.getTime()) / 86_400_000);

  const [people, ais, messages, handbacks] = await Promise.all([
    prisma.user.findMany({
      where: { tenantId, role: { in: ["ADMIN", "AGENT"] }, isActive: true },
      select: { id: true, name: true, email: true },
    }),
    prisma.aIAgent.findMany({
      where: { tenantId, status: { in: ["ACTIVE", "PAUSED"] } },
      select: { id: true, name: true },
    }),
    prisma.message.findMany({
      where: {
        tenantId,
        createdAt: window,
        messageType: { not: "system" },
        conversation: REAL_CONVERSATION,
      },
      select: {
        conversationId: true, direction: true, createdAt: true, metadata: true, senderName: true,
        conversation: { select: { status: true, assignedAgentId: true, assignedAiAgentId: true } },
      },
      orderBy: { createdAt: "asc" },
      take: 50_000,
    }),
    (prisma as any).conversationHandover.count({
      where: { tenantId, toHandler: "ai_agent", reason: "return_to_ai", at: window },
    }).catch(() => 0),
  ]);

  // Per conversation, in time order.
  type Conv = { status: string; agent: string | null; ai: string | null; msgs: any[] };
  const convs = new Map<string, Conv>();
  const hourHistogram = new Array(24).fill(0);
  for (const m of messages as any[]) {
    const c: Conv = convs.get(m.conversationId) ?? {
      status: m.conversation.status, agent: m.conversation.assignedAgentId, ai: m.conversation.assignedAiAgentId, msgs: [] as any[],
    };
    c.msgs.push(m);
    convs.set(m.conversationId, c);
    if (m.direction === "INBOUND") hourHistogram[m.createdAt.getUTCHours()]++;
  }

  const firstReplyGap = (msgs: any[], byAi: boolean): number | null => {
    const firstIn = msgs.find((m) => m.direction === "INBOUND");
    if (!firstIn) return null;
    const reply = msgs.find((m) => m.direction === "OUTBOUND" && m.createdAt > firstIn.createdAt && isAiOutbound(m) === byAi);
    return reply ? reply.createdAt.getTime() - firstIn.createdAt.getTime() : null;
  };

  const report = (kind: "human" | "ai", id: string, name: string): TeamMemberRow => {
    const mine = [...convs.entries()].filter(([, c]) =>
      kind === "human"
        ? c.agent === id && c.msgs.some((m) => m.direction === "OUTBOUND")
        : c.ai === id && c.msgs.some((m) => m.direction === "OUTBOUND" && isAiOutbound(m)),
    );
    const gaps = mine.map(([, c]) => firstReplyGap(c.msgs, kind === "ai")).filter((g): g is number => g != null);
    const loadByDay = new Array(n).fill(0);
    for (const [, c] of mine) {
      const daysTouched = new Set(c.msgs.filter((m) => m.direction === "OUTBOUND").map((m) => dayIndex(m.createdAt)));
      for (const d of daysTouched) if (d >= 0 && d < n) loadByDay[d]++;
    }
    return {
      kind,
      id,
      name,
      handled: mine.length,
      firstReplyMedianMs: median(gaps),
      resolvedRate: mine.length ? Math.round((mine.filter(([, c]) => c.status === "CLOSED").length / mine.length) * 100) / 100 : null,
      loadByDay,
    };
  };

  const members = [
    ...people.map((u: any) => report("human", u.id, u.name || u.email)),
    ...ais.map((a: any) => report("ai", a.id, a.name)),
  ];

  // Cards, over every conversation a PERSON replied in (assigned or not).
  const humanConvs = [...convs.values()].filter((c) => c.msgs.some((m) => m.direction === "OUTBOUND" && !isAiOutbound(m)));
  const humanGaps = humanConvs.map((c) => firstReplyGap(c.msgs, false)).filter((g): g is number => g != null);
  const peak = Math.max(...hourHistogram);

  return {
    days: n,
    from: start.toISOString(),
    to: end.toISOString(),
    members,
    cards: {
      handledByPeople: humanConvs.length,
      firstReplyMedianMs: median(humanGaps),
      resolvedRate: humanConvs.length ? Math.round((humanConvs.filter((c) => c.status === "CLOSED").length / humanConvs.length) * 100) / 100 : null,
      handedBackToGotcha: handbacks,
      busiestHourUtc: peak > 0 ? hourHistogram.indexOf(peak) : null,
      inboundByHourUtc: hourHistogram,
    },
  };
}

// ─── The quiet-day sources ────────────────────────────────────

/**
 * Questions GOTCHA could not answer.
 *
 * NOT getTopQuestions with a filter. That ranks intent slugs by frequency and
 * has no concept of a miss, so a question asked thirty times and answered badly
 * thirty times is indistinguishable there from a popular one. These rows were
 * written at the moment retrieval failed, with the reason it failed.
 *
 * Resolved gaps are excluded by default: the list is a to-do, and something the
 * owner has already written an article about does not belong on it. It is
 * excluded, not deleted, so the record that it was once a gap survives.
 */

/**
 * An optional date window. Null when neither end was given, which means "all
 * of history" - distinct from a window that happens to be empty.
 */
function parseOptionalRange(from?: string, to?: string): { fromDate: Date; toDate: Date } | null {
  if (!from && !to) return null;
  return parseDateRange(from, to);
}

export async function getUnansweredQuestions(
  tenantId: string,
  opts: { limit?: number; includeResolved?: boolean; from?: string; to?: string } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);

  // The card says "four questions it could not answer THIS WEEK", so the
  // window has to be a parameter rather than the whole of history. Filtered on
  // lastAskedAt, not firstAskedAt: a gap opened in March and asked again this
  // morning is a question it could not answer this week.
  const window = parseOptionalRange(opts.from, opts.to);

  const rows = await prisma.unansweredQuestion.findMany({
    where: {
      tenantId,
      ...(opts.includeResolved ? {} : { resolvedAt: null }),
      ...(window ? { lastAskedAt: { gte: window.fromDate, lte: window.toDate } } : {}),
    },
    // By how badly it is missing, then by how recently - a gap asked forty
    // times last month outranks one asked twice this morning.
    orderBy: [{ askCount: "desc" }, { lastAskedAt: "desc" }],
    take: limit,
    select: {
      id: true, question: true, reason: true, askCount: true, askedBy: true,
      firstAskedAt: true, lastAskedAt: true, resolvedAt: true,
    },
  });

  return {
    // Echoed back so the card's "this week" is checkable against the window it
    // actually used, rather than a default the reader cannot see.
    period: window
      ? { from: window.fromDate.toISOString(), to: window.toDate.toISOString() }
      : null,
    data: rows.map((r) => ({
      id: r.id,
      question: r.question,
      reason: r.reason,
      askCount: r.askCount,
      askedBy: r.askedBy,
      firstAskedAt: r.firstAskedAt.toISOString(),
      lastAskedAt: r.lastAskedAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * What people asked the catalogue for.
 *
 * Defaults to the CURRENT ISO week, because the card's claim is "this week" and
 * a running total since launch cannot answer "is this getting worse". Defaults
 * to misses, because a term the shop already stocks is not a finding.
 */
export async function getProductDemand(
  tenantId: string,
  opts: { limit?: number; weekKey?: string; includeStocked?: boolean } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const weekKey = opts.weekKey || isoWeekKey();

  const rows = await prisma.productDemandTerm.findMany({
    where: {
      tenantId,
      weekKey,
      ...(opts.includeStocked ? {} : { inCatalogue: false }),
    },
    orderBy: [{ askCount: "desc" }, { lastSeenAt: "desc" }],
    take: limit,
    select: {
      id: true, term: true, askCount: true, askedBy: true,
      inCatalogue: true, firstSeenAt: true, lastSeenAt: true,
    },
  });

  const weeksRunning = await consecutiveWeeks(tenantId, rows.map((r) => r.term), weekKey);

  return {
    // Echoed back, never left implicit: a card that says "this week" beside a
    // number is making a claim about which week, and the reader cannot check it
    // against a default they cannot see.
    weekKey,
    data: rows.map((r) => ({
      id: r.id,
      term: r.term,
      askCount: r.askCount,
      askedBy: r.askedBy,
      inCatalogue: r.inCatalogue,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      // "Second week running" - the line that turns a number into a trend.
      weeksRunning: weeksRunning.get(r.term) ?? 1,
    })),
  };
}

/**
 * How many weeks in an unbroken run, ending at `weekKey`, each term has been
 * asked for.
 *
 * CONSECUTIVE, not total. A term asked in March and again this week is not on
 * a two-week run, and reporting it as one would tell the owner a dead question
 * is a growing trend. The run stops at the first missing week.
 *
 * One query for the whole page, walked backwards in memory: the alternative is
 * a query per term per week, which is a card that gets slower the more useful
 * it becomes.
 */
const WEEKS_RUNNING_LOOKBACK = 12;

async function consecutiveWeeks(
  tenantId: string,
  terms: string[],
  currentWeek: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (terms.length === 0) return out;

  // The window to look back over, oldest first.
  const weeks: string[] = [];
  const cursor = new Date();
  for (let i = 0; i < WEEKS_RUNNING_LOOKBACK; i++) {
    weeks.push(isoWeekKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }

  const rows = await prisma.productDemandTerm.findMany({
    where: { tenantId, term: { in: terms }, weekKey: { in: weeks } },
    select: { term: true, weekKey: true },
  });

  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!seen.has(r.term)) seen.set(r.term, new Set());
    seen.get(r.term)!.add(r.weekKey);
  }

  for (const term of terms) {
    const present = seen.get(term) ?? new Set<string>();
    let run = 0;
    // weeks[0] is the current week; walk back until a gap.
    for (const w of weeks) {
      if (!present.has(w)) break;
      run++;
    }
    // A term on this page was asked this week by construction, so a run of
    // zero would be an artefact of the lookback rather than a fact.
    out.set(term, Math.max(1, run));
  }
  return out;
}

/**
 * Customers who used to talk to this business and have stopped.
 *
 * "Dormant" is a JUDGEMENT, not a fact, so the endpoint returns the definition
 * it used alongside the rows. Without it the number is unfalsifiable: nobody
 * reading "47 dormant customers" can tell whether that means silent for a month
 * or for a year, and the two would lead to completely different decisions.
 *
 * The floor matters as much as the ceiling. Somebody who wrote once, four
 * months ago, is not a lapsed customer - they are a stranger who asked a
 * question. Requiring a minimum number of conversations is what separates the
 * two, and without it this is a list of one-time enquirers.
 */
const DORMANT_DEFAULT_DAYS = 60;
const DORMANT_MIN_CONVERSATIONS = 2;

export async function getDormantCustomers(
  tenantId: string,
  opts: { limit?: number; days?: number; minConversations?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const days = Math.min(Math.max(opts.days ?? DORMANT_DEFAULT_DAYS, 7), 730);
  const minConversations = Math.min(
    Math.max(opts.minConversations ?? DORMANT_MIN_CONVERSATIONS, 1),
    50,
  );
  const cutoff = new Date(Date.now() - days * 86_400_000);

  // Grouped on the identity a conversation actually carries. There is no
  // contactId on Conversation - the customer is `customerExternalId` (a phone
  // number on WhatsApp, a PSID on Messenger) scoped by channel, because the
  // same string on two channels is not the same person.
  const grouped = await prisma.conversation.groupBy({
    by: ["customerExternalId", "channel"],
    where: { tenantId, ...REAL_CONVERSATION },
    _count: { _all: true },
    _max: { lastMessageAt: true, customerName: true },
  });

  const dormant = grouped
    .filter((g) => {
      if (g._count._all < minConversations) return false;
      const last = g._max.lastMessageAt;
      // A customer with conversations but no message timestamp cannot be SHOWN
      // to have gone quiet, so they are left out rather than assumed dormant.
      return last !== null && last < cutoff;
    })
    // Quietest first: the longest silence is the one most worth breaking.
    .sort((a, b) => a._max.lastMessageAt!.getTime() - b._max.lastMessageAt!.getTime())
    .slice(0, limit);

  return {
    // The definition travels WITH the rows. It is the difference between a
    // number a reader can act on and one they have to take on trust.
    definition: {
      quietForDays: days,
      minConversations,
      quietSince: cutoff.toISOString(),
    },
    data: dormant.map((d) => ({
      // The channel identifier IS the id here, because there is no guaranteed
      // Contact row behind it. `name` stays null rather than being filled with
      // a phone number dressed up as a name.
      customerId: d.customerExternalId,
      channel: d.channel,
      name: d._max.customerName ?? null,
      conversationCount: d._count._all,
      lastSeenAt: d._max.lastMessageAt!.toISOString(),
      quietDays: Math.floor((Date.now() - d._max.lastMessageAt!.getTime()) / 86_400_000),
    })),
  };
}

// ─── Home: what is happening right now ────────────────────────

/**
 * The "right now" line on the dark card.
 *
 * Neither existing endpoint answers this. `getActivity` is PAST tense - what
 * happened, in order. `getQueueDepth` counts customers WAITING, which is the
 * opposite of work in flight. This is the present continuous: what the AI is
 * doing at this instant.
 *
 * `toolsRunning` groups by SUBJECT rather than tool name, because the sentence
 * the card renders is "checking 4 orders" - not "4 executions of get_order".
 * Three different order-lookup tools are one fact to the person reading it.
 */
const IN_FLIGHT_WINDOW_MS = 2 * 60_000;

export async function getInFlight(tenantId: string) {
  const since = new Date(Date.now() - IN_FLIGHT_WINDOW_MS);
  const now = new Date();

  const [conversationsHandling, recentExecutions, awaitingApproval] = await Promise.all([
    // Driven by automation, not closed, and spoken in inside the window. A
    // conversation the AI opened yesterday and has said nothing in since is
    // not something it is doing "right now".
    prisma.conversation.count({
      where: {
        tenantId,
        ...REAL_CONVERSATION,
        status: { in: ["OPEN", "WAITING"] as ("OPEN" | "WAITING")[] },
        handledBy: { in: ["ai_agent", "flow"] },
        isHandedOver: false,
        lastMessageAt: { gte: since },
      },
    }),
    prisma.toolExecution.findMany({
      where: { tenantId, createdAt: { gte: since } },
      select: { toolName: true },
    }),
    // The SAME predicate getOverview uses for pendingApprovalCount, so the
    // sentence and the metric strip cannot disagree about what is waiting.
    prisma.approvalRequest.count({
      where: { tenantId, status: "PENDING", expiresAt: { gt: now } },
    }),
  ]);

  const bySubject = new Map<string, number>();
  for (const e of recentExecutions) {
    const subject = toolSubject(e.toolName);
    // An unmapped tool has no honest noun, and inventing one would put
    // "checking 4 orders" on the card for something that touched no order.
    if (subject === "none") continue;
    bySubject.set(subject, (bySubject.get(subject) ?? 0) + 1);
  }

  return {
    conversationsHandling,
    toolsRunning: [...bySubject.entries()]
      .map(([subject, count]) => ({ subject, count }))
      .sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject)),
    awaitingApproval,
  };
}

// ─── Home: "worth an hour, while it is quiet" ─────────────────

/**
 * The four quiet-day sources, merged and ranked by how much future work each
 * removes.
 *
 * Ranked HERE for the same reason the queue is: four sources in four different
 * units cannot be ordered by a client without it inventing weights, and two
 * clients inventing their own weights disagree the moment either changes.
 *
 * The reasoning lives in shared (quiet-day-ranking.ts); this function's job is
 * only to find out what is true. Note that the conflicts source lives in
 * services/ai, so it is left out here rather than reached for across a service
 * boundary - the endpoint says so in `sources`, instead of quietly ranking a
 * shorter list and looking complete.
 */
export async function getQuietDayList(
  tenantId: string,
  opts: { limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const weekKey = isoWeekKey();

  const [unansweredRows, demandRows, dormant] = await Promise.all([
    prisma.unansweredQuestion.findMany({
      where: { tenantId, resolvedAt: null },
      orderBy: [{ askCount: "desc" }, { lastAskedAt: "desc" }],
      take: 25,
      select: { id: true, question: true, reason: true, askCount: true, askedBy: true,
                firstAskedAt: true, lastAskedAt: true },
    }),
    getProductDemand(tenantId, { limit: 25, weekKey }),
    getDormantCustomers(tenantId, { limit: 1 }),
  ]);

  const now = Date.now();
  const items = buildQuietDayList({
    unanswered: unansweredRows.map((r) => ({
      id: r.id,
      question: r.question,
      reason: r.reason,
      askCount: r.askCount,
      askedBy: r.askedBy,
      // How long it has been observed, so a gap asked 30 times in a week is
      // not rated the same as one asked 30 times over six months.
      weeksObserved: Math.max(
        1,
        Math.round((now - r.firstAskedAt.getTime()) / (7 * 86_400_000)),
      ),
    })),
    // Conflicts are owned by services/ai; see the note above.
    conflicts: [],
    demand: demandRows.data
      .filter((d) => !d.inCatalogue)
      .map((d) => ({
        id: d.id,
        term: d.term,
        askCount: d.askCount,
        askedBy: d.askedBy,
        weeksRunning: d.weeksRunning,
      })),
    dormant:
      dormant.data.length > 0
        ? { count: dormant.data.length, quietForDays: dormant.definition.quietForDays }
        : null,
  });

  return {
    weekKey,
    // Which sources this ranking actually saw. A card that silently omits one
    // reads as "there is nothing there", which is a different claim.
    sources: {
      unanswered_question: true,
      product_demand: true,
      dormant_customers: true,
      knowledge_conflict: false,
    },
    data: items.slice(0, limit),
  };
}

// ─── Language share ──────────────────────────────────────────

/**
 * What a conversation has to be to count as the business's real traffic.
 *
 * ★ BOTH HALVES ARE REQUIRED AND `isTest` ALONE DOES NOTHING USEFUL. Sandbox
 * conversations - the AI-employee rehearsals a team runs during setup - are
 * written with `isTest = false`, so filtering on that flag alone lets every one
 * of them through. The external-id prefix is the product's own definition of a
 * sandbox conversation (`sandbox-conversation.service.ts`), so it cannot drift
 * from what the test chat actually writes.
 *
 * This is the same pair that now defines a billable conversation in
 * `usage-allowance.ts` (fixed in bd1ddf0a) and in billing's observed-usage
 * measurement, so "what counts as a conversation" has ONE definition.
 *
 * Every conversation and message query in this file uses it (the 21 that read
 * `isTest: false` alone were moved in one pass, and
 * `__tests__/test-conversations-excluded.test.ts` no longer accepts the
 * incomplete form). It is the same definition as @chatcenter/shared's
 * REAL_CONVERSATION (pinned by that test); it is declared here because this
 * service's tests mock the shared barrel wholesale.
 */
export const REAL_CONVERSATION = {
  isTest: false,
  NOT: { customerExternalId: { startsWith: "sandbox:" } },
} as const;

export interface LanguageShareRow {
  /** ISO-639-1, or null for a conversation whose language was never detected. */
  locale: string | null;
  conversations: number;
  /** Percentage of ALL conversations in the window, including undetected ones. */
  share: number;
}

/**
 * The language mix of recent conversations, for "most of your traffic is in X -
 * do you answer in X?".
 *
 * `Conversation.detectedLocale` is set once per thread by
 * `incoming-worker/src/services/locale-detect.service.ts`, so this is measured
 * from what customers actually wrote, not from any setting.
 *
 * ★ UNDETECTED CONVERSATIONS ARE A ROW, NOT A DROPPED RECORD. Excluding them
 * would divide by a smaller population and overstate every language - a panel
 * reading "62% Hebrew" when a third of the traffic was never classified is
 * wrong in the direction that invites a decision. Shares here always sum to
 * 100% of the window.
 */
export async function getLanguageShare(
  tenantId: string,
  days = 30,
): Promise<{ windowDays: number; total: number; rows: LanguageShareRow[] }> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const grouped = await prisma.conversation.groupBy({
    by: ["detectedLocale"],
    where: { tenantId, ...REAL_CONVERSATION, createdAt: { gte: since } },
    _count: { _all: true },
  });

  const total = grouped.reduce((sum, g) => sum + g._count._all, 0);
  const rows: LanguageShareRow[] = grouped
    .map((g) => ({
      // Normalised to the language, not the tag: "he-IL" and "he" are one
      // language to a person choosing which languages to answer in.
      locale: g.detectedLocale ? String(g.detectedLocale).toLowerCase().slice(0, 2) : null,
      conversations: g._count._all,
      share: 0,
    }))
    // Merging after normalisation, since two tags can collapse onto one language.
    .reduce<LanguageShareRow[]>((acc, r) => {
      const found = acc.find((x) => x.locale === r.locale);
      if (found) found.conversations += r.conversations;
      else acc.push(r);
      return acc;
    }, [])
    .map((r) => ({ ...r, share: total > 0 ? Math.round((r.conversations / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.conversations - a.conversations);

  return { windowDays: days, total, rows };
}
