/** P1-7 - run one full bot turn directly, then report the model each micro-call used. */
import { prisma } from "@chatcenter/shared";
import { initAIService } from "../src/services/ai.service";
import { generateAIBotReply } from "../src/services/ai-bot.service";

const [tenantId, conversationId, aiAgentId, message] = process.argv.slice(2);

(async () => {
  initAIService({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    defaultModel: process.env.OPENAI_DEFAULT_MODEL || undefined,
    defaultEmbeddingModel: process.env.EMBEDDING_MODEL || undefined,
  });
  const r = await generateAIBotReply({ tenantId, conversationId, aiAgentId, incomingMessage: message });
  console.log("[p1-7] reply:", (r.reply ?? r.escalation?.reason ?? "").slice(0, 50));

  const rows = await prisma.usageLog.findMany({
    where: { tenantId, conversationId, model: { not: null } } as any,
    orderBy: { createdAt: "desc" }, take: 8,
    select: { feature: true, model: true, durationMs: true } as any,
  });
  for (const row of rows as any[]) console.log(`[p1-7] ${row.feature} → model=${row.model} dur=${row.durationMs ?? "-"}ms`);
  await prisma.$disconnect();
})().catch((e) => { console.error("[p1-7] error:", e?.message || e); process.exit(1); });
