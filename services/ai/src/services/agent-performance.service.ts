import { prisma } from "@chatcenter/shared";

// ─── Score an agent's performance for a conversation ────────

export async function scoreAgent(tenantId: string, conversationId: string): Promise<any | null> {
  // Fetch conversation with assigned agent, messages, tool executions, intelligence
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: {
      assignedAgent: { select: { id: true, name: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        select: { direction: true, body: true, createdAt: true, metadata: true },
      },
      intelligence: true,
    },
  });

  if (!conversation || !conversation.assignedAgent) {
    return null;
  }

  const agentId = conversation.assignedAgent.id;
  const messages = conversation.messages as Array<{
    direction: string;
    body: string;
    createdAt: Date;
    metadata: any;
  }>;
  const intelligence = conversation.intelligence;

  // ── responseSpeed (1-5) ──────────────────────────────────
  const inboundMessages = messages.filter((m) => m.direction === "INBOUND");
  const outboundMessages = messages.filter((m) => m.direction === "OUTBOUND");

  let responseSpeed = 3;
  if (inboundMessages.length > 0 && outboundMessages.length > 0) {
    const responseTimes: number[] = [];
    for (const inbound of inboundMessages) {
      const nextOutbound = outboundMessages.find(
        (o) => o.createdAt > inbound.createdAt
      );
      if (nextOutbound) {
        const diffMs = nextOutbound.createdAt.getTime() - inbound.createdAt.getTime();
        responseTimes.push(diffMs / 1000 / 60); // minutes
      }
    }
    if (responseTimes.length > 0) {
      const avgMinutes = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
      if (avgMinutes < 1) responseSpeed = 5;
      else if (avgMinutes < 3) responseSpeed = 4;
      else if (avgMinutes < 5) responseSpeed = 3;
      else if (avgMinutes < 10) responseSpeed = 2;
      else responseSpeed = 1;
    }
  }

  // ── resolutionScore (1-5) ────────────────────────────────
  const outcome = intelligence?.resolutionOutcome || "abandoned";
  let resolutionScore: number;
  if (outcome === "resolved") resolutionScore = 5;
  else if (outcome === "escalated") resolutionScore = 3;
  else if (conversation.status === "OPEN" || conversation.status === "WAITING") resolutionScore = 2;
  else resolutionScore = 1;

  // ── customerHandling (1-5) ───────────────────────────────
  const sentiment = intelligence?.sentiment || "neutral";
  let customerHandling: number;
  if (sentiment === "positive") customerHandling = 5;
  else if (sentiment === "neutral") customerHandling = 3;
  else customerHandling = 1;

  // ── copilotUsageRate ─────────────────────────────────────
  const outboundCount = outboundMessages.length;
  const copilotUsed = outboundMessages.filter((m) => {
    const meta = m.metadata as any;
    return meta?.aiSuggestionUsed === true || meta?.copilotUsed === true;
  }).length;
  const copilotUsageRate = outboundCount > 0 ? copilotUsed / outboundCount : 0;

  // ── toolsUsedCount ───────────────────────────────────────
  const toolExecutions = await prisma.toolExecution.count({
    where: { conversationId, tenantId },
  });

  // ── protocolAdherence (1-5) ──────────────────────────────
  let protocolAdherence = 1;
  if (copilotUsageRate > 0.5) protocolAdherence += 2;
  if (toolExecutions > 0) protocolAdherence += 1;
  if (resolutionScore >= 4) protocolAdherence += 1;
  protocolAdherence = Math.min(5, protocolAdherence);

  // ── responseQuality (1-5) ────────────────────────────────
  // Heuristic: based on avg message length and resolution
  const avgBodyLength =
    outboundMessages.length > 0
      ? outboundMessages.reduce((sum, m) => sum + (m.body?.length || 0), 0) /
        outboundMessages.length
      : 0;
  let responseQuality = 3;
  if (avgBodyLength > 200) responseQuality += 1;
  if (resolutionScore >= 4) responseQuality += 1;
  if (resolutionScore <= 1) responseQuality -= 1;
  responseQuality = Math.max(1, Math.min(5, responseQuality));

  // ── overallScore (0-100) ─────────────────────────────────
  const overallScore =
    (responseSpeed * 0.15 +
      responseQuality * 0.25 +
      resolutionScore * 0.25 +
      protocolAdherence * 0.15 +
      customerHandling * 0.2) *
    20; // scale 1-5 → 0-100

  // ── strengths & improvements ─────────────────────────────
  const strengths: string[] = [];
  const improvements: string[] = [];

  if (responseSpeed >= 4) strengths.push("Fast response time");
  else if (responseSpeed <= 2) improvements.push("Improve response time");

  if (responseQuality >= 4) strengths.push("High quality responses");
  else if (responseQuality <= 2) improvements.push("Improve response quality and detail");

  if (resolutionScore >= 4) strengths.push("Effective issue resolution");
  else if (resolutionScore <= 2) improvements.push("Focus on resolving customer issues");

  if (protocolAdherence >= 4) strengths.push("Strong protocol adherence");
  else if (protocolAdherence <= 2) improvements.push("Follow escalation and copilot protocols");

  if (customerHandling >= 4) strengths.push("Excellent customer handling");
  else if (customerHandling <= 2) improvements.push("Improve empathy and professionalism");

  if (copilotUsageRate > 0.5) strengths.push("Effective use of AI copilot");
  if (toolExecutions > 0) strengths.push("Utilized available tools");

  // ── Upsert AgentScore ────────────────────────────────────
  const score = await prisma.agentScore.upsert({
    where: { conversationId_agentId: { conversationId, agentId } },
    create: {
      tenantId,
      conversationId,
      agentId,
      responseQuality,
      responseSpeed,
      resolutionScore,
      protocolAdherence,
      customerHandling,
      overallScore,
      strengths,
      improvements,
      copilotUsageRate,
      toolsUsedCount: toolExecutions,
      messageCount: messages.length,
      analyzedAt: new Date(),
    },
    update: {
      responseQuality,
      responseSpeed,
      resolutionScore,
      protocolAdherence,
      customerHandling,
      overallScore,
      strengths,
      improvements,
      copilotUsageRate,
      toolsUsedCount: toolExecutions,
      messageCount: messages.length,
      analyzedAt: new Date(),
    },
  });

  return score;
}

