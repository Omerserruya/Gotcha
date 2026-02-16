import { prisma, getRedis } from "@chatcenter/shared";

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
