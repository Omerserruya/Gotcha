/**
 * LIVE PILOT HARNESS - drives the production Calendar capability through the Agent
 * Loop (the new cognitive kernel) on the real dev DB with the real OpenAI reasoner.
 *
 * This is NOT a test fixture: it exercises the exact production path a bot turn
 * takes when AGENT_LOOP_MODE is on - runAgentLoopForBotTurn → runAgentLoop →
 * assembleOracleFacts (real calendar port) → OpenAI Reasoner → authorize → Capability
 * Runtime → observation → re-read → … → Writer. It then dumps the persisted
 * agent_loop_runs + agent_loop_iterations so we can inspect the emergent workflow.
 *
 * Run (from services/ai), DB host rewritten to localhost:
 *   DATABASE_URL="postgresql://postgres:PW@localhost:5432/whatsapp_cc" \
 *   OPENAI_API_KEY="$OPENAI_API_KEY" \
 *   npx tsx scripts/pilot-calendar-loop.ts <scenarioKey> "<hebrew message>" [shadow|autonomous]
 *
 * Deletion: this harness is a migration-evaluation tool. It lives until the loop is
 * the production calendar path and the migration register's deletion gates are green;
 * tracked in docs/architecture/calendar-migration-register.md.
 */

import { prisma } from "@chatcenter/shared";
import "../src/services/connectors"; // side-effect: registers provider adapters (as the service does at boot)
import { initAIService } from "../src/services/ai.service";
import { runAgentLoopForBotTurn } from "../src/services/agent-loop/bot-loop-adapter";

const TENANT_ID = "cmmov5qh10000ltnqm7pmxqzc";
const AGENT_ID = "cm5aabb73f8d574c5b909ca1e9fcd6a142"; // דניאל - CONNECTED Google Calendar

async function seedConversation(conversationId: string, incoming: string) {
  // Idempotent + TenantGuard-compliant (every mutation `where` carries tenantId).
  // Fresh, single-inbound transcript so the turn is reproducible.
  await prisma.message.deleteMany({ where: { conversationId, tenantId: TENANT_ID } });
  await prisma.conversation.deleteMany({ where: { id: conversationId, tenantId: TENANT_ID } });
  await prisma.conversation.create({
    data: {
      id: conversationId,
      tenantId: TENANT_ID,
      customerExternalId: "pilot-customer-001",
      customerName: "Pilot Customer",
      assignedAiAgentId: AGENT_ID,
      status: "OPEN",
      detectedLocale: "he",
      channel: "WHATSAPP",
    } as any,
  });
  await prisma.message.create({
    data: {
      id: `${conversationId}-in-1`,
      tenantId: TENANT_ID,
      conversationId,
      direction: "INBOUND",
      body: incoming,
      messageType: "text",
    } as any,
  });
}

async function main() {
  const scenarioKey = process.argv[2] || "book";
  const incoming = process.argv[3] || "אני רוצה לקבוע פגישה למחר בבוקר";
  const mode = (process.argv[4] as "shadow" | "autonomous") || "shadow";

  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required for a live pilot");
  initAIService({ apiKey: process.env.OPENAI_API_KEY });

  const conversationId = `pilot-loop-${scenarioKey}`;
  await seedConversation(conversationId, incoming);

  console.log(`\n=== LIVE PILOT [${mode}] scenario=${scenarioKey} ===`);
  console.log(`tenant=${TENANT_ID} agent=${AGENT_ID} conv=${conversationId}`);
  console.log(`customer: "${incoming}"\n`);

  const t0 = Date.now();
  const result = await runAgentLoopForBotTurn(
    { tenantId: TENANT_ID, conversationId, aiAgentId: AGENT_ID, incomingMessage: incoming },
    mode,
  );
  const wall = Date.now() - t0;

  console.log("=== LOOP RESULT ===");
  console.log("reply:", result.reply);
  console.log("escalation:", JSON.stringify(result.escalation));
  console.log("awaitingApproval:", JSON.stringify(result.awaitingApproval));
  console.log("toolCallLog:", JSON.stringify(result.toolCallLog, null, 2));
  console.log(`tokens=${result.totalTokens} wall=${wall}ms model=${result.modelUsed}`);

  // Inspect what actually persisted - the observability contract.
  const run = await (prisma as any).agentLoopRun.findFirst({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
  });
  console.log("\n=== PERSISTED RUN (agent_loop_runs) ===");
  if (!run) {
    console.log("  <none> - RUN DID NOT PERSIST");
  } else {
    console.log(`  loopId=${run.loopId} termination=${run.terminationReason} iterations=${run.iterationCount} mode=${run.mode}`);
    console.log(`  provider=${run.provider} model=${run.model} spentUnits=${run.spentUnits} wallMs=${run.wallMs}`);
    const iters = await (prisma as any).agentLoopIteration.findMany({
      where: { loopId: run.loopId },
      orderBy: { iteration: "asc" },
    });
    console.log(`\n=== PERSISTED ITERATIONS (${iters.length}) ===`);
    for (const it of iters) {
      console.log(
        `  #${it.iteration} decision=${it.decisionType} op=${it.proposedOperation ?? "-"} runtime=${it.runtimeResult ?? "-"}`,
      );
      if (it.reasoningSummary) console.log(`     why: ${it.reasoningSummary}`);
      if (it.observation) console.log(`     obs: ${JSON.stringify(it.observation)}`);
    }
    if (iters.length === 0) {
      console.log("  <none> - ITERATIONS DID NOT PERSIST (FK ordering?) - observability gap");
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("PILOT FAILED:", e);
  await prisma.$disconnect();
  process.exit(1);
});