// ─── Get or generate score for a conversation ───────────────

export async function getAgentScore(
  tenantId: string,
  conversationId: string
): Promise<any | null> {
  const existing = await prisma.agentScore.findFirst({
    where: { conversationId, tenantId },
  });
  if (existing) return existing;
  return scoreAgent(tenantId, conversationId);
}

// ─── Agent overview (aggregate across date range) ───────────

export async function getAgentOverview(
  tenantId: string,
  agentId: string,
  from?: string,
  to?: string
): Promise<{
  agentId: string;
  totalConversations: number;
  avgOverallScore: number;
  avgResponseSpeed: number;
  avgResolutionScore: number;
  avgResponseQuality: number;
  avgCustomerHandling: number;
  avgProtocolAdherence: number;
  topStrengths: string[];
  topImprovements: string[];
}> {
  const where: any = { tenantId, agentId };
  if (from || to) {
    where.analyzedAt = {};
    if (from) where.analyzedAt.gte = new Date(from);
    if (to) where.analyzedAt.lte = new Date(to);
  }

  const scores = await prisma.agentScore.findMany({ where });

  if (scores.length === 0) {
    return {
      agentId,
      totalConversations: 0,
      avgOverallScore: 0,
      avgResponseSpeed: 0,
      avgResolutionScore: 0,
      avgResponseQuality: 0,
      avgCustomerHandling: 0,
      avgProtocolAdherence: 0,
      topStrengths: [],
      topImprovements: [],
    };
  }

  const avg = (field: keyof typeof scores[0]) => {
    const vals = scores.map((s) => (s[field] as number) || 0);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  // Tally strengths and improvements
  const strengthCounts: Record<string, number> = {};
  const improvementCounts: Record<string, number> = {};
  for (const s of scores) {
    for (const str of (s.strengths as string[])) {
      strengthCounts[str] = (strengthCounts[str] || 0) + 1;
    }
    for (const imp of (s.improvements as string[])) {
      improvementCounts[imp] = (improvementCounts[imp] || 0) + 1;
    }
  }

  const topN = (counts: Record<string, number>, n: number) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k]) => k);

  return {
    agentId,
    totalConversations: scores.length,
    avgOverallScore: Math.round(avg("overallScore") * 10) / 10,
    avgResponseSpeed: Math.round(avg("responseSpeed") * 10) / 10,
    avgResolutionScore: Math.round(avg("resolutionScore") * 10) / 10,
    avgResponseQuality: Math.round(avg("responseQuality") * 10) / 10,
    avgCustomerHandling: Math.round(avg("customerHandling") * 10) / 10,
    avgProtocolAdherence: Math.round(avg("protocolAdherence") * 10) / 10,
    topStrengths: topN(strengthCounts, 3),
    topImprovements: topN(improvementCounts, 3),
  };
}
