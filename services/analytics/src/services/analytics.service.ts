import { prisma, getRedis } from "@chatcenter/shared";

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

export async function getDashboardStats(tenantId: string) {
  const redis = getRedis();
  const today = new Date().toISOString().slice(0, 10);
  const [activeConversations, waitingConversations, dailyData, responseTimes, resolutionTimes] = await Promise.all([
    prisma.conversation.count({ where: { tenantId, status: "OPEN" } }),
    prisma.conversation.count({ where: { tenantId, status: "WAITING" } }),
    redis.hgetall(`analytics:${tenantId}:${today}`),
    redis.lrange(`analytics:${tenantId}:response_times:${today}`, 0, -1),
    redis.lrange(`analytics:${tenantId}:resolution_times:${today}`, 0, -1),
  ]);
  const avgResponseTimeMs = responseTimes.length ? responseTimes.reduce((sum, t) => sum + parseInt(t, 10), 0) / responseTimes.length : null;
  const avgResolutionTimeMs = resolutionTimes.length ? resolutionTimes.reduce((sum, t) => sum + parseInt(t, 10), 0) / resolutionTimes.length : null;
  return {
    activeConversations, waitingConversations,
    closedToday: parseInt(dailyData.conversations_closed || "0", 10),
    totalMessagesToday: parseInt(dailyData.messages_total || "0", 10),
    avgResponseTimeMs: avgResponseTimeMs ? Math.round(avgResponseTimeMs) : null,
    avgResolutionTimeMs: avgResolutionTimeMs ? Math.round(avgResolutionTimeMs) : null,
  };
}

