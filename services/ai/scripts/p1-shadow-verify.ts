/**
 * P1 live verification - run ONE real shadow loop for a conversation and print
 * what the persisted iterations prove: real grants-derived permissions, real
 * billing status, committed goal, dry_run gate probing, observation data.
 *
 *   docker compose exec ai npx tsx scripts/p1-shadow-verify.ts <tenantId> <conversationId> <aiAgentId> "<message>"
 */

import { prisma } from "@chatcenter/shared";
import { runAgentLoopForBotTurn } from "../src/services/agent-loop/bot-loop-adapter";
import { initAIService } from "../src/services/ai.service";

const [tenantId, conversationId, aiAgentId, message] = process.argv.slice(2);

(async () => {
  // The real service inits at boot; a standalone script must init the LLM client.
  initAIService({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    defaultModel: process.env.OPENAI_DEFAULT_MODEL || undefined,
    defaultEmbeddingModel: process.env.EMBEDDING_MODEL || undefined,
  });
  const before = await (prisma as any).agentLoopRun.count();
  console.log("[p1] loop runs before:", before);

  const r = await runAgentLoopForBotTurn(
    { tenantId, conversationId, aiAgentId, incomingMessage: message || "hi" },
    "shadow",
  );
  console.log("[p1] shadow reply mapped:", { reply: r.reply?.slice(0, 60), escalation: r.escalation, tokens: r.totalTokens });

  // Inspect the run we just created.
  const run = await (prisma as any).agentLoopRun.findFirst({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
  });
  console.log("[p1] run:", { id: run?.id, mode: run?.mode, goal: run?.goal, termination: run?.terminationReason });

  const iters = await (prisma as any).agentLoopIteration.findMany({
    where: { loopId: run?.id },
    orderBy: { iteration: "asc" },
  });
  for (const it of iters) {
    const facts = it.oracleFactsSnapshot as any;
    console.log(`[p1] iter ${it.iteration}: decision=${it.decisionType} op=${it.proposedOperation ?? "-"} runtime=${it.runtimeResult ?? "-"}`);
    if (it.iteration === 1 && facts) {
      console.log("       billing:", JSON.stringify(facts.billing), "| withinLimits:", facts.entitlements?.withinLimits);
      console.log("       permissions.allowedOperations:", JSON.stringify(facts.permissions?.allowedOperations));
      console.log("       menu:", (facts.availableOperations ?? []).map((o: any) => o.name).join(","));
    }
    if (it.observation) console.log("       observation:", String(it.observation).slice(0, 200));
  }
  await prisma.$disconnect();
})().catch((e) => { console.error("[p1] error:", e?.message || e); process.exit(1); });