export async function getAgentStats(tenantId: string) {
  const redis = getRedis();
  const today = new Date().toISOString().slice(0, 10);
  const agents = await prisma.user.findMany({
    where: { tenantId, role: "AGENT", isActive: true },
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
      agentId: agent.id, name: agent.name, email: agent.email,
      activeConversations: agent._count.conversations,
      claimedToday: parseInt(agentData.claimed || "0", 10),
      avgResponseTimeMs: avgResponseTimeMs ? Math.round(avgResponseTimeMs) : null,
    });
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

export async function getQueueDepth(tenantId: string) {
  const waitingConversations = await prisma.conversation.findMany({
    where: { tenantId, status: { in: ["OPEN", "WAITING"] }, assignedAgentId: null },
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
  ] = await Promise.all([
    prisma.conversation.count({ where: { tenantId, createdAt: dateFilter } }),
    prisma.conversation.count({ where: { tenantId, status: "CLOSED", createdAt: dateFilter } }),
    prisma.message.count({ where: { tenantId, createdAt: dateFilter } }),
    prisma.conversation.findMany({
      where: { tenantId, status: "CLOSED", closedAt: dateFilter },
      select: { createdAt: true, closedAt: true, assignedAgentId: true, messages: { select: { metadata: true }, take: 1, where: { direction: "OUTBOUND" } } },
    }),
    prisma.conversation.count({ where: { tenantId, createdAt: priorFilter } }),
    prisma.conversation.count({ where: { tenantId, status: "CLOSED", createdAt: priorFilter } }),
    prisma.message.count({ where: { tenantId, createdAt: priorFilter } }),
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
    aiHandledCount = await prisma.message.count({
      where: {
        tenantId,
        direction: "OUTBOUND",
        createdAt: dateFilter,
        metadata: { path: ["source"], equals: "ai_bot" },
      },
    });
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
    deltas: { totalConversationsPct: totalDelta, resolvedConversationsPct: resolvedDelta, totalMessagesPct: messagesDelta },
    period: { from: fromDate.toISOString(), to: toDate.toISOString() },
  };
}

export async function getTopQuestions(tenantId: string, from?: string, to?: string, limit = 10) {
  const { fromDate, toDate } = parseDateRange(from, to);
  const dateFilter = { gte: fromDate, lte: toDate };

  // Group by detectedIntent from ConversationIntelligence
  const intentGroups = await prisma.conversationIntelligence.groupBy({
    by: ["detectedIntent"],
    where: { tenantId, analyzedAt: dateFilter, detectedIntent: { not: null } },
    _count: { detectedIntent: true },
    orderBy: { _count: { detectedIntent: "desc" } },
    take: limit,
  });

  if (intentGroups.length > 0) {
    return intentGroups.map((g: { detectedIntent: string | null; _count: { detectedIntent: number } }) => ({
      question: g.detectedIntent,
      intent: g.detectedIntent,
      count: g._count.detectedIntent,
      automatable: g._count.detectedIntent > 5,
    }));
  }

  // Fallback: analyze inbound message bodies
  const messages = await prisma.message.findMany({
    where: { tenantId, direction: "INBOUND", createdAt: dateFilter },
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

  const executions = await prisma.toolExecution.findMany({
    where: { tenantId, createdAt: dateFilter },
    select: {
      tenantToolId: true,
      success: true,
      durationMs: true,
      tenantTool: { select: { catalogTool: { select: { name: true } } } },
    },
  });

  const byTool: Record<string, { toolName: string; total: number; successes: number; durations: number[] }> = {};
  for (const ex of executions) {
    const toolName = ex.tenantTool?.catalogTool?.name ?? "unknown";
    if (!byTool[ex.tenantToolId]) {
      byTool[ex.tenantToolId] = { toolName, total: 0, successes: 0, durations: [] };
    }
    byTool[ex.tenantToolId].total += 1;
    if (ex.success) byTool[ex.tenantToolId].successes += 1;
    if (ex.durationMs != null) byTool[ex.tenantToolId].durations.push(ex.durationMs);
  }

  return Object.entries(byTool).map(([toolId, stats]) => ({
    toolId,
    toolName: stats.toolName,
    executionCount: stats.total,
    successRate: stats.total > 0 ? Math.round((stats.successes / stats.total) * 100) : 0,
    avgDurationMs: stats.durations.length
      ? Math.round(stats.durations.reduce((s, d) => s + d, 0) / stats.durations.length)
      : null,
  }));
}

export async function getChannelPerformance(tenantId: string, from?: string, to?: string) {
  const { fromDate, toDate } = parseDateRange(from, to);
  const dateFilter = { gte: fromDate, lte: toDate };

  const conversations = await prisma.conversation.findMany({
    where: { tenantId, createdAt: dateFilter },
    select: { id: true, channel: true, status: true, createdAt: true, closedAt: true },
  });

  const convIds = conversations.map((c: { id: string }) => c.id);
  const messages = convIds.length > 0
    ? await prisma.message.groupBy({
        by: ["conversationId"],
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
      where: { tenantId, createdAt: dateFilter, departmentId: { not: null } },
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

  const [totalAIMessages, totalOutboundMessages, intelligence, tokenSums] = await Promise.all([
    prisma.message.count({
      where: { tenantId, direction: "OUTBOUND", createdAt: dateFilter, metadata: { path: ["source"], equals: "ai_bot" } },
    }),
    prisma.message.count({ where: { tenantId, direction: "OUTBOUND", createdAt: dateFilter } }),
    prisma.conversationIntelligence.findMany({
      where: { tenantId, analyzedAt: dateFilter },
      select: { aiConfidence: true, resolutionOutcome: true },
    }),
    prisma.usageLog.aggregate({
      where: { tenantId, type: "ai_tokens", createdAt: dateFilter },
      _sum: { quantity: true, promptTokens: true, completionTokens: true },
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

  return {
    totalAIMessages,
    totalHumanMessages,
    aiResolutionRate,
    avgAIConfidence,
    escalationRate,
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
      where: { tenantId, createdAt: dateFilter, departmentId: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 3,
    }),
    prisma.conversation.groupBy({
      by: ["channel"],
      where: { tenantId, createdAt: dateFilter },
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

  const insights: Array<{ id: string; type: string; title: string; description: string; impact: string; actionable: boolean }> = [];

  // Insight 1: Top automatable intent
  if (topIntents.length > 0) {
    const top = topIntents[0] as { detectedIntent: string | null; _count: { detectedIntent: number } };
    insights.push({
      id: "top-intent-automation",
      type: "automation",
      title: `Automate "${top.detectedIntent}" responses`,
      description: `The intent "${top.detectedIntent}" appeared ${top._count.detectedIntent} times in the last 30 days. Creating an automated flow could reduce agent workload significantly.`,
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
        type: "performance",
        title: "High escalation rate detected",
        description: `${escalationRate}% of AI-handled conversations were escalated to human agents. Review AI confidence thresholds and knowledge base coverage.`,
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
      type: "quality",
      title: "AI confidence below threshold",
      description: `${lowPct}% of conversations had AI confidence below 50%. Expanding your knowledge base or refining prompts could improve accuracy.`,
      impact: "medium",
      actionable: true,
    });
  }

  // Insight 4: Top volume channel
  if (channelConvs.length > 0) {
    const topChannel = channelConvs[0] as { channel: string; _count: { id: number } };
    insights.push({
      id: "top-volume-channel",
      type: "volume",
      title: `${topChannel.channel} is your highest-volume channel`,
      description: `${topChannel._count.id} conversations came through ${topChannel.channel} in the last 30 days. Ensure dedicated automation and staffing for this channel.`,
      impact: "medium",
      actionable: false,
    });
  }

  // Insight 5: Multiple frequent intents
  if (topIntents.length > 2) {
    const automatable = (topIntents as Array<{ detectedIntent: string | null; _count: { detectedIntent: number } }>)
      .filter(i => i._count.detectedIntent > 5)
      .length;
    if (automatable > 1) {
      insights.push({
        id: "multi-intent-automation",
        type: "automation",
        title: `${automatable} intents are candidates for automation`,
        description: `${automatable} recurring intents each appeared more than 5 times. Building chatbot flows for these could reduce repetitive agent work.`,
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
        type: "staffing",
        title: `${dept?.name || "One department"} is handling disproportionate volume`,
        description: `This department received ${top._count.id} conversations vs ${second._count.id} for the next busiest. Consider rebalancing routing rules or adding agents.`,
        impact: "medium",
        actionable: true,
      });
    }
  }

  return insights;
}
